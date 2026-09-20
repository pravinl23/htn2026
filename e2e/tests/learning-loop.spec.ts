import type { Page } from "@playwright/test";
import { expect, readGhostText, readStorage, test } from "../fixtures";

const ANSWERS_KEY = "ghost.answers";

interface StoredAnswers {
  answers: Array<{ value: string; optionLabel?: string; count: number; origins: string[] }>;
}

async function openSite(page: Page, site: "greenhouse" | "amazon" | "airbnb"): Promise<void> {
  await page.goto(`http://${site}.localhost:5173/learning-sites/`);
  await expect(page.locator("#surface")).toHaveText(site);
  await expect.poll(async () => (await readGhostText(page, "workAuthorization"))?.text ?? "").not.toBe("");
}

test.describe("one local learning loop across sites", () => {
  test.use({ settings: { learningEnabled: true } });

  test("a Greenhouse correction becomes the instant Amazon and Airbnb proposal", async ({ page, worker }) => {
    await openSite(page, "greenhouse");
    await expect.poll(async () => (await readGhostText(page, "workAuthorization"))?.text).toBe("No");

    await page.locator("label[for=work-auth-yes]").click();
    await expect(page.locator("#work-auth-yes")).toBeChecked();
    await expect.poll(async () => (await readStorage<StoredAnswers>(worker, ANSWERS_KEY))?.answers[0]?.optionLabel).toBe("Yes");

    await openSite(page, "amazon");
    await expect.poll(async () => (await readGhostText(page, "workAuthorization"))?.text).toBe("Yes");
    await page.locator("#work-auth-no").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#work-auth-yes")).toBeChecked();

    await openSite(page, "airbnb");
    await expect.poll(async () => (await readGhostText(page, "workAuthorization"))?.text).toBe("Yes");
    await page.locator("#work-auth-no").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#work-auth-yes")).toBeChecked();

    const stored = await readStorage<StoredAnswers>(worker, ANSWERS_KEY);
    expect(stored?.answers).toHaveLength(1);
    expect(stored?.answers[0]).toMatchObject({ value: "gh-yes", optionLabel: "Yes", count: 1 });
  });
});
