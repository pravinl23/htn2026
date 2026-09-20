/**
 * Adversarial tests for detectLoop, filterNoise, shape keys and path patterns.
 * Expectations come from docs/loops.md (sections 1, 3.1, 3.2). Where the doc is silent the test name says
 * "UNSPECIFIED" and asserts the safest behavior for a product where a wrong ghost is worse than no ghost.
 */
import { describe, expect, it } from "vitest";
import { LOOP_WINDOW_MS, detectLoop, filterNoise, normalizeUrl, pathPatternOf, shapeKey, shapeKeys } from "../src";
import type { LoopCandidate, TraceEvent } from "../src";
import {
  DEMO_ORIGIN,
  INBOX_LIST,
  INVOICES,
  REPLY_LABEL,
  SHEET_COLUMNS,
  TraceBuilder,
  handleInvoice,
  invoicePath,
  makeTarget,
  typedCells,
} from "./helpers/traceBuilder";
import type { Invoice } from "./helpers/traceBuilder";

// ---- helpers ----

const INVOICE_KEYS = [
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
];

/** Twelve deterministic invoices so sessions can run longer than the four canonical ones. */
const MANY: Invoice[] = Array.from({ length: 12 }, (_, i) => ({
  id: `INV-${2001 + i}`,
  vendor: `Vendor ${String.fromCharCode(65 + i)}`,
  date: `Oct ${i + 1}, 2026`,
  total: `$${100 + i}.00`,
  typedDate: `2026-10-${String(i + 1).padStart(2, "0")}`,
  typedTotal: `${100 + i}`,
}));

function lastOf<T>(xs: readonly T[]): T | undefined {
  return xs[xs.length - 1];
}

function listIndexes(run: readonly TraceEvent[]): number[] {
  return run.flatMap((e) => (e.target?.list ? [e.target.list.index] : []));
}

function inputValues(run: readonly TraceEvent[]): Array<string | undefined> {
  return run.filter((e) => e.type === "input").map((e) => e.value);
}

/** Lands on the inbox before every item: one run is exactly INVOICE_KEYS. Sheet rows advance by one per run. */
function session(indexes: readonly number[], invoices: Invoice[] = INVOICES, tb: TraceBuilder = new TraceBuilder()): TraceBuilder {
  indexes.forEach((index, row) => handleInvoice(tb.navigate("/invoices"), index, row, invoices));
  return tb;
}

function detect(tb: TraceBuilder): LoopCandidate | null {
  return detectLoop(tb.events(), tb.now);
}

/** Invariants of docs/loops.md 3.2 that hold for every candidate, whatever the scenario. */
function expectWellFormed(loop: LoopCandidate): void {
  expect(loop.length).toBeGreaterThanOrEqual(3);
  expect(loop.runA).toHaveLength(loop.length);
  expect(loop.runB).toHaveLength(loop.length);
  expect(shapeKeys(loop.runA)).toEqual(shapeKeys(loop.runB));
  expect([...loop.runA, ...loop.runB].filter((e) => e.synthetic === true)).toEqual([]);
}

function expectInvoiceLoop(loop: LoopCandidate | null, indexA: number, indexB: number, invoices: Invoice[] = INVOICES): void {
  expect(loop).not.toBeNull();
  if (!loop) return;
  expectWellFormed(loop);
  expect(shapeKeys(loop.runA)).toEqual(INVOICE_KEYS);
  expect(listIndexes(loop.runA)).toEqual([indexA]);
  expect(listIndexes(loop.runB)).toEqual([indexB]);
  expect(inputValues(loop.runA)).toEqual(typedCells(invoices[indexA]!));
  expect(inputValues(loop.runB)).toEqual(typedCells(invoices[indexB]!));
}

/** For noise the doc does not promise to tolerate: staying silent is fine, a distorted candidate is not. */
function expectNullOrInvoiceLoop(loop: LoopCandidate | null, indexA: number, indexB: number): void {
  if (loop !== null) expectInvoiceLoop(loop, indexA, indexB);
}

const MAIL_LIST = "ul#mail";

/** A loop of exactly three steps: open the mail, land on it, archive it. */
function archiveMail(tb: TraceBuilder, index: number): TraceBuilder {
  return tb.at("/mail").clickItem(MAIL_LIST, index, `mail-${index}`).navigate(`/mail/${index + 100}`).click("Archive");
}

const LEAD_LIST = "table#leads";
const LEAD_FIELDS = ["First name", "Last name", "Company", "Title", "Work phone", "City", "Country", "Notes"];

/** A loop of exactly twelve steps: open a lead, fill eight fields, save, go back to the list. */
function enterLead(tb: TraceBuilder, index: number): TraceBuilder {
  tb.at("/leads").clickItem(LEAD_LIST, index, `lead-${index}`).navigate(`/leads/${index + 500}`);
  LEAD_FIELDS.forEach((field) => tb.input(field, `${field} of lead ${index}`));
  return tb.click("Save").navigate("/leads");
}

/** The two-step unit A B: click a mail, click Archive (no navigation in between). */
function abab(reps: number): TraceBuilder {
  const tb = new TraceBuilder().at("/mail");
  for (let i = 0; i < reps; i++) tb.clickItem(MAIL_LIST, i, `mail-${i}`).click("Archive");
  return tb;
}

// ---- detectLoop: documented noise ----

