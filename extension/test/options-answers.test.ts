// The "Learned answers" tab: what the user themselves answered, shown, deleted, forgotten per site, or
// promoted to a profile fact. Everything on this page came from the machine it is running on.
import { LearnedAnswerStore } from "@ghost/shared";
import type { CapturedField, LearnedAnswer } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLearnedAnswers, getProfile, resetMemoryStorage, updateLearnedAnswers } from "../src/lib/storage";
import { answersSection, factKeyFromQuestion, originSummary } from "../src/options/answers-section";
import { mountSections } from "../src/options/sections";

const ZERO = { x: 0, y: 0, width: 0, height: 0 };
const REFERRAL: CapturedField = {
  signature: "referral", label: "How did you hear about us?", kind: "select", rect: ZERO,
  options: [{ value: "li", label: "LinkedIn" }, { value: "other", label: "Other" }],
};
const VETERAN: CapturedField = {
  signature: "veteran", label: "Veteran status", kind: "select", rect: ZERO, context: "Voluntary self-identification",
  options: [{ value: "d", label: "I prefer not to answer" }],
};

const answer = (over: Partial<LearnedAnswer> = {}): LearnedAnswer => ({
  signature: "sig", textSignature: "text", label: "How did you hear about us?", kind: "select",
  value: "li", optionLabel: "LinkedIn", count: 1, updatedAt: "2026-09-19T12:00:00.000Z",
  origins: ["https://jobs.example.com"], class: "ordinary", ...over,
});

describe("answers-section helpers", () => {
  it("turns a question into a fact key, or refuses one that cannot be", () => {
    expect(factKeyFromQuestion("Preferred pronouns")).toBe("preferredPronouns");
    expect(factKeyFromQuestion("How did you hear about us?")).toBe("howDidYouHear");
    expect(factKeyFromQuestion("   ")).toBeNull();
    expect(factKeyFromQuestion("???")).toBeNull();
  });

  it("says how often an answer was given and where, by host and never by full URL", () => {
    expect(originSummary(answer())).toBe("1 time · jobs.example.com");
    expect(originSummary(answer({ count: 3, origins: ["https://a.test/x", "https://b.test"] }))).toBe("3 times · a.test, b.test");
    expect(originSummary(answer({ origins: [] }))).toBe("1 time");
  });
});

describe("the Learned answers tab", () => {
  const $ = <T extends HTMLElement>(testId: string): T => {
    const el = document.querySelector<T>(`[data-testid="${testId}"]`);
    if (!el) throw new Error(`missing ${testId}`);
    return el;
  };
  const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="answer-row"]')];
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  async function mount(): Promise<void> {
    const nav = document.createElement("nav");
    const panels = document.createElement("main");
    document.body.replaceChildren(nav, panels);
    await mountSections(nav, panels, [answersSection]);
  }

  async function seed(): Promise<void> {
    await updateLearnedAnswers((store) => {
      store.add({ field: REFERRAL, value: "li", optionLabel: "LinkedIn", origin: "https://jobs.example.com" });
      store.add({ field: VETERAN, value: "d", optionLabel: "I prefer not to answer", origin: "https://careers.other.test" });
      return true;
    });
  }

  beforeEach(() => resetMemoryStorage());
  afterEach(() => document.body.replaceChildren());

  it("says so plainly when nothing has been learned", async () => {
    await mount();
    expect($("answers-empty").hidden).toBe(false);
    expect($("answers-summary").textContent).toBe("0 learned answers");
  });

  it("lists what was learned, newest first, with its class and where it was used", async () => {
    await seed();
    await mount();
    expect($("answers-summary").textContent).toBe("2 learned answers");
    expect(rows()).toHaveLength(2);
    expect(rows()[0]?.dataset.class).toBe("protected");
    expect(rows()[0]?.textContent).toContain("Veteran status");
    expect(rows()[0]?.textContent).toContain("careers.other.test");
    expect(rows()[1]?.textContent).toContain("LinkedIn");
  });

  it("renders a question as text, never as markup", async () => {
    await updateLearnedAnswers((store) => {
      store.add({ field: { ...REFERRAL, label: "<img src=x onerror=alert(1)> Where?" }, value: "li", optionLabel: "LinkedIn" });
      return true;
    });
    await mount();
    expect(document.querySelector('[data-testid="answers-list"] img')).toBeNull();
    expect(rows()[0]?.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("deletes one answer and leaves the rest", async () => {
    await seed();
    await mount();
    const signature = rows()[1]?.dataset.signature ?? "";
    $<HTMLButtonElement>(`answer-forget-${signature}`).click();
    await settle();
    expect((await getLearnedAnswers()).getBySignature(signature)).toBeNull();
    expect((await getLearnedAnswers()).size).toBe(1);
  });

  it("forgets everything learned on one site without touching another", async () => {
    await seed();
    await mount();
    const signature = rows()[0]?.dataset.signature ?? "";
    $<HTMLButtonElement>(`answer-forget-site-${signature}`).click();
    await settle();
    const left = (await getLearnedAnswers()).list();
    expect(left).toHaveLength(1);
    expect(left[0]?.origins).toEqual(["https://jobs.example.com"]);
    expect($("answers-status").textContent).toContain("careers.other.test");
  });

  it("promotes an answer to a profile fact without forgetting the answer", async () => {
    await seed();
    await mount();
    const signature = rows()[1]?.dataset.signature ?? "";
    $<HTMLButtonElement>(`answer-promote-${signature}`).click();
    await settle();
    expect((await getProfile()).facts.howDidYouHear).toBe("li");
    expect((await getLearnedAnswers()).getBySignature(signature)).not.toBeNull();
  });

  it("follows a correction made in another tab", async () => {
    await mount();
    expect(rows()).toHaveLength(0);
    await seed();
    await settle();
    expect(rows()).toHaveLength(2);
  });

  it("never holds the store's own objects", async () => {
    await seed();
    const store = await getLearnedAnswers();
    store.list()[0]!.value = "tampered";
    expect(LearnedAnswerStore.fromJSON(store.toJSON()).list()[0]?.value).not.toBe("tampered");
  });
});
