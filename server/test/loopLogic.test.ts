import { synthesizeProgram, type LoopCandidate, type UnresolvedStep } from "@shabang/shared";
import { describe, expect, it } from "vitest";
import { parseModelPicks, MalformedAnswer } from "../src/loop/answers";
import { applyMappings } from "../src/loop/apply";
import { buildOpenQuestion, verifyCandidate, type FactCandidate } from "../src/loop/candidates";
import { isIdOrCardNumber, looksSecret, passesLuhn } from "../src/loop/secrets";
import { SHORTHAND_INVOICES, factsFor, invoiceCandidate, invoiceUrl } from "../src/loop/testing";
import { programTitle } from "../src/loop/title";
import { LOOP_TRANSFORMS, applyLoopTransform, reproduces, type ServerLoopProgram } from "../src/loop/transforms";

const step = (valueA: string, valueB: string, label = "Vendor"): UnresolvedStep => ({ stepIndex: 0, var: "v", label, valueA, valueB });
const fact = (textA: string, textB: string): FactCandidate => ({ pathPattern: "/invoices/:id", locator: { by: "data-field", value: "x" }, label: "X", textA, textB });

describe("closed transform list", () => {
  it("is exactly the eight documented transforms", () => {
    expect([...LOOP_TRANSFORMS]).toEqual(["trim", "number", "date-iso", "lowercase", "uppercase", "first-word", "last-word", "digits-only"]);
  });

  it.each([
    ["trim", "  Thistledown \n Textiles ", "Thistledown Textiles"],
    ["number", "$1,204.50", "1204.50"],
    ["date-iso", "Sep 3, 2026", "2026-09-03"],
    ["lowercase", "Thistledown  Textiles", "thistledown textiles"],
    ["uppercase", "inv-2001", "INV-2001"],
    ["first-word", "Thistledown Textiles", "Thistledown"],
    ["first-word", "Chen, Alex", "Chen"],
    ["last-word", "Invoice INV-2001", "INV-2001"],
    ["digits-only", "INV-2001", "2001"],
  ] as const)("%s: %j -> %j", (transform, text, expected) => {
    expect(applyLoopTransform(text, transform)).toBe(expected);
  });

  it("returns null instead of an empty or unparseable value", () => {
    expect(applyLoopTransform("no digits here", "digits-only")).toBeNull();
    expect(applyLoopTransform("   ", "first-word")).toBeNull();
    expect(applyLoopTransform("soon", "date-iso")).toBeNull();
    expect(applyLoopTransform("as is", undefined)).toBe("as is");
  });

  it("an extended transform must reproduce the typed text exactly; empty values never match", () => {
    expect(reproduces("Thistledown", "Thistledown Textiles", "first-word")).toBe(true);
    expect(reproduces("thistledown", "Thistledown Textiles", "first-word")).toBe(false);
    expect(reproduces("", "Thistledown Textiles", "first-word")).toBe(false);
    expect(reproduces("x", "", undefined)).toBe(false);
    expect(reproduces("980", "$980.00", "number")).toBe(true); // shared heuristic semantics for its own transforms
  });
});

describe("verifyCandidate", () => {
  it("needs the SAME transform to reproduce BOTH runs", () => {
    expect(verifyCandidate(fact("Thistledown Textiles", "Marigold Freight Lines"), step("Thistledown", "Marigold"))).toMatchObject({ transform: "first-word" });
    // Run A is a first word, run B a last word: no single transform explains both.
    expect(verifyCandidate(fact("Thistledown Textiles", "Marigold Freight Lines"), step("Thistledown", "Lines"))).toBeNull();
    expect(verifyCandidate(fact("Thistledown Textiles", "Marigold Freight Lines"), step("Thistledown", "Globex"))).toBeNull();
  });

  it("prefers copy-as-is, then the model's suggestion, then the weakest transform", () => {
    expect(verifyCandidate(fact("ACME", "GLOBEX"), step("ACME", "GLOBEX"), "uppercase")).toEqual({ pathPattern: "/invoices/:id", locator: { by: "data-field", value: "x" } });
    // Both "first-word" and "uppercase" would fail here; "lowercase" is what reproduces the values.
    expect(verifyCandidate(fact("ACME", "GLOBEX"), step("acme", "globex"), "first-word")?.transform).toBe("trim"); // shared trim matching ignores case
    expect(verifyCandidate(fact("A1", "B2"), step("1", "2"), "digits-only")?.transform).toBe("digits-only");
  });
});