describe("detectLoop: noise the doc promises to tolerate (3.2)", () => {
  it("ignores scroll/focus clicks on the page body before, between, inside and after the runs", () => {
    const tb = new TraceBuilder().clickBody().clickBody();
    session([0], INVOICES, tb).clickBody().clickBody().clickBody().navigate("/invoices").clickBody();
    const inv = INVOICES[1]!;
    tb.clickItem(INBOX_LIST, 1, inv.id).clickBody().navigate(invoicePath(inv)).clickBody().navigate("/sheet").clickBody();
    typedCells(inv).forEach((value, col) => tb.fillCell(1, col, SHEET_COLUMNS[col] ?? "", value).clickBody());
    tb.navigate(invoicePath(inv)).clickBody().click(REPLY_LABEL, { locked: true }).clickBody().clickBody();
    expectInvoiceLoop(detect(tb), 0, 1);
  });

  it("treats a click on an unlabelled non-interactive element (empty or whitespace label, kind other) as a focus-only click", () => {
    const tb = session([0]);
    tb.click("", { kind: "other", signature: "div.page" }).click("   ", { kind: "other", signature: "main" });
    session([1], INVOICES, tb);
    // session([1]) writes into row 0 again: rows are irrelevant to detection, values and list index differ.
    expectInvoiceLoop(detect(tb), 0, 1);
  });

  it("a body click between a typo and its correction does not stop the two edits from collapsing (last value wins)", () => {
    const tb = session([0]).navigate("/invoices");
    const inv = INVOICES[1]!;
    tb.clickItem(INBOX_LIST, 1, inv.id).navigate(invoicePath(inv)).navigate("/sheet");
    tb.fillCell(1, 0, "Vendor", "Globx").clickBody().fillCell(1, 0, "Vendor", inv.vendor);
    tb.fillCell(1, 1, "Invoice #", inv.id).fillCell(1, 2, "Date", inv.typedDate).fillCell(1, 3, "Total", inv.typedTotal);
    tb.navigate(invoicePath(inv)).click(REPLY_LABEL, { locked: true });
    expectInvoiceLoop(detect(tb), 0, 1);
  });

  it("drops a rapid double click (within 500 ms) on the list item in run A and on the locked button in run B", () => {
    const first = INVOICES[0]!;
    const tb = new TraceBuilder().navigate("/invoices");
    tb.clickItem(INBOX_LIST, 0, first.id).wait(-1300).clickItem(INBOX_LIST, 0, first.id);
    tb.navigate(invoicePath(first)).navigate("/sheet");
    typedCells(first).forEach((value, col) => tb.fillCell(0, col, SHEET_COLUMNS[col] ?? "", value));
    tb.navigate(invoicePath(first)).click(REPLY_LABEL, { locked: true });
    session([1], INVOICES, tb).wait(-1200).click(REPLY_LABEL, { locked: true });
    expectInvoiceLoop(detect(tb), 0, 1);
  });

  it("drops a slow second click on the same button too, because consecutive duplicate keys are dropped", () => {
    const tb = session([0]).wait(4000).click(REPLY_LABEL, { locked: true });
    session([1], INVOICES, tb);
    expectInvoiceLoop(detect(tb), 0, 1);
  });

  it("UNSPECIFIED which duplicate survives: a misclick on the wrong list item corrected right away must keep the LAST click, the item the user actually worked on", () => {
    const tb = session([0]).navigate("/invoices").clickItem(INBOX_LIST, 3, INVOICES[3]!.id);
    handleInvoice(tb, 1, 1);
    expectInvoiceLoop(detect(tb), 0, 1);
  });

  it("no-op events never count toward the minimum length: [item, body click, Archive] x 2 is a 2-step loop, so null", () => {
    const tb = new TraceBuilder().at("/mail");
    for (let i = 0; i < 2; i++) tb.clickItem(MAIL_LIST, i, `mail-${i}`).clickBody().click("Archive");
    expect(detect(tb)).toBeNull();
  });

  it("consecutive duplicates never count toward the minimum length: [item, Archive, Archive] x 2 is a 2-step loop, so null", () => {
    const tb = new TraceBuilder().at("/mail");
    for (let i = 0; i < 2; i++) tb.clickItem(MAIL_LIST, i, `mail-${i}`).click("Archive").wait(3000).click("Archive");
    expect(detect(tb)).toBeNull();
  });

  it("filterNoise keeps every meaningful event of a clean run and does not mutate its input", () => {
    const events = session([0, 1]).events();
    const snapshot = JSON.parse(JSON.stringify(events)) as TraceEvent[];
    expect(shapeKeys(filterNoise(events))).toEqual([...INVOICE_KEYS, ...INVOICE_KEYS]);
    detectLoop(events, lastOf(events)!.t);
    expect(events).toEqual(snapshot);
  });
});

// ---- detectLoop: noise the doc does NOT list ----

