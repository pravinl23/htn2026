// Helpers for the specs that drive the job application WITH a prediction server (stages 2 to 4).
// stage1-form.spec.ts keeps its own copies on purpose: it is the offline oracle and stays self-contained.
import type { Locator, Page } from "@playwright/test";
import { DEMO_URL, HOST, expect } from "./fixtures";

export const SUBMIT = "[data-testid=submit]";
export const FORM_ROUTE = "/v1/predict/form";
export const TEXT_ROUTE = "/v1/ghost-text";
const MAX_TABS = 40;

/** The fictional Alex Chen demo profile as the form should hold it, written out so tests are an independent oracle. */
export const EXPECTED: Record<string, string> = {
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
export const ESSAYS = ["whyNorthwind", "project"] as const;
/** What no walk may touch: the file input, the consent box and the sensitive payroll trap. */
export const NEVER_FILLED: Record<string, string | boolean> = { resume: "", consent: false, sin: "", payrollPassword: "" };
export const PROFILE_FIELDS = Object.keys(EXPECTED).length;
/** 14 profile fields plus the locked Submit. */
export const OFFLINE_GHOSTS = PROFILE_FIELDS + 1;
/** With a text provider both essay textareas get a draft as well. */
export const SERVER_GHOSTS = OFFLINE_GHOSTS + ESSAYS.length;

export type FormValues = Record<string, string | boolean>;
export interface DemoWindow {
  __submitted?: boolean;
  __formState?: FormValues;
  __submitAttempts?: number;
}
export interface HostState {
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

/** The payroll trap sits in a collapsed <details>; opened at once, every capture sees a visible SIN and password field. */
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

export async function hostState(page: Page): Promise<HostState> {
  return page.locator(HOST).evaluate((el) => ({
    count: Number(el.getAttribute("data-ghost-count") ?? "0"),
    accepted: Number(el.getAttribute("data-ghost-accepted") ?? "0"),
    locked: el.getAttribute("data-ghost-current-locked") === "true",
    current: el.getAttribute("data-ghost-current") ?? "",
  }));
}

/** Init scripts are per page, so they are installed once however often the page navigates. */
const prepared = new WeakSet<Page>();

export async function gotoForm(page: Page, path: string): Promise<void> {
  if (!prepared.has(page)) {
    prepared.add(page);
    await countSubmitAttempts(page);
    await openSensitiveTrap(page);
  }
  await page.goto(`${DEMO_URL}${path}`);
  await expect(page.locator("#sin")).toBeVisible();
  await expect(page.locator("#payroll-password")).toBeVisible();
}

export async function expectGhosts(page: Page, ghosts: number): Promise<Locator> {
  const host = page.locator(HOST);
  await expect(host).toHaveAttribute("data-ghost-count", String(ghosts));
  await expect(host).toHaveAttribute("data-ghost-state", ghosts > 0 ? "ready" : "idle");
  return host;
}

/** Tab is native while the current ghost is off screen, and the form starts below the fold. */
export async function scrollToForm(page: Page, smooth = false): Promise<void> {
  await page.evaluate((behavior) => {
    document.getElementById("apply-title")?.scrollIntoView({ behavior, block: "start" });
  }, smooth ? "smooth" as const : "instant" as const);
  await expect(page.locator("#first-name")).toBeInViewport({ ratio: 1 });
}

export async function openForm(page: Page, path: string, ghosts: number): Promise<Locator> {
  await gotoForm(page, path);
  const host = await expectGhosts(page, ghosts);
  await scrollToForm(page);
  return host;
}

/** One Tab at a time, each confirmed by data-ghost-accepted, until the lock or the end of the ghosts. */
export async function walk(page: Page, paceMs = 0): Promise<number> {
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

export async function readFormState(page: Page): Promise<FormValues> {
  return page.evaluate(() => ({ ...((window as DemoWindow).__formState ?? {}) }));
}

/** The page's own state, which is what proves a write reached React and not just the DOM. */
export async function expectFormState(page: Page, expected: FormValues): Promise<void> {
  await expect.poll(async () => {
    const state = await readFormState(page);
    return Object.fromEntries(Object.keys(expected).map((key) => [key, state[key]]));
  }).toEqual(expected);
}

export async function expectNotSubmitted(page: Page): Promise<void> {
  const seen = await page.evaluate(() => {
    const w = window as DemoWindow;
    return { submitted: w.__submitted, attempts: w.__submitAttempts };
  });
  expect(seen.submitted).toBeFalsy();
  expect(seen.attempts).toBe(0);
  await expect(page.locator("[data-testid=submitted]")).toHaveCount(0);
  await expect(page.locator("[data-testid=form-errors]")).toBeHidden();
}

export async function expectParkedOnSubmit(page: Page): Promise<void> {
  const host = page.locator(HOST);
  await expect(host).toHaveAttribute("data-ghost-current-locked", "true");
  await expect(host).toHaveAttribute("data-ghost-count", "1");
  await expect(page.locator(SUBMIT)).toBeFocused();
}

/** Anything the content script or the page complains about. The content script logs with a "[ghost]" prefix. */
export function collectComplaints(page: Page): string[] {
  const complaints: string[] = [];
  page.on("pageerror", (error) => complaints.push(error.message));
  page.on("console", (message) => {
    if (message.text().includes("[ghost]")) complaints.push(message.text());
  });
  return complaints;
}
