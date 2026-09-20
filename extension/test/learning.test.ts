// Opt-in learning: every NEVER of the contract, past-answer dedupe, the debounce, the toast and its Undo.
import { DEFAULT_SETTINGS, NEEDS_TEXT, NONE } from "@ghost/shared";
import type { CapturedField, FieldAssignment, Ghost, GhostSettings, PastAnswer, Profile } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideLearning, factValueFor, Learner, LEARN_DEBOUNCE_MS, looksSecret, MAX_ANSWER_CHARS, MAX_PAST_ANSWERS, mergePastAnswer,
  normalizeQuestion, passesLuhn, pickMapping, sameValue, undoAnswer, undoFact,
} from "../src/content/learning";
import type { LearnerDeps } from "../src/content/learning";
import type { ToastRequest } from "../src/content/learnToast";
import { createEmitter } from "../src/lib/events";
import type { GhostEmitter } from "../src/lib/events";
import { getLearnedAnswers, getProfile, resetMemoryStorage, saveProfile } from "../src/lib/storage";

const ZERO = { x: 0, y: 0, width: 0, height: 0 };
const field = (over: Partial<CapturedField> & { signature: string; label: string }): CapturedField => ({ kind: "text", rect: ZERO, ...over });
const PHONE = field({ signature: "phone", label: "Phone number", kind: "tel", inputType: "tel", name: "phone" });
const FIRST = field({ signature: "first", label: "First name", name: "firstName" });
const LAST = field({ signature: "last", label: "Last name", name: "lastName" });
const EMAIL = field({ signature: "email", label: "Email", kind: "email", inputType: "email", name: "email" });
const ESSAY = field({ signature: "why", label: "Why do you want to work at Northwind?", kind: "textarea", name: "why" });
const ANSWER = "Because the logistics problems Northwind works on are the ones I enjoy most.";
const map = (f: CapturedField, factKey: string, confidence = 0.95): FieldAssignment => ({ signature: f.signature, factKey, confidence });
const profileOf = (facts: Record<string, string>, pastAnswers: PastAnswer[] = []): Profile => ({ facts, pastAnswers });
const NO_PHONE = profileOf({ firstName: "Alex", lastName: "Chen", email: "alex.chen.dev@example.com" });

