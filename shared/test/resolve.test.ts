import { describe, expect, it } from "vitest";
import { matchOption, parseIsoDate, resolveFieldValue, type CapturedField, type FieldKind, type FieldOption } from "../src";

const rect = { x: 0, y: 0, width: 100, height: 20 };
function field(label: string, kind: FieldKind, options?: FieldOption[]): CapturedField {
  return { signature: label, label, kind, rect, options };
}
const opts = (...labels: string[]): FieldOption[] => labels.map((l) => ({ value: l.toLowerCase().replace(/\W+/g, "-"), label: l }));

describe("resolveFieldValue", () => {
  it("fills plain text as is", () => {
    expect(resolveFieldValue(field("First name", "text"), "firstName", "Alex")).toMatchObject({ action: "fill", value: "Alex" });
  });

  it("adds a scheme for url inputs", () => {
    expect(resolveFieldValue(field("Site", "url"), "website", "alexchen.dev")?.value).toBe("https://alexchen.dev");
  });

  it("formats graduation date per input kind", () => {
    expect(resolveFieldValue(field("Graduation", "month"), "graduationDate", "2028-04")?.value).toBe("2028-04");
    expect(resolveFieldValue(field("Graduation", "date"), "graduationDate", "2028-04")?.value).toBe("2028-04-01");
    expect(resolveFieldValue(field("Expected graduation", "text"), "graduationDate", "2028-04")?.value).toBe("April 2028");
    expect(resolveFieldValue(field("Graduation year", "text"), "graduationDate", "2028-04")?.value).toBe("2028");
    expect(resolveFieldValue(field("Graduation year", "number"), "graduationDate", "2028-04")?.value).toBe("2028");
  });

  it("selects a graduation year option", () => {
    const r = resolveFieldValue(field("Graduation year", "select", opts("2026", "2027", "2028")), "graduationDate", "2028-04");
    expect(r).toMatchObject({ action: "select", value: "2028" });
  });

  it("maps yes/no facts onto wordy options", () => {
    const f = field("Authorized?", "select", [{ value: "", label: "Select..." }, ...opts("Yes, I am authorized", "No, I am not")]);
    expect(resolveFieldValue(f, "workAuthorization", "yes")?.displayText).toBe("Yes, I am authorized");
    expect(resolveFieldValue(f, "requiresSponsorship", "no")?.displayText).toBe("No, I am not");
  });

  it("matches referral options by containment", () => {
    const f = field("How did you hear?", "select", opts("LinkedIn", "Hack the North 2026", "A friend"));
    expect(resolveFieldValue(f, "referralSource", "Hack the North")?.displayText).toBe("Hack the North 2026");
  });

  it("returns null when no option fits", () => {
    expect(resolveFieldValue(field("Pick", "select", opts("Red", "Green")), "school", "University of Waterloo")).toBeNull();
  });

  it("never proposes placeholder options", () => {
    expect(matchOption([{ value: "", label: "Select yes or no" }], "yes")).toBeNull();
  });

  it("refuses non numeric values for number inputs and non dates for date inputs", () => {
    expect(resolveFieldValue(field("Age", "number"), "firstName", "Alex")).toBeNull();
    expect(resolveFieldValue(field("Start", "date"), "firstName", "Alex")).toBeNull();
  });

  it("checks boxes only for yes/no facts", () => {
    expect(resolveFieldValue(field("Authorized", "checkbox"), "workAuthorization", "yes")).toMatchObject({ action: "check", value: "true" });
    expect(resolveFieldValue(field("Authorized", "checkbox"), "school", "UW")).toBeNull();
  });
});

describe("parseIsoDate", () => {
  it("parses month and full dates and rejects junk", () => {
    expect(parseIsoDate("2028-04")).toEqual({ year: 2028, month: 4 });
    expect(parseIsoDate("2028-04-15")).toEqual({ year: 2028, month: 4, day: 15 });
    expect(parseIsoDate("April 2028")).toBeNull();
    expect(parseIsoDate("2028-13")).toBeNull();
  });
});
