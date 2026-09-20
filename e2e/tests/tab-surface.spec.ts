// One owner of Tab per moment (extension/src/content/tabSurface.ts, docs/compare-approaches.md §3.6).
//
// Ghost binds keydown on `window` in the CAPTURE phase and swallows Tab with preventDefault +
// stopPropagation, so a page that runs its own Tab-driven surface — approach B's workflow page, a command
// palette, an editor — can never win the key by registering first. This spec proves the way out, with the
// built extension loaded in every test:
//   1. approach B's real page, served with <meta name="ghost-tab" content="off">: B's three-step story runs
//      and Ghost puts nothing on the page at all.
//   2. Ghost's own page in the same browser: the walk is untouched by the opt-out existing.
//   3. a page that flips `data-ghost-tab="active"` at runtime: Ghost hands the key back within one rescan and
//      takes it up again when the page gives it up.
// Localhost only, headless, no keys.
import type { Page } from "@playwright/test";
import { scrollToForm } from "../apply";
import { DEMO_URL, E2E_SERVER_URL, HOST, expect, test } from "../fixtures";

const NEXT_HOST = "#ghost-next-host";
const WORKFLOW_PATH = "/workflow/index.html";
const WORKFLOW_URL = `${DEMO_URL}${WORKFLOW_PATH}?server=${encodeURIComponent(E2E_SERVER_URL)}`;

/** The counters a B-style page handler would keep: how much of Tab ever reaches the page world. */
interface ProbeWindow {
  __tabsSeen?: number;
  __approvals?: number;
}

/**
 * Gives approach B's own page the opt-out meta in its head, without editing the demo (that file belongs to
 * the workflow stream). This is exactly the one-line change docs/compare-approaches.md asks them for.
 *
 * The meta is written at document start, before any page script and long before the content script has
 * finished reading storage, so Ghost sees it on its first look. It is NOT served through `page.route`:
 * a fulfilled document puts the page in an address space Chrome then refuses to let reach 127.0.0.1,
 * which would break the page's own calls to the prediction server rather than testing anything of ours.
 */
async function serveWithOptOut(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const write = (): boolean => {
      if (!document.head || document.querySelector('meta[name="ghost-tab"]')) return document.head !== null;
      const meta = document.createElement("meta");
      meta.setAttribute("name", "ghost-tab");
      meta.setAttribute("content", "off");
      document.head.appendChild(meta);
      return true;
    };
    if (write()) return;
    const observer = new MutationObserver(() => {
      if (write()) observer.disconnect();
    });
    observer.observe(document.documentElement ?? document, { childList: true, subtree: true });
  });
}

/** A page-world Tab handler with approach B's exact contract (demo/public/workflow/index.html:125). */
async function installTabProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as ProbeWindow;
    w.__tabsSeen = 0;
    w.__approvals = 0;
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      w.__tabsSeen = (w.__tabsSeen ?? 0) + 1;
      if (event.shiftKey || event.metaKey || event.altKey || event.ctrlKey) return;
      event.preventDefault();
      w.__approvals = (w.__approvals ?? 0) + 1;
    });
  });
}

async function readProbe(page: Page): Promise<{ seen: number; approvals: number }> {
  return page.evaluate(() => ({ seen: (window as ProbeWindow).__tabsSeen ?? -1, approvals: (window as ProbeWindow).__approvals ?? -1 }));
}

async function declareTabSurface(page: Page, value: string | null): Promise<void> {
  await page.evaluate((v) => {
    if (v === null) document.documentElement.removeAttribute("data-ghost-tab");
    else document.documentElement.setAttribute("data-ghost-tab", v);
  }, value);
}

test.describe("a page that declares it owns Tab", () => {
  test("approach B's page, served with the opt-out, keeps every Tab and Ghost never appears", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    // First prove the extension really is in this browser and this profile: its own demo page gets ghosts.
    await page.goto(`${DEMO_URL}/apply`);
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "ready", { timeout: 20_000 });

    await serveWithOptOut(page);
    await page.goto(WORKFLOW_URL);
    await expect(page.locator("#title")).toHaveText("Check calendar availability", { timeout: 20_000 });
    expect(await page.evaluate(() => document.querySelector('meta[name="ghost-tab"]')?.getAttribute("content")), "the page really did opt out").toBe("off");

    // Ghost stood down entirely: no overlay host, no next-action host, no loop sheet.
    await expect(page.locator(HOST), "an opted-out page carries no Ghost overlay").toHaveCount(0);
    await expect(page.locator(NEXT_HOST)).toHaveCount(0);
    await expect(page.locator("#ghost-loop-host")).toHaveCount(0);

    // B's three-step meeting story, driven only by Tab.
    await page.keyboard.press("Tab");
    await expect(page.locator("#title")).toHaveText("Create draft response");
    await page.keyboard.press("Tab");
    await expect(page.locator("#title")).toHaveText("Create tentative event");
    await page.keyboard.press("Tab");
    await expect(page.locator("#timeline")).toContainText("Workflow complete");
    await expect(page.locator("#timeline")).toContainText("Event created");

    await expect(page.locator(HOST), "and Ghost stayed away for the whole story").toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Ghost's own page in the same browser still walks: the opt-out costs the form walk nothing", async ({ page }) => {
    await page.goto(`${DEMO_URL}/apply`);
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready", { timeout: 20_000 });
    expect(Number(await host.getAttribute("data-ghost-count"))).toBeGreaterThan(1);
    await scrollToForm(page); // the form starts below the fold, where the first Tab only jumps to it

    await page.keyboard.press("Tab");
    await expect(host).toHaveAttribute("data-ghost-accepted", "1");
    await expect(page.locator("#first-name")).toHaveValue("Alex");
  });

  test("an active Tab surface takes the key back mid-page, and giving it up hands it to Ghost again", async ({ page }) => {
    await installTabProbe(page);
    await page.goto(`${DEMO_URL}/apply`);
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready", { timeout: 20_000 });
    const before = Number(await host.getAttribute("data-ghost-count"));
    expect(before, "Ghost has plenty to say on this page").toBeGreaterThan(1);
    await scrollToForm(page);

    // The page declares its own surface active. Ghost drops every ghost on the next rescan.
    await declareTabSurface(page, "active");
    await expect(host, "Ghost takes its ghosts away while the page owns Tab").toHaveAttribute("data-ghost-count", "0");
    await page.keyboard.press("Tab");
    const yielded = await readProbe(page);
    expect(yielded, "the page's own handler gets the key").toEqual({ seen: 1, approvals: 1 });
    await expect(host, "and Ghost filled nothing").toHaveAttribute("data-ghost-accepted", "0");
    await expect(page.locator("#first-name")).toHaveValue("");

    // The page gives Tab back: the walk returns and swallows the key again.
    await declareTabSurface(page, null);
    await expect(host).toHaveAttribute("data-ghost-state", "ready");
    await page.keyboard.press("Tab");
    await expect(host).toHaveAttribute("data-ghost-accepted", "1");
    await expect(page.locator("#first-name")).toHaveValue("Alex");
    expect(await readProbe(page), "Ghost's capture-phase handler keeps the page out again").toEqual({ seen: 1, approvals: 1 });
  });
});
