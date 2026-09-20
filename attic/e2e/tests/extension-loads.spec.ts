import type { Page } from "@playwright/test";
import { DEMO_URL, expect, test } from "../fixtures";

const OVERLAY_HOST = "#ghost-overlay-host";

/** Page exceptions plus anything the content script logs: it runs in its own world, where pageerror never fires. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.text().includes("[ghost]")) errors.push(message.text());
  });
  return errors;
}

test("service worker is registered", async ({ context, extensionId }) => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  const urls = context.serviceWorkers().map((worker) => worker.url());
  expect(urls).toContain(`chrome-extension://${extensionId}/background.js`);
});

test("options page opens", async ({ page, extensionId }) => {
  const errors = collectPageErrors(page);
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page).toHaveURL(`chrome-extension://${extensionId}/options.html`);
  await expect(page).toHaveTitle(/Ghost/);
  expect(errors).toEqual([]);
});

test("demo page loads without extension errors", async ({ page, extensionId }) => {
  expect(extensionId).toBeTruthy();
  const errors = collectPageErrors(page);
  const response = await page.goto(`${DEMO_URL}/`);
  expect(response?.ok()).toBe(true);
  await page.waitForLoadState("load");
  await expect(page.locator(OVERLAY_HOST)).toBeAttached();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as { __submitted?: boolean }).__submitted)).toBeFalsy();
});

test("content script mounts the overlay host on the demo page", async ({ page, extensionId }) => {
  expect(extensionId).toBeTruthy();
  await page.goto(`${DEMO_URL}/`);
  const host = page.locator(OVERLAY_HOST);
  await expect(host).toBeAttached();
  await expect(host).toHaveAttribute("data-ghost-state", /^(idle|ready)$/);
});

test("the page cannot read predicted profile values out of the overlay", async ({ page }) => {
  await page.goto(`${DEMO_URL}/apply`);
  const host = page.locator(`${OVERLAY_HOST}[data-ghost-state="ready"]`);
  await expect(host).toBeAttached();
  // Main-world view of the host, which is all a hostile page gets: a closed root, no children, no values in attributes.
  const seen = await host.evaluate((el) => ({
    root: el.shadowRoot === null,
    html: el.innerHTML,
    attrs: el.getAttributeNames().map((name) => `${name}=${el.getAttribute(name)}`).join(" "),
  }));
  expect(seen.root).toBe(true);
  expect(seen.html).toBe("");
  expect(seen.attrs).not.toMatch(/alex|chen|519|waterloo|example\.com/i);
});
