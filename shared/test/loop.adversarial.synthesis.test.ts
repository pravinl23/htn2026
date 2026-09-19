/**
 * Adversarial tests for synthesizeProgram, values.ts, planRemaining, EpisodicStore and predictFromMemory.
 * Expectations come from docs/loops.md. Where the doc is silent the test name says "unspecified" and picks the
 * safest behavior for a product where a wrong ghost is worse than no ghost.
 */
import { describe, expect, it } from "vitest";
import {
  EPISODIC_MAX_PAIRS, EpisodicStore, applyTransform, canonicalNumberString, describeIrreversible, detectLoop, matchValue,
  parseDateToIso, planRemaining, predictFromMemory, synthesizeProgram,
} from "../src";
import type {
  EpisodicAction, EpisodicPair, FactLocator, FactsByUrl, LoopCandidate, LoopProgram, LoopStep, NextCandidate, PageFact, TraceEvent,
} from "../src";
import { DEMO_ORIGIN, INBOX_LIST, INVOICES, REPLY_LABEL, TraceBuilder, handleInvoice, invoiceFactsByUrl, invoiceSession } from "./helpers/traceBuilder";

const THRESHOLD = 0.7; // DEFAULT settings.confidenceThreshold
const NBSP = String.fromCharCode(0xa0);
const MINUS = String.fromCharCode(0x2212); // typographic minus
const pairs = (rows: Array<[string, string]>): Array<[string, string]> => rows;

type ExtractStep = Extract<LoopStep, { op: "extract" }>;
type FillStep = Extract<LoopStep, { op: "fill" }>;
type ClickStep = Extract<LoopStep, { op: "click" }>;

interface Item {
  id: string;
  facts: PageFact[];
}

interface Session {
  loop: LoopCandidate;
  facts: FactsByUrl;
}

const fact = (by: FactLocator["by"], value: string, label: string, text: string): PageFact => ({ locator: { by, value }, label, text });
const itemUrl = (id: string): string => `${DEMO_ORIGIN}/invoices/${id}`;

/** One pass per item: inbox, open item, land on its page, then whatever the test does there. */
function session(
  items: Item[],
  perItem: (tb: TraceBuilder, item: Item, run: number) => void,
  opts: { indexes?: number[]; patch?: (e: TraceEvent) => TraceEvent } = {},
): Session {
  const tb = new TraceBuilder();
  const facts: FactsByUrl = { [`${DEMO_ORIGIN}/invoices`]: [fact("css", "h1", "", "Inbox")] };
  items.forEach((item, run) => {
    facts[itemUrl(item.id)] = item.facts;
    tb.navigate("/invoices").clickItem(INBOX_LIST, opts.indexes?.[run] ?? run, item.id).navigate(`/invoices/${item.id}`);
    perItem(tb, item, run);
  });
  const events = opts.patch ? tb.events().map(opts.patch) : tb.events();
  const loop = detectLoop(events, tb.now);
  if (!loop) throw new Error("expected detectLoop to find the loop");
  return { loop, facts };
}

/** The user copies ONE value per item into a sheet column, appending a row each time. */
function copyOne(header: string, rows: Array<Item & { typed: string }>): LoopProgram | null {
  const s = session(rows, (tb, item, run) => {
    tb.navigate("/sheet").fillCell(run, 0, header, rows[run]?.typed ?? "").click("Save");
    void item;
  });
  return synthesizeProgram(s.loop, s.facts);
}

const extractsOf = (p: LoopProgram): ExtractStep[] => p.steps.filter((s): s is ExtractStep => s.op === "extract");
const fillsOf = (p: LoopProgram): FillStep[] => p.steps.filter((s): s is FillStep => s.op === "fill");
const clicksOf = (p: LoopProgram): ClickStep[] => p.steps.filter((s): s is ClickStep => s.op === "click");

function onlyFill(p: LoopProgram | null): { program: LoopProgram; fill: FillStep } {
  if (!p) throw new Error("expected a program");
  const fills = fillsOf(p);
  const fill = fills[0];
  if (!fill || fills.length !== 1) throw new Error(`expected exactly one fill, got ${fills.length}`);
  return { program: p, fill };
}

function varOf(fill: FillStep): string | null {
  return "var" in fill.value ? fill.value.var : null;
}

function sourceOf(p: LoopProgram, fill: FillStep): ExtractStep | undefined {
  return extractsOf(p).find((e) => e.var === varOf(fill));
}

function isFlagged(p: LoopProgram, fill: FillStep): boolean {
  return (p.unresolved ?? []).some((u) => u.var === varOf(fill)) || p.confidence < THRESHOLD;
}

/** Every variable a fill uses is either extracted BEFORE that fill or reported as unresolved. */
function expectVarsAccountedFor(p: LoopProgram): void {
  p.steps.forEach((step, i) => {
    if (step.op !== "fill" || !("var" in step.value)) return;
    const name = step.value.var;
    const definedAt = p.steps.findIndex((s) => s.op === "extract" && s.var === name);
    const unresolved = (p.unresolved ?? []).some((u) => u.var === name);
    expect(unresolved || (definedAt >= 0 && definedAt < i), `var ${name} used at step ${i}`).toBe(true);
    expect(unresolved && definedAt >= 0, `var ${name} is both extracted and unresolved`).toBe(false);
  });
}

/** What the executor would write for an item: the fact under each extract's locator, transformed. */
function replay(p: LoopProgram, facts: PageFact[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const e of extractsOf(p)) {
    const hit = facts.find((f) => f.locator.by === e.from.locator.by && f.locator.value === e.from.locator.value);
    out[e.var] = hit ? applyTransform(hit.text, e.from.transform) : null;
  }
  return out;
}

const money = (id: string, subtotal: string, total: string): Item => ({
  id,
  facts: [fact("data-field", "subtotal", "Subtotal", subtotal), fact("data-field", "total", "Total", total)],
});

// ---------------------------------------------------------------------------------------------------------------------