describe("decideLearning: what may become a fact", () => {
  const decide = (over: Partial<Parameters<typeof decideLearning>[0]>) =>
    decideLearning({ field: PHONE, value: "+1 519 555 0142", mapping: map(PHONE, "phone"), profile: NO_PHONE, enabled: true, ...over });

  it("learns a value typed into a recognized field the profile has nothing for", () => {
    expect(decide({})).toEqual({ kind: "fact", key: "phone", value: "+1 519 555 0142" });
  });

  it("learns an update when the typed value really differs from the profile's", () => {
    const profile = profileOf({ phone: "+1 519 555 0142" });
    expect(decide({ profile, value: "+1 226 555 0199" })).toEqual({ kind: "fact", key: "phone", value: "+1 226 555 0199" });
  });

  it("keeps the profile's own spelling when the typed value is the same thing", () => {
    const profile = profileOf({ phone: "+1 519 555 0142", location: "Waterloo, ON" });
    expect(decide({ profile, value: "5195550142" })).toBeNull();
    expect(decide({ profile, value: "(519) 555-0142" })).toBeNull();
    const where = field({ signature: "loc", label: "Current location" });
    expect(decide({ profile, field: where, mapping: map(where, "location"), value: "Waterloo" })).toBeNull();
  });

  it("NEVER learns while learning is disabled", () => {
    expect(decide({ enabled: false })).toBeNull();
  });

  it("NEVER learns from a mapping below 0.85, from none, or from no mapping at all", () => {
    expect(decide({ mapping: map(PHONE, "phone", 0.84) })).toBeNull();
    expect(decide({ mapping: map(PHONE, NONE, 0.99) })).toBeNull();
    expect(decide({ mapping: null })).toBeNull();
    expect(decide({ mapping: map(PHONE, "phone", 0.85) })).not.toBeNull();
  });

  it.each([
    ["label", { label: "Social Insurance Number" }],
    ["name", { name: "card_number" }],
    ["autocomplete", { autocomplete: "cc-number" }],
    ["input type", { inputType: "password" }],
    ["placeholder", { placeholder: "Your password" }],
    ["section context", { context: "Payment: credit card details" }],
  ])("NEVER learns from a sensitive field (%s)", (_, over) => {
    expect(decide({ field: { ...PHONE, ...over } })).toBeNull();
  });

  it("NEVER learns a card-like number (13 to 19 digits passing Luhn), however it is spaced", () => {
    const other = field({ signature: "ref", label: "Referral source" });
    for (const value of ["4242424242424242", "4242 4242 4242 4242", "4242-4242-4242-4242", "378282246310005"]) {
      expect(decide({ field: other, mapping: map(other, "referralSource"), value })).toBeNull();
    }
    // 16 digits that fail Luhn are an order number, not a card.
    expect(decide({ field: other, mapping: map(other, "referralSource"), value: "4242424242424241" })).not.toBeNull();
  });

  it("NEVER learns a 9-digit SIN/SSN-like number", () => {
    for (const value of ["046 454 286", "123-45-6789", "123456789"]) expect(decide({ value })).toBeNull();
  });

  it("NEVER learns a fact whose key looks sensitive or is not a key", () => {
    expect(decide({ mapping: map(PHONE, "extra.passportNumber") })).toBeNull();
    expect(decide({ mapping: map(PHONE, "not a key") })).toBeNull();
  });

  it("only learns facts from typed fields: a select's or a radio's value is the site's code", () => {
    for (const kind of ["select", "radio", "checkbox", "textarea", "file"] as const) {
      expect(decide({ field: { ...PHONE, kind } })).toBeNull();
    }
  });

  it("refuses values that cannot be the fact", () => {
    expect(decide({ value: "call me maybe" })).toBeNull();
    expect(decide({ value: "   " })).toBeNull();
    expect(decide({ field: EMAIL, mapping: map(EMAIL, "email"), value: "not-an-email", profile: profileOf({}) })).toBeNull();
    expect(decide({ field: FIRST, mapping: map(FIRST, "firstName"), value: "Alex2", profile: profileOf({}) })).toBeNull();
  });
});

describe("decideLearning: essay answers", () => {
  const decide = (over: Partial<Parameters<typeof decideLearning>[0]>) =>
    decideLearning({ field: ESSAY, value: ANSWER, mapping: map(ESSAY, NEEDS_TEXT, 0.92), profile: NO_PHONE, enabled: true, ...over });

  it("saves the answer under the field's label and caps it at 2000 characters", () => {
    expect(decide({})).toEqual({ kind: "answer", question: ESSAY.label, answer: ANSWER });
    const long = decide({ value: "word ".repeat(1000) });
    expect(long?.kind === "answer" && long.answer.length).toBe(MAX_ANSWER_CHARS);
  });

  it("NEVER saves one when disabled, under 0.85, from a sensitive prompt, or quoting a secret", () => {
    expect(decide({ enabled: false })).toBeNull();
    expect(decide({ mapping: map(ESSAY, NEEDS_TEXT, 0.8) })).toBeNull();
    expect(decide({ field: { ...ESSAY, label: "What is your security question answer?" } })).toBeNull();
    expect(decide({ value: `${ANSWER} My card is 4242 4242 4242 4242.` })).toBeNull();
    expect(decide({ value: `${ANSWER} SIN 046-454-286.` })).toBeNull();
  });

  it("ignores scraps and fields that are not prose", () => {
    expect(decide({ value: "n/a" })).toBeNull();
    expect(decide({ field: { ...ESSAY, kind: "select" } })).toBeNull();
  });
});

