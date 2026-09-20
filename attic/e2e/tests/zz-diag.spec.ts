// TEMPORARY diagnostic. Deleted before the run is reported.
import type { Page } from "@playwright/test";
import { DEMO_URL, HOST, expect, test } from "../fixtures";

interface Seen { key: string; code: string; location: number; repeat: boolean; type: string; alt: boolean; trusted: boolean }

test("what does Playwright's AltRight actually look like in the page?", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __seen: Seen[] }).__seen = [];
    const record = (event: KeyboardEvent): void => {
      (window as unknown as { __seen: Seen[] }).__seen.push({
        key: event.key, code: event.code, location: event.location, repeat: event.repeat,
        type: event.type, alt: event.altKey, trusted: event.isTrusted,
      });
    };
    window.addEventListener("keydown", record, true);
    window.addEventListener("keyup", record, true);
  });

  await page.goto(`${DEMO_URL}/apply`);
  const host = page.locator(HOST);
  await expect(host).toHaveAttribute("data-ghost-state", "ready", { timeout: 20_000 });
  await page.evaluate(() => document.getElementById("apply-title")?.scrollIntoView({ block: "start" }));
  await page.locator("#first-name").focus();

  await page.keyboard.down("AltRight");
  await page.keyboard.up("AltRight");
  await page.waitForTimeout(400);
  console.log(`SEEN ${JSON.stringify(await page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen))}`);
  const a = await page.evaluate((id) => Object.fromEntries(Array.from(document.getElementById(id)?.attributes ?? [], (x) => [x.name, x.value])), HOST.slice(1));
  console.log(`AFTER ⌥ tap: accepted=${a["data-ghost-accepted"]} count=${a["data-ghost-count"]} key=${a["data-ghost-key"]}`);

  // and via a raw CDP-free synthetic, to see whether the watcher itself is the problem
  await page.evaluate(() => {
    const init = { key: "Alt", code: "AltRight", location: 2, bubbles: true, cancelable: true };
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", init));
    document.activeElement?.dispatchEvent(new KeyboardEvent("keyup", init));
  });
  await page.waitForTimeout(400);
  const b = await page.evaluate((id) => Object.fromEntries(Array.from(document.getElementById(id)?.attributes ?? [], (x) => [x.name, x.value])), HOST.slice(1));
  console.log(`AFTER synthetic (untrusted, should be ignored): accepted=${b["data-ghost-accepted"]}`);
});
