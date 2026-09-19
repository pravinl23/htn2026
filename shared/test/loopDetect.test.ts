import { describe, expect, it } from "vitest";
import { LOOP_WINDOW_MS, detectLoop, shapeKeys } from "../src";
import { INBOX_LIST, INVOICES, TraceBuilder, handleInvoice, invoiceSession } from "./helpers/traceBuilder";

describe("detectLoop", () => {
  it("finds the canonical invoice loop right after the second reply", () => {
    const tb = invoiceSession(2);
    const loop = detectLoop(tb.events(), tb.now);
    expect(loop).not.toBeNull();
    expect(loop?.length).toBe(10);
    expect(shapeKeys(loop!.runA)).toEqual(shapeKeys(loop!.runB));
    expect(shapeKeys(loop!.runA)).toEqual([
      "navigate|/invoices|",
      "click|/invoices|LIST(ul#inbox)",
      "navigate|/invoices/:id|",
      "navigate|/sheet|",
      "input|/sheet|CELL(Vendor)",
      "input|/sheet|CELL(Invoice #)",
      "input|/sheet|CELL(Date)",
      "input|/sheet|CELL(Total)",
      "navigate|/invoices/:id|",
      "click|/invoices/:id|Reply: received#button",
    ]);
    expect(loop?.runA[1]?.target?.list?.index).toBe(0);
    expect(loop?.runB[1]?.target?.list?.index).toBe(1);
  });

  it("does not fire after one run, or one and a half", () => {
    const one = invoiceSession(1);
    expect(detectLoop(one.events(), one.now)).toBeNull();
    const events = invoiceSession(2).events().slice(0, -3);
    expect(detectLoop(events, events[events.length - 1]!.t)).toBeNull();
  });

  it("still finds the loop when the trace starts with unrelated actions", () => {
    const tb = new TraceBuilder().navigate("/mail").click("Inbox").navigate("/invoices");
    handleInvoice(tb, 0).navigate("/invoices");
    handleInvoice(tb, 1);
    expect(detectLoop(tb.events(), tb.now)?.length).toBe(10);
  });

  it("uses the last two runs and the smallest unit after three or four repetitions", () => {
    for (const count of [3, 4]) {
      const tb = invoiceSession(count);
      const loop = detectLoop(tb.events(), tb.now);
      expect(loop?.length).toBe(10);
      expect(loop?.runA[1]?.target?.list?.index).toBe(count - 2);
      expect(loop?.runB[1]?.target?.list?.index).toBe(count - 1);
    }
  });

  it("only looks at the last 10 minutes relative to the now parameter", () => {
    const tb = invoiceSession(2);
    expect(detectLoop(tb.events(), tb.now + LOOP_WINDOW_MS + 1)).toBeNull();
    const slow = new TraceBuilder().navigate("/invoices");
    handleInvoice(slow, 0).wait(LOOP_WINDOW_MS).navigate("/invoices");
    handleInvoice(slow, 1);
    expect(detectLoop(slow.events(), slow.now)).toBeNull();
    expect(detectLoop(slow.events(), slow.now, { windowMs: 3 * LOOP_WINDOW_MS })?.length).toBe(10);
  });

  it("ignores Ghost's own synthetic events", () => {
    const tb = new TraceBuilder().navigate("/invoices");
    handleInvoice(tb, 0);
    const mine = tb.events();
    const replay = new TraceBuilder({ start: tb.now }).navigate("/invoices");
    handleInvoice(replay, 1);
    const ghost = replay.events().map((e) => ({ ...e, synthetic: true }));
    expect(detectLoop([...mine, ...ghost], replay.now)).toBeNull();
  });

  it("ignores synthetic events that interleave with a real loop", () => {
    const tb = new TraceBuilder().navigate("/invoices");
    handleInvoice(tb, 0).synthetic().click("Ghost HUD").navigate("/invoices");
    handleInvoice(tb, 1);
    expect(detectLoop(tb.events(), tb.now)?.length).toBe(10);
  });

  it("rejects an identical redo: same item, same values", () => {
    const tb = new TraceBuilder().navigate("/invoices");
    handleInvoice(tb, 0).navigate("/invoices");
    handleInvoice(tb, 0);
    expect(detectLoop(tb.events(), tb.now)).toBeNull();
  });

  it("accepts a repeat where only values change", () => {
    const tb = new TraceBuilder().at("/crm/new");
    for (const name of ["Ada", "Grace"]) tb.input("Name", name).input("Team", "Platform").click("Add another");
    expect(detectLoop(tb.events(), tb.now)?.length).toBe(3);
  });

  it("requires at least three steps per run", () => {
    const tb = new TraceBuilder().at("/mail");
    tb.clickItem("ul#mail", 0, "a").click("Archive").clickItem("ul#mail", 1, "b").click("Archive");
    expect(detectLoop(tb.events(), tb.now)).toBeNull();
    expect(detectLoop(tb.events(), tb.now, { minLength: 2 })?.length).toBe(2);
  });

  it("tolerates noise: body clicks, double clicks and corrected inputs", () => {
    const tb = new TraceBuilder().navigate("/invoices");
    handleInvoice(tb, 0).navigate("/invoices").clickBody();
    const inv = INVOICES[1]!;
    tb.clickItem(INBOX_LIST, 1, inv.id).wait(-1300).clickItem(INBOX_LIST, 1, inv.id);
    tb.navigate(`/invoices/${inv.id}`).navigate("/sheet");
    tb.fillCell(1, 0, "Vendor", "Globx").fillCell(1, 0, "Vendor", inv.vendor).clickBody();
    tb.fillCell(1, 1, "Invoice #", inv.id).fillCell(1, 2, "Date", inv.typedDate).fillCell(1, 3, "Total", inv.typedTotal);
    tb.navigate(`/invoices/${inv.id}`).click("Reply: received", { locked: true });
    const loop = detectLoop(tb.events(), tb.now);
    expect(loop?.length).toBe(10);
    expect(loop?.runB[4]?.value).toBe(inv.vendor);
  });

  it("can be restricted to one tab group", () => {
    const tb = invoiceSession(2);
    expect(detectLoop(tb.events(), tb.now, { tabIds: [1] })?.length).toBe(10);
    expect(detectLoop(tb.events(), tb.now, { tabIds: [2] })).toBeNull();
  });

  it("detects a loop spread over two tabs", () => {
    const tb = new TraceBuilder();
    INVOICES.slice(0, 2).forEach((inv, i) => {
      tb.tabswitch(1, "/invoices").clickItem(INBOX_LIST, i, inv.id).navigate(`/invoices/${inv.id}`);
      tb.tabswitch(2, "/sheet").fillCell(i, 0, "Vendor", inv.vendor).fillCell(i, 3, "Total", inv.typedTotal);
      tb.tabswitch(1, `/invoices/${inv.id}`).click("Reply: received", { locked: true });
    });
    expect(detectLoop(tb.events(), tb.now)?.length).toBe(8);
  });
});
