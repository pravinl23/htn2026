// Recording a correction (docs/answers.md section 4), where it is kept, and the value-free counters that
// come with it (section 6). Nothing here ever leaves the machine, and no value is ever counted or logged.
import { ANSWER_COUNTER_NAMES, DEFAULT_SETTINGS, LearnedAnswerStore } from "@ghost/shared";
import type { CapturedField, Ghost, GhostSettings, Profile } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TOAST, Learner, LEARN_DEBOUNCE_MS, optionLabelFor, undoLearnedAnswer } from "../src/content/learning";
import type { LearnerDeps } from "../src/content/learning";
import type { ToastRequest } from "../src/content/learnToast";
import { createEmitter } from "../src/lib/events";
import type { GhostEmitter } from "../src/lib/events";
import {
  addAnswerCounters, getLearnedAnswers, getMetrics, normalizeMetrics, resetMemoryStorage, saveProfile, updateLearnedAnswers,
} from "../src/lib/storage";

const ZERO = { x: 0, y: 0, width: 0, height: 0 };
const field = (over: Partial<CapturedField> & { signature: string; label: string }): CapturedField => ({ kind: "text", rect: ZERO, ...over });

const REFERRAL = field({
  signature: "referral", label: "How did you hear about us?", kind: "select", name: "referralSource",
  options: [{ value: "hn", label: "Hack the North" }, { value: "li", label: "LinkedIn" }, { value: "other", label: "Other" }],
});
const GENDER = field({
  signature: "gender", label: "Gender", kind: "select", context: "Voluntary self-identification",
  options: [{ value: "m", label: "Male" }, { value: "d", label: "I don't wish to answer" }],
});
const SIN = field({ signature: "sin", label: "Social Insurance Number" });
const PROFILE: Profile = { facts: { firstName: "Alex", email: "alex.chen.dev@example.com" }, pastAnswers: [] };

describe("optionLabelFor", () => {
  it("finds the visible text behind a chosen value, by value or by label", () => {
    expect(optionLabelFor(REFERRAL, "li")).toBe("LinkedIn");
    expect(optionLabelFor(REFERRAL, "LinkedIn")).toBe("LinkedIn");
    expect(optionLabelFor(REFERRAL, "nope")).toBeUndefined();
    expect(optionLabelFor(field({ signature: "t", label: "Name" }), "Alex")).toBeUndefined();
  });
});

describe("undoLearnedAnswer", () => {
  const learn = (store: LearnedAnswerStore, value: string, optionLabel: string) =>
    store.add({ field: REFERRAL, value, optionLabel, origin: "https://jobs.example.com" }).answer;

  it("takes the new answer away and brings the one it replaced back", () => {
    const store = new LearnedAnswerStore();
    const first = learn(store, "hn", "Hack the North");
    const second = learn(store, "li", "LinkedIn");
    expect(undoLearnedAnswer(store, second!, first)).toBe(true);
    expect(store.get(REFERRAL)?.optionLabel).toBe("Hack the North");
  });

  it("leaves a store that has moved on since exactly as it is", () => {
    const store = new LearnedAnswerStore();
    const stale = learn(store, "li", "LinkedIn");
    learn(store, "other", "Other");
    expect(undoLearnedAnswer(store, stale!, null)).toBe(false);
    expect(store.get(REFERRAL)?.optionLabel).toBe("Other");
  });
});

describe("ghost.answers and the answer counters in storage", () => {
  beforeEach(() => resetMemoryStorage());

  it("round-trips the store through chrome.storage.local", async () => {
    await updateLearnedAnswers((store) => store.add({ field: REFERRAL, value: "li", optionLabel: "LinkedIn" }).answer !== null);
    const reloaded = await getLearnedAnswers();
    expect(reloaded.get(REFERRAL)).toMatchObject({ value: "li", optionLabel: "LinkedIn", count: 1, class: "ordinary" });
  });

  it("adds up only the counter names the answer engine can produce", async () => {
    const name = ANSWER_COUNTER_NAMES[0] as string;
    await addAnswerCounters({ [name]: 2, "answer.invented.by.a.page": 99 });
    await addAnswerCounters({ [name]: 1 });
    const metrics = await getMetrics();
    expect(metrics.answers).toEqual({ [name]: 3 });
  });

  it("reads junk under `answers` as nothing at all", () => {
    expect(normalizeMetrics({ answers: { "answer.corrected.ordinary": "lots", nonsense: 4 } }).answers).toEqual({});
  });
});

