// Stage 1: Tab walks the job application with the offline heuristic provider. Localhost only.
import type { Locator, Page } from "@playwright/test";
import { DEMO_URL, expect, test } from "../fixtures";

const HOST = "#ghost-overlay-host";
const SUBMIT = "[data-testid=submit]";
const MAX_TABS = 40;
const VIDEO_PACE_MS = 320;

/** The fictional Alex Chen demo profile, written out here so the test is an independent oracle. */
const EXPECTED: Record<string, string> = {
  firstName: "Alex",
  lastName: "Chen",
  email: "alex.chen.dev@example.com",
  phone: "+1 519 555 0142",
  location: "Waterloo, ON",
  linkedin: "https://linkedin.com/in/alexchen-dev",
  github: "https://github.com/alexchen-dev",
  website: "https://alexchen.dev",
  school: "University of Waterloo",
  degree: "BCS Computer Science",
  graduationDate: "2028-04",
  workAuthorization: "yes",
  sponsorship: "no",
  referralSource: "Hack the North",
};
const UNTOUCHED: Record<string, string | boolean> = {
  whyNorthwind: "", project: "", resume: "", consent: false, sin: "", payrollPassword: "",
};
const PROFILE_FIELD_COUNT = Object.keys(EXPECTED).length;

type FormValues = Record<string, string | boolean>;
interface DemoWindow {
  __submitted?: boolean;
  __formState?: FormValues;
  __submitAttempts?: number;
}
interface HostState {
  count: number;
  accepted: number;
  locked: boolean;
  current: string;
}

/** A failed validation leaves __submitted false, so submit events and Submit clicks are counted too. */
async function countSubmitAttempts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as DemoWindow;
    w.__submitAttempts = 0;
    const bump = (): void => void (w.__submitAttempts = (w.__submitAttempts ?? 0) + 1);
    window.addEventListener("submit", bump, true);
    window.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-testid=submit]")) bump();
    }, true);
  });
}

async function hostState(page: Page): Promise<HostState> {
  return page.locator(HOST).evaluate((el) => ({
    count: Number(el.getAttribute("data-ghost-count") ?? "0"),
    accepted: Number(el.getAttribute("data-ghost-accepted") ?? "0"),
    locked: el.getAttribute("data-ghost-current-locked") === "true",
    current: el.getAttribute("data-ghost-current") ?? "",
  }));
}

/**
 * The payroll trap sits in a collapsed <details>, where Ghost would not even see it. Opening it the moment
 * it is rendered means every capture of the form includes a visible SIN and password field.
 */
async function openSensitiveTrap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const payroll = document.querySelector("[data-testid=payroll]");
      if (!payroll) return;
      payroll.setAttribute("open", "");
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

/** Tab is native while the current ghost is off screen, and the form starts below the fold. */
async function openForm(page: Page, path: string, smooth = false): Promise<Locator> {
  await countSubmitAttempts(page);
  await openSensitiveTrap(page);
  await page.goto(`${DEMO_URL}${path}`);
  const host = page.locator(`${HOST}[data-ghost-state="ready"]`);
  await expect(host).toBeAttached();
  await expect(page.locator("#sin")).toBeVisible();
  await expect(page.locator("#payroll-password")).toBeVisible();
  // 14 profile fields plus the locked Submit: the visible SIN and password fields get no ghost.
  await expect(host).toHaveAttribute("data-ghost-count", String(PROFILE_FIELD_COUNT + 1));
  if (smooth) await page.waitForTimeout(600);
  await page.evaluate((behavior) => {
    document.getElementById("apply-title")?.scrollIntoView({ behavior, block: "start" });
  }, smooth ? "smooth" as const : "instant" as const);
  await expect(page.locator("#first-name")).toBeInViewport({ ratio: 1 });
  if (smooth) await page.waitForTimeout(900);
  return page.locator(HOST);
}

/** One Tab at a time, each confirmed by data-ghost-accepted, until the lock or the end of the ghosts. */
async function walk(page: Page, paceMs = 0): Promise<number> {
  const host = page.locator(HOST);
  for (let presses = 0; presses < MAX_TABS; presses++) {
    const state = await hostState(page);
    if (state.count === 0 || state.locked) return presses;
    await page.keyboard.press("Tab");
    await expect(host).toHaveAttribute("data-ghost-accepted", String(state.accepted + 1));
    if (paceMs > 0) await page.waitForTimeout(paceMs);
  }
  throw new Error(`The walk did not reach the lock within ${MAX_TABS} Tab presses`);
}

async function readFormState(page: Page): Promise<FormValues> {
  return page.evaluate(() => ({ ...((window as DemoWindow).__formState ?? {}) }));
}

