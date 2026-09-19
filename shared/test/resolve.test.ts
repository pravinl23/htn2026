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
    expect(resolveFieldValue(field("Graduation", "date"), "graduationDate", "2028-04-15")?.value).toBe("2028-04-15");
    expect(resolveFieldValue(field("Graduation", "date"), "graduationDate", "2028-04")).toBeNull(); // never invent a day
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

describe("matchOption never guesses", () => {
  it("matches whole words, never substrings (the state code AR is not inside Ontario)", () => {
    expect(matchOption(opts("AL", "AK", "AZ", "AR", "RI"), "Ontario")).toBeNull();
    expect(matchOption(opts("Yes", "No"), "Hack the North")).toBeNull();
  });

  it("does not take a generic word for the whole fact", () => {
    expect(matchOption(opts("High school", "College", "University"), "University of Waterloo")).toBeNull();
    expect(matchOption(opts("Computer Science", "Mathematics"), "BCS Computer Science")?.option.label).toBe("Computer Science");
  });

  it("does not confuse two schools that share filler words", () => {
    expect(matchOption(opts("University of Toronto", "University of Ottawa"), "University of Waterloo")).toBeNull();
    expect(matchOption(opts("University of Toronto", "Waterloo University"), "University of Waterloo")?.option.label).toBe("Waterloo University");
  });

  it("returns null when two options fit equally well", () => {
    expect(matchOption(opts("Yes, I am a citizen", "Yes, I hold a work permit", "No"), "yes")).toBeNull();
    expect(matchOption(opts("Inside Canada", "Outside Canada"), "Canada")).toBeNull();
    expect(matchOption(opts("Canada", "Outside Canada"), "Canada")?.option.label).toBe("Canada");
  });

  it("reads yes/no from the first word or a 1/0 value, not from a leading number", () => {
    expect(matchOption(opts("1-2 years", "3-5 years"), "yes")).toBeNull();
    expect(matchOption([{ value: "1", label: "Oui" }, { value: "0", label: "Non" }], "no")?.option.value).toBe("0");
    expect(matchOption(opts("Not sure", "No"), "no")?.option.label).toBe("No");
  });

  it("cannot choose between two terms of the same graduation year", () => {
    expect(resolveFieldValue(field("Graduation", "select", opts("Spring 2028", "Fall 2028")), "graduationDate", "2028-04")).toBeNull();
  });
});

describe("resolveFieldValue respects the input type", () => {
  it("refuses values that cannot belong in an email, tel or url input (assignments may come from a model)", () => {
    expect(resolveFieldValue(field("Email", "email"), "firstName", "Alex")).toBeNull();
    expect(resolveFieldValue(field("Phone", "tel"), "email", "alex.chen.dev@example.com")).toBeNull();
    expect(resolveFieldValue(field("Site", "url"), "school", "University of Waterloo")).toBeNull();
    expect(resolveFieldValue(field("Email", "email"), "email", "alex.chen.dev@example.com")?.value).toBe("alex.chen.dev@example.com");
    expect(resolveFieldValue(field("Phone", "tel"), "phone", "+1 519 555 0142")?.value).toBe("+1 519 555 0142");
    expect(resolveFieldValue(field("Site", "url"), "github", "https://github.com/alexchen-dev")?.value).toBe("https://github.com/alexchen-dev");
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