describe("buildOpenQuestion", () => {
  const candidate = invoiceCandidate(SHORTHAND_INVOICES);
  const facts = factsFor(SHORTHAND_INVOICES);
  const unresolved = synthesizeProgram(candidate, facts)?.unresolved ?? [];

  it("offers only facts whose text differs between the two items, once per locator", () => {
    const q = buildOpenQuestion(candidate, facts, unresolved);
    expect(q.steps.map((s) => [s.key, s.step.var, s.setId])).toEqual([["s0", "vendor", "g0"], ["s1", "invoiceNumber", "g0"]]);
    expect(q.sets).toHaveLength(1);
    expect(q.sets[0]?.candidates.map((c) => c.label)).toEqual(["", "Vendor", "Invoice #", "Date", "Total"]);
  });

  it("asks nothing when a run's page facts are missing: both runs must be explained", () => {
    const onlyA = { ...facts };
    delete onlyA[invoiceUrl(SHORTHAND_INVOICES[1]!)];
    expect(buildOpenQuestion(candidate, onlyA, unresolved).steps).toEqual([]);
  });

  it("ignores pages the user only visited AFTER typing the value", () => {
    // Same runs, but the item page is first seen after the sheet was filled.
    const reorder = (run: LoopCandidate["runA"]): LoopCandidate["runA"] => {
      const [click, toItem, toSheet, ...rest] = run;
      const fills = rest.filter((e) => e.type === "input");
      const tail = rest.filter((e) => e.type !== "input");
      return click && toItem && toSheet ? [click, toSheet, ...fills, toItem, ...tail.filter((e) => e.type !== "navigate" || e.pathPattern === "/invoices")] : run;
    };
    const late: LoopCandidate = { length: 0, runA: reorder(candidate.runA), runB: reorder(candidate.runB) };
    expect(buildOpenQuestion(late, facts, unresolved).steps).toEqual([]);
  });

  it("handles runs that start mid-cycle: steps before the item click belong to the previous item", () => {
    // Rotate so each run is [fills..., reply, back to inbox, click next item, open it, go to sheet].
    const rotate = (run: LoopCandidate["runA"]): LoopCandidate["runA"] => [...run.slice(3), ...run.slice(0, 3)];
    const runA = rotate(candidate.runA);
    const runB = rotate(candidate.runB);
    const q = buildOpenQuestion({ length: runA.length, runA, runB }, facts, unresolved);
    // The fills of run A have no page before them inside the run, so nothing can explain run A: not asked.
    expect(q.steps).toEqual([]);
  });

  it("asks about a mid-cycle step when each run still shows its item page before the step", () => {
    // Each run is [open item page, go to sheet, fills, ..., back to inbox, click NEXT item]: the item pages are inside the runs.
    const rotate = (run: LoopCandidate["runA"]): LoopCandidate["runA"] => [...run.slice(1), ...run.slice(0, 1)];
    const runA = rotate(candidate.runA);
    const runB = rotate(candidate.runB);
    const q = buildOpenQuestion({ length: runA.length, runA, runB }, facts, unresolved);
    expect(q.steps.map((s) => s.step.var)).toEqual(["vendor", "invoiceNumber"]);
    expect(q.sets[0]?.candidates[1]).toMatchObject({ label: "Vendor", textA: "Thistledown Textiles", textB: "Marigold Freight Lines" });
  });

  it("returns nothing without a list iterator", () => {
    const flat = { ...candidate, runA: candidate.runA.slice(1), runB: candidate.runB.slice(1) };
    expect(buildOpenQuestion(flat, facts, unresolved)).toEqual({ sets: [], steps: [] });
  });
});