async function readDom(page: Page): Promise<FormValues> {
  return page.evaluate(() => {
    const out: Record<string, string | boolean> = {};
    const form = document.getElementById("application-form") as HTMLFormElement;
    for (const el of Array.from(form.elements)) {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
      if (!el.name) continue;
      if (el instanceof HTMLInputElement && el.type === "radio") out[el.name] = el.checked ? el.value : out[el.name] ?? "";
      else if (el instanceof HTMLInputElement && el.type === "checkbox") out[el.name] = el.checked;
      else if (el instanceof HTMLInputElement && el.type === "file") out[el.name] = el.files?.[0]?.name ?? "";
      else out[el.name] = el.value;
    }
    return out;
  });
}

/** The page's own state and the DOM must agree: that is what proves the native-setter path on React. */
async function expectValues(page: Page, expected: FormValues): Promise<void> {
  await expect.poll(() => readFormState(page)).toEqual(expected);
  expect(await readDom(page)).toEqual(expected);
}

async function expectNotSubmitted(page: Page): Promise<void> {
  const seen = await page.evaluate(() => {
    const w = window as DemoWindow;
    return { submitted: w.__submitted, attempts: w.__submitAttempts };
  });
  expect(seen.submitted).toBeFalsy();
  expect(seen.attempts).toBe(0);
  await expect(page.locator("[data-testid=submitted]")).toHaveCount(0);
  await expect(page.locator("[data-testid=form-errors]")).toBeHidden();
}

async function expectParkedOnSubmit(page: Page): Promise<void> {
  const host = page.locator(HOST);
  await expect(host).toHaveAttribute("data-ghost-current-locked", "true");
  await expect(host).toHaveAttribute("data-ghost-count", "1");
  await expect(page.locator(SUBMIT)).toBeFocused();
  // The shadow root is closed (it holds profile values), so the host reports where the pointer rests.
  await expect(host).toHaveAttribute("data-ghost-cursor", /^\d+,\d+$/);
  await expect.poll(() => cursorTouches(page)).toBe(true);
}

async function cursorTouches(page: Page): Promise<boolean> {
  const [at, button] = await Promise.all([page.locator(HOST).getAttribute("data-ghost-cursor"), page.locator(SUBMIT).boundingBox()]);
  const [x, y] = (at ?? "").split(",").map(Number);
  if (x === undefined || y === undefined || !button) return false;
  return x >= button.x && x <= button.x + button.width && y >= button.y && y <= button.y + button.height;
}

async function overPressTab(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await page.keyboard.press("Tab");
  await page.waitForTimeout(250);
}

async function walkWholeForm(page: Page, path: string, paceMs = 0): Promise<void> {
  const host = await openForm(page, path, paceMs > 0);
  const presses = await walk(page, paceMs);
  expect(presses).toBe(PROFILE_FIELD_COUNT);
  await expect(host).toHaveAttribute("data-ghost-accepted", String(PROFILE_FIELD_COUNT));
  await expectValues(page, { ...EXPECTED, ...UNTOUCHED });
  await expectParkedOnSubmit(page);
  await overPressTab(page, 3);
  await expectParkedOnSubmit(page);
  await expectNotSubmitted(page);
  await expectValues(page, { ...EXPECTED, ...UNTOUCHED });
  expect(await host.getAttribute("data-ghost-error")).toBeNull();
  await expect(page.locator("#sin, #payroll-password, #why-northwind, #project, #consent").and(page.locator("[data-ghost-hint]"))).toHaveCount(0);
}

