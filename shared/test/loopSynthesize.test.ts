import { describe, expect, it } from "vitest";
import { MASKED_VALUE, detectLoop, synthesizeProgram } from "../src";
import type { FactsByUrl, LoopCandidate, LoopStep } from "../src";
import {
  DEMO_ORIGIN, INBOX_LIST, INVOICES, REPLY_LABEL, TraceBuilder, handleInvoice, invoiceFacts, invoiceFactsByUrl, invoiceSession,
} from "./helpers/traceBuilder";

function candidateOf(tb: TraceBuilder): LoopCandidate {
  const loop = detectLoop(tb.events(), tb.now);
  if (!loop) throw new Error("expected a loop");
  return loop;
}

const ops = (steps: LoopStep[]): string[] => steps.map((s) => s.op);

describe("synthesizeProgram: canonical invoice loop", () => {
  const program = synthesizeProgram(candidateOf(invoiceSession(2)), invoiceFactsByUrl());

  it("produces open-item, 4 extracts, goto sheet, 4 fills, a locked click", () => {
    expect(program).not.toBeNull();
    expect(ops(program!.steps)).toEqual([
      "open-item", "extract", "extract", "extract", "extract", "goto", "fill", "fill", "fill", "fill", "click",
    ]);
  });

  it("describes the iterator", () => {
    expect(program?.iterator).toEqual({
      origin: DEMO_ORIGIN, pathPattern: "/invoices", listSignature: INBOX_LIST, stride: 1, nextIndex: 2, itemPathPattern: "/invoices/:id",
    });
  });

  it("extracts each value from the invoice page with the right locator and transform", () => {
    const extracts = program!.steps.filter((s) => s.op === "extract");
    expect(extracts).toEqual([
      { op: "extract", var: "vendor", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" } } },
      { op: "extract", var: "invoiceNumber", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "number" } } },
      { op: "extract", var: "date", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "date" }, transform: "date-iso" } },
      { op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "total" }, transform: "number" } },
    ]);
  });

  it("goes to the sheet and appends a row, one fill per column", () => {
    expect(program?.steps[5]).toEqual({ op: "goto", origin: DEMO_ORIGIN, pathPattern: "/sheet", url: `${DEMO_ORIGIN}/sheet` });
    const fills = program!.steps.filter((s) => s.op === "fill");
    expect(fills.map((f) => f.op === "fill" && f.target.cell)).toEqual([
      { row: "next-empty", colHeader: "Vendor" },
      { row: "next-empty", colHeader: "Invoice #" },
      { row: "next-empty", colHeader: "Date" },
      { row: "next-empty", colHeader: "Total" },
    ]);
    expect(fills.map((f) => f.op === "fill" && f.value)).toEqual([{ var: "vendor" }, { var: "invoiceNumber" }, { var: "date" }, { var: "total" }]);
    expect(fills.every((f) => f.op === "fill" && f.target.signature === undefined && f.at?.pathPattern === "/sheet")).toBe(true);
  });

  it("keeps the reply locked and lists it as the one irreversible effect", () => {
    const last = program!.steps[10];
    expect(last).toMatchObject({ op: "click", locked: true, target: { label: REPLY_LABEL, kind: "button" }, at: { pathPattern: "/invoices/:id" } });
    expect(program?.irreversible).toEqual([{ stepIndex: 10, description: REPLY_LABEL }]);
  });

  it("is confident, fully resolved, deterministic and serializable", () => {
    expect(program?.unresolved).toEqual([]);
    expect(program!.confidence).toBeGreaterThanOrEqual(0.85);
    expect(program!.confidence).toBeLessThanOrEqual(1);
    expect(program?.name).toBe('Copy 4 fields from /invoices/:id to /sheet and click "Reply: received"');
    const again = synthesizeProgram(candidateOf(invoiceSession(2)), invoiceFactsByUrl());
    expect(again).toEqual(program);
    expect(JSON.parse(JSON.stringify(program))).toEqual(program);
  });
});