describe("adversarial synthesizeProgram: a typed value that matches two page facts", () => {
  const TOTAL = { by: "data-field", value: "total" };

  it("total equals subtotal in run A only: picks the locator that explains BOTH runs (total)", () => {
    const { program, fill } = onlyFill(copyOne("Amount", [
      { ...money("INV-5001", "$100.00", "$100.00"), typed: "$100.00" },
      { ...money("INV-5002", "$90.00", "$99.00"), typed: "$99.00" },
    ]));
    expect(sourceOf(program, fill)?.from.locator).toEqual(TOTAL);
    expect(extractsOf(program)).toHaveLength(1);
    expect(program.unresolved ?? []).toEqual([]);
    expectVarsAccountedFor(program);
  });

  it("total equals subtotal in run B only: still total", () => {
    const { program, fill } = onlyFill(copyOne("Amount", [
      { ...money("INV-5001", "$90.00", "$99.00"), typed: "$99.00" },
      { ...money("INV-5002", "$100.00", "$100.00"), typed: "$100.00" },
    ]));
    expect(sourceOf(program, fill)?.from.locator).toEqual(TOTAL);
    expect(program.unresolved ?? []).toEqual([]);
  });

  it("the column header resembles the WRONG fact (Subtotal) but only total explains both runs: evidence beats label affinity", () => {
    const { program, fill } = onlyFill(copyOne("Subtotal", [
      { ...money("INV-5001", "$100.00", "$100.00"), typed: "$100.00" },
      { ...money("INV-5002", "$90.00", "$99.00"), typed: "$99.00" },
    ]));
    expect(sourceOf(program, fill)?.from.locator).toEqual(TOTAL);
  });

  it("the ambiguity survives number formatting (typed 100.00 / 99.00 against $100.00 / $99.00)", () => {
    const { program, fill } = onlyFill(copyOne("Amount", [
      { ...money("INV-5001", "$100.00", "$100.00"), typed: "100.00" },
      { ...money("INV-5002", "$90.00", "$99.00"), typed: "99.00" },
    ]));
    expect(sourceOf(program, fill)?.from).toMatchObject({ locator: TOTAL, transform: "number" });
  });

  it("run A is explained only by subtotal and run B only by total: NO locator explains both, so the step is unresolved", () => {
    const { program, fill } = onlyFill(copyOne("Amount", [
      { ...money("INV-5001", "$80.00", "$100.00"), typed: "$80.00" },
      { ...money("INV-5002", "$90.00", "$99.00"), typed: "$99.00" },
    ]));
    expect(extractsOf(program)).toEqual([]);
    expect(program.unresolved).toEqual([expect.objectContaining({ var: varOf(fill), valueA: "$80.00", valueB: "$99.00" })]);
    expect(program.confidence).toBeLessThan(THRESHOLD);
  });
});

describe("adversarial values.ts: currency, thousands separators, negative numbers", () => {
  for (const [typed, page] of pairs([
    ["1204.50", "$1,204.50"],
    ["1204.50", "USD 1,204.50"],
    ["1204.50", "1,204.50 USD"],
    ["1204.5", "1.204,50 €"],
    ["1204.50", `1${NBSP}204,50${NBSP}€`],
    ["1204.50", "  £1,204.50  "],
    ["15000", "$15,000.00"],
    ["1234567.89", "1,234,567.89"],
    ["0", "$0.00"],
    ["-1204.50", "-$1,204.50"],
    ["-1204.50", "$-1,204.50"],
    ["-1204.50", "($1,204.50)"],
    ["-1204.50", "(1.204,50 EUR)"],
    ["($1,204.50)", "-1204.50"],
  ])) {
    it(`typed ${JSON.stringify(typed)} is the number on the page ${JSON.stringify(page)}`, () => {
      expect(matchValue(typed, page)).toEqual({ mode: "number", transform: "number" });
    });
  }

  for (const [typed, page] of pairs([
    ["1204.50", "($1,204.50)"],
    ["1204.50", "-$1,204.50"],
    ["-1204.50", "$1,204.50"],
    ["5", `${MINUS}5`],
    ["5", "5-"],
    ["5", "5 CR"],
    ["1204", "$1,204.50"],
    ["1205", "$1,204.50"],
    ["1.204", "1,204"],
    ["1042", "INV-1042"],
    ["50", "50%"],
    ["12", "1,2"],
    ["2026", "2026-01-01"],
    ["20260903", "2026-09-03"],
  ])) {
    it(`typed ${JSON.stringify(typed)} is NOT explained by ${JSON.stringify(page)} (sign, magnitude and ids are never dropped)`, () => {
      expect(matchValue(typed, page)).toBeNull();
    });
  }

  it("a negative shown with a typographic minus (U+2212, common in rendered tables) is the same number", () => {
    expect(canonicalNumberString(`${MINUS}$1,204.50`)).toBe("-1204.50");
    expect(matchValue("-1204.50", `${MINUS}$1,204.50`)).toEqual({ mode: "number", transform: "number" });
  });

  it("the number transform keeps the sign and the source's decimals", () => {
    expect(applyTransform("($1,204.50)", "number")).toBe("-1204.50");
    expect(applyTransform("-$980.00", "number")).toBe("-980.00");
    expect(applyTransform("1.204,50 €", "number")).toBe("1204.50");
    expect(applyTransform("n/a", "number")).toBeNull();
  });
});

describe("adversarial synthesizeProgram: currency and negative numbers", () => {
  const ledger = (id: string, credit: string, debit: string): Item => ({
    id,
    facts: [fact("data-field", "credit", "Credit", credit), fact("data-field", "debit", "Debit", debit)],
  });

  it("resolves accounting negatives in both notations to one locator with the number transform", () => {
    const rows = [
      { ...ledger("INV-5101", "$10.00", "($1,204.50)"), typed: "-1204.50" },
      { ...ledger("INV-5102", "$20.00", "-$980.00"), typed: "-980" },
    ];
    const { program, fill } = onlyFill(copyOne("Balance", rows));
    expect(sourceOf(program, fill)?.from).toMatchObject({ locator: { by: "data-field", value: "debit" }, transform: "number" });
    expect(program.unresolved ?? []).toEqual([]);
    expect(program.confidence).toBeGreaterThanOrEqual(THRESHOLD);
    expect(replay(program, rows[0]!.facts)[varOf(fill) ?? ""]).toBe("-1204.50");
  });

  it("credit 50.00 and debit (50.00) on the same page: a typed -50.00 comes from the debit, never the credit", () => {
    const { program, fill } = onlyFill(copyOne("Amount", [
      { ...ledger("INV-5101", "$50.00", "($50.00)"), typed: "-50.00" },
      { ...ledger("INV-5102", "$20.00", "($20.00)"), typed: "-20.00" },
    ]));
    expect(sourceOf(program, fill)?.from.locator).toEqual({ by: "data-field", value: "debit" });
  });

  it("the page only shows the positive amount and the user typed it negated: unresolved, never a sign-dropping match", () => {
    const { program, fill } = onlyFill(copyOne("Amount", [
      { id: "INV-5101", facts: [fact("data-field", "total", "Total", "$50.00")], typed: "-50.00" },
      { id: "INV-5102", facts: [fact("data-field", "total", "Total", "$20.00")], typed: "-20.00" },
    ]));
    expect(extractsOf(program)).toEqual([]);
    expect(program.unresolved?.map((u) => u.var)).toEqual([varOf(fill)]);
  });
});

