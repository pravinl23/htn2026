import { DEFAULT_SETTINGS, DEMO_PROFILE, NEEDS_TEXT, NONE } from "@ghost/shared";
import type { CapturedField, FieldAssignment, GhostSettings } from "@ghost/shared";
import { describe, expect, it } from "vitest";
import { buildGhostsOffline, ghostsFromAssignments, isPlaceholderChoice } from "../src/content/predict";
import type { PredictDeps } from "../src/content/predict";

const RECT = { x: 0, y: 0, width: 200, height: 32 };

function field(partial: Partial<CapturedField> & { signature: string; label: string }): CapturedField {
  return { kind: "text", value: "", rect: RECT, ...partial };
}

function deps(settings: Partial<GhostSettings> = {}, extra: Partial<PredictDeps> = {}): PredictDeps {
  return { profile: DEMO_PROFILE, settings: { ...DEFAULT_SETTINGS, ...settings }, ...extra };
}

const WORK_AUTH_OPTIONS = [
  { value: "", label: "Select an option" },
  { value: "yes", label: "Yes, I am authorized to work in Canada" },
  { value: "no", label: "No" },
];

const SUBMIT = field({ signature: "submit", label: "Submit application", kind: "button", inputType: "submit", locked: true, value: undefined });

function applyForm(): CapturedField[] {
  return [
    field({ signature: "first", label: "First name", autocomplete: "given-name" }),
    field({ signature: "email", label: "Email", kind: "email" }),
    field({ signature: "grad", label: "Expected graduation date", kind: "month" }),
    field({ signature: "auth", label: "Are you legally authorized to work in Canada?", kind: "select", options: WORK_AUTH_OPTIONS }),
    field({
      signature: "sponsor", label: "Will you now or in the future require sponsorship?", kind: "radio",
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    }),
    field({ signature: "why", label: "Why Northwind?", kind: "textarea" }),
    field({ signature: "consent", label: "I agree to the privacy policy", kind: "checkbox", value: "false" }),
    SUBMIT,
  ];
}

describe("buildGhostsOffline", () => {
  it("maps profile-backed fields to ghosts in DOM order with the right action and value", () => {
    const ghosts = buildGhostsOffline(applyForm(), deps());
    expect(ghosts.map((g) => [g.signature, g.action, g.value])).toEqual([
      ["first", "fill", "Alex"],
      ["email", "fill", "alex.chen.dev@example.com"],
      ["grad", "fill", "2028-04"],
      ["auth", "select", "yes"],
      ["sponsor", "select", "no"],
      ["submit", "click", undefined],
    ]);
    expect(ghosts.find((g) => g.signature === "auth")?.displayText).toBe("Yes, I am authorized to work in Canada");
    expect(ghosts.every((g) => g.source === "offline")).toBe(true);
  });

  it("produces no ghost for free-text (needs_text), consent, or file fields", () => {
    const signatures = buildGhostsOffline(applyForm(), deps()).map((g) => g.signature);
    expect(signatures).not.toContain("why");
    expect(signatures).not.toContain("consent");
  });

  it("drops ghosts below the confidence threshold", () => {
    const fields = [
      field({ signature: "first", label: "First name" }), // 0.95
      field({ signature: "loc", label: "Current location" }), // 0.85
      field({ signature: "hint", label: "Contact", name: "phone" }), // 0.95 - 0.08 from a name hint
    ];
    expect(buildGhostsOffline(fields, deps({ confidenceThreshold: 0.7 })).map((g) => g.signature)).toEqual(["first", "loc", "hint"]);
    expect(buildGhostsOffline(fields, deps({ confidenceThreshold: 0.86 })).map((g) => g.signature)).toEqual(["first", "hint"]);
    expect(buildGhostsOffline(fields, deps({ confidenceThreshold: 0.9 })).map((g) => g.signature)).toEqual(["first"]);
    expect(buildGhostsOffline(fields, deps({ confidenceThreshold: 0.99 }))).toEqual([]);
  });

  it("never proposes a value for a field that already has one", () => {
    const fields = [
      field({ signature: "first", label: "First name", value: "Sam" }),
      field({ signature: "auth", label: "Work authorization", kind: "select", options: WORK_AUTH_OPTIONS, value: "no" }),
      field({
        signature: "sponsor", label: "Require sponsorship?", kind: "radio", value: "yes",
        options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      }),
      field({ signature: "last", label: "Last name", value: "   " }), // whitespace is still something the controller refuses to overwrite
      field({ signature: "email", label: "Email", kind: "email" }),
    ];
    expect(buildGhostsOffline(fields, deps()).map((g) => g.signature)).toEqual(["email"]);
  });

  it("offers to tick a checkbox but never to untick one", () => {
    const box = (value: string): CapturedField[] => [
      field({ signature: "visa", label: "I will require visa sponsorship", kind: "checkbox", value }),
    ];
    const needs = { facts: { requiresSponsorship: "yes" }, pastAnswers: [] };
    const doesNot = { facts: { requiresSponsorship: "no" }, pastAnswers: [] };
    expect(buildGhostsOffline(box("false"), { profile: needs, settings: DEFAULT_SETTINGS })[0]).toMatchObject({ action: "check", value: "true" });
    expect(buildGhostsOffline(box("true"), { profile: doesNot, settings: DEFAULT_SETTINGS })).toEqual([]);
    expect(buildGhostsOffline(box("true"), { profile: needs, settings: DEFAULT_SETTINGS })).toEqual([]);
  });

  it("treats a select sitting on its placeholder option as empty", () => {
    const options = [{ value: "none", label: "-- Choose --" }, { value: "Hack the North", label: "Hack the North" }];
    const fields = [field({ signature: "ref", label: "How did you hear about us?", kind: "select", options, value: "none" })];
    expect(buildGhostsOffline(fields, deps())[0]).toMatchObject({ signature: "ref", action: "select", value: "Hack the North" });
  });

  it("skips facts that are missing or blank in the profile", () => {
    const profile = { facts: { firstName: "Alex", lastName: "" }, pastAnswers: [] };
    const fields = [field({ signature: "first", label: "First name" }), field({ signature: "last", label: "Last name" })];
    const ghosts = buildGhostsOffline(fields, { profile, settings: DEFAULT_SETTINGS });
    expect(ghosts.map((g) => g.signature)).toEqual(["first"]);
  });
});