describe("synthesizeProgram: alignment and iterator", () => {
  it("handles a run aligned on the item click (user already back on the inbox)", () => {
    const tb = new TraceBuilder();
    handleInvoice(tb, 0).navigate("/invoices");
    handleInvoice(tb, 1).navigate("/invoices");
    const loop = candidateOf(tb);
    expect(loop.runA[0]?.type).toBe("click");
    const program = synthesizeProgram(loop, invoiceFactsByUrl());
    expect(ops(program!.steps)).toEqual(["open-item", "extract", "extract", "extract", "extract", "goto", "fill", "fill", "fill", "fill", "click"]);
    expect(program?.unresolved).toEqual([]);
  });

  it("advances nextIndex after a third manual run and accepts a known total", () => {
    const program = synthesizeProgram(candidateOf(invoiceSession(3)), invoiceFactsByUrl(), { total: 50, id: "p1", name: "Invoices" });
    expect(program?.iterator).toMatchObject({ nextIndex: 3, stride: 1, total: 50 });
    expect(program).toMatchObject({ id: "p1", name: "Invoices" });
  });

  it("learns a consistent stride and lowers confidence for it", () => {
    const tb = new TraceBuilder().navigate("/invoices");
    handleInvoice(tb, 0, 0).navigate("/invoices");
    handleInvoice(tb, 2, 1);
    const program = synthesizeProgram(candidateOf(tb), invoiceFactsByUrl());
    expect(program?.iterator).toMatchObject({ stride: 2, nextIndex: 4 });
    expect(program!.confidence).toBeLessThan(synthesizeProgram(candidateOf(invoiceSession(2)), invoiceFactsByUrl())!.confidence);
  });

  it("returns null without a list iterator", () => {
    const tb = new TraceBuilder().at("/crm/new");
    for (const name of ["Ada", "Grace"]) tb.input("Name", name).input("Team", "Platform").click("Add another");
    expect(synthesizeProgram(candidateOf(tb), {})).toBeNull();
  });

  it("returns null when the runs are not aligned or there is nothing to do per item", () => {
    const loop = candidateOf(invoiceSession(2));
    expect(synthesizeProgram({ ...loop, runB: loop.runB.slice(1) }, invoiceFactsByUrl())).toBeNull();
    const browse = new TraceBuilder();
    INVOICES.slice(0, 2).forEach((inv, i) => browse.navigate("/invoices").clickItem(INBOX_LIST, i, inv.id).navigate(`/invoices/${inv.id}`));
    expect(synthesizeProgram(candidateOf(browse), invoiceFactsByUrl())).toBeNull();
  });

  it("never generalizes a masked (sensitive) value", () => {
    const loop = candidateOf(invoiceSession(2));
    loop.runB[4] = { ...loop.runB[4]!, value: MASKED_VALUE };
    expect(synthesizeProgram(loop, invoiceFactsByUrl())).toBeNull();
  });
});

