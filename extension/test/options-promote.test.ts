// "Make this a profile fact" is a one-click change of what Ghost does with an answer everywhere afterwards,
// and a fact KEY is the one profile thing that rides on the wire. A protected characteristic or a legal
// declaration must not go through it (docs/answers.md sections 4 and 7).
import type { CapturedField } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLearnedAnswers, getProfile, resetMemoryStorage, updateLearnedAnswers } from "../src/lib/storage";
import { answersSection } from "../src/options/answers-section";
import { mountSections } from "../src/options/sections";

const ZERO = { x: 0, y: 0, width: 0, height: 0 };

const REFERRAL: CapturedField = {
  signature: "referral", label: "How did you hear about us?", kind: "select", rect: ZERO,
  options: [{ value: "li", label: "LinkedIn" }, { value: "other", label: "Other" }],
};
const GENDER: CapturedField = {
  signature: "gender", label: "Gender", kind: "select", rect: ZERO, context: "Voluntary self-identification",
  options: [{ value: "m", label: "Male" }, { value: "d", label: "I prefer not to answer" }],
};
const AUTHORIZATION: CapturedField = {
  signature: "auth", label: "Are you legally authorized to work in the United States?", kind: "select", rect: ZERO,
  options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
};

const $ = <T extends HTMLElement>(testId: string): T => {
  const el = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`missing ${testId}`);
  return el;
};
const rowFor = (signature: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="answer-row"][data-signature="${signature}"]`);
  if (!el) throw new Error(`missing row ${signature}`);
  return el;
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(): Promise<void> {
  const nav = document.createElement("nav");
  const panels = document.createElement("main");
  document.body.replaceChildren(nav, panels);
  await mountSections(nav, panels, [answersSection]);
}

async function seed(): Promise<Record<string, string>> {
  const signatures: Record<string, string> = {};
  await updateLearnedAnswers((store) => {
    signatures["referral"] = store.add({ field: REFERRAL, value: "li", optionLabel: "LinkedIn", origin: "https://jobs.example.com" }).answer?.signature ?? "";
    signatures["gender"] = store.add({ field: GENDER, value: "m", optionLabel: "Male", origin: "https://jobs.example.com" }).answer?.signature ?? "";
    signatures["auth"] = store.add({ field: AUTHORIZATION, value: "yes", optionLabel: "Yes", origin: "https://jobs.example.com" }).answer?.signature ?? "";
    return true;
  });
  return signatures;
}

beforeEach(() => resetMemoryStorage());
afterEach(() => document.body.replaceChildren());

describe("promoting a learned answer to a profile fact", () => {
  it("refuses a protected characteristic, and says why", async () => {
    const signatures = await seed();
    await mount();
    const signature = signatures["gender"] ?? "";
    const button = rowFor(signature).querySelector<HTMLButtonElement>(`[data-testid="answer-promote-${signature}"]`);
    expect(button?.disabled).toBe(true);
    expect(button?.title).toContain("never promoted to a profile fact");

    // And again with the button forced open, because the refusal that matters is the one in the handler.
    button?.removeAttribute("disabled");
    button?.click();
    await settle();
    const facts = (await getProfile()).facts;
    // No `gender` fact, and therefore no `gender` key in a later predict request either.
    expect(Object.keys(facts)).not.toContain("gender");
    expect($("answers-status").textContent).toContain("never promoted");
    // The answer itself is untouched: it still answers that one question, locally.
    expect((await getLearnedAnswers()).getBySignature(signature)).not.toBeNull();
  });

  it("refuses a legal declaration too", async () => {
    const signatures = await seed();
    await mount();
    const signature = signatures["auth"] ?? "";
    const button = rowFor(signature).querySelector<HTMLButtonElement>(`[data-testid="answer-promote-${signature}"]`);
    expect(button?.disabled).toBe(true);
    button?.removeAttribute("disabled");
    button?.click();
    await settle();
    const facts = (await getProfile()).facts;
    expect(Object.keys(facts).some((key) => key.startsWith("areYouLegally"))).toBe(false);
  });

  it("still promotes an ordinary answer", async () => {
    const signatures = await seed();
    await mount();
    const signature = signatures["referral"] ?? "";
    const button = rowFor(signature).querySelector<HTMLButtonElement>(`[data-testid="answer-promote-${signature}"]`);
    expect(button?.disabled).toBe(false);
    button?.click();
    await settle();
    expect((await getProfile()).facts["howDidYouHear"]).toBe("li");
  });
});