describe("detectLoop: noise between runs that the doc does not list", () => {
  it("UNSPECIFIED a labelled stray click between the runs: stay silent or return the exact 10-step runs, never a distorted candidate", () => {
    const tb = session([0]).at("/invoices").click("Help");
    session([1], INVOICES, tb);
    expectNullOrInvoiceLoop(detect(tb), 0, 1);
  });

  it("after a labelled stray click between runs 1 and 2, a clean third run is a tail tandem repeat and MUST be detected (items 1 -> 2)", () => {
    const tb = session([0]).at("/invoices").click("Help");
    session([1, 2], INVOICES, tb);
    // session() restarts rows at 0 for its own index list; only list indexes and values matter here.
    expectInvoiceLoop(detect(tb), 1, 2);
  });

  it("UNSPECIFIED a tab switch away and back between the runs: stay silent or return the exact 10-step runs", () => {
    const tb = session([0]).tabswitch(9, "/news").click("Like").tabswitch(1, "/invoices");
    session([1], INVOICES, tb);
    expectNullOrInvoiceLoop(detect(tb), 0, 1);
    expectNullOrInvoiceLoop(detectLoop(tb.events(), tb.now, { tabIds: [1] }), 0, 1);
  });

  it("after a tab switch between runs 1 and 2, a clean third run MUST be detected (items 1 -> 2)", () => {
    const tb = session([0]).tabswitch(9, "/news").click("Like").tabswitch(1, "/invoices");
    session([1, 2], INVOICES, tb);
    expectInvoiceLoop(detect(tb), 1, 2);
  });

  it("same tab group: activity on an unrelated tab interleaved INSIDE the runs is ignored when tabIds restricts the group", () => {
    const events = session([0, 1]).events();
    const other = new TraceBuilder({ tabId: 7, start: events[0]!.t + 1 }).at("/news");
    // One unrelated event lands after every one of the user's events.
    const mixed = events.flatMap((e, i) => [e, ...other.wait(e.t - other.now).click(`Story ${i % 3}`).events().slice(-1)]);
    const sorted = [...mixed].sort((x, y) => x.t - y.t);
    expectInvoiceLoop(detectLoop(sorted, lastOf(sorted)!.t, { tabIds: [1] }), 0, 1);
  });

  it("UNSPECIFIED run A clicks into each cell before typing, run B tabs between cells: stay silent or return aligned runs", () => {
    const first = INVOICES[0]!;
    const tb = new TraceBuilder().navigate("/invoices").clickItem(INBOX_LIST, 0, first.id).navigate(invoicePath(first)).navigate("/sheet");
    typedCells(first).forEach((value, col) => {
      const colHeader = SHEET_COLUMNS[col] ?? "";
      tb.click(`${colHeader} row 1`, { kind: "text", signature: `cell:0:${col}`, cell: { row: 0, col, colHeader } });
      tb.fillCell(0, col, colHeader, value);
    });
    tb.navigate(invoicePath(first)).click(REPLY_LABEL, { locked: true });
    session([1], INVOICES, tb);
    const loop = detect(tb);
    if (loop !== null) {
      expectWellFormed(loop);
      expect(listIndexes(loop.runA)).toEqual([0]);
      expect(listIndexes(loop.runB)).toEqual([1]);
    }
  });
});

// ---- detectLoop: a third run in progress ----

describe("detectLoop: third partial run in progress", () => {
  it("at every step of run 3 the tail is still a tandem repeat of L=10 that ends at the newest event (keys[n-2L..n-L) == keys[n-L..n))", () => {
    const full = session([0, 1, 2]).events();
    for (let k = 1; k <= 9; k++) {
      const events = full.slice(0, 20 + k);
      const newest = lastOf(events)!;
      const loop = detectLoop(events, newest.t);
      expect(loop, `after ${k} events of run 3`).not.toBeNull();
      if (!loop) continue;
      expectWellFormed(loop);
      expect(loop.length, `after ${k} events of run 3`).toBe(10);
      expect([...loop.runA, ...loop.runB], `after ${k} events of run 3`).toEqual(events.slice(-20));
      const [a] = listIndexes(loop.runA);
      const [b] = listIndexes(loop.runB);
      expect(listIndexes(loop.runA)).toHaveLength(1);
      expect((b ?? NaN) - (a ?? NaN)).toBe(1);
    }
  });

  it("when run 3 is complete the candidate is runs 2 and 3, never runs 1 and 2", () => {
    expectInvoiceLoop(detect(session([0, 1, 2])), 1, 2);
  });

  it("a third run that diverges (opens the item, then does something else) ends the tail repeat: null", () => {
    const tb = session([0, 1]).navigate("/invoices");
    const inv = INVOICES[2]!;
    tb.clickItem(INBOX_LIST, 2, inv.id).navigate(invoicePath(inv)).click("Forward");
    expect(detect(tb)).toBeNull();
  });

  it("the user finished two runs and moved on to something else: the loop is no longer at the tail, so null", () => {
    const tb = session([0, 1]).navigate("/mail").click("Compose").input("To", "sam@example.com");
    expect(detect(tb)).toBeNull();
  });

  it("one run plus a partial second run is never a loop, at any cut point", () => {
    const full = session([0, 1]).events();
    for (let n = 1; n < 20; n++) {
      const events = full.slice(0, n);
      expect(detectLoop(events, lastOf(events)!.t), `first ${n} events`).toBeNull();
    }
  });
});

// ---- detectLoop: run lengths ----

