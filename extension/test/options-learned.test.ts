import { recordCorrection } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLearnedAnswers, resetMemoryStorage, updateLearnedAnswers } from "../src/lib/storage";
import { learnedSection } from "../src/options/learned-section";
import { mountSections } from "../src/options/sections";

const FIELD = {
  label: "Are you legally authorized to work in the United States for any employer?",
  kind: "radio" as const,
  options: [{ value: "greenhouse-yes", label: "Yes" }, { value: "greenhouse-no", label: "No" }],
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("learned answers options section", () => {
  beforeEach(async () => {
    document.body.replaceChildren(document.createElement("nav"), document.createElement("main"));
    await mountSections(document.querySelector("nav") as HTMLElement, document.querySelector("main") as HTMLElement, [learnedSection]);
  });

  afterEach(() => {
    document.body.replaceChildren();
    resetMemoryStorage();
  });

  it("updates live, renders text safely, and forgets one answer", async () => {
    expect(document.querySelectorAll('[data-testid="learned-answer"]')).toHaveLength(0);
    await updateLearnedAnswers((store) => {
      recordCorrection(FIELD, "greenhouse-yes", store, {
        optionLabel: "<b>Yes</b>",
        origin: "https://greenhouse.localhost",
        now: 0,
      });
      return true;
    });
    await settle();
    expect(document.querySelectorAll('[data-testid="learned-answer"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="learned-answers"] b')).toBeNull();
    expect(document.querySelector('[data-testid="learned-answer"]')?.textContent).toContain("greenhouse.localhost");
    (document.querySelector('[data-testid="learned-delete"]') as HTMLButtonElement).click();
    await settle();
    expect((await getLearnedAnswers()).size).toBe(0);
    expect(document.querySelectorAll('[data-testid="learned-answer"]')).toHaveLength(0);
  });

  it("requires two clicks before forgetting every learned answer", async () => {
    await updateLearnedAnswers((store) => {
      recordCorrection(FIELD, "greenhouse-yes", store, { optionLabel: "Yes", now: 0 });
      return true;
    });
    await settle();
    const button = document.querySelector('[data-testid="learned-forget-all"]') as HTMLButtonElement;
    button.click();
    expect((await getLearnedAnswers()).size).toBe(1);
    expect(button.textContent).toMatch(/Click again/);
    button.click();
    await settle();
    expect((await getLearnedAnswers()).size).toBe(0);
  });
});