describe("locked submit ghost", () => {
  it("comes last, is locked, and carries no value", () => {
    const ghosts = buildGhostsOffline(applyForm(), deps());
    expect(ghosts.at(-1)).toMatchObject({ signature: "submit", action: "click", locked: true, displayText: "Submit application" });
    expect(ghosts.filter((g) => g.locked)).toHaveLength(1);
    expect(ghosts.slice(0, -1).every((g) => !g.locked)).toBe(true);
  });

  it("is not produced when the form has no other ghosts", () => {
    const fields = [field({ signature: "first", label: "First name", value: "Alex" }), SUBMIT];
    expect(buildGhostsOffline(fields, deps())).toEqual([]);
  });

  it("stays when keepLock says the walk already filled the form", () => {
    const fields = [field({ signature: "first", label: "First name", value: "Alex" }), SUBMIT];
    expect(buildGhostsOffline(fields, deps({}, { keepLock: true })).map((g) => g.signature)).toEqual(["submit"]);
  });

  it("picks the form's own submit, not a search button above or a cancel beside it", () => {
    const button = (signature: string, label: string): CapturedField =>
      field({ signature, label, kind: "button", locked: true, value: undefined });
    const fields = [
      button("search", "Search"),
      field({ signature: "first", label: "First name" }),
      button("submit", "Submit application"),
      button("cancel", "Cancel"),
      field({ signature: "link", label: "Delete account", kind: "link", locked: true, value: undefined }),
    ];
    const locked = buildGhostsOffline(fields, deps()).filter((g) => g.locked);
    expect(locked.map((g) => g.signature)).toEqual(["submit"]);
  });

  it("ignores buttons that are not locked", () => {
    const fields = [
      field({ signature: "first", label: "First name" }),
      field({ signature: "toggle", label: "Show details", kind: "button", locked: false, value: undefined }),
    ];
    expect(buildGhostsOffline(fields, deps()).map((g) => g.signature)).toEqual(["first"]);
  });
});

describe("ghostsFromAssignments", () => {
  const fields = [
    field({ signature: "a", label: "Field A" }),
    field({ signature: "b", label: "Field B", kind: "textarea" }),
    field({ signature: "c", label: "Field C" }),
    field({ signature: "d", label: "Field D", kind: "select", options: [{ value: "ca", label: "Canada (CA)" }, { value: "us", label: "United States" }] }),
  ];

  it("uses the given assignments and source instead of the heuristic", () => {
    const assignments: FieldAssignment[] = [
      { signature: "a", factKey: "school", confidence: 0.9 },
      { signature: "b", factKey: NEEDS_TEXT, confidence: 0.95 },
      { signature: "c", factKey: NONE, confidence: 0.99 },
    ];
    const ghosts = ghostsFromAssignments(fields, assignments, deps(), "server");
    expect(ghosts).toEqual([
      { signature: "a", action: "fill", value: "University of Waterloo", displayText: "University of Waterloo", confidence: 0.9, locked: false, source: "server" },
    ]);
  });

  it("multiplies the assignment confidence by the option-match factor before gating", () => {
    const assignments: FieldAssignment[] = [{ signature: "d", factKey: "country", confidence: 0.8 }];
    const [ghost] = ghostsFromAssignments(fields, assignments, deps({ confidenceThreshold: 0.7 }), "server");
    expect(ghost).toMatchObject({ signature: "d", action: "select", value: "ca" });
    expect(ghost?.confidence).toBeCloseTo(0.8 * 0.88, 5);
    expect(ghostsFromAssignments(fields, assignments, deps({ confidenceThreshold: 0.75 }), "server")).toEqual([]);
  });

  it("ignores unknown fact keys, unknown signatures and unresolvable values", () => {
    const assignments: FieldAssignment[] = [
      { signature: "a", factKey: "favouriteColour", confidence: 0.99 },
      { signature: "zzz", factKey: "email", confidence: 0.99 },
      { signature: "d", factKey: "email", confidence: 0.99 },
    ];
    expect(ghostsFromAssignments(fields, assignments, deps(), "server")).toEqual([]);
  });

  it("refuses a sensitive-looking field even when an assignment points at it", () => {
    const risky = [
      field({ signature: "pw", label: "Password", inputType: "password" }),
      field({ signature: "card", label: "Number", autocomplete: "cc-number" }),
      field({ signature: "sin", label: "Social Insurance Number" }),
    ];
    const assignments = risky.map((f) => ({ signature: f.signature, factKey: "phone", confidence: 0.99 }));
    expect(ghostsFromAssignments(risky, assignments, deps(), "server")).toEqual([]);
  });
});

describe("isPlaceholderChoice", () => {
  it("recognises empty values and prompt-like labels", () => {
    expect(isPlaceholderChoice("", "anything")).toBe(true);
    expect(isPlaceholderChoice("0", "Select an option")).toBe(true);
    expect(isPlaceholderChoice("0", "-- Choose --")).toBe(true);
    expect(isPlaceholderChoice("yes", "Yes")).toBe(false);
  });
});