describe("detectLoop: run lengths", () => {
  it("detects a loop of exactly 3 steps with nothing before it (n == 2L)", () => {
    const tb = new TraceBuilder();
    archiveMail(tb, 0);
    archiveMail(tb, 1);
    const events = tb.events();
    const loop = detect(tb);
    expect(loop?.length).toBe(3);
    expect(loop?.runA).toEqual(events.slice(0, 3));
    expect(loop?.runB).toEqual(events.slice(3));
    expect(shapeKeys(loop?.runA ?? [])).toEqual(["click|/mail|LIST(ul#mail)", "navigate|/mail/:id|", "click|/mail/:id|Archive#button"]);
  });

  it("keeps reporting L=3 and the LAST two runs after 3, 4, 5, 6 and 7 repetitions", () => {
    for (const reps of [3, 4, 5, 6, 7]) {
      const tb = new TraceBuilder().navigate("/mail");
      for (let i = 0; i < reps; i++) archiveMail(tb, i);
      const loop = detect(tb);
      expect(loop?.length, `${reps} repetitions`).toBe(3);
      expect(listIndexes(loop?.runA ?? []), `${reps} repetitions`).toEqual([reps - 2]);
      expect(listIndexes(loop?.runB ?? []), `${reps} repetitions`).toEqual([reps - 1]);
    }
  });

  it("detects a loop of exactly 12 steps, and still reports 12 after 3 and 4 repetitions", () => {
    for (const reps of [2, 3, 4]) {
      const tb = new TraceBuilder().navigate("/leads");
      for (let i = 0; i < reps; i++) enterLead(tb, i);
      const loop = detect(tb);
      expect(loop?.length, `${reps} repetitions`).toBe(12);
      if (!loop) continue;
      expectWellFormed(loop);
      expect(listIndexes(loop.runA)).toEqual([reps - 2]);
      expect(listIndexes(loop.runB)).toEqual([reps - 1]);
      expect(lastOf(loop.runB)).toEqual(lastOf(tb.events()));
    }
  });

  it("the canonical 10-step loop stays L=10 with the last two runs for 2 to 7 repetitions", () => {
    for (let reps = 2; reps <= 7; reps++) {
      const indexes = Array.from({ length: reps }, (_, i) => i);
      expectInvoiceLoop(detect(session(indexes, MANY)), reps - 2, reps - 1, MANY);
    }
  });

  it("a genuine 4-step unit with a repeated key inside (A B A C) is reported as L=4, after 2 and after 4 repetitions", () => {
    for (const reps of [2, 4]) {
      const tb = new TraceBuilder().at("/crm/new");
      for (let i = 0; i < reps; i++) tb.click("Copy").input("Vendor", `vendor ${i}`).click("Copy").input("Total", `${i}`);
      const loop = detect(tb);
      expect(loop?.length, `${reps} repetitions`).toBe(4);
      expect(inputValues(loop?.runB ?? [])).toEqual([`vendor ${reps - 1}`, `${reps - 1}`]);
    }
  });
});

// ---- detectLoop: A B A B ... ----

describe("detectLoop: two-step units (A B A B ...) are below L >= 3", () => {
  it("A B repeated 2 or 3 times has no tail repeat with L >= 3: null", () => {
    expect(detect(abab(2))).toBeNull();
    expect(detect(abab(3))).toBeNull();
  });

  it("UNSPECIFIED A B repeated 4 to 8 times: the true unit is 2 steps (too short), so the safest answer stays null; never a doubled 'L=4' unit whose runs each hold two iterations", () => {
    for (let reps = 4; reps <= 8; reps++) {
      const loop = detect(abab(reps));
      expect(loop === null ? null : { length: loop.length, itemsPerRun: listIndexes(loop.runA).length }, `${reps} repetitions`).toBeNull();
    }
  });

  it("whatever the repetition count, a candidate run never contains more than one iteration of the list", () => {
    for (let reps = 2; reps <= 8; reps++) {
      const loop = detect(abab(reps));
      if (loop !== null) expect(listIndexes(loop.runA).length, `${reps} repetitions`).toBeLessThanOrEqual(1);
    }
  });
});

// ---- detectLoop: several loops in history ----

describe("detectLoop: two different loops in history", () => {
  it("old 3-step mail loop, then the invoice loop twice: picks the invoice loop at the tail", () => {
    const tb = new TraceBuilder().navigate("/mail");
    for (let i = 0; i < 3; i++) archiveMail(tb, i);
    expectInvoiceLoop(detect(session([0, 1], INVOICES, tb)), 0, 1);
  });

  it("invoice loop three times, then the 3-step mail loop twice: picks the mail loop (most recent tail), not the longer older one", () => {
    const tb = session([0, 1, 2]).navigate("/mail");
    archiveMail(tb, 4);
    archiveMail(tb, 5);
    const loop = detect(tb);
    expect(loop?.length).toBe(3);
    expect(listIndexes(loop?.runA ?? [])).toEqual([4]);
    expect(listIndexes(loop?.runB ?? [])).toEqual([5]);
    expect(loop?.runB.every((e) => e.pathPattern.startsWith("/mail"))).toBe(true);
  });

  it("an old loop done twice, then a different loop done only ONCE: nothing at the tail was done twice, so null", () => {
    const tb = new TraceBuilder().navigate("/mail");
    archiveMail(tb, 0);
    archiveMail(tb, 1);
    expect(detect(session([0], INVOICES, tb))).toBeNull();
  });

  it("a short loop that shares its keys with an older longer loop: reports the short one", () => {
    const tb = session([0, 1]);
    for (const index of [2, 3]) {
      const inv = INVOICES[index]!;
      tb.navigate("/invoices").clickItem(INBOX_LIST, index, inv.id).navigate(invoicePath(inv)).click(REPLY_LABEL, { locked: true });
    }
    const loop = detect(tb);
    expect(loop?.length).toBe(4);
    expect(listIndexes(loop?.runA ?? [])).toEqual([2]);
    expect(listIndexes(loop?.runB ?? [])).toEqual([3]);
  });
});

