import { expect, test } from "@playwright/test";
import { E2E_SERVER_URL } from "../fixtures";

test("atomic workflow demo completes the three-step meeting story", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`/workflow/index.html?server=${encodeURIComponent(E2E_SERVER_URL)}`);

  await expect(page.locator("#title")).toHaveText("Check calendar availability");
  await expect(page.locator("#meta")).toContainText("heuristic");
  await page.keyboard.press("Tab");

  await expect(page.locator("#title")).toHaveText("Create draft response");
  await expect(page.locator("#timeline")).toContainText("Calendar checked");
  await page.keyboard.press("Tab");

  await expect(page.locator("#title")).toHaveText("Create tentative event");
  await expect(page.locator("#timeline")).toContainText("Draft created");
  await page.keyboard.press("Tab");

  await expect(page.locator("#timeline")).toContainText("Workflow complete");
  await expect(page.locator("#timeline")).toContainText("Event created");
  await expect(page.locator("#suggestion")).toBeHidden();
  expect(errors).toEqual([]);
});

test("workflow demo can turn a visible Slack report into a reviewed issue", async ({ page }) => {
  await page.goto(`/workflow/index.html?server=${encodeURIComponent(E2E_SERVER_URL)}`);
  await expect(page.locator("#title")).toHaveText("Check calendar availability");

  await page.locator("#issue").click();
  await expect(page.locator("#title")).toHaveText("Create GitHub issue");
  await expect(page.locator("#subject")).toHaveText("Checkout crashes after applying a coupon");
  await page.keyboard.press("Tab");

  await expect(page.locator("#timeline")).toContainText("GitHub issue #42 created");
  await expect(page.locator("#timeline")).toContainText("Workflow complete");
});
