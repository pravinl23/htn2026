import { describe, expect, it } from "vitest";
import { DEMO_PROFILE, NEEDS_TEXT, NONE, mapFieldToFact, type CapturedField, type FieldKind } from "../src";

const factKeys = Object.keys(DEMO_PROFILE.facts);
const rect = { x: 0, y: 0, width: 100, height: 20 };

function field(label: string, kind: FieldKind = "text", extra: Partial<CapturedField> = {}): CapturedField {
  return { signature: `sig:${label}`, label, kind, rect, ...extra };
}

describe("mapFieldToFact", () => {
  const cases: Array<[string, FieldKind, string]> = [
    ["First name", "text", "firstName"],
    ["Last name *", "text", "lastName"],
    ["Full legal name", "text", "fullName"],
    ["Email address", "email", "email"],
    ["Phone number", "tel", "phone"],
    ["Current location (city, province)", "text", "location"],
    ["LinkedIn profile", "url", "linkedin"],
    ["GitHub URL", "url", "github"],
    ["Portfolio or personal website", "url", "website"],
    ["School", "text", "school"],
    ["Degree", "text", "degree"],
    ["Expected graduation date", "month", "graduationDate"],
    ["Are you legally authorized to work in Canada?", "select", "workAuthorization"],
    ["Will you now or in the future require sponsorship?", "radio", "requiresSponsorship"],
    ["How did you hear about us?", "select", "referralSource"],
    ["Why Northwind?", "textarea", NEEDS_TEXT],
    ["Tell us about a project you are proud of", "textarea", NEEDS_TEXT],
  ];
  for (const [label, kind, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      const a = mapFieldToFact(field(label, kind), factKeys);
      expect(a.factKey).toBe(expected);
      expect(a.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }

  it("asks about sponsorship even when the label also mentions authorization", () => {
    const a = mapFieldToFact(field("Are you authorized to work without visa sponsorship?", "radio"), factKeys);
    expect(a.factKey).toBe("requiresSponsorship");
  });

  it("uses autocomplete hints over a vague label", () => {
    expect(mapFieldToFact(field("Field 1", "text", { autocomplete: "given-name" }), factKeys).factKey).toBe("firstName");
  });

  it("falls back to name/id hints", () => {
    const a = mapFieldToFact(field("", "text", { name: "applicant_last_name" }), factKeys);
    expect(a.factKey).toBe("lastName");
  });

  it("stays below the default threshold for other people's details", () => {
    const a = mapFieldToFact(field("Reference email"), factKeys);
    expect(a.confidence).toBeLessThan(0.7);
    expect(mapFieldToFact(field("Emergency contact phone", "tel"), factKeys).confidence).toBeLessThan(0.7);
  });

  it("never proposes consent checkboxes, buttons or uploads", () => {
    expect(mapFieldToFact(field("I agree to the terms", "checkbox"), factKeys).factKey).toBe(NONE);
    expect(mapFieldToFact(field("Submit application", "button"), factKeys).factKey).toBe(NONE);
    expect(mapFieldToFact(field("Resume", "file"), factKeys).factKey).toBe(NONE);
  });

  it("only returns fact keys the caller offered", () => {
    expect(mapFieldToFact(field("First name"), ["email"]).factKey).toBe(NONE);
  });

  it("returns none for unknown labels", () => {
    expect(mapFieldToFact(field("Favourite colour"), factKeys).factKey).toBe(NONE);
  });
});