// ---- detectLoop: stride ----

describe("detectLoop: list stride", () => {
  it("every other item (index 0 then 2) is a loop: runs keep their own indexes so the synthesizer can see stride 2", () => {
    expectInvoiceLoop(detect(session([0, 2])), 0, 2);
  });

  it("stride 2 over three runs (0, 2, 4) reports the last two runs (2 -> 4)", () => {
    expectInvoiceLoop(detect(session([0, 2, 4], MANY)), 2, 4, MANY);
  });
});

// ---- detectLoop: redo ----

describe("detectLoop: an identical redo is not a loop", () => {
  it("same item, same values: null", () => {
    expect(detect(session([0, 0]))).toBeNull();
  });

  it("same item, same values, but typed into the NEXT sheet row: still a redo (needs a list-index or value change)", () => {
    const tb = new TraceBuilder().navigate("/invoices");
    handleInvoice(tb, 0, 0).navigate("/invoices");
    handleInvoice(tb, 0, 1);
    expect(detect(tb)).toBeNull();
  });

  it("same item, same FINAL values, with a corrected typo, a double click and body clicks only in run B: still a redo", () => {
    const tb = session([0]).navigate("/invoices").clickBody();
    const inv = INVOICES[0]!;
    tb.clickItem(INBOX_LIST, 0, inv.id).wait(-1300).clickItem(INBOX_LIST, 0, inv.id);
    tb.navigate(invoicePath(inv)).navigate("/sheet");
    tb.fillCell(0, 0, "Vendor", "Nrthwind").fillCell(0, 0, "Vendor", inv.vendor).clickBody();
    tb.fillCell(0, 1, "Invoice #", inv.id).fillCell(0, 2, "Date", inv.typedDate).fillCell(0, 3, "Total", inv.typedTotal);
    tb.navigate(invoicePath(inv)).click(REPLY_LABEL, { locked: true });
    expect(detect(tb)).toBeNull();
  });

  it("the same redo done four times is still a redo: repetition count does not rescue it", () => {
    expect(detect(session([0, 0, 0, 0]))).toBeNull();
  });

  it("items 0, 1, then item 1 AGAIN: the two runs at the tail are identical, so null", () => {
    expect(detect(session([0, 1, 1]))).toBeNull();
  });

  it("a cycle of plain clicks with no list item and no values is identical in every detail: null", () => {
    const tb = new TraceBuilder().at("/settings");
    for (let i = 0; i < 2; i++) tb.click("General").click("Privacy").click("Advanced");
    expect(detect(tb)).toBeNull();
    for (let i = 0; i < 2; i++) tb.click("General").click("Privacy").click("Advanced");
    expect(detect(tb)).toBeNull();
  });

  it("same item but ONE value changed is not an identical redo: the doc requires a candidate", () => {
    const tb = session([0]).navigate("/invoices");
    const inv = INVOICES[0]!;
    tb.clickItem(INBOX_LIST, 0, inv.id).navigate(invoicePath(inv)).navigate("/sheet");
    tb.fillCell(0, 0, "Vendor", inv.vendor).fillCell(0, 1, "Invoice #", inv.id).fillCell(0, 2, "Date", inv.typedDate).fillCell(0, 3, "Total", "1204.99");
    tb.navigate(invoicePath(inv)).click(REPLY_LABEL, { locked: true });
    const loop = detect(tb);
    expect(loop?.length).toBe(10);
    expect(lastOf(inputValues(loop?.runB ?? []))).toBe("1204.99");
  });

  it("different items with IDENTICAL typed values (reply 'received' to each mail) is a loop: the list index changed", () => {
    const tb = new TraceBuilder().navigate("/mail");
    for (const index of [0, 1]) {
      tb.at("/mail").clickItem(MAIL_LIST, index, `mail-${index}`).navigate(`/mail/${index + 100}`);
      tb.input("Reply", "received").submit("Send").navigate("/mail");
    }
    const loop = detect(tb);
    expect(loop?.length).toBe(5);
    expect(listIndexes(loop?.runA ?? [])).toEqual([0]);
    expect(listIndexes(loop?.runB ?? [])).toEqual([1]);
  });

  it("DOC-LITERAL same list index in both runs and no values, only the item key differs (handled mails vanish, the user always clicks row 0): no list-index change and no value change, so null", () => {
    const tb = new TraceBuilder().navigate("/mail");
    for (const [i, key] of ["mail-a", "mail-b"].entries()) tb.at("/mail").clickItem(MAIL_LIST, 0, key).navigate(`/mail/${100 + i}`).click("Archive");
    expect(detect(tb)).toBeNull();
  });
});

// ---- detectLoop: synthetic events ----