describe("value helpers", () => {
  it("Luhn", () => {
    expect(passesLuhn("4242424242424242")).toBe(true);
    expect(passesLuhn("4242424242424241")).toBe(false);
    expect(passesLuhn("")).toBe(false);
  });

  it("looksSecret leaves phone numbers, dates and years alone", () => {
    for (const value of ["+1 519 555 0142", "2028-04", "2026-09-19", "Waterloo, ON N2L 3G1", "5195550142"]) expect(looksSecret(value)).toBe(false);
  });

  it("sameValue is about letters and digits, and needs four of them to call a part the same", () => {
    expect(sameValue("Alex Chen", "alex  chen")).toBe(true);
    expect(sameValue("https://github.com/alexchen-dev", "alexchen-dev")).toBe(true);
    expect(sameValue("Al", "Alex")).toBe(false);
    expect(sameValue("Waterloo", "Toronto")).toBe(false);
  });

  it("graduation dates are kept in the ISO shape the resolver reads", () => {
    expect(factValueFor("graduationDate", "2028-04")).toBe("2028-04");
    expect(factValueFor("graduationDate", "4/2028")).toBe("2028-04");
    expect(factValueFor("graduationDate", "next spring")).toBeNull();
  });
});

describe("pickMapping", () => {
  const offline = map(PHONE, "phone", 0.93);
  it("falls back to the offline heuristic when the server said nothing, or nothing confident", () => {
    expect(pickMapping(offline, undefined)).toBe(offline);
    expect(pickMapping(offline, { ...map(PHONE, "fullName", 0.5) })).toBe(offline);
    expect(pickMapping(undefined, undefined)).toBeNull();
  });

  it("trusts a confident served fact, but nobody when both are sure of different facts", () => {
    const served = map(PHONE, "phone", 0.97);
    expect(pickMapping(map(PHONE, NONE, 0.6), served)).toBe(served);
    expect(pickMapping(offline, map(PHONE, "fullName", 0.9))).toBeNull();
  });

  it("believes a calibrated 'not a fact', and only a calibrated one", () => {
    const weak = map(PHONE, "phone", 0.8);
    expect(pickMapping(weak, { ...map(PHONE, NONE, 0.95), calibrated: true })?.factKey).toBe(NONE);
    expect(pickMapping(weak, { ...map(PHONE, NONE, 0.95), calibrated: false })).toBe(weak);
  });
});

describe("past answers", () => {
  const entry = (question: string, answer: string, savedAt = "2026-09-19T00:00:00.000Z"): PastAnswer => ({ question, answer, origin: "http://localhost:5173", savedAt });

  it("dedupes by normalized question: the newest answer wins and moves to the end", () => {
    const list = [entry("Why Northwind?", "old"), entry("Tell us about a project", "project")];
    const merged = mergePastAnswer(list, entry("  why   northwind ", "new"));
    expect(merged.map((a) => a.answer)).toEqual(["project", "new"]);
    expect(normalizeQuestion("Why Northwind?")).toBe(normalizeQuestion("why northwind"));
  });

  it("keeps at most 50, dropping the oldest, and caps answers at 2000 characters", () => {
    let list: PastAnswer[] = [];
    for (let i = 0; i < MAX_PAST_ANSWERS + 5; i++) list = mergePastAnswer(list, entry(`Question number ${i}`, `answer ${i}`));
    expect(list).toHaveLength(MAX_PAST_ANSWERS);
    expect(list[0]?.answer).toBe("answer 5");
    expect(list.at(-1)?.answer).toBe(`answer ${MAX_PAST_ANSWERS + 4}`);
    expect(mergePastAnswer([], entry("Q", "x".repeat(5000)))[0]?.answer).toHaveLength(MAX_ANSWER_CHARS);
  });

  it("undo puts the replaced answer back, and leaves a profile alone that has moved on", () => {
    const old = entry("Why Northwind?", "old");
    const fresh = entry("Why Northwind?", "new");
    const after = profileOf({}, mergePastAnswer([old], fresh));
    expect(undoAnswer(after, fresh, old)?.pastAnswers).toEqual([old]);
    expect(undoAnswer(after, fresh, undefined)?.pastAnswers).toEqual([]);
    expect(undoAnswer(profileOf({}, [old]), fresh, old)).toBeNull();
  });

  it("undoFact restores the previous value, deletes a new key, and never clobbers a later edit", () => {
    expect(undoFact(profileOf({ phone: "new" }), { key: "phone", value: "new", previous: "old" })?.facts).toEqual({ phone: "old" });
    expect(undoFact(profileOf({ phone: "new" }), { key: "phone", value: "new", previous: undefined })?.facts).toEqual({});
    expect(undoFact(profileOf({ phone: "edited since" }), { key: "phone", value: "new", previous: "old" })).toBeNull();
  });
});

