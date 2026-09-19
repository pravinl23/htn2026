import { describe, expect, it } from "vitest";
import { applyTransform, canonicalNumberString, matchValue, matchesUnder, parseDateToIso, parseLooseNumber } from "../src";

describe("parseDateToIso", () => {
  it.each([
    ["2026-09-03", "2026-09-03"],
    ["2026-9-3", "2026-09-03"],
    ["2026/09/03", "2026-09-03"],
    ["2026-09-03T14:00:00Z", "2026-09-03"],
    ["Sep 3, 2026", "2026-09-03"],
    ["Sept. 3 2026", "2026-09-03"],
    ["September 3rd, 2026", "2026-09-03"],
    ["3 September 2026", "2026-09-03"],
    ["3rd Sep 2026", "2026-09-03"],
    ["Thu, Sep 3, 2026", "2026-09-03"],
    ["09/03/2026", "2026-09-03"],
    ["9/3/26", "2026-09-03"],
    ["03.09.2026", "2026-09-03"],
    ["Feb 29, 2028", "2028-02-29"],
  ])("%s -> %s", (input, iso) => {
    expect(parseDateToIso(input)).toBe(iso);
  });

  it("supports day-first numeric dates on request", () => {
    expect(parseDateToIso("03/09/2026", { dayFirst: true })).toBe("2026-09-03");
    expect(parseDateToIso("25/12/2026", { dayFirst: true })).toBe("2026-12-25");
  });

  // Was "25/12/2026 -> 2026-12-25": flipping to day-first on an impossible month let a day-first page pass and then misread 04/05.
  it("never guesses day-first from an impossible month: slashes are month first or nothing", () => {
    expect(parseDateToIso("25/12/2026")).toBeNull();
    expect(parseDateToIso("03/25/2026", { dayFirst: true })).toBeNull();
  });

  it.each(["", "Feb 30, 2026", "13/13/2026", "Total 3, 2026", "INV-1042", "1204.50", "soon"])("rejects %j", (input) => {
    expect(parseDateToIso(input)).toBeNull();
  });
});

describe("numbers", () => {
  it.each([
    ["$1,204.50", "1204.50", 1204.5],
    ["1204.5", "1204.5", 1204.5],
    ["USD 980", "980", 980],
    ["€1.204,50", "1204.50", 1204.5],
    ["1.204.500", "1204500", 1204500],
    ["12,5", "12.5", 12.5],
    ["(42.10)", "-42.10", -42.1],
    ["-7", "-7", -7],
    [".5", "0.5", 0.5],
    [" 15,000.00 CAD ", "15000.00", 15000],
  ])("%s", (input, canonical, value) => {
    expect(canonicalNumberString(input)).toBe(canonical);
    expect(parseLooseNumber(input)).toBeCloseTo(value);
  });

  it.each(["", "INV-1042", "09/03/2026", "12 apples", "1,2,3", "$"])("rejects %j", (input) => {
    expect(parseLooseNumber(input)).toBeNull();
  });
});

describe("matchValue", () => {
  it("picks the weakest mode that explains the value", () => {
    expect(matchValue("Northwind Traders", "Northwind Traders")).toEqual({ mode: "exact" });
    expect(matchValue("northwind  traders", " Northwind Traders ")).toEqual({ mode: "trim", transform: "trim" });
    expect(matchValue("1204.5", "$1,204.50")).toEqual({ mode: "number", transform: "number" });
    expect(matchValue("2026-09-03", "3 September 2026")).toEqual({ mode: "date-iso", transform: "date-iso" });
    // Was date-iso: the transform writes ISO, so it cannot reproduce a date the user typed as 09/03/2026.
    expect(matchValue("09/03/2026", "Sep 3, 2026")).toBeNull();
  });

  it("does not match different or empty values", () => {
    expect(matchValue("1204.5", "$1,204.51")).toBeNull();
    expect(matchValue("2026-09-03", "Sep 4, 2026")).toBeNull();
    expect(matchValue("", "")).toBeNull();
    expect(matchValue("  ", "  ")).toBeNull();
  });

  it("stronger modes also accept exact matches, so one mode can explain both runs", () => {
    expect(matchesUnder("980", "980", "number")).toBe(true);
    expect(matchesUnder("Initech", "Initech", "trim")).toBe(true);
    expect(matchesUnder("Initech", "Initech", "number")).toBe(false);
  });
});

describe("applyTransform", () => {
  it("produces what the executor writes", () => {
    expect(applyTransform(" Northwind  Traders ", undefined)).toBe(" Northwind  Traders ");
    expect(applyTransform(" Northwind  Traders ", "trim")).toBe("Northwind Traders");
    expect(applyTransform("$1,204.50", "number")).toBe("1204.50");
    expect(applyTransform("Sep 3, 2026", "date-iso")).toBe("2026-09-03");
  });

  it("returns null when the text cannot be transformed", () => {
    expect(applyTransform("n/a", "number")).toBeNull();
    expect(applyTransform("n/a", "date-iso")).toBeNull();
  });
});