describe("detectLoop: Shabang's own synthetic events", () => {
  it("two fully synthetic runs are never 'the user did it twice'", () => {
    const events = session([0, 1]).events().map((e) => ({ ...e, synthetic: true }));
    expect(detectLoop(events, lastOf(events)!.t)).toBeNull();
  });

  it("run B where Shabang (not the user) filled one cell: the user's own events no longer repeat, so null", () => {
    const tb = session([0]).navigate("/invoices");
    const inv = INVOICES[1]!;
    tb.clickItem(INBOX_LIST, 1, inv.id).navigate(invoicePath(inv)).navigate("/sheet");
    tb.synthetic().fillCell(1, 0, "Vendor", inv.vendor);
    tb.fillCell(1, 1, "Invoice #", inv.id).fillCell(1, 2, "Date", inv.typedDate).fillCell(1, 3, "Total", inv.typedTotal);
    tb.navigate(invoicePath(inv)).click(REPLY_LABEL, { locked: true });
    expect(detect(tb)).toBeNull();
  });

  it("synthetic events are removed BEFORE noise filtering: they must not swallow the user's click or overwrite the user's value", () => {
    const tb = session([0]).navigate("/invoices");
    const inv = INVOICES[1]!;
    tb.clickItem(INBOX_LIST, 1, inv.id).navigate(invoicePath(inv)).navigate("/sheet");
    tb.fillCell(1, 0, "Vendor", inv.vendor).synthetic().fillCell(1, 0, "Vendor", "GHOST OVERWRITE");
    tb.fillCell(1, 1, "Invoice #", inv.id).fillCell(1, 2, "Date", inv.typedDate).fillCell(1, 3, "Total", inv.typedTotal);
    tb.navigate(invoicePath(inv));
    tb.synthetic().click(REPLY_LABEL, { locked: true }).wait(-1300).click(REPLY_LABEL, { locked: true });
    expectInvoiceLoop(detect(tb), 0, 1);
  });

  it("synthetic events sprinkled through both runs, with keys that would break the repeat, change nothing", () => {
    const events = session([0, 1]).events();
    const noisy = events.flatMap((e, i) => {
      if (i % 3 !== 0) return [e];
      const ghost: TraceEvent = { ...e, t: e.t + 1, type: "click", synthetic: true, target: makeTarget(`Shabang step ${i}`, "button") };
      delete ghost.value;
      return [e, ghost];
    });
    expectInvoiceLoop(detectLoop(noisy, lastOf(noisy)!.t), 0, 1);
  });

  it("a candidate never contains a synthetic event, even when Shabang ran items in between two user runs", () => {
    const user0 = session([0]);
    const ghost = session([1, 2], MANY, new TraceBuilder({ start: user0.now })).events().map((e) => ({ ...e, synthetic: true }));
    const user3 = session([3], MANY, new TraceBuilder({ start: lastOf(ghost)!.t }));
    const events = [...user0.events(), ...ghost, ...user3.events()];
    const loop = detectLoop(events, user3.now);
    if (loop !== null) expectWellFormed(loop);
  });
});

// ---- detectLoop: the 10 minute window ----

describe("detectLoop: events older than the window", () => {
  it("a loop finished more than 10 minutes ago, nothing since: null", () => {
    const tb = session([0, 1]);
    expect(detectLoop(tb.events(), tb.now + LOOP_WINDOW_MS + 1)).toBeNull();
  });

  it("an old loop plus fresh unrelated activity: null", () => {
    const tb = session([0, 1]).wait(LOOP_WINDOW_MS + 60_000).navigate("/calendar").click("Thursday 2pm");
    expect(detect(tb)).toBeNull();
  });

  it("two old runs plus ONE fresh run: only one run is inside the window, so null", () => {
    const tb = session([0, 1]).wait(LOOP_WINDOW_MS + 60_000);
    expect(detect(session([2], INVOICES, tb))).toBeNull();
  });

  it("run 1 is older than the window, runs 2 and 3 are inside: reports runs 2 and 3 and no event from before the window", () => {
    const tb = session([0]).wait(LOOP_WINDOW_MS + 60_000);
    session([1, 2], INVOICES, tb);
    const loop = detect(tb);
    expectInvoiceLoop(loop, 1, 2);
    for (const e of [...(loop?.runA ?? []), ...(loop?.runB ?? [])]) expect(e.t).toBeGreaterThanOrEqual(tb.now - LOOP_WINDOW_MS);
  });

  it("run A straddles the window edge (its first five events are too old): the repeat is incomplete, so null", () => {
    const events = session([0, 1]).events().map((e, i) => (i < 5 ? { ...e, t: e.t - LOOP_WINDOW_MS } : e));
    expect(detectLoop(events, lastOf(events)!.t)).toBeNull();
  });

  it("two slow runs that together take 9 minutes are inside the window: detected", () => {
    const tb = session([0, 1], INVOICES, new TraceBuilder({ stepMs: 27_000 }));
    expect(tb.now - tb.events()[0]!.t).toBeLessThan(LOOP_WINDOW_MS);
    expectInvoiceLoop(detect(tb), 0, 1);
  });

  it("two slow runs that together take 11 minutes are not: null", () => {
    const tb = session([0, 1], INVOICES, new TraceBuilder({ stepMs: 35_000 }));
    expect(tb.now - tb.events()[0]!.t).toBeGreaterThan(LOOP_WINDOW_MS);
    expect(detect(tb)).toBeNull();
  });

  it("the window is measured from the `now` argument, not from the newest event", () => {
    const tb = session([0, 1]);
    const first = tb.events()[0]!;
    expectInvoiceLoop(detectLoop(tb.events(), first.t + LOOP_WINDOW_MS - 1), 0, 1);
    expect(detectLoop(tb.events(), first.t + LOOP_WINDOW_MS + 5 * 1500 + 1)).toBeNull();
  });
});