describe("the Learner records a correction", () => {
  let events: GhostEmitter;
  let settings: GhostSettings;
  let toasts: ToastRequest[];
  let counters: Record<string, number>;
  let learner: Learner;
  let win: EventTarget;

  async function start(over: Partial<LearnerDeps> = {}): Promise<void> {
    await saveProfile(PROFILE);
    learner = new Learner({
      events,
      getSettings: () => settings,
      getProfile: () => PROFILE,
      capture: () => [REFERRAL, GENDER, SIN],
      isSensitiveElement: () => false,
      toast: (request) => toasts.push(request),
      counters: (deltas) => {
        for (const [name, delta] of Object.entries(deltas)) counters[name] = (counters[name] ?? 0) + delta;
      },
      origin: () => "https://jobs.example.com",
      now: () => new Date("2026-09-19T12:00:00Z"),
      win: win as unknown as Window,
      ...over,
    });
    learner.start();
  }

  const answered = (f: CapturedField, value: string): void =>
    events.emit("user:input", { field: f, value, el: document.createElement("input") });

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
    counters = {};
    win = new EventTarget();
  });

  afterEach(() => {
    learner.stop();
    vi.useRealTimers();
  });

  it("keeps what the user chose, with the option's own words, and says it will remember", async () => {
    await start();
    answered(REFERRAL, "li");
    await settle();
    const stored = await getLearnedAnswers();
    expect(stored.get(REFERRAL)).toMatchObject({ value: "li", optionLabel: "LinkedIn", origins: ["https://jobs.example.com"] });
    expect(toasts.map((t) => t.text)).toEqual([ANSWER_TOAST]);
    expect(counters).toEqual({ "answer.corrected.ordinary": 1 });
  });

  it("Undo takes the remembered answer away again", async () => {
    await start();
    answered(REFERRAL, "li");
    await settle();
    toasts[0]?.onUndo();
    await vi.advanceTimersByTimeAsync(0);
    expect((await getLearnedAnswers()).get(REFERRAL)).toBeNull();
  });

  it("counts the same answer again without a second chip", async () => {
    await start();
    answered(REFERRAL, "li");
    await settle();
    answered(REFERRAL, "li");
    await settle();
    expect((await getLearnedAnswers()).get(REFERRAL)?.count).toBe(2);
    expect(toasts).toHaveLength(1);
  });

  it("remembers a protected answer the user gave, and keeps it on this machine", async () => {
    await start();
    answered(GENDER, "m");
    await settle();
    expect((await getLearnedAnswers()).get(GENDER)).toMatchObject({ value: "m", class: "protected" });
    expect(counters).toEqual({ "answer.corrected.protected": 1 });
  });

  it("NEVER remembers a sensitive field, whatever the user types into it", async () => {
    await start();
    answered(SIN, "046 454 286");
    await settle();
    expect((await getLearnedAnswers()).size).toBe(0);
    expect(toasts).toEqual([]);
    expect(JSON.stringify(await getMetrics())).not.toContain("046");
  });

  it("remembers nothing at all while learning is switched off", async () => {
    settings = { ...DEFAULT_SETTINGS };
    await start();
    answered(REFERRAL, "li");
    await settle();
    expect((await getLearnedAnswers()).size).toBe(0);
  });

  it("says whether the proposal it replaced was a guess, and never what either of them was", async () => {
    await start();
    const guess: Ghost = {
      signature: REFERRAL.signature, action: "select", value: "other", displayText: "Other", confidence: 0.72,
      locked: false, source: "offline", guess: true, answerClass: "ordinary", answerSource: "guess",
    };
    events.emit("ghost:dismissed", { ghost: guess, reason: "typed" });
    answered(REFERRAL, "li");
    await settle();
    expect(counters).toEqual({ "answer.proposed.ordinary.guess": 1, "answer.corrected.ordinary": 1 });
  });

  it("counts an accepted answer-engine ghost, and leaves an ordinary fact ghost to the usual metrics", async () => {
    await start();
    const base = { signature: GENDER.signature, action: "select" as const, value: "d", displayText: "I don't wish to answer", confidence: 0.8, locked: false, source: "offline" as const };
    events.emit("ghost:accepted", { ghost: { ...base, answerClass: "protected", answerSource: "fact" }, field: GENDER, ms: 3 });
    events.emit("ghost:accepted", { ghost: { ...base, signature: "plain" }, field: REFERRAL, ms: 3 });
    expect(counters).toEqual({ "answer.accepted.protected.fact": 1 });
  });
});