describe("adversarial values.ts and synthesis: dates in different formats", () => {
  for (const page of [
    "Sep 3, 2026", "September 3, 2026", "3 September 2026", "3 Sep 2026", "Thu, Sep 3rd 2026", "Thursday, September 3, 2026",
    "09/03/2026", "9/3/2026", "2026/09/03", "03.09.2026", "  Sep  3,  2026 ",
  ]) {
    it(`page text ${JSON.stringify(page)} is the typed 2026-09-03`, () => {
      expect(matchValue("2026-09-03", page)).toEqual({ mode: "date-iso", transform: "date-iso" });
      expect(applyTransform(page, "date-iso")).toBe("2026-09-03");
    });
  }

  for (const [typed, page] of pairs([
    ["2026-09-03", "Sep 4, 2026"],
    ["2026-09-03", "Sep 3, 2025"],
    ["2026-03-02", "Feb 30, 2026"],
    ["2026-03-01", "2026-02-29"],
    ["2026-09-03", "Septober 3, 2026"],
    ["2026-09-03", "Due Sep 3, 2026"],
  ])) {
    it(`typed ${JSON.stringify(typed)} is NOT explained by ${JSON.stringify(page)} (no rollover, no fuzzy months, no partial text)`, () => {
      expect(matchValue(typed, page)).toBeNull();
    });
  }

  it("dates are validated in code: impossible dates never parse", () => {
    for (const bad of ["Feb 30, 2026", "2026-02-29", "2026-13-01", "13/13/2026", "0/5/2026", "Sep 0, 2026", "2026-09-31"]) {
      expect(parseDateToIso(bad), bad).toBeNull();
    }
    expect(parseDateToIso("Feb 29, 2024")).toBe("2024-02-29");
  });

  it("each run shows the date in a different format: one locator with date-iso explains both", () => {
    const rows = [
      { id: "INV-5201", facts: [fact("data-field", "date", "Date", "Thu, Sep 3rd 2026")], typed: "2026-09-03" },
      { id: "INV-5202", facts: [fact("data-field", "date", "Date", "8 September 2026")], typed: "2026-09-08" },
    ];
    const { program, fill } = onlyFill(copyOne("Date", rows));
    expect(sourceOf(program, fill)?.from).toEqual({ pathPattern: "/invoices/:id", locator: { by: "data-field", value: "date" }, transform: "date-iso" });
    expect(replay(program, rows[1]!.facts)[varOf(fill) ?? ""]).toBe("2026-09-08");
  });

  it("two dates on the page (issued, due) that coincide in run A only: picks the one that explains both runs", () => {
    const dates = (id: string, issued: string, due: string): Item => ({
      id,
      facts: [fact("data-field", "issued", "Issued", issued), fact("data-field", "due", "Due", due)],
    });
    const { program, fill } = onlyFill(copyOne("Date", [
      { ...dates("INV-5201", "Sep 3, 2026", "Sep 3, 2026"), typed: "2026-09-03" },
      { ...dates("INV-5202", "Sep 8, 2026", "Oct 8, 2026"), typed: "2026-10-08" },
    ]));
    expect(sourceOf(program, fill)?.from.locator).toEqual({ by: "data-field", value: "due" });
  });

  it("unspecified, safest: the user typed dates as 09/03/2026 but the only date transform writes ISO, so replay must reproduce the user's own text or the step is flagged (unresolved or below threshold)", () => {
    const rows = [
      { id: "INV-5201", facts: [fact("data-field", "date", "Date", "Sep 3, 2026")], typed: "09/03/2026" },
      { id: "INV-5202", facts: [fact("data-field", "date", "Date", "Sep 8, 2026")], typed: "09/08/2026" },
    ];
    const { program, fill } = onlyFill(copyOne("Date", rows));
    const replayed = replay(program, rows[0]!.facts)[varOf(fill) ?? ""];
    expect(isFlagged(program, fill) || replayed === "09/03/2026", `would write ${replayed} where the user typed 09/03/2026`).toBe(true);
  });

  it("unspecified, safest: run B proves the page is day-first (15/03/2026), so a later 04/05/2026 must never be confidently written as April 5th", () => {
    const rows = [
      { id: "INV-5201", facts: [fact("data-field", "date", "Date", "03/03/2026")], typed: "2026-03-03" },
      { id: "INV-5202", facts: [fact("data-field", "date", "Date", "15/03/2026")], typed: "2026-03-15" },
    ];
    const { program, fill } = onlyFill(copyOne("Date", rows));
    const third = replay(program, [fact("data-field", "date", "Date", "04/05/2026")])[varOf(fill) ?? ""];
    expect(isFlagged(program, fill) || third !== "2026-04-05", `third item would be written as ${third}`).toBe(true);
  });
});

describe("adversarial values.ts and synthesis: surrounding whitespace", () => {
  for (const [typed, page] of pairs([
    ["  Northwind Traders ", "Northwind Traders"],
    ["Northwind Traders", "\n   Northwind   Traders\t"],
    [`Northwind${NBSP}Traders`, "Northwind Traders"],
    ["northwind traders", "Northwind Traders"],
  ])) {
    it(`typed ${JSON.stringify(typed)} matches ${JSON.stringify(page)} under trim`, () => {
      expect(matchValue(typed, page)).toEqual({ mode: "trim", transform: "trim" });
    });
  }

  for (const [typed, page] of pairs([
    ["North", "Northwind Traders"],
    ["Northwind Traders Inc", "Northwind Traders"],
    ["North wind Traders", "Northwind Traders"],
    ["", ""],
    ["   ", "   "],
    [" ", "Northwind Traders"],
    ["Northwind Traders", "  "],
  ])) {
    it(`typed ${JSON.stringify(typed)} is NOT explained by ${JSON.stringify(page)} (no substrings, empty never matches)`, () => {
      expect(matchValue(typed, page)).toBeNull();
    });
  }

  it("typed values with stray spaces resolve to the fact with the trim transform, and replay writes the clean text", () => {
    const rows = [
      { id: "INV-5301", facts: [fact("data-field", "vendor", "Vendor", "\n  Northwind Traders ")], typed: " Northwind Traders" },
      { id: "INV-5302", facts: [fact("data-field", "vendor", "Vendor", "Globex Corporation")], typed: "Globex Corporation  " },
    ];
    const { program, fill } = onlyFill(copyOne("Vendor", rows));
    expect(sourceOf(program, fill)?.from).toMatchObject({ locator: { by: "data-field", value: "vendor" }, transform: "trim" });
    expect(program.unresolved ?? []).toEqual([]);
    expect(program.confidence).toBeGreaterThanOrEqual(THRESHOLD);
    expect(replay(program, rows[0]!.facts)[varOf(fill) ?? ""]).toBe("Northwind Traders");
  });

  it("exact in run A, trailing space in run B: one mode (trim) explains both", () => {
    const { program, fill } = onlyFill(copyOne("Vendor", [
      { id: "INV-5301", facts: [fact("data-field", "vendor", "Vendor", "Northwind Traders")], typed: "Northwind Traders" },
      { id: "INV-5302", facts: [fact("data-field", "vendor", "Vendor", "Globex Corporation")], typed: "Globex Corporation " },
    ]));
    expect(sourceOf(program, fill)?.from).toMatchObject({ locator: { by: "data-field", value: "vendor" }, transform: "trim" });
  });

  it("unspecified, safest: 'Received' vs 'Received ' (same constant, stray space) is a constant or is flagged, never a page-fact variable", () => {
    const { program, fill } = onlyFill(copyOne("Status", [
      { id: "INV-5301", facts: [fact("data-field", "vendor", "Vendor", "Northwind Traders")], typed: "Received" },
      { id: "INV-5302", facts: [fact("data-field", "vendor", "Vendor", "Globex Corporation")], typed: "Received " },
    ]));
    expect(extractsOf(program)).toEqual([]);
    const constant = "const" in fill.value ? fill.value.const.trim() : null;
    expect(constant === "Received" || isFlagged(program, fill)).toBe(true);
  });
});

