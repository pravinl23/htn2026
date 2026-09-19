// Hostile and awkward markup: honeypots, card fields without autocomplete, input masks, a sticky header,
// a scroll box, a page dialog. Runs against the local lab page only (demo/public/lab).
import type { Locator, Page } from "@playwright/test";
import { DEMO_URL, expect, test } from "../fixtures";

const HOST = "#ghost-overlay-host";
// first name, phone, LinkedIn, GitHub, website, school, plus the locked Send button.
const GHOSTS = 7;

interface LabWindow {
  __submitted?: boolean;
  __escapes?: number;
}

async function openLab(page: Page): Promise<Locator> {
  await page.goto(`${DEMO_URL}/lab/`);
  const host = page.locator(`${HOST}[data-ghost-state="ready"]`);
  await expect(host).toBeAttached();
  await expect(host).toHaveAttribute("data-ghost-count", String(GHOSTS));
  return page.locator(HOST);
}

async function accepted(page: Page): Promise<number> {
  return Number((await page.locator(HOST).getAttribute("data-ghost-accepted")) ?? "0");
}

async function values(page: Page, ids: string[]): Promise<Record<string, string>> {
  return page.evaluate((list) => Object.fromEntries(list.map((id) => [id, (document.getElementById(id) as HTMLInputElement).value])), ids);
}

test.describe("hardening: what Ghost must not do on a hostile page", () => {
  test("walks only what a person can see: no honeypot, no card field, no invented day, and a masked phone counts as filled", async ({ page }) => {
    const host = await openLab(page);
    for (let n = 1; n < GHOSTS; n++) {
      await page.keyboard.press("Tab");
      await expect(host).toHaveAttribute("data-ghost-accepted", String(n));
    }
    await expect(host).toHaveAttribute("data-ghost-current-locked", "true");
    await expect(page.locator("#lab-submit")).toBeFocused();
    expect(await host.getAttribute("data-ghost-error")).toBeNull(); // the mask rewrote our phone number; that is not a failure

    expect(await values(page, ["first", "phone", "linkedin", "github", "site", "school"])).toEqual({
      first: "Alex",
      phone: "(519) 555-0142",
      linkedin: "https://linkedin.com/in/alexchen-dev",
      github: "https://github.com/alexchen-dev",
      site: "https://alexchen.dev",
      school: "University of Waterloo",
    });
    const untouched = ["hp1", "hp2", "hp3", "hp4", "holder", "number", "exp", "code", "start", "notes"];
    expect(await values(page, untouched)).toEqual(Object.fromEntries(untouched.map((id) => [id, ""])));
    expect(await page.evaluate(() => (window as LabWindow).__submitted)).toBeFalsy();
  });

  test("Tab pressed in an unrelated control stays native", async ({ page }) => {
    await openLab(page);
    await page.locator("#site-search").click();
    await page.keyboard.type("robots");
    await page.keyboard.press("Tab");
    await expect(page.locator("#open-modal")).toBeFocused();
    await page.locator("#notes").click();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250); // negative check: give a wrongly intercepted Tab time to write
    expect(await accepted(page)).toBe(0);
    expect(await values(page, ["first", "phone"])).toEqual({ first: "", phone: "" });
  });

  test("Escape reaches the page's own dialog, and off-screen ghosts never eat it", async ({ page }) => {
    const host = await openLab(page);
    await page.locator("#open-modal").click();
    await expect(page.locator("#modal")).toHaveAttribute("data-open", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal")).toHaveAttribute("data-open", "false");

    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, document.body.scrollHeight);
    });
    await expect(page.locator("#first")).not.toBeInViewport();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => (window as LabWindow).__escapes)).toBe(3);
    await expect(host).toHaveAttribute("data-ghost-count", String(GHOSTS)); // nothing was silently dismissed
  });

  test("a field hidden under the sticky header is not a Tab target", async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => {
      const first = document.getElementById("first") as HTMLElement;
      window.scrollBy(0, first.getBoundingClientRect().top - 8); // its middle now sits under the header
    });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250); // negative check
    expect(await accepted(page)).toBe(0);
    expect(await values(page, ["first"])).toEqual({ first: "" });
    await expect(page.locator("#site-search")).toBeFocused(); // native Tab went where the browser sends it
  });

  test("the dialog covering the form hands Tab back to the page", async ({ page }) => {
    await openLab(page);
    await page.locator("#open-modal").click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Tab");
    await page.waitForTimeout(250); // negative check
    expect(await accepted(page)).toBe(0);
    expect(await values(page, ["first"])).toEqual({ first: "" });
  });

  test("an application form embedded in an iframe gets its own ghosts", async ({ page }) => {
    await page.goto(`${DEMO_URL}/lab/embed.html`);
    const frame = page.frameLocator("#embedded-form");
    const host = frame.locator(`${HOST}[data-ghost-state="ready"]`);
    await expect(host).toBeAttached();
    await frame.locator("#first-name").click();
    await page.keyboard.press("Tab");
    await expect(frame.locator(HOST)).toHaveAttribute("data-ghost-accepted", "1");
    await expect(frame.locator("#first-name")).toHaveValue("Alex");
    await expect(frame.locator("#last-name")).toBeFocused();
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "idle"); // the outer page has nothing to offer
  });
});