describe("Learner", () => {
  let events: GhostEmitter;
  let settings: GhostSettings;
  let toasts: ToastRequest[];
  let learner: Learner;
  let win: EventTarget;

  async function start(over: Partial<LearnerDeps> = {}, stored: Profile = NO_PHONE): Promise<void> {
    await saveProfile(stored);
    learner = new Learner({
      events,
      getSettings: () => settings,
      getProfile: () => stored,
      capture: () => [FIRST, LAST, EMAIL, PHONE, ESSAY],
      isSensitiveElement: () => false,
      toast: (request) => toasts.push(request),
      origin: () => "http://localhost:5173",
      now: () => new Date("2026-09-19T12:00:00Z"),
      win: win as unknown as Window,
      ...over,
    });
    learner.start();
  }

  const typed = (f: CapturedField, value: string): void => events.emit("user:input", { field: f, value, el: document.createElement("input") });
  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(LEARN_DEBOUNCE_MS);
    await learner.flush();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetMemoryStorage();
    events = createEmitter();
    settings = { ...DEFAULT_SETTINGS, learningEnabled: true };
    toasts = [];
    win = new EventTarget();
  });

  afterEach(() => {
    learner.stop();
    vi.useRealTimers();
  });

  it("is off by default: nothing is scheduled, captured or written", async () => {
    settings = { ...DEFAULT_SETTINGS };
    const capture = vi.fn(() => [PHONE]);
    await start({ capture });
    typed(PHONE, "+1 519 555 0142");
    await settle();
    expect(capture).not.toHaveBeenCalled();
    expect((await getProfile()).facts.phone).toBeUndefined();
    expect(toasts).toEqual([]);
  });

  it("learns a new fact after the debounce, through storage, and says so with the KEY only", async () => {
    await start();
    typed(PHONE, "+1 519 555 0142");
    expect((await getProfile()).facts.phone).toBeUndefined(); // not per event: only once the field is left alone
    await settle();
    expect((await getProfile()).facts.phone).toBe("+1 519 555 0142");
    expect(toasts.map((t) => t.text)).toEqual(["Ghost learned: phone"]);
  });

  it("persists a manual choice in the site-independent answer store", async () => {
    const authorization = field({
      signature: "auth",
      label: "Are you legally authorized to work in the United States?",
      kind: "select",
      options: [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }],
    });
    await start({ capture: () => [FIRST, authorization] });
    typed(authorization, "yes");
    await settle();
    expect((await getLearnedAnswers()).get(authorization)).toMatchObject({ value: "yes", optionLabel: "Yes", count: 1 });
  });

  it("debounces per field: the last committed value is the one lesson", async () => {
    await start();
    typed(PHONE, "+1 519 555 01");
    await vi.advanceTimersByTimeAsync(LEARN_DEBOUNCE_MS - 50);
    typed(PHONE, "+1 519 555 0142");
    await settle();
    expect((await getProfile()).facts.phone).toBe("+1 519 555 0142");
    expect(toasts).toHaveLength(1);
  });

  it("Undo takes a new fact away again and puts an updated one back", async () => {
    await start({}, profileOf({ ...NO_PHONE.facts, phone: "+1 519 555 0142" }));
    typed(PHONE, "+1 226 555 0199");
    await settle();
    expect((await getProfile()).facts.phone).toBe("+1 226 555 0199");
    toasts[0]?.onUndo();
    await vi.advanceTimersByTimeAsync(0);
    expect((await getProfile()).facts.phone).toBe("+1 519 555 0142");
  });

  it("decides against what storage holds now, not the page's stale copy of the profile", async () => {
    await start();
    await saveProfile(profileOf({ ...NO_PHONE.facts, phone: "+1 519 555 0142" })); // the options page saved it meanwhile
    typed(PHONE, "519-555-0142");
    await settle();
    expect((await getProfile()).facts.phone).toBe("+1 519 555 0142");
    expect(toasts).toEqual([]);
  });

  it("NEVER learns from an element capture calls sensitive, whatever the field record says", async () => {
    await start({ isSensitiveElement: () => true });
    const el = document.createElement("input");
    document.body.appendChild(el);
    events.emit("user:input", { field: PHONE, value: "+1 519 555 0142", el });
    await settle();
    el.remove();
    expect((await getProfile()).facts.phone).toBeUndefined();
  });

  it("NEVER learns the email of a login or newsletter box: the heuristic sees the whole form", async () => {
    await start({ capture: () => [EMAIL] }, profileOf({}));
    typed(EMAIL, "someone.else@example.com");
    await settle();
    expect((await getProfile()).facts.email).toBeUndefined();
  });

  it("NEVER learns when learning was switched off before the debounce ran out", async () => {
    await start();
    typed(PHONE, "+1 519 555 0142");
    settings = { ...settings, learningEnabled: false };
    await settle();
    expect((await getProfile()).facts.phone).toBeUndefined();
  });

  it("uses a confident served mapping, and backs off when it contradicts the heuristic", async () => {
    const vague = field({ signature: "reach", label: "Best way to reach you", kind: "tel", inputType: "tel" });
    await start({ capture: () => [FIRST, LAST, vague], served: () => ({ ...map(vague, "phone", 0.96), calibrated: true }) });
    typed(vague, "+1 519 555 0142");
    await settle();
    expect((await getProfile()).facts.phone).toBe("+1 519 555 0142");

    learner.stop();
    await start({ served: () => map(PHONE, "fullName", 0.95) }, profileOf({}));
    typed(PHONE, "+1 519 555 0142");
    await settle();
    expect((await getProfile()).facts).toEqual({});
  });

  it("saves typed essay answers with origin and time, newest per question", async () => {
    await start();
    typed(ESSAY, ANSWER);
    await settle();
    typed(ESSAY, `${ANSWER} Also, the team.`);
    await settle();
    expect((await getProfile()).pastAnswers).toEqual([
      { question: ESSAY.label, answer: `${ANSWER} Also, the team.`, origin: "http://localhost:5173", savedAt: "2026-09-19T12:00:00.000Z" },
    ]);
    expect(toasts.map((t) => t.text)).toEqual(["Ghost saved this answer", "Ghost saved this answer"]);
    toasts[1]?.onUndo();
    await vi.advanceTimersByTimeAsync(0);
    expect((await getProfile()).pastAnswers.map((a) => a.answer)).toEqual([ANSWER]); // Undo brings the replaced answer back
  });

  it("saves an ACCEPTED draft as a past answer, and nothing for an accepted fact ghost", async () => {
    await start();
    const ghost = (over: Partial<Ghost>): Ghost => ({ signature: ESSAY.signature, action: "fill", value: ANSWER, displayText: ANSWER, confidence: 0.8, locked: false, source: "llm", ...over });
    events.emit("ghost:accepted", { ghost: ghost({}), field: ESSAY, ms: 3 });
    events.emit("ghost:accepted", { ghost: ghost({ signature: PHONE.signature, source: "offline", value: "+1 226 555 0199" }), field: PHONE, ms: 3 });
    await settle();
    const stored = await getProfile();
    expect(stored.pastAnswers.map((a) => a.answer)).toEqual([ANSWER]);
    expect(stored.facts.phone).toBeUndefined();
  });

  it("writes nothing and shows nothing when the same answer is committed again", async () => {
    await start();
    typed(ESSAY, ANSWER);
    await settle();
    typed(ESSAY, ANSWER);
    await settle();
    expect(toasts).toHaveLength(1);
  });

  it("flushes what is still waiting when the page goes away, and stop() drops the rest", async () => {
    await start();
    typed(PHONE, "+1 519 555 0142");
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect((await getProfile()).facts.phone).toBe("+1 519 555 0142");

    typed(FIRST, "Jordan");
    learner.stop();
    await vi.advanceTimersByTimeAsync(LEARN_DEBOUNCE_MS * 2);
    expect((await getProfile()).facts.firstName).toBe("Alex");
  });
});