test.describe("stage 1: Tab through the job application", () => {
  test("React /apply: Tab fills every profile field and parks on a locked Submit", async ({ page, saveVideo }) => {
    saveVideo(page, "stage1-form.webm");
    await walkWholeForm(page, "/apply", VIDEO_PACE_MS);
    await page.waitForTimeout(1200); // let the video linger on the lock badge
  });

  test("plain HTML /apply-plain/: the same walk", async ({ page }) => {
    await walkWholeForm(page, "/apply-plain/");
  });

  test("Tab stays native on a page with nothing to offer", async ({ page }) => {
    await page.goto(`${DEMO_URL}/`);
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "idle");
    await expect(host).toHaveAttribute("data-ghost-count", "0");
    await page.keyboard.press("Tab");
    await expect(page.locator("a.demo-card").first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("a.demo-card").nth(1)).toBeFocused();
  });

  test("typing overrides the ghost and Tab carries on with the next field", async ({ page }) => {
    const host = await openForm(page, "/apply");
    await page.locator("#first-name").click();
    const firstNameGhost = (await hostState(page)).current;
    await page.keyboard.type("Sam");
    await expect(host).toHaveAttribute("data-ghost-count", String(PROFILE_FIELD_COUNT));
    await expect(host).not.toHaveAttribute("data-ghost-current", firstNameGhost);
    await expect(page.locator("#first-name")).not.toHaveAttribute("data-ghost-hint", /.*/);

    await page.keyboard.press("Tab");
    await expect(host).toHaveAttribute("data-ghost-accepted", "1");
    await expect(page.locator("#last-name")).toHaveValue("Chen");
    await expect(page.locator("#first-name")).toHaveValue("Sam");

    await walk(page);
    await expect(host).toHaveAttribute("data-ghost-accepted", String(PROFILE_FIELD_COUNT - 1));
    await expectValues(page, { ...EXPECTED, ...UNTOUCHED, firstName: "Sam" });
    await expectParkedOnSubmit(page);
    await expectNotSubmitted(page);
  });

  test("Escape dismisses the current ghost and the next one becomes current", async ({ page }) => {
    const host = await openForm(page, "/apply");
    await page.locator("#first-name").focus();
    const firstNameGhost = (await hostState(page)).current;
    expect(firstNameGhost).not.toBe("");
    await page.keyboard.press("Escape");
    await expect(host).toHaveAttribute("data-ghost-count", String(PROFILE_FIELD_COUNT));
    await expect(host).not.toHaveAttribute("data-ghost-current", firstNameGhost);
    await expect(host).toHaveAttribute("data-ghost-current-locked", "false");

    await page.keyboard.press("Tab");
    await expect(host).toHaveAttribute("data-ghost-accepted", "1");
    await expect(page.locator("#last-name")).toHaveValue("Chen");
    await expect(page.locator("#first-name")).toHaveValue("");

    await walk(page);
    await expectValues(page, { ...EXPECTED, ...UNTOUCHED, firstName: "" });
    await expectNotSubmitted(page);
  });

  test("holding Tab accepts every unlocked ghost and stops at the locked Submit", async ({ page }) => {
    const host = await openForm(page, "/apply");
    await page.locator("#first-name").focus();
    // keyboard.down without an up is an auto-repeat keydown. Repeats that land mid-write are dropped by
    // design, so the hold is spaced like a real key repeat.
    for (let i = 0; i < 80 && !(await hostState(page)).locked; i++) {
      await page.keyboard.down("Tab");
      await page.waitForTimeout(30);
    }
    for (let i = 0; i < 10; i++) await page.keyboard.down("Tab");
    await page.waitForTimeout(250);
    await page.keyboard.up("Tab");

    await expect(host).toHaveAttribute("data-ghost-accepted", String(PROFILE_FIELD_COUNT));
    await expectValues(page, { ...EXPECTED, ...UNTOUCHED });
    await expectParkedOnSubmit(page);
    await expectNotSubmitted(page);
  });

  test("an explicit Enter on the locked Submit still submits (local demo only)", async ({ page }) => {
    await openForm(page, "/apply");
    await walk(page);
    await expectParkedOnSubmit(page);
    await expectNotSubmitted(page);

    await page.locator("#why-northwind").fill("Robots that ship.");
    await page.locator("#consent").check();
    await page.locator(SUBMIT).focus();
    await page.keyboard.press("Enter");

    await expect(page.locator("[data-testid=submitted]")).toBeVisible();
    const seen = await page.evaluate(() => {
      const w = window as DemoWindow;
      return { submitted: w.__submitted, attempts: w.__submitAttempts ?? 0 };
    });
    expect(seen.submitted).toBe(true);
    expect(seen.attempts).toBeGreaterThan(0); // proves the oracle behind expectNotSubmitted can fire
  });

  test("disabling Ghost on the options page removes every ghost and leaves Tab native", async ({ page, context, extensionId }) => {
    await openForm(page, "/apply");

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html#settings`);
    await expect(options.locator("body")).toHaveAttribute("data-ready", "true");
    await options.getByTestId("setting-enabled").uncheck();
    await expect(options.getByTestId("settings-status")).toHaveText("Saved");
    await options.close();

    await expect(page.locator(HOST)).toHaveCount(0); // the open page reacts to the storage change
    await page.reload();
    await expect(page.locator("#application-form")).toBeVisible();
    await page.waitForTimeout(1000); // a negative check: give a (wrongly) enabled Ghost time to show up
    await expect(page.locator(HOST)).toHaveCount(0);
    await expect(page.locator("[data-ghost-hint]")).toHaveCount(0);

    await page.locator("#first-name").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#last-name")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#email")).toBeFocused();
    await expectValues(page, { ...Object.fromEntries(Object.keys(EXPECTED).map((key) => [key, ""])), ...UNTOUCHED });
    await expectNotSubmitted(page);
  });
});