// ---- detectLoop: degenerate input ----

describe("detectLoop: degenerate input", () => {
  it("returns null without throwing for an empty trace, a single event, and noise only", () => {
    expect(detectLoop([], 0)).toBeNull();
    const one = new TraceBuilder().navigate("/invoices");
    expect(detect(one)).toBeNull();
    const noise = new TraceBuilder();
    for (let i = 0; i < 12; i++) noise.clickBody();
    expect(detect(noise)).toBeNull();
  });

  it("the same key over and over (one button clicked 12 times) collapses to one event: null", () => {
    const tb = new TraceBuilder().at("/counter");
    for (let i = 0; i < 12; i++) tb.click("+");
    expect(detect(tb)).toBeNull();
  });
});

// ---- shape keys ----

describe("shapeKey (3.1)", () => {
  it("list items: index, item key, label and signature are all removed; only the list signature stays", () => {
    const [a, b] = new TraceBuilder().at("/invoices").clickItem(INBOX_LIST, 0, "INV-1001").clickItem(INBOX_LIST, 37, "INV-1038").events();
    expect(shapeKey(a!)).toBe("click|/invoices|LIST(ul#inbox)");
    expect(shapeKey(b!)).toBe(shapeKey(a!));
    const [other] = new TraceBuilder().at("/invoices").clickItem("ul#archive", 0, "INV-1001").events();
    expect(shapeKey(other!)).not.toBe(shapeKey(a!));
  });

  it("grid cells: row, column index, label and signature are removed; the column header stays", () => {
    const events = new TraceBuilder().at("/sheet").fillCell(0, 3, "Total", "1").fillCell(41, 3, "Total", "2").fillCell(0, 0, "Vendor", "x").events();
    expect(shapeKeys(events)).toEqual(["input|/sheet|CELL(Total)", "input|/sheet|CELL(Total)", "input|/sheet|CELL(Vendor)"]);
  });

  it("values are never part of the key, for input, select and check events alike", () => {
    const base = new TraceBuilder().at("/form").input("Country", "Canada").events()[0]!;
    for (const type of ["input", "select", "check"] as const) {
      const x: TraceEvent = { ...base, type, value: "Canada" };
      const y: TraceEvent = { ...base, type, value: "a completely different value | with#separators" };
      expect(shapeKey(x)).toBe(shapeKey(y));
      expect(shapeKey(x)).not.toContain("Canada");
    }
  });

  it("the key separates event type, page pattern, label and kind", () => {
    const tb = new TraceBuilder().at("/form");
    const [click, input, otherPage, otherKind, otherLabel] = tb
      .click("Country", { kind: "select" })
      .input("Country", "x", { kind: "select" })
      .at("/other")
      .input("Country", "x", { kind: "select" })
      .at("/form")
      .input("Country", "x", { kind: "text" })
      .input("County", "x", { kind: "select" })
      .events();
    expect(shapeKey(input!)).toBe("input|/form|Country#select");
    expect(new Set([click, input, otherPage, otherKind, otherLabel].map((e) => shapeKey(e!))).size).toBe(5);
  });

  it("two records of the same page pattern share a key, whatever their query string or trailing slash", () => {
    const events = new TraceBuilder()
      .at("/invoices/INV-1001").click(REPLY_LABEL)
      .at("/invoices/INV-1038/").click(REPLY_LABEL)
      .at("/invoices/INV-1040?from=inbox#reply").click(REPLY_LABEL)
      .events();
    expect(new Set(shapeKeys(events)).size).toBe(1);
    expect(shapeKey(events[0]!)).toBe("click|/invoices/:id|Reply: received#button");
    for (const e of events) expect(e.url).not.toMatch(/[?#]/);
  });

  it("events without a target (navigate, tabswitch) still differ by type and page", () => {
    const [nav, sw, nav2] = new TraceBuilder().navigate("/sheet").tabswitch(2, "/sheet").navigate("/mail").events();
    expect(shapeKey(nav!)).toBe("navigate|/sheet|");
    expect(shapeKey(sw!)).toBe("tabswitch|/sheet|");
    expect(shapeKey(nav2!)).not.toBe(shapeKey(nav!));
  });

  it("UNSPECIFIED a sheet cell that capture ALSO tags as a list item keeps its column in the key (else four fills collapse into one step)", () => {
    const events = new TraceBuilder().at("/sheet").events();
    const tb = new TraceBuilder().at("/sheet");
    SHEET_COLUMNS.forEach((colHeader, col) => {
      const list = { listSignature: "table#sheet", index: 0, itemKey: "row 1" };
      tb.input(`${colHeader} row 1`, "v", { signature: `cell:0:${col}`, list, cell: { row: 0, col, colHeader } });
    });
    events.push(...tb.events());
    expect(new Set(shapeKeys(events)).size).toBe(4);
    expect(filterNoise(events)).toHaveLength(4);
  });
});

// ---- path patterns ----

describe("pathPatternOf / normalizeUrl edge cases (section 1)", () => {
  it("/invoices/INV-1042 -> /invoices/:id (the doc's own example), for every id of that family", () => {
    for (const id of ["INV-1042", "INV-1001", "inv_7", "1042", "0"]) expect(pathPatternOf(`/invoices/${id}`)).toBe("/invoices/:id");
  });

  it("/u/0/mail -> /u/:id/mail: a digits-only segment is volatile wherever it sits, and its neighbours are kept", () => {
    expect(pathPatternOf("/u/0/mail")).toBe("/u/:id/mail");
    expect(pathPatternOf("/u/1/mail")).toBe(pathPatternOf("/u/0/mail"));
    expect(pathPatternOf("/mail/u/0")).toBe("/mail/u/:id");
    expect(pathPatternOf("/u/0/mail/inbox/18c2f9a7b3d4e5f6")).toBe("/u/:id/mail/inbox/:id");
  });

  it("UNSPECIFIED trailing and doubled slashes are insignificant, so /sheet and /sheet/ are the same page", () => {
    expect(pathPatternOf("/invoices/INV-1042/")).toBe("/invoices/:id");
    expect(pathPatternOf("/sheet/")).toBe("/sheet");
    expect(pathPatternOf("/sheet//")).toBe("/sheet");
    expect(pathPatternOf("//invoices//INV-1042//")).toBe("/invoices/:id");
    expect(pathPatternOf("/")).toBe("/");
    expect(pathPatternOf("///")).toBe("/");
    expect(pathPatternOf("")).toBe("/");
  });

  it("a loop whose second run visits /sheet/ (trailing slash) instead of /sheet is still the same loop", () => {
    const tb = session([0]).navigate("/invoices");
    const inv = INVOICES[1]!;
    tb.clickItem(INBOX_LIST, 1, inv.id).navigate(`${invoicePath(inv)}/`).navigate("/sheet/");
    typedCells(inv).forEach((value, col) => tb.fillCell(1, col, SHEET_COLUMNS[col] ?? "", value));
    tb.navigate(invoicePath(inv)).click(REPLY_LABEL, { locked: true });
    expectInvoiceLoop(detect(tb), 0, 1);
  });

  it("uuids in any case, with or without dashes, become :id", () => {
    expect(pathPatternOf("/docs/3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b")).toBe("/docs/:id");
    expect(pathPatternOf("/docs/3F2B8C1E-9A4D-4E2F-8B1A-0C9D8E7F6A5B/edit")).toBe("/docs/:id/edit");
    expect(pathPatternOf("/docs/3f2b8c1e9a4d4e2f8b1a0c9d8e7f6a5b")).toBe("/docs/:id");
    expect(pathPatternOf("/docs/abcdefab-cdef-abcd-efab-cdefabcdefab/edit")).toBe("/docs/:id/edit");
  });

  it("ordinary words stay literal, including words made only of hex letters", () => {
    for (const path of ["/invoices", "/sheet", "/mail", "/calendar", "/settings/profile", "/feed", "/facade", "/decade/added", "/cafe/beef"]) {
      expect(pathPatternOf(path)).toBe(path);
    }
  });

  it("query strings and fragments never reach the pattern, even when they contain slashes and ids", () => {
    expect(pathPatternOf("/sheet?row=12&next=/invoices/INV-7")).toBe("/sheet");
    expect(pathPatternOf("/sheet#/row/12")).toBe("/sheet");
    expect(pathPatternOf("/invoices/INV-1042?token=abc123#top")).toBe("/invoices/:id");
    expect(pathPatternOf("/invoices/INV-1042/?reset=1")).toBe("/invoices/:id");
  });

  it("normalizeUrl keeps origin + pathname only: no query, fragment or credentials in url, pathname or pattern", () => {
    const n = normalizeUrl("http://alex:hunter2@localhost:5173/invoices/INV-1042?token=s3cret&next=/sheet/9#reply/2");
    expect(n).toEqual({
      origin: DEMO_ORIGIN,
      pathname: "/invoices/INV-1042",
      pathPattern: "/invoices/:id",
      url: `${DEMO_ORIGIN}/invoices/INV-1042`,
    });
    expect(JSON.stringify(n)).not.toMatch(/s3cret|hunter2|alex|reply|[?#@]/);
  });

  it("a query string that itself contains a url, an @ or a fragment cannot change the origin or the path", () => {
    const n = normalizeUrl("https://app.example.com/sheet?next=https://evil.example/@admin/7#x");
    expect(n?.origin).toBe("https://app.example.com");
    expect(n?.url).toBe("https://app.example.com/sheet");
    expect(n?.pathPattern).toBe("/sheet");
    expect(normalizeUrl("https://app.example.com?user=a@b.example")?.url).toBe("https://app.example.com/");
    expect(normalizeUrl("https://app.example.com#/invoices/INV-1")?.pathPattern).toBe("/");
  });

  it("an @ in the path (profile handles) is not mistaken for credentials", () => {
    const n = normalizeUrl("https://social.example/@alexchen/posts/12345");
    expect(n?.origin).toBe("https://social.example");
    expect(n?.pathPattern).toBe("/@alexchen/posts/:id");
  });

  it("UNSPECIFIED percent-encoding is not an id: /my%20documents and /caf%C3%A9 stay literal and distinct (over-generalizing merges unrelated pages into /:id)", () => {
    expect(pathPatternOf("/my%20documents")).not.toBe("/:id");
    expect(pathPatternOf("/my%20documents")).not.toBe(pathPatternOf("/my%20pictures"));
    expect(pathPatternOf("/wiki/caf%C3%A9")).not.toBe("/wiki/:id");
    // A real id stays an id when it is percent-encoded.
    expect(pathPatternOf("/invoices/INV%2D1042")).toBe("/invoices/:id");
  });
});
