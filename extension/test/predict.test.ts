import { DEFAULT_SETTINGS, DEMO_PROFILE, NEEDS_TEXT, NONE } from "@ghost/shared";
import type { CapturedField, FieldAssignment, GhostSettings } from "@ghost/shared";
import { describe, expect, it, vi } from "vitest";
import {
  LLM_CONFIDENCE, buildGhostsOffline, createFormPredictor, draftableFields, ghostsFromAssignments, isPlaceholderChoice, planForm, predictableFields,
  upgradeGhosts, usableFactKeys,
} from "../src/content/predict";
import type { FormPredictorDeps, PredictDeps } from "../src/content/predict";
import type { ServedAssignment } from "../src/lib/messages";

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

  // docs/always-propose.md: the threshold changes how a proposal is DRAWN, never whether it exists.
  it("keeps every ghost below the confidence threshold, drawn as a long shot", () => {
    const fields = [
      field({ signature: "first", label: "First name" }), // 0.95
      field({ signature: "loc", label: "Current location" }), // 0.85
      field({ signature: "hint", label: "Contact", name: "phone" }), // 0.95 - 0.08 from a name hint
    ];
    const tiers = (threshold: number): Array<[string, string | undefined]> =>
      buildGhostsOffline(fields, deps({ confidenceThreshold: threshold })).map((g) => [g.signature, g.tier]);

    expect(tiers(0.7)).toEqual([["first", "confident"], ["loc", "confident"], ["hint", "confident"]]);
    // Raising the bar dims the ones that no longer clear it. It never deletes one.
    expect(tiers(0.86)).toEqual([["first", "confident"], ["loc", "long-shot"], ["hint", "confident"]]);
    expect(tiers(0.9)).toEqual([["first", "confident"], ["loc", "long-shot"], ["hint", "long-shot"]]);
    expect(tiers(0.99)).toEqual([["first", "long-shot"], ["loc", "long-shot"], ["hint", "long-shot"]]);
    // Every long shot is a guess: it carries the chip, its reason, and it stops a held accept key.
    const strict = buildGhostsOffline(fields, deps({ confidenceThreshold: 0.99 }));
    expect(strict.every((g) => g.guess === true && (g.reason ?? "") !== "")).toBe(true);
  });

  it("names a reason, from one short list, for every control it does not propose for", () => {
    const fields = [
      field({ signature: "pw", label: "Password", inputType: "password" }),
      field({ signature: "first", label: "First name", value: "Sam" }),
      field({ signature: "size", label: "T-shirt size", kind: "select", options: [{ value: "s", label: "S" }, { value: "m", label: "M" }] }),
      field({ signature: "email", label: "Email", kind: "email" }),
    ];
    const plan = planForm(fields, [], deps(), "offline");
    expect(plan.skips).toEqual([
      { signature: "pw", reason: "sensitive" },
      { signature: "first", reason: "already-answered" },
    ]);
    // The T-shirt size has no fact and no neutral option, and is proposed anyway, as a long shot.
    expect(plan.ghosts.map((g) => [g.signature, g.tier])).toEqual([["size", "long-shot"], ["email", "confident"]]);
  });

  it("proposes the first control on a page it understands nothing on", () => {
    const fields = [
      field({ signature: "q", label: "Search", kind: "text" }),
      field({ signature: "go", label: "Go", kind: "button" }),
    ];
    const ghosts = buildGhostsOffline(fields, deps());
    expect(ghosts.map((g) => [g.signature, g.action, g.tier, g.guess])).toEqual([["q", "click", "long-shot", true]]);
    expect(ghosts[0]?.reason).toContain("where it would start");
  });

  it("proposes nothing at all only when there is nothing on the page to act on", () => {
    expect(buildGhostsOffline([], deps())).toEqual([]);
    const onlySensitive = [field({ signature: "pw", label: "Password", inputType: "password" })];
    expect(buildGhostsOffline(onlySensitive, deps())).toEqual([]);
    const onlyAnswered = [field({ signature: "first", label: "First name", value: "Sam" })];
    expect(buildGhostsOffline(onlyAnswered, deps())).toEqual([]);
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
    expect(ghosts[0]).toEqual({
      signature: "a", action: "fill", value: "University of Waterloo", displayText: "University of Waterloo",
      confidence: 0.9, locked: false, source: "server", tier: "confident",
    });
    // Field B is free text the draft path owns, Field C was answered `none` -- and Field D, which nobody
    // assigned anything, still gets the answer engine's long shot rather than silence.
    expect(ghosts.map((g) => [g.signature, g.tier])).toEqual([["a", "confident"], ["d", "long-shot"]]);
  });

  it("multiplies the assignment confidence by the option-match factor, and tiers the result", () => {
    const assignments: FieldAssignment[] = [{ signature: "d", factKey: "country", confidence: 0.8 }];
    const [ghost] = ghostsFromAssignments(fields, assignments, deps({ confidenceThreshold: 0.7 }), "server");
    expect(ghost).toMatchObject({ signature: "d", action: "select", value: "ca", tier: "guess", guess: true });
    expect(ghost?.confidence).toBeCloseTo(0.8 * 0.88, 5);
    // A stricter threshold dims the same ghost instead of removing it (docs/always-propose.md).
    const [strict] = ghostsFromAssignments(fields, assignments, deps({ confidenceThreshold: 0.75 }), "server");
    expect(strict).toMatchObject({ signature: "d", value: "ca", tier: "long-shot", guess: true });
  });

  it("ignores unknown fact keys, unknown signatures and unresolvable values", () => {
    const assignments: FieldAssignment[] = [
      { signature: "a", factKey: "favouriteColour", confidence: 0.99 },
      { signature: "zzz", factKey: "email", confidence: 0.99 },
      { signature: "d", factKey: "email", confidence: 0.99 },
    ];
    const ghosts = ghostsFromAssignments(fields, assignments, deps(), "server");
    // None of those assignments produces a value -- and none of them silences the field either: D is a
    // dropdown, so the answer engine proposes the option that claims the least, as a long shot.
    expect(ghosts.map((g) => [g.signature, g.tier, g.answerSource])).toEqual([["d", "long-shot", "guess"]]);
    expect(ghosts.every((g) => g.value !== "alex.chen.dev@example.com")).toBe(true);
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

describe("upgradeGhosts", () => {
  const jev = (signature: string, factKey: string, confidence: number): ServedAssignment => ({ signature, factKey, confidence, source: "jev-gateway", calibrated: true });
  const llm = (signature: string, factKey: string, confidence: number): ServedAssignment => ({ signature, factKey, confidence, source: "llm", calibrated: false });

  it("takes the server's answer per field and keeps the offline one where the server said nothing", () => {
    const fields = [
      field({ signature: "first", label: "First name" }), // offline says firstName; the model knows better here
      field({ signature: "handle", label: "Where can we see your code?" }), // offline: nothing
      field({ signature: "last", label: "Last name" }),
      SUBMIT,
    ];
    expect(buildGhostsOffline(fields, deps()).map((g) => g.signature)).toEqual(["first", "last", "submit"]);
    const ghosts = upgradeGhosts(fields, [jev("first", NONE, 0.98), jev("handle", "github", 0.93)], deps(), "server");
    expect(ghosts.map((g) => [g.signature, g.value, g.source])).toEqual([
      ["handle", "https://github.com/alexchen-dev", "server"],
      ["last", "Chen", "offline"],
      ["submit", undefined, "server"],
    ]);
  });

  it("tiers server assignments with the live threshold instead of dropping them", () => {
    const fields = [field({ signature: "handle", label: "Where can we see your code?" })];
    const loose = upgradeGhosts(fields, [jev("handle", "github", 0.75)], deps({ confidenceThreshold: 0.7 }), "server");
    expect(loose.map((g) => g.tier)).toEqual(["guess"]);
    const strict = upgradeGhosts(fields, [jev("handle", "github", 0.75)], deps({ confidenceThreshold: 0.8 }), "server");
    expect(strict.map((g) => [g.value, g.tier])).toEqual([["https://github.com/alexchen-dev", "long-shot"]]);
  });

  it("never lets an uncalibrated answer override a more confident offline ghost with another fact", () => {
    const fields = [field({ signature: "first", label: "First name" })]; // offline: firstName at 0.95
    const kept = upgradeGhosts(fields, [llm("first", "fullName", 0.9)], deps(), "server");
    expect(kept.map((g) => [g.value, g.source])).toEqual([["Alex", "offline"]]);
    const keptOverNone = upgradeGhosts(fields, [llm("first", NONE, 0.8)], deps(), "server");
    expect(keptOverNone.map((g) => g.value)).toEqual(["Alex"]);
  });

  it("lets an uncalibrated answer win when it is the more confident one, agrees, or no offline ghost exists", () => {
    const first = [field({ signature: "first", label: "First name" })];
    expect(upgradeGhosts(first, [llm("first", "fullName", 0.99)], deps(), "server").map((g) => g.value)).toEqual(["Alex Chen"]);
    expect(upgradeGhosts(first, [llm("first", "firstName", 0.8)], deps(), "cache").map((g) => [g.value, g.source])).toEqual([["Alex", "cache"]]);
    const vague = [field({ signature: "handle", label: "Where can we see your code?" })];
    expect(upgradeGhosts(vague, [llm("handle", "github", 0.8)], deps(), "server").map((g) => g.value)).toEqual(["https://github.com/alexchen-dev"]);
  });

  it("lets a calibrated answer override the offline ghost even at lower confidence", () => {
    const fields = [field({ signature: "first", label: "First name" })];
    expect(upgradeGhosts(fields, [jev("first", "fullName", 0.8)], deps(), "server").map((g) => g.value)).toEqual(["Alex Chen"]);
  });

  it("still refuses sensitive fields and fields that already have a value", () => {
    const fields = [field({ signature: "sin", label: "Social Insurance Number" }), field({ signature: "first", label: "First name", value: "Sam" })];
    expect(upgradeGhosts(fields, [jev("sin", "phone", 0.99), jev("first", "firstName", 0.99)], deps(), "server")).toEqual([]);
  });
});

describe("predictableFields", () => {
  it("keeps value-capable fields only and strips their current value and geometry", () => {
    const wire = predictableFields([
      field({ signature: "first", label: "First name", value: "Sam" }),
      field({ signature: "why", label: "Why Northwind?", kind: "textarea", value: "Because robots" }),
      field({ signature: "cv", label: "Resume", kind: "file" }),
      field({ signature: "home", label: "Home", kind: "link" }),
      SUBMIT,
    ]);
    expect(wire.map((f) => f.signature)).toEqual(["first", "why"]);
    expect(JSON.stringify(wire)).not.toContain("Sam");
    expect(JSON.stringify(wire)).not.toContain("robots");
    expect(wire[0]?.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("lists fact keys that have a value, never the values", () => {
    expect(usableFactKeys({ facts: { firstName: "Alex", phone: "" }, pastAnswers: [] })).toEqual(["firstName"]);
  });
});

describe("createFormPredictor", () => {
  const REQUEST = { origin: "http://localhost:5173", formSignature: "form-1-x", fields: [field({ signature: "first", label: "First name" })], factKeys: ["firstName"] };
  const ASSIGNMENTS: ServedAssignment[] = [{ signature: "first", factKey: "firstName", confidence: 0.97, source: "jev-gateway", calibrated: true }];

  function harness(reply: Awaited<ReturnType<FormPredictorDeps["askServer"]>>) {
    const store = new Map<string, { assignments: ServedAssignment[]; provider: string }>();
    const askServer = vi.fn<FormPredictorDeps["askServer"]>(async () => reply);
    const predict = createFormPredictor({
      readCache: async (origin, signature) => store.get(`${origin} ${signature}`) ?? null,
      saveCache: async (origin, signature, _keys, answer) => void store.set(`${origin} ${signature}`, answer),
      askServer,
    });
    return { predict, askServer, store };
  }

  it("asks the server on a miss, and a repeat visit makes ZERO server calls", async () => {
    const { predict, askServer } = harness({ ok: true, data: { assignments: ASSIGNMENTS, provider: "jev-gateway", calibrated: true, latencyMs: 90 } });
    const first = await predict(REQUEST);
    expect(first).toMatchObject({ cache: "miss", provider: "jev-gateway", assignments: ASSIGNMENTS });
    expect(askServer).toHaveBeenCalledTimes(1);
    const again = await predict(REQUEST);
    expect(again).toMatchObject({ cache: "hit", provider: "jev-gateway", assignments: ASSIGNMENTS });
    expect(askServer).toHaveBeenCalledTimes(1);
  });

  it("answers null (stay offline) when the server is down, and remembers nothing", async () => {
    const { predict, store } = harness({ ok: false, error: "unreachable" });
    expect(await predict(REQUEST)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("never rejects, even when the cache or the worker throws", async () => {
    const predict = createFormPredictor({
      readCache: async () => Promise.reject(new Error("storage is gone")),
      saveCache: async () => undefined,
      askServer: async () => Promise.reject(new Error("Extension context invalidated")),
    });
    expect(await predict(REQUEST)).toBeNull();
  });

  it("uses but does not remember a fallback answer, so a provider hiccup is not pinned to the site", async () => {
    const { predict, store, askServer } = harness({ ok: true, data: { assignments: ASSIGNMENTS, provider: "heuristic", calibrated: false, latencyMs: 2500, fallbackFrom: "jev-gateway" } });
    expect((await predict(REQUEST))?.provider).toBe("heuristic");
    expect(store.size).toBe(0);
    await predict(REQUEST);
    expect(askServer).toHaveBeenCalledTimes(2);
  });
});

describe("free-text drafts (Stage 3)", () => {
  const draftsOf = (entries: Record<string, { text: string; pending: boolean }>): NonNullable<PredictDeps["drafts"]> => ({ get: (signature) => entries[signature] });
  const needsText = (signature: string, confidence: number, calibrated?: boolean): ServedAssignment => ({ signature, factKey: NEEDS_TEXT, confidence, calibrated });

  it("plans the essay fields of a recognised form for drafting, and offers no ghost before a draft has text", () => {
    const plan = planForm(applyForm(), [], deps({}, { drafts: draftsOf({}) }), "offline");
    expect(plan.textFields.map((f) => f.signature)).toEqual(["why"]);
    expect(plan.ghosts.map((g) => g.signature)).not.toContain("why");
  });

  it("turns a streaming draft into a pending llm fill ghost in DOM order, before the locked Submit", () => {
    const streaming = deps({}, { drafts: draftsOf({ why: { text: "I want to build", pending: true } }) });
    const ghosts = planForm(applyForm(), [], streaming, "offline").ghosts;
    expect(ghosts.map((g) => g.signature)).toEqual(["first", "email", "grad", "auth", "sponsor", "why", "submit"]);
    expect(ghosts.find((g) => g.signature === "why")).toEqual({
      signature: "why", action: "fill", value: "I want to build", displayText: "I want to build", confidence: LLM_CONFIDENCE,
      locked: false, source: "llm", pending: true,
      // 0.8 is under CONFIDENT_TIER: a draft is a suggestion to read, so it wears the chip and stops a hold.
      tier: "guess", guess: true, reason: "a draft written for you: read it before you take it",
    });
    const finished = deps({}, { drafts: draftsOf({ why: { text: "I want to build robots.", pending: false } }) });
    const ghost = planForm(applyForm(), [], finished, "offline").ghosts.find((g) => g.signature === "why");
    expect(ghost).toMatchObject({ value: "I want to build robots.", source: "llm" });
    expect(ghost).not.toHaveProperty("pending");
  });

  it("keeps the llm source through a server upgrade", () => {
    const withDraft = deps({}, { drafts: draftsOf({ why: { text: "Robots.", pending: false } }) });
    const served: ServedAssignment[] = [{ signature: "first", factKey: "firstName", confidence: 0.97, source: "jev-gateway", calibrated: true }];
    const ghosts = upgradeGhosts(applyForm(), served, withDraft, "server");
    expect(ghosts.find((g) => g.signature === "why")?.source).toBe("llm");
    expect(ghosts.find((g) => g.signature === "first")?.source).toBe("server");
  });

  it("still drafts when the user's threshold is above the fixed 0.8, and draws the draft as a long shot", () => {
    const strict = deps({ confidenceThreshold: 0.85 }, { drafts: draftsOf({ why: { text: "Robots.", pending: false } }) });
    const plan = planForm(applyForm(), [], strict, "offline");
    // The threshold is not a veto on spending the call, only on how sure the result is allowed to look.
    expect(plan.textFields.map((f) => f.signature)).toEqual(["why"]);
    expect(plan.ghosts.find((g) => g.signature === "why")).toMatchObject({ value: "Robots.", tier: "long-shot", guess: true });
  });

  it("wants a real prompt from an uncalibrated mapper, and takes a calibrated needs_text at the threshold", () => {
    const fields = [...applyForm().slice(0, 5), field({ signature: "notes", label: "Additional information", kind: "textarea" }), SUBMIT];
    expect(planForm(fields, [], deps({}, { drafts: draftsOf({}) }), "offline").textFields).toEqual([]); // our heuristic: 0.8, any textarea
    const facts = mapped(fields);
    expect(draftableFields(fields, [...facts, needsText("notes", 0.84, false)], deps()).map((f) => f.signature)).toEqual([]);
    expect(draftableFields(fields, [...facts, needsText("notes", 0.74, true)], deps()).map((f) => f.signature)).toEqual(["notes"]);
    expect(draftableFields(fields, [...facts, needsText("notes", 0.69, true)], deps())).toEqual([]);
    // Both bars are about what the FIELD IS, so the user's own threshold does not move them either way.
    const picky = deps({ confidenceThreshold: 0.95 });
    expect(draftableFields(fields, [...facts, needsText("notes", 0.74, true)], picky).map((f) => f.signature)).toEqual(["notes"]);
  });

  it("drafts nothing outside a form of the user's own details: a comment box or a chat input is not an essay question", () => {
    const comment = [field({ signature: "c", label: "Why do you disagree with this post?", kind: "textarea" }), SUBMIT];
    expect(planForm(comment, [], deps({}, { drafts: draftsOf({}) }), "offline").textFields).toEqual([]);
    const oneFact = [field({ signature: "first", label: "First name", autocomplete: "given-name" }), ...comment];
    expect(planForm(oneFact, [], deps({}, { drafts: draftsOf({}) }), "offline").textFields).toEqual([]);
  });

  it("never drafts for a field that has text, has no label, looks sensitive, or is not a text box", () => {
    const base = applyForm().slice(0, 5);
    const facts = mapped(base);
    const candidates = [
      field({ signature: "typed", label: "Why Northwind?", kind: "textarea", value: "Because robots" }),
      field({ signature: "unlabelled", label: " ", kind: "textarea" }),
      field({ signature: "secret", label: "Why did you pick this security question?", kind: "textarea" }),
      field({ signature: "choice", label: "Why Northwind?", kind: "select", options: [{ value: "", label: "Select" }] }),
      field({ signature: "ok", label: "Tell us about a project you are proud of", kind: "textarea" }),
    ];
    const assignments = [...facts, ...candidates.map((c) => needsText(c.signature, 0.95, true))];
    expect(draftableFields([...base, ...candidates], assignments, deps()).map((f) => f.signature)).toEqual(["ok"]);
  });

  function mapped(fields: CapturedField[]): ServedAssignment[] {
    const keys: Record<string, string> = { first: "firstName", email: "email", grad: "graduationDate", auth: "workAuthorization", sponsor: "requiresSponsorship" };
    return fields.filter((f) => keys[f.signature]).map((f) => ({ signature: f.signature, factKey: keys[f.signature] ?? NONE, confidence: 0.95 }));
  }
});