describe("synthesizeProgram: values", () => {
  it("keeps identical values as constants and identical targets by signature", () => {
    const tb = new TraceBuilder();
    INVOICES.slice(0, 2).forEach((inv, i) => {
      tb.navigate("/invoices").clickItem(INBOX_LIST, i, inv.id).navigate(`/invoices/${inv.id}`);
      tb.input("Note", "Received, thanks").click("Save note");
    });
    const program = synthesizeProgram(candidateOf(tb), invoiceFactsByUrl());
    expect(program?.steps).toEqual([
      { op: "open-item" },
      { op: "fill", target: { label: "Note", kind: "text", signature: "text:Note" }, value: { const: "Received, thanks" }, at: { origin: DEMO_ORIGIN, pathPattern: "/invoices/:id" } },
      { op: "click", target: { label: "Save note", kind: "button", signature: "button:Save note" }, locked: false, at: { origin: DEMO_ORIGIN, pathPattern: "/invoices/:id" } },
    ]);
    expect(program?.irreversible).toEqual([]);
    expect(program?.confidence).toBe(1);
  });

  it("reports a step as unresolved when no fact explains the values", () => {
    const facts = invoiceFactsByUrl();
    for (const inv of INVOICES) facts[`${DEMO_ORIGIN}/invoices/${inv.id}`] = invoiceFacts(inv).filter((f) => !/total|amount/i.test(f.label));
    const program = synthesizeProgram(candidateOf(invoiceSession(2)), facts);
    expect(ops(program!.steps)).toEqual(["open-item", "extract", "extract", "extract", "goto", "fill", "fill", "fill", "fill", "click"]);
    expect(program?.unresolved).toEqual([{ stepIndex: 8, var: "total", label: "Total", valueA: "1204.50", valueB: "980" }]);
    expect(program?.steps[8]).toMatchObject({ op: "fill", value: { var: "total" } });
    expect(program!.confidence).toBeLessThan(0.7);
  });

  it("requires the same locator to explain BOTH runs", () => {
    const facts: FactsByUrl = invoiceFactsByUrl();
    const second = INVOICES[1]!;
    facts[`${DEMO_ORIGIN}/invoices/${second.id}`] = invoiceFacts(second).map((f) =>
      f.label === "Vendor" ? { ...f, locator: { by: "css", value: "dl > dd:nth-child(2)" } } : f,
    );
    const program = synthesizeProgram(candidateOf(invoiceSession(2)), facts);
    expect(program?.unresolved?.map((u) => u.label)).toEqual(["Vendor"]);
  });

  it("prefers the fact whose label matches the column when two facts hold the same text", () => {
    const tb = new TraceBuilder();
    INVOICES.slice(0, 2).forEach((inv, i) => {
      tb.navigate("/invoices").clickItem(INBOX_LIST, i, inv.id).navigate(`/invoices/${inv.id}`).navigate("/sheet");
      tb.fillCell(i, 0, "Amount due", inv.total).click("Save");
    });
    const program = synthesizeProgram(candidateOf(tb), invoiceFactsByUrl());
    expect(program?.steps[1]).toEqual({ op: "extract", var: "amountDue", from: { pathPattern: "/invoices/:id", locator: { by: "label", value: "Amount due" } } });
  });

  it("reuses one extract when the same fact feeds two fields", () => {
    const tb = new TraceBuilder();
    INVOICES.slice(0, 2).forEach((inv, i) => {
      tb.navigate("/invoices").clickItem(INBOX_LIST, i, inv.id).navigate(`/invoices/${inv.id}`).navigate("/sheet");
      tb.fillCell(i, 0, "Vendor", inv.vendor).fillCell(i, 4, "Payee", inv.vendor);
    });
    const program = synthesizeProgram(candidateOf(tb), invoiceFactsByUrl());
    expect(ops(program!.steps)).toEqual(["open-item", "extract", "goto", "fill", "fill"]);
    expect(program!.steps.slice(3).map((s) => s.op === "fill" && s.value)).toEqual([{ var: "vendor" }, { var: "vendor" }]);
  });

  it("explains a step that precedes the item click from the previous run's pages, with less confidence", () => {
    // Each run: log the PREVIOUS item's total, then open the next item. Run B's value comes from the item opened in run A.
    const tb = new TraceBuilder().navigate("/sheet");
    tb.fillCell(0, 3, "Total", "1").navigate("/invoices").clickItem(INBOX_LIST, 0, "INV-1001").navigate("/invoices/INV-1001").navigate("/sheet");
    tb.fillCell(1, 3, "Total", "1204.50").navigate("/invoices").clickItem(INBOX_LIST, 1, "INV-1002").navigate("/invoices/INV-1002").navigate("/sheet");
    const loop = candidateOf(tb);
    expect(loop.runA[0]?.type).toBe("input");
    const program = synthesizeProgram(loop, invoiceFactsByUrl());
    expect(ops(program!.steps)).toEqual(["open-item", "extract", "goto", "fill"]);
    expect(program?.unresolved).toEqual([]);
    expect(program!.confidence).toBeLessThan(0.85);
  });

  it("treats a submit after a locked click as one irreversible step", () => {
    const tb = new TraceBuilder();
    INVOICES.slice(0, 2).forEach((inv, i) => {
      tb.navigate("/invoices").clickItem(INBOX_LIST, i, inv.id).navigate(`/invoices/${inv.id}`);
      tb.input("Reply", "Received").click("Send", { locked: true }).submit("Reply form");
    });
    const program = synthesizeProgram(candidateOf(tb), invoiceFactsByUrl());
    expect(ops(program!.steps)).toEqual(["open-item", "fill", "click"]);
    expect(program?.irreversible).toEqual([{ stepIndex: 2, description: "Send" }]);
  });

  it("lists a locked field (auto-saving control) as an irreversible fill with a readable description", () => {
    const tb = new TraceBuilder();
    INVOICES.slice(0, 2).forEach((inv, i) => {
      tb.navigate("/invoices").clickItem(INBOX_LIST, i, inv.id).navigate(`/invoices/${inv.id}`);
      tb.input("Note", "ok").input("Status", "Paid", { kind: "select", locked: i === 1 }).click("Next");
    });
    const program = synthesizeProgram(candidateOf(tb), invoiceFactsByUrl());
    expect(program?.steps[2]).toMatchObject({ op: "fill", locked: true, value: { const: "Paid" } });
    expect(program?.irreversible).toEqual([{ stepIndex: 2, description: 'Set Status to "Paid"' }]);
  });
});

describe("synthesizeProgram: detection fires in the middle of the third item", () => {
  /** Two full passes, then `events` more events of the third pass (10 events per pass after the first inbox visit). */
  function midThirdItem(events: number): LoopCandidate {
    const tb = invoiceSession(2).navigate("/invoices");
    const all = handleInvoice(tb, 2).events();
    const cut = all.slice(0, all.length - 10 + events);
    const loop = detectLoop(cut, cut[cut.length - 1]?.t ?? 0);
    if (!loop) throw new Error("expected a loop");
    return loop;
  }

  it("the item was only opened: the run restarts at that item instead of skipping it", () => {
    for (const events of [2, 3, 4]) expect(synthesizeProgram(midThirdItem(events), invoiceFactsByUrl())?.iterator.nextIndex).toBe(2);
    const program = synthesizeProgram(midThirdItem(4), invoiceFactsByUrl());
    expect(program?.irreversible.map((x) => x.description)).toEqual([REPLY_LABEL]);
  });

  it("the item is half-done (one cell typed, reply not sent): no program until the user finishes it", () => {
    for (const events of [5, 8, 9]) expect(synthesizeProgram(midThirdItem(events), invoiceFactsByUrl())).toBeNull();
  });

  it("the item is finished: the run continues with the next one", () => {
    expect(synthesizeProgram(midThirdItem(10), invoiceFactsByUrl())?.iterator.nextIndex).toBe(3);
  });
});