describe("applyMappings", () => {
  const candidate = invoiceCandidate(SHORTHAND_INVOICES);
  const base = synthesizeProgram(candidate, factsFor(SHORTHAND_INVOICES)) as ServerLoopProgram;
  const vendor = { var: "vendor", pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" } as const, transform: "first-word" as const };

  it("hoists the new extract next to its siblings, before the fill, and never mutates the input", () => {
    const before = JSON.stringify(base);
    const out = applyMappings(base, [vendor]);
    expect(JSON.stringify(base)).toBe(before);
    const at = out.steps.findIndex((s) => s.op === "extract" && s.var === "vendor");
    const fillAt = out.steps.findIndex((s) => s.op === "fill" && "var" in s.value && s.value.var === "vendor");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(fillAt);
    expect(out.steps[at - 1]?.op).toBe("extract");
    expect(out.unresolved?.map((u) => u.var)).toEqual(["invoiceNumber"]);
    const still = out.unresolved?.[0];
    expect(out.steps[still?.stepIndex ?? -1]).toMatchObject({ op: "fill", value: { var: "invoiceNumber" } });
    for (const effect of out.irreversible) expect(out.steps[effect.stepIndex]).toMatchObject({ op: "click", locked: true });
  });

  it("places the extract right after open-item when the item page has no extract yet", () => {
    const bare: ServerLoopProgram = { ...base, steps: base.steps.filter((s) => s.op !== "extract") };
    const out = applyMappings(bare, [vendor]);
    expect(out.steps.slice(0, 2).map((s) => s.op)).toEqual(["open-item", "extract"]);
  });

  it("reuses an identical extract instead of adding a second one", () => {
    const again = { ...vendor, var: "invoiceNumber" };
    const out = applyMappings(base, [vendor, again]);
    expect(out.steps.filter((s) => s.op === "extract")).toHaveLength(3);
    const fills = out.steps.flatMap((s) => (s.op === "fill" && "var" in s.value ? [s.value.var] : []));
    expect(fills.slice(0, 2)).toEqual(["vendor", "vendor"]);
    expect(out.unresolved).toEqual([]);
  });

  it("ignores a mapping for a variable the program does not fill", () => {
    const out = applyMappings(base, [{ ...vendor, var: "ghost" }]);
    expect(out.steps).toEqual(base.steps);
    expect(out.confidence).toBe(base.confidence);
  });
});

describe("programTitle", () => {
  const base = synthesizeProgram(invoiceCandidate(SHORTHAND_INVOICES), factsFor(SHORTHAND_INVOICES)) as ServerLoopProgram;

  it("names the copied columns, the destination page and the click", () => {
    expect(programTitle(base)).toBe("Copy Vendor, Invoice #, Date, Total to sheet and Reply: received");
  });

  it("summarizes long lists and clips long labels", () => {
    const fill = base.steps.find((s) => s.op === "fill");
    const many = Array.from({ length: 7 }, (_, i) => ({ ...fill, target: { label: `Column ${i} ${"x".repeat(60)}`, kind: "text" as const } })) as ServerLoopProgram["steps"];
    const title = programTitle({ ...base, steps: many });
    expect(title).toContain("and 4 more");
    expect(title.length).toBeLessThanOrEqual(120);
  });

  it("falls back to fills, then to opening items", () => {
    const click = base.steps.filter((s) => s.op === "click" || s.op === "open-item");
    expect(programTitle({ ...base, steps: click })).toBe("Open each item in invoices and Reply: received");
    const constant: ServerLoopProgram["steps"] = [{ op: "fill", target: { label: "Status", kind: "text" }, value: { const: "Paid" }, at: { origin: "http://localhost:5173", pathPattern: "/sheet" } }];
    expect(programTitle({ ...base, steps: constant })).toBe("Fill Status on sheet");
  });
});

describe("parseModelPicks", () => {
  it("keeps only known steps, first answer wins, and drops unknown transforms", () => {
    const picks = parseModelPicks(JSON.stringify({ answers: { s0: { candidate: 1, transform: "rot13" }, s9: { candidate: 0 }, s1: { candidate: "C4", transform: "number" } } }), ["s0", "s1"]);
    expect([...picks]).toEqual([["s0", { candidate: 1 }], ["s1", { candidate: 4, transform: "number" }]]);
  });

  it("throws MalformedAnswer only when there is no JSON object to read", () => {
    expect(() => parseModelPicks("nope", ["s0"])).toThrow(MalformedAnswer);
    expect(() => parseModelPicks("{broken", ["s0"])).toThrow(MalformedAnswer);
    expect(parseModelPicks('{"answers": null}', ["s0"]).size).toBe(0);
    expect(parseModelPicks('{"answers": {"s0": {"candidate": -1}}}', ["s0"]).size).toBe(0);
  });
});

describe("secret-shaped text", () => {
  it("knows the Luhn check digit", () => {
    expect(["4111111111111111", "5500000000000004", "046454286", "79927398713"].map(passesLuhn)).toEqual([true, true, true, true]);
    expect(["4111111111111112", "1234567890123456", "046454280", "", "4111 1111"].map(passesLuhn)).toEqual([false, false, false, false, false]);
  });

  it("narrow test (before any code reads a fact): SSN shapes and check-digit-valid SIN / card numbers only", () => {
    for (const text of ["123-45-6789", "SSN 123 45 6789", "4111 1111 1111 1111", "card 5500-0000-0000-0004 exp", "046 454 286"]) expect([text, isIdOrCardNumber(text)]).toEqual([text, true]);
    for (const text of ["1234567890123456", "046 454 280", "555-123-4567", "2026-09-03", "$1,204.50", "INV-1042", "Net 30"]) expect([text, isIdOrCardNumber(text)]).toEqual([text, false]);
  });

  it("broad test (in front of a prompt): any SSN, SIN or 13 to 19 digit shape", () => {
    for (const text of ["123-45-6789", "046 454 280", "1234567890123456", "4111-1111-1111-1111"]) expect([text, looksSecret(text)]).toEqual([text, true]);
    for (const text of ["555-123-4567", "2026-09-03", "$1,204.50", "INV-1042", "Sep 3, 2026"]) expect([text, looksSecret(text)]).toEqual([text, false]);
  });
});