describe("adversarial synthesizeProgram: a variable value that no fact explains", () => {
  const vendorOnly = (id: string, vendor: string, extra: PageFact[] = []): Item => ({ id, facts: [fact("data-field", "vendor", "Vendor", vendor), ...extra] });

  function twoColumns(items: Item[], second: string[]): LoopProgram {
    const s = session(items, (tb, item, run) => {
      const vendor = item.facts[0]?.text ?? "";
      tb.navigate("/sheet").fillCell(run, 0, "Vendor", vendor).fillCell(run, 1, "PO number", second[run] ?? "");
    });
    const program = synthesizeProgram(s.loop, s.facts);
    if (!program) throw new Error("expected a program");
    return program;
  }

  it("is reported as unresolved with both values, stays a variable (never a constant), and lowers the program confidence", () => {
    const resolved = twoColumns([vendorOnly("INV-5401", "Northwind Traders"), vendorOnly("INV-5402", "Globex Corporation")], ["same", "same"]);
    const program = twoColumns([vendorOnly("INV-5401", "Northwind Traders"), vendorOnly("INV-5402", "Globex Corporation")], ["PO-7781", "PO-9912"]);
    const po = fillsOf(program)[1]!;
    expect("const" in po.value).toBe(false);
    expect(program.unresolved).toEqual([
      { stepIndex: program.steps.indexOf(po), var: varOf(po), label: po.target.label, valueA: "PO-7781", valueB: "PO-9912" },
    ]);
    expect(extractsOf(program).map((e) => e.var)).not.toContain(varOf(po));
    expect(program.confidence).toBeLessThan(resolved.confidence);
    expect(program.confidence).toBeLessThan(THRESHOLD);
    expect(program.confidence).toBeGreaterThanOrEqual(0);
    expectVarsAccountedFor(program);
  });

  it("the resolved sibling column is unaffected: vendor still comes from its fact", () => {
    const program = twoColumns([vendorOnly("INV-5401", "Northwind Traders"), vendorOnly("INV-5402", "Globex Corporation")], ["PO-7781", "PO-9912"]);
    expect(extractsOf(program)).toEqual([{ op: "extract", var: "vendor", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" } } }]);
    expect(fillsOf(program)[0]?.value).toEqual({ var: "vendor" });
    expect(varOf(fillsOf(program)[1]!)).not.toBe("vendor");
  });

  it("a fact that matches in run A only (coincidence) does not resolve it", () => {
    const program = twoColumns(
      [
        vendorOnly("INV-5401", "Northwind Traders", [fact("data-field", "reference", "PO number", "PO-7781")]),
        vendorOnly("INV-5402", "Globex Corporation", [fact("data-field", "reference", "PO number", "PO-0000")]),
      ],
      ["PO-7781", "PO-9912"],
    );
    expect(program.unresolved?.map((u) => [u.valueA, u.valueB])).toEqual([["PO-7781", "PO-9912"]]);
    expect(extractsOf(program).map((e) => e.from.locator.value)).toEqual(["vendor"]);
  });

  it("a fact that matches in run B only does not resolve it either", () => {
    const program = twoColumns(
      [
        vendorOnly("INV-5401", "Northwind Traders", [fact("data-field", "reference", "PO number", "PO-0000")]),
        vendorOnly("INV-5402", "Globex Corporation", [fact("data-field", "reference", "PO number", "PO-9912")]),
      ],
      ["PO-7781", "PO-9912"],
    );
    expect(program.unresolved?.map((u) => u.valueB)).toEqual(["PO-9912"]);
    expect(extractsOf(program).map((e) => e.from.locator.value)).toEqual(["vendor"]);
  });

  it("only facts visited EARLIER in the run count: a page opened after typing cannot be the source", () => {
    const customers: FactsByUrl = {
      [`${DEMO_ORIGIN}/customers/C-17`]: [fact("data-field", "name", "Customer", "Ada Lovelace")],
      [`${DEMO_ORIGIN}/customers/C-22`]: [fact("data-field", "name", "Customer", "Grace Hopper")],
    };
    const typed = ["Ada Lovelace", "Grace Hopper"];
    const ids = ["C-17", "C-22"];
    const s = session(
      [{ id: "INV-5401", facts: [] }, { id: "INV-5402", facts: [] }],
      (tb, _item, run) => tb.navigate("/sheet").fillCell(run, 0, "Customer", typed[run] ?? "").navigate(`/customers/${ids[run]}`).click("Mark reviewed"),
    );
    const program = synthesizeProgram(s.loop, { ...s.facts, ...customers });
    const { fill } = onlyFill(program);
    expect(extractsOf(program!)).toEqual([]);
    expect(program!.unresolved?.map((u) => u.var)).toEqual([varOf(fill)]);
  });

  it("two unresolved columns get distinct variables and both are reported", () => {
    const s = session([{ id: "INV-5401", facts: [] }, { id: "INV-5402", facts: [] }], (tb, _item, run) => {
      tb.navigate("/sheet").fillCell(run, 0, "Note", `first ${run}`).fillCell(run, 1, "Note", `second ${run}`).fillCell(run, 2, "Other", `x${run}`);
    }, {
      // Two columns share a header: keep them apart so noise filtering does not merge the consecutive cells.
      patch: (e) => (e.target?.cell?.col === 1 ? { ...e, target: { ...e.target, cell: { ...e.target.cell, colHeader: "Note (2)" } } } : e),
    });
    const program = synthesizeProgram(s.loop, s.facts);
    const vars = fillsOf(program!).map(varOf);
    expect(new Set(vars).size).toBe(3);
    expect(program!.unresolved?.map((u) => u.var)).toEqual(vars);
    expect(program!.unresolved?.map((u) => program!.steps[u.stepIndex])).toEqual(fillsOf(program!));
  });
});

describe("adversarial synthesizeProgram: a constant that happens to equal a page fact in both runs", () => {
  const withCurrency = (id: string, vendor: string): Item => ({
    id,
    facts: [fact("data-field", "currency", "Currency", "USD"), fact("data-field", "vendor", "Vendor", vendor)],
  });

  function run(items: Item[]): LoopProgram {
    const s = session(items, (tb, item, i) => {
      tb.navigate("/sheet").fillCell(i, 0, "Vendor", item.facts.find((f) => f.label === "Vendor")?.text ?? "").fillCell(i, 1, "Currency", "USD");
    });
    const program = synthesizeProgram(s.loop, s.facts);
    if (!program) throw new Error("expected a program");
    return program;
  }

  it("documented choice (docs/loops.md 3.3, first bullet): identical value stays a CONSTANT even though data-field=currency shows the same text on both pages", () => {
    const program = run([withCurrency("INV-5501", "Northwind Traders"), withCurrency("INV-5502", "Globex Corporation")]);
    const currency = fillsOf(program)[1]!;
    expect(currency.value).toEqual({ const: "USD" });
    expect(currency.target.cell).toEqual({ row: "next-empty", colHeader: "Currency" });
    expect(extractsOf(program).map((e) => e.from.locator.value)).toEqual(["vendor"]);
    expect(program.unresolved ?? []).toEqual([]);
  });

  it("the outcome does not depend on the order of the facts and is stable across calls", () => {
    const items = [withCurrency("INV-5501", "Northwind Traders"), withCurrency("INV-5502", "Globex Corporation")];
    const reversed = items.map((item) => ({ ...item, facts: [...item.facts].reverse() }));
    const a = run(items);
    expect(run(reversed).steps.filter((s) => s.op === "fill")).toEqual(fillsOf(a));
    expect(run(items)).toEqual(a);
  });
});

describe("adversarial synthesizeProgram: list index", () => {
  const baseline = synthesizeProgram(detectLoop(invoiceSession(2).events(), invoiceSession(2).now)!, invoiceFactsByUrl())!;

  function backwards(first: number, second: number): LoopProgram | null {
    const tb = new TraceBuilder().navigate("/invoices");
    handleInvoice(tb, first, 0).navigate("/invoices");
    handleInvoice(tb, second, 1);
    const loop = detectLoop(tb.events(), tb.now);
    if (!loop) throw new Error("expected a loop");
    return synthesizeProgram(loop, invoiceFactsByUrl());
  }

  it("going backwards (3 then 2) is a consistent stride of -1: nextIndex 1, remaining [1, 0], never more confident than stride 1", () => {
    const program = backwards(3, 2);
    expect(program?.iterator).toMatchObject({ stride: -1, nextIndex: 1, listSignature: INBOX_LIST });
    expect(planRemaining(program!, INVOICES.length)).toEqual([1, 0]);
    expect(planRemaining(program!, INVOICES.length, [1])).toEqual([0]);
    expect(program!.confidence).toBeLessThanOrEqual(baseline.confidence);
    expect(program!.unresolved ?? []).toEqual([]);
  });

  it("going backwards off the top of the list (1 then 0) leaves nothing to run and never plans a negative index", () => {
    const program = backwards(1, 0);
    if (program === null) return; // refusing is also safe
    expect(program.iterator.nextIndex).toBe(-1);
    expect(planRemaining(program, INVOICES.length)).toEqual([]);
    expect(describeIrreversible(program, planRemaining(program, INVOICES.length).length)).toEqual([]);
  });

  it("the same list index in both runs (a corrected redo of one item) has no iterator: null, never an invented one", () => {
    const item = { id: "INV-5601", facts: [fact("data-field", "vendor", "Vendor", "Initech")] };
    const typed = ["Initech", "Initech Inc"];
    const s = session([item, item], (tb, _item, run) => tb.navigate("/sheet").fillCell(0, 0, "Vendor", typed[run] ?? "").click("Save"), { indexes: [2, 2] });
    expect(synthesizeProgram(s.loop, s.facts)).toBeNull();
  });

  it("unspecified, safest: detection fires mid-cycle after the user already OPENED the third item; that unfinished item must not be silently skipped (plan includes it, or the program is refused or below threshold)", () => {
    const tb = new TraceBuilder();
    const open = (i: number): TraceBuilder => tb.navigate("/invoices").clickItem(INBOX_LIST, i, INVOICES[i]!.id).navigate(`/invoices/${INVOICES[i]!.id}`).navigate("/sheet");
    for (const i of [0, 1]) open(i).fillCell(i, 0, "Vendor", INVOICES[i]!.vendor).click("Save");
    open(2);
    const loop = detectLoop(tb.events(), tb.now);
    expect(loop?.runB.some((e) => e.target?.list?.index === 2)).toBe(true);
    const program = synthesizeProgram(loop!, invoiceFactsByUrl());
    if (program === null || program.confidence < THRESHOLD) return;
    expect(planRemaining(program, INVOICES.length), `nextIndex ${program.iterator.nextIndex} at confidence ${program.confidence}`).toContain(2);
  });

  it("two list clicks per run that advance by different strides are not one iterator: null", () => {
    const tb = new TraceBuilder();
    [0, 1].forEach((run) => {
      tb.navigate("/invoices").clickItem(INBOX_LIST, run, `INV-100${run + 1}`).navigate(`/invoices/INV-100${run + 1}`);
      tb.input("Note", "ok").navigate("/invoices").clickItem(INBOX_LIST, 10 + run * 3, `INV-20${run}0`).navigate(`/invoices/INV-20${run}0`).click("Archive");
    });
    const loop = detectLoop(tb.events(), tb.now);
    expect(loop).not.toBeNull();
    expect(synthesizeProgram(loop!, {})).toBeNull();
  });
});

describe("adversarial synthesizeProgram: grid cell rows", () => {
  const items: Array<Item & { typed: string }> = [
    { id: "INV-5701", facts: [fact("data-field", "vendor", "Vendor", "Northwind Traders")], typed: "Northwind Traders" },
    { id: "INV-5702", facts: [fact("data-field", "vendor", "Vendor", "Globex Corporation")], typed: "Globex Corporation" },
  ];

  function withRows(rowA: number, rowB: number): { program: LoopProgram; fill: FillStep } {
    const rows = [rowA, rowB];
    const s = session(items, (tb, item, run) => tb.navigate("/sheet").fillCell(rows[run] ?? 0, 0, "Vendor", items[run]?.typed ?? item.id).click("Save"));
    return onlyFill(synthesizeProgram(s.loop, s.facts));
  }

  it("row advanced by one (from any starting row): append-row, column fixed by header, no pinned signature, full confidence", () => {
    const { program, fill } = withRows(7, 8);
    expect(fill.target).toEqual({ label: "Vendor", kind: "text", cell: { row: "next-empty", colHeader: "Vendor" } });
    expect(program.confidence).toBe(1);
  });

  it("the same row in both runs is NOT an append: no next-empty claim, the cell stays pinned by signature", () => {
    const { fill } = withRows(0, 0);
    expect(fill.target.cell).toBeUndefined();
    expect(fill.target.signature).toBe("cell:0:0");
    expect(fill.value).toEqual({ var: "vendor" });
  });

  it("doc 3.3 says append-row is for a row that 'advanced by one': rows going BACKWARDS (5 then 4) must not yield a confident next-empty fill", () => {
    const { program, fill } = withRows(5, 4);
    const claimsAppend = fill.target.cell?.row === "next-empty";
    expect(!claimsAppend || program.confidence < THRESHOLD, `next-empty at confidence ${program.confidence}`).toBe(true);
  });

  it("doc 3.3 says append-row is for a row that 'advanced by one': skipping a row (0 then 2) must not yield a confident next-empty fill", () => {
    const { program, fill } = withRows(0, 2);
    const claimsAppend = fill.target.cell?.row === "next-empty";
    expect(!claimsAppend || program.confidence < THRESHOLD, `next-empty at confidence ${program.confidence}`).toBe(true);
  });
});

describe("adversarial synthesizeProgram: locked steps are preserved with descriptions", () => {
  const plain = (id: string): Item => ({ id, facts: [] });
  const two = [plain("INV-5801"), plain("INV-5802")];

  function expectIrreversibleConsistent(p: LoopProgram): void {
    const lockedIndexes = p.steps.flatMap((s, i) => (s.op === "click" && s.locked ? [i] : []));
    expect(p.irreversible.map((x) => x.stepIndex)).toEqual(lockedIndexes);
    for (const x of p.irreversible) expect(x.description.trim()).not.toBe("");
  }

  it("locked in only ONE of the two runs is still locked (when in doubt, lock)", () => {
    const s = session(two, (tb, _item, run) => tb.input("Note", "ok").click("Archive", { locked: run === 1 }));
    const program = synthesizeProgram(s.loop, s.facts)!;
    expect(clicksOf(program)).toEqual([expect.objectContaining({ locked: true, target: expect.objectContaining({ label: "Archive" }) })]);
    expect(program.irreversible).toEqual([{ stepIndex: program.steps.length - 1, description: "Archive" }]);
  });

  it("two locked actions per item are both listed, in order, with step indexes that point at them (after extract hoisting)", () => {
    const s = session(
      [{ id: "INV-5801", facts: [fact("data-field", "vendor", "Vendor", "Northwind Traders")] }, { id: "INV-5802", facts: [fact("data-field", "vendor", "Vendor", "Globex Corporation")] }],
      (tb, item) => tb.click("Delete draft", { locked: true }).input("Reply", item.facts[0]?.text ?? "").click("Send", { locked: true }),
    );
    const program = synthesizeProgram(s.loop, s.facts)!;
    expect(program.irreversible.map((x) => x.description)).toEqual(["Delete draft", "Send"]);
    expect(program.irreversible.map((x) => program.steps[x.stepIndex])).toEqual(clicksOf(program));
    expectIrreversibleConsistent(program);
    expectVarsAccountedFor(program);
    expect(describeIrreversible(program, 48)).toEqual(["Delete draft x 48", "Send x 48"]);
  });

  it("a locked icon button without an accessible name still gets a non-empty description", () => {
    const s = session(two, (tb) => tb.input("Note", "ok").click("", { locked: true, signature: "button#trash" }));
    const program = synthesizeProgram(s.loop, s.facts)!;
    expect(program.irreversible).toHaveLength(1);
    expectIrreversibleConsistent(program);
  });

  it("a locked button whose signature embeds the item id keeps its lock and is not pinned to run A's signature", () => {
    const s = session(two, (tb, item) => tb.input("Note", "ok").click(REPLY_LABEL, { locked: true, signature: `button#reply-${item.id}` }));
    const program = synthesizeProgram(s.loop, s.facts)!;
    const click = clicksOf(program)[0]!;
    expect(click.locked).toBe(true);
    expect(click.target.signature).toBeUndefined();
    expect(click.target.label).toBe(REPLY_LABEL);
  });

  it("an unlocked click stays unlocked and is not listed", () => {
    const s = session(two, (tb) => tb.input("Note", "ok").click("Next"));
    const program = synthesizeProgram(s.loop, s.facts)!;
    expect(clicksOf(program).map((c) => c.locked)).toEqual([false]);
    expect(program.irreversible).toEqual([]);
  });

  it("a bare submit event (Enter in a field, no button click recorded) is a locked, listed step", () => {
    const s = session(two, (tb) => tb.input("Reply", "Received").submit("Reply form"));
    const program = synthesizeProgram(s.loop, s.facts)!;
    expect(clicksOf(program)).toEqual([expect.objectContaining({ locked: true })]);
    expect(program.irreversible).toEqual([{ stepIndex: program.steps.length - 1, description: "Reply form" }]);
  });

  it("a locked click and a LATER submit on a different page are two irreversible effects: the confirmation must list both", () => {
    const s = session(two, (tb, item) => tb.click("Approve", { locked: true }).navigate(`/invoices/${item.id}/receipt`).submit("Send receipt form"));
    const program = synthesizeProgram(s.loop, s.facts)!;
    expect(program.irreversible.map((x) => x.description)).toEqual(["Approve", "Send receipt form"]);
    expectIrreversibleConsistent(program);
  });

  it("a locked target on a non-click event (auto-saving select inside [data-ghost-lock]) is listed as irreversible, or the program is refused", () => {
    const s = session(two, (tb) => tb.input("Note", "ok").input("Status", "Paid", { kind: "select", locked: true }).click("Next"), {
      patch: (e) => (e.target?.label === "Status" ? { ...e, type: "select" } : e),
    });
    const program = synthesizeProgram(s.loop, s.facts);
    if (program === null) return;
    const at = program.steps.findIndex((step) => step.op === "fill" && step.target.label === "Status");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(program.irreversible.map((x) => x.stepIndex)).toContain(at);
  });

  it("the canonical loop's single confirmation line counts exactly the remaining items", () => {
    const tb = invoiceSession(2);
    const program = synthesizeProgram(detectLoop(tb.events(), tb.now)!, invoiceFactsByUrl())!;
    expect(describeIrreversible(program, planRemaining(program, INVOICES.length).length)).toEqual([`${REPLY_LABEL} x 2`]);
    expect(describeIrreversible(program, planRemaining(program, INVOICES.length, [3]).length)).toEqual([`${REPLY_LABEL} x 1`]);
    expect(describeIrreversible(program, planRemaining(program, 2).length)).toEqual([]);
  });
});

describe("adversarial planRemaining", () => {
  function programWith(nextIndex: number, stride: number): LoopProgram {
    return {
      id: "p", name: "p", confidence: 1, irreversible: [{ stepIndex: 1, description: "Send" }],
      iterator: { origin: DEMO_ORIGIN, pathPattern: "/invoices", listSignature: INBOX_LIST, stride, nextIndex },
      steps: [{ op: "open-item" }, { op: "click", target: { label: "Send", kind: "button" }, locked: true }],
    };
  }

  it("total smaller than, or equal to, nextIndex: nothing remains", () => {
    expect(planRemaining(programWith(5, 1), 3)).toEqual([]);
    expect(planRemaining(programWith(5, 1), 5)).toEqual([]);
    expect(planRemaining(programWith(5, 1), 6)).toEqual([5]);
  });

  it("degenerate totals never produce work (0, negative, NaN, Infinity)", () => {
    for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(planRemaining(programWith(0, 1), total), String(total)).toEqual([]);
    }
  });

  it("skips handled indexes given as an array with duplicates, a Set, or a generator, and ignores out-of-range ones", () => {
    const program = programWith(2, 1);
    expect(planRemaining(program, 8, [3, 3, 5, 99, -4, 0])).toEqual([2, 4, 6, 7]);
    expect(planRemaining(program, 8, new Set([2, 7]))).toEqual([3, 4, 5, 6]);
    function* handled(): Generator<number> { yield 4; yield 6; }
    expect(planRemaining(program, 8, handled())).toEqual([2, 3, 5, 7]);
  });

  it("everything already handled: nothing remains, and the confirmation lists nothing", () => {
    const program = programWith(2, 1);
    expect(planRemaining(program, 5, [2, 3, 4])).toEqual([]);
    expect(describeIrreversible(program, 0)).toEqual([]);
  });

  it("never revisits the two items the user did by hand, even when they are not in handledIndexes", () => {
    const remaining = planRemaining(programWith(2, 1), 6);
    expect(remaining).not.toContain(0);
    expect(remaining).not.toContain(1);
  });

  it("negative stride walks down to 0 and stops; a stride of 0, NaN or a nextIndex outside the list yields nothing (and terminates)", () => {
    expect(planRemaining(programWith(3, -1), 50, [2])).toEqual([3, 1, 0]);
    expect(planRemaining(programWith(7, -3), 50)).toEqual([7, 4, 1]);
    expect(planRemaining(programWith(-1, -1), 50)).toEqual([]);
    expect(planRemaining(programWith(-1, 1), 50).every((i) => i >= 0)).toBe(true);
    expect(planRemaining(programWith(2, 0), 50)).toEqual([]);
    expect(planRemaining(programWith(2, Number.NaN), 50).length).toBeLessThanOrEqual(1);
  });

  it("is pure: the program and the handled set are not modified", () => {
    const program = programWith(2, 2);
    const snapshot = JSON.stringify(program);
    const handled = new Set([4]);
    expect(planRemaining(program, 9, handled)).toEqual([2, 6, 8]);
    expect(JSON.stringify(program)).toBe(snapshot);
    expect([...handled]).toEqual([4]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const action = (label: string, kind: EpisodicAction["kind"] = "button"): EpisodicAction => ({
  type: "click", targetShape: `${label}#${kind}`, label, signature: `${kind}:${label}`, kind, locked: false,
});
const button = (label: string, locked = false): NextCandidate => ({ id: `button:${label}`, kind: "button", label, locked });

describe("adversarial EpisodicStore: LRU bound", () => {
  it("never grows past the default cap of 300, keeping the most recent pairs", () => {
    expect(EPISODIC_MAX_PAIRS).toBe(300);
    const store = new EpisodicStore();
    for (let i = 0; i < 1000; i++) store.add(`state ${i}`, action(`Button ${i}`));
    expect(store.size).toBe(300);
    expect(store.toJSON().pairs).toHaveLength(300);
    expect(store.predict("state 699", [button("Button 699")]).candidateId).toBe("none");
    expect(store.predict("state 700", [button("Button 700")]).candidateId).toBe("button:Button 700");
    expect(store.predict("state 999", [button("Button 999")]).candidateId).toBe("button:Button 999");
  });

  it("re-observing a pair protects it from eviction and keeps its count", () => {
    const store = new EpisodicStore(3);
    store.add("a", action("A"));
    store.add("b", action("B"));
    store.add("c", action("C"));
    store.add("a", action("A"));
    store.add("d", action("D"));
    expect(store.size).toBe(3);
    expect(store.retrieve("b")).toEqual([]);
    expect(store.retrieve("a")).toEqual([expect.objectContaining({ summary: "a", count: 2 })]);
  });

  it("an evicted pair starts over at one observation (0.75, not 0.9) when it is seen again", () => {
    const store = new EpisodicStore(2);
    store.add("a", action("A"));
    store.add("a", action("A"));
    store.add("b", action("B"));
    store.add("c", action("C"));
    store.add("a", action("A"));
    expect(store.predict("a", [button("A")])).toEqual({ candidateId: "button:A", confidence: 0.75 });
  });

  it("restoring a snapshot that holds more pairs than the cap keeps the most recent ones and stays bounded", () => {
    const pairs: EpisodicPair[] = Array.from({ length: 10 }, (_, i) => ({ summary: `s${i}`, action: action(`B${i}`), count: 1 }));
    const store = EpisodicStore.fromJSON({ max: 4, pairs });
    expect(store.toJSON().pairs.map((p) => p.summary)).toEqual(["s6", "s7", "s8", "s9"]);
    store.add("s10", action("B10"));
    expect(store.toJSON().pairs.map((p) => p.summary)).toEqual(["s7", "s8", "s9", "s10"]);
  });

  it("eviction order survives a JSON round trip", () => {
    const store = new EpisodicStore(3);
    for (const s of ["a", "b", "c"]) store.add(s, action(s.toUpperCase()));
    store.add("a", action("A"));
    const restored = EpisodicStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
    restored.add("d", action("D"));
    expect(restored.toJSON().pairs.map((p) => [p.summary, p.count])).toEqual([["c", 1], ["a", 2], ["d", 1]]);
  });

  it("a cap of 0 or less still holds at most one pair instead of growing without bound", () => {
    for (const max of [0, -5]) {
      const store = new EpisodicStore(max);
      for (let i = 0; i < 10; i++) store.add(`s${i}`, action(`B${i}`));
      expect(store.size).toBeLessThanOrEqual(1);
    }
  });

  it("the bound cannot be defeated by a NaN cap (Math.max(1, NaN) is NaN, and length > NaN is never true)", () => {
    const store = new EpisodicStore(Number.NaN);
    for (let i = 0; i < 400; i++) store.add(`s${i}`, action(`B${i}`));
    expect(store.size).toBeLessThanOrEqual(EPISODIC_MAX_PAIRS);
  });

  it("unspecified, safest: a corrupt snapshot (missing or null max, as JSON turns NaN into null) restores the default bound, not a cap of 1 and not an unbounded store", () => {
    const pairs: EpisodicPair[] = Array.from({ length: 5 }, (_, i) => ({ summary: `s${i}`, action: action(`B${i}`), count: 1 }));
    const missing = EpisodicStore.fromJSON({ pairs } as unknown as { max: number; pairs: EpisodicPair[] });
    expect([missing.max, missing.size]).toEqual([EPISODIC_MAX_PAIRS, 5]);
    const corrupt = JSON.parse(JSON.stringify({ max: Number.NaN, pairs })) as { max: number; pairs: EpisodicPair[] };
    const store = EpisodicStore.fromJSON(corrupt);
    expect([store.max, store.size]).toEqual([EPISODIC_MAX_PAIRS, 5]);
  });

  it("callers cannot corrupt the store through objects they passed in or got back", () => {
    const store = new EpisodicStore();
    const mine = action("Send");
    store.add("s", mine);
    mine.label = "Changed after add";
    const got = store.retrieve("s")[0]!;
    got.count = 99;
    got.action.label = "Changed after retrieve";
    store.toJSON().pairs[0]!.count = 42;
    expect(store.retrieve("s")).toEqual([{ summary: "s", action: action("Send"), count: 1 }]);
    expect(store.predict("s", [button("Send")]).confidence).toBe(0.75);
  });
});

describe("adversarial EpisodicStore: retrieve ranking", () => {
  const STATE = "/mail/:id > click|/mail|LIST(ul#mail) > navigate|/mail/:id|";

  it("an exact match seen once outranks a near match seen 100 times and added later", () => {
    const store = new EpisodicStore();
    store.add(STATE, action("Exact"));
    for (let i = 0; i < 100; i++) store.add(`${STATE} > click|/mail/:id|Archive#button`, action("Near"));
    expect(store.retrieve(STATE).map((p) => p.action.label)).toEqual(["Exact", "Near"]);
    expect(store.retrieve(STATE, 1).map((p) => p.action.label)).toEqual(["Exact"]);
  });

  it("the same tokens in a different order are NOT the same state: ranked after the exact pair and never predicted from", () => {
    const store = new EpisodicStore();
    const reordered = "/mail/:id > navigate|/mail/:id| > click|/mail|LIST(ul#mail)";
    store.add(reordered, action("Reordered"));
    expect(store.predict(STATE, [button("Reordered")])).toEqual({ candidateId: "none", confidence: 0 });
    store.add(STATE, action("Exact"));
    store.add(reordered, action("Reordered"));
    expect(store.retrieve(STATE).map((p) => p.action.label)).toEqual(["Exact", "Reordered"]);
    expect(store.predict(STATE, [button("Reordered"), button("Exact")])).toEqual({ candidateId: "button:Exact", confidence: 0.75 });
  });

  it("among exact matches the most frequent action comes first, then the most recent", () => {
    const store = new EpisodicStore();
    store.add("s", action("Old once"));
    store.add("s", action("Twice"));
    store.add("s", action("Twice"));
    store.add("s", action("New once"));
    expect(store.retrieve("s").map((p) => p.action.label)).toEqual(["Twice", "New once", "Old once"]);
  });

  it("non-exact pairs are ordered by Jaccard similarity, ties by recency, and frequency does not beat similarity", () => {
    const store = new EpisodicStore();
    for (let i = 0; i < 9; i++) store.add("alpha zeta", action("Far but frequent"));
    store.add("alpha beta gamma zeta", action("Close, older"));
    store.add("alpha beta gamma eta", action("Close, newer"));
    store.add("alpha beta gamma delta epsilon", action("Closer"));
    expect(store.retrieve("alpha beta gamma delta").map((p) => p.action.label)).toEqual(["Closer", "Close, newer", "Close, older", "Far but frequent"]);
  });

  it("pairs that share nothing with the state are never returned, whatever k is; k of 0 or less returns nothing", () => {
    const store = new EpisodicStore();
    store.add("alpha beta", action("A"));
    store.add("gamma delta", action("B"));
    expect(store.retrieve("alpha", 50).map((p) => p.action.label)).toEqual(["A"]);
    expect(store.retrieve("alpha", 0)).toEqual([]);
    expect(store.retrieve("alpha", -3)).toEqual([]);
    expect(store.retrieve("")).toEqual([]);
  });

  it("returns the top 5 by default with every exact match ahead of every similar one", () => {
    const store = new EpisodicStore();
    for (let i = 0; i < 4; i++) store.add(`s extra${i}`, action(`Similar ${i}`));
    for (let i = 0; i < 3; i++) store.add("s", action(`Exact ${i}`));
    for (let i = 4; i < 8; i++) store.add(`s extra${i}`, action(`Similar ${i}`));
    const got = store.retrieve("s");
    expect(got).toHaveLength(5);
    expect(got.slice(0, 3).every((p) => p.summary === "s")).toBe(true);
    expect(got.slice(3).every((p) => p.summary !== "s")).toBe(true);
  });
});

describe("adversarial predictFromMemory: thresholds", () => {
  const pair = (summary: string, a: EpisodicAction, count: number): EpisodicPair => ({ summary, action: a, count });
  const candidates = [button("Pick slot"), button("Send", true), button("Archive")];

  it("0.75 after exactly one observation, 0.9 after two, and still exactly 0.9 after fifty", () => {
    expect(predictFromMemory("s", candidates, [pair("s", action("Pick slot"), 1)])).toEqual({ candidateId: "button:Pick slot", confidence: 0.75 });
    expect(predictFromMemory("s", candidates, [pair("s", action("Pick slot"), 2)])).toEqual({ candidateId: "button:Pick slot", confidence: 0.9 });
    expect(predictFromMemory("s", candidates, [pair("s", action("Pick slot"), 50)])).toEqual({ candidateId: "button:Pick slot", confidence: 0.9 });
  });

  it("both confidences clear the default 0.7 threshold; a tie never does, at any count", () => {
    expect(0.75).toBeGreaterThan(THRESHOLD);
    for (const count of [1, 2, 50]) {
      const tie = predictFromMemory("s", candidates, [pair("s", action("Pick slot"), count), pair("s", action("Archive"), count)]);
      expect(tie.confidence, `tie at count ${count}`).toBeLessThan(THRESHOLD);
    }
    const threeWay = predictFromMemory("s", candidates, [pair("s", action("Pick slot"), 3), pair("s", action("Archive"), 3), pair("s", action("Send"), 1)]);
    expect(threeWay.confidence).toBeLessThan(THRESHOLD);
  });

  it("nothing to propose is exactly { none, 0 }: empty memory, no candidates, unseen state, target not on the page", () => {
    const none = { candidateId: "none", confidence: 0 };
    expect(predictFromMemory("s", candidates, [])).toEqual(none);
    expect(predictFromMemory("s", [], [pair("s", action("Pick slot"), 9)])).toEqual(none);
    expect(predictFromMemory("s", candidates, [pair("other", action("Pick slot"), 9)])).toEqual(none);
    expect(predictFromMemory("s", candidates, [pair("s", action("Gone"), 9)])).toEqual(none);
  });

  it("a merely similar state never predicts, however often it was seen", () => {
    const memory = [pair("s > click|/mail|Archive#button", action("Pick slot"), 100), pair("S", action("Pick slot"), 100), pair("s ", action("Pick slot"), 100)];
    expect(predictFromMemory("s", candidates, memory)).toEqual({ candidateId: "none", confidence: 0 });
  });

  it("the label fallback needs a unique, whole-label, same-kind match: substrings, other kinds and duplicates give none", () => {
    const stale = (label: string, kind: EpisodicAction["kind"] = "button"): EpisodicAction => ({ ...action(label, kind), signature: "stale-signature" });
    const none = { candidateId: "none", confidence: 0 };
    expect(predictFromMemory("s", [button("Reply all")], [pair("s", stale("Reply"), 5)])).toEqual(none);
    expect(predictFromMemory("s", [{ id: "l1", kind: "link", label: "Reply", locked: false }], [pair("s", stale("Reply"), 5)])).toEqual(none);
    expect(predictFromMemory("s", [{ ...button("Reply"), id: "b1" }, { ...button("Reply"), id: "b2" }], [pair("s", stale("Reply"), 5)])).toEqual(none);
    expect(predictFromMemory("s", [{ ...button(""), id: "b1" }], [pair("s", stale(""), 5)])).toEqual(none);
    expect(predictFromMemory("s", [{ ...button("  reply "), id: "b1" }], [pair("s", stale("Reply"), 1)])).toEqual({ candidateId: "b1", confidence: 0.75 });
  });

  it("an action that is no longer on the page does not block or boost the one that is", () => {
    const memory = [pair("s", action("Gone"), 7), pair("s", action("Pick slot"), 1)];
    expect(predictFromMemory("s", candidates, memory)).toEqual({ candidateId: "button:Pick slot", confidence: 0.75 });
  });

  it("through the store: once is 0.75, twice is 0.9, and a competing action seen equally often drops below threshold", () => {
    const store = new EpisodicStore();
    store.add("s", action("Pick slot"));
    expect(store.predict("s", candidates).confidence).toBe(0.75);
    store.add("s", action("Pick slot"));
    expect(store.predict("s", candidates).confidence).toBe(0.9);
    store.add("s", action("Archive"));
    store.add("s", action("Archive"));
    expect(store.predict("s", candidates).confidence).toBeLessThan(THRESHOLD);
  });
});
