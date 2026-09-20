// Stage 5: next-action ghosts beyond forms (docs/loops.md section 2). Done once by hand, the next time Ghost's cursor
// already sits on it and Tab does it. Against the keyless server: its heuristic /v1/predict/next plus the worker's
// episodic memory. The ghost's root is closed, so the host's data-ghost-next-* attributes are the test hooks.
//
// No sleeps: every wait is on a fact. The worker's own fetch is wrapped (from the test, inside the service worker)
// so a test sees exactly which page was asked about and what the server answered.
import type { Locator, Page, Worker } from "@playwright/test";
import { DEMO_URL, E2E_SERVER_URL, expect, readStorage, test } from "../fixtures";

const NEXT_HOST = "#ghost-next-host";
const EMAIL = /\/mail\/msg-1001$/;
const INBOX = /\/mail$/;
const CALENDAR = /\/calendar$/;
/** What the worker sends for the email page: origin + path PATTERN, never the message id. */
const EMAIL_PLACE = `${DEMO_URL}/mail/:id`;

interface Exchange {
  body: { url: string; recentActions: Array<{ type: string; url: string; label?: string }>; candidates: Array<{ id: string; label: string }> };
  answer: { candidateId: string; provider: string } | null;
}

interface SpyScope {
  fetch: typeof fetch;
  __ghostNextSpy?: Exchange[];
}

interface TraceEventLite {
  type: string;
  url: string;
  synthetic?: boolean;
  target?: { label?: string };
}

interface MemoryLite {
  pairs?: Array<{ count: number; action: { type: string; label: string } }>;
}

function collectComplaints(page: Page): string[] {
  const complaints: string[] = [];
  page.on("pageerror", (error) => complaints.push(error.message));
  return complaints;
}

/** Records every /v1/predict/next body and answer the worker sees. Idempotent, and again after a worker restart. */
async function spyOnNext(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const scope = globalThis as unknown as SpyScope;
    if (scope.__ghostNextSpy) return;
    const log: Exchange[] = [];
    scope.__ghostNextSpy = log;
    const real = scope.fetch.bind(globalThis);
    scope.fetch = async (input, init) => {
      const response = await real(input, init);
      if (String(input).endsWith("/v1/predict/next")) {
        const answer = (await response.clone().json().catch(() => null)) as Exchange["answer"];
        log.push({ body: JSON.parse(String(init?.body)) as Exchange["body"], answer });
      }
      return response;
    };
  });
}

async function exchanges(worker: Worker): Promise<Exchange[]> {
  await spyOnNext(worker);
  return worker.evaluate(() => (globalThis as unknown as SpyScope).__ghostNextSpy ?? []);
}

/** Waits until the worker asked the server about `place` (after `since` earlier exchanges) and got an answer. */
async function answered(worker: Worker, place: string, since: number): Promise<Exchange> {
  let found: Exchange | undefined;
  await expect.poll(async () => {
    found = (await exchanges(worker)).slice(since).find((e) => e.body.url === place && e.answer !== null);
    return found !== undefined;
  }, { message: `a /v1/predict/next answer about ${place}` }).toBe(true);
  if (!found) throw new Error("unreachable");
  return found;
}

async function sessionTrace(worker: Worker): Promise<TraceEventLite[]> {
  return worker.evaluate(async () => {
    const area = (globalThis as unknown as { chrome: { storage: { session: { get(key: string): Promise<Record<string, unknown>> } } } }).chrome.storage.session;
    return ((await area.get("ghost.trace.events"))["ghost.trace.events"] ?? []) as TraceEventLite[];
  });
}

async function freshInbox(page: Page): Promise<void> {
  await page.goto("/reset");
  await expect(page.getByTestId("reset-done")).toHaveAttribute("data-remaining", "0");
  await page.goto("/mail");
  await expect(page.getByTestId("mail-row").first()).toBeVisible();
}

/** Opens the meeting request from the inbox; resolves with the server's answer about THIS page. */
async function openFirstEmail(page: Page, worker: Worker): Promise<Exchange> {
  const since = (await exchanges(worker)).length;
  await page.getByTestId("mail-row").first().click();
  await expect(page).toHaveURL(EMAIL);
  await expect(page.getByRole("link", { name: "Open calendar" })).toBeVisible();
  return answered(worker, EMAIL_PLACE, since);
}

/** Two frames in the page: a reply the worker already sent has been applied by the content script. */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** The ghost is up, and its pointer's tip rests inside `target`. */
async function expectCursorOn(page: Page, target: Locator): Promise<Locator> {
  const host = page.locator(NEXT_HOST);
  await expect(host).toHaveAttribute("data-ghost-next", "visible");
  const [x = Number.NaN, y = Number.NaN] = ((await host.getAttribute("data-ghost-next-cursor")) ?? "").split(",").map(Number);
  const box = await target.boundingBox();
  if (!box) throw new Error("the target has no box");
  expect(x).toBeGreaterThanOrEqual(box.x);
  expect(x).toBeLessThanOrEqual(box.x + box.width);
  expect(y).toBeGreaterThanOrEqual(box.y);
  expect(y).toBeLessThanOrEqual(box.y + box.height);
  return host;
}

async function expectNothingSent(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as { __mailSent?: boolean }).__mailSent === true)).toBe(false);
  await expect(page.getByTestId("mail-sent")).toHaveCount(0);
}

const visibleGhost = (page: Page): Locator => page.locator(`${NEXT_HOST}[data-ghost-next="visible"]`);

test.describe("stage 5: the next action, beyond forms", () => {
  test.use({ serverUrl: E2E_SERVER_URL });

  test("open the email, open the calendar, come back: the next time the ghost cursor sits on Open calendar and Tab clicks it", async ({ page, worker }) => {
    const complaints = collectComplaints(page);
    await spyOnNext(worker);
    await freshInbox(page);

    const first = await openFirstEmail(page, worker);
    expect(first.answer?.candidateId).toBe("none"); // never seen before: nothing to propose, and no memory to overrule it
    expect(first.body.candidates.map((c) => c.label)).toContain("Open calendar");
    // Only this site's actions, as path patterns: the message id never leaves the browser.
    expect(JSON.stringify(first.body)).not.toContain("msg-1001");
    for (const action of first.body.recentActions) expect(action.url.startsWith(`${DEMO_URL}/`)).toBe(true);
    await settled(page);
    await expect(visibleGhost(page)).toHaveCount(0);

    // Rule 1: with no ghost visible, Tab is the browser's. Focus moves on, nothing is clicked.
    await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    await expect(page).toHaveURL(EMAIL);

    await page.getByRole("link", { name: "Open calendar" }).click(); // done once, by hand
    await expect(page).toHaveURL(CALENDAR);

    await page.goBack();
    await expect(page).toHaveURL(EMAIL);
    await page.goBack();
    await expect(page).toHaveURL(INBOX);
    await openFirstEmail(page, worker);

    const host = await expectCursorOn(page, page.getByRole("link", { name: "Open calendar" }));
    await expect(host).toHaveAttribute("data-ghost-next-locked", "false");
    await expect(page.getByTestId("send-reply")).toBeVisible(); // the locked Send is right there, and never Ghost's to press
    await expectNothingSent(page);

    await page.keyboard.press("Tab");
    await expect(page).toHaveURL(CALENDAR);
    await expect(visibleGhost(page)).toHaveCount(0);

    // The Tab-made click is Ghost's own (synthetic): traced as such, and never remembered as a demonstration.
    // The router records one event at a time, so once the calendar's navigate follows it, memory is written.
    await expect.poll(async () => {
      const trace = await sessionTrace(worker);
      const clicks = trace.map((e, i) => (e.type === "click" && e.target?.label === "Open calendar" ? i : -1)).filter((i) => i >= 0);
      const tabbed = clicks.at(-1) ?? -1;
      return clicks.length === 2 && trace[tabbed]?.synthetic === true && trace.slice(tabbed + 1).some((e) => e.type === "navigate" && CALENDAR.test(e.url));
    }, { message: "the Tab-made click is traced as synthetic, then the calendar's navigate" }).toBe(true);
    const memory = await readStorage<MemoryLite>(worker, "ghost.memory");
    const learned = (memory?.pairs ?? []).filter((p) => p.action.type === "click" && p.action.label === "Open calendar");
    expect(learned.map((p) => p.count)).toEqual([1]); // the one manual click; accepting the ghost added nothing

    await page.goBack();
    await expect(page).toHaveURL(EMAIL);
    await expectNothingSent(page);
    await expect(page.getByTestId("send-reply")).toBeVisible();
    expect(complaints).toEqual([]);
  });

  test("the extension's presence heartbeat reaches the server (so Ghost Desktop stays out of this browser)", async ({ worker }) => {
    expect(worker.url()).toMatch(/^chrome-extension:\/\//); // the extension is loaded; nothing on a page is needed
    // The fixture pointed the worker at this server; a settings change beats right away instead of waiting 30 s.
    // Chromium cannot be told apart from Arc and Vivaldi (same brands, no UA token), so it beats under those names too.
    const freshExtensionBrowsers = async (): Promise<string[]> => {
      const response = await fetch(`${E2E_SERVER_URL}/v1/presence`);
      const { clients } = (await response.json()) as { clients: Array<{ client: string; browser: string | null; version: string | null; ageMs: number }> };
      return clients.filter((c) => c.client === "extension" && c.ageMs < 20_000 && c.version === "0.1.0").map((c) => c.browser ?? "").sort();
    };
    await expect.poll(freshExtensionBrowsers).toEqual(["arc", "chromium", "vivaldi"]);
  });

  test("a remembered locked action (Send reply) only gets focus: Tab never clicks it", async ({ page, worker }) => {
    await spyOnNext(worker);
    await freshInbox(page);
    await openFirstEmail(page, worker);
    // The user presses Send on an empty reply: the page refuses (nothing is sent) and says so in an alert.
    await page.getByTestId("send-reply").click();
    await expect(page.getByRole("alert")).toHaveText("Write a reply before sending.");
    await expectNothingSent(page);

    await page.goBack();
    await expect(page).toHaveURL(INBOX);
    const asked = await openFirstEmail(page, worker);
    const questions = (await exchanges(worker)).length;
    expect(asked.body.candidates.map((c) => c.label)).toContain("Send reply");
    await expect(page.getByRole("alert")).toHaveCount(0);

    const send = page.getByTestId("send-reply");
    await expect(send).not.toBeInViewport(); // the navigation scrolled to the top
    await settled(page); // the answer (Send, from memory) is in: predicted, but not drawn while off screen
    await expect(visibleGhost(page)).toHaveCount(0);
    await page.mouse.wheel(0, 1200); // the user scrolls down to the reply; a scroll is not an action, the ghost appears
    await expect(send).toBeInViewport();
    const host = await expectCursorOn(page, send);
    await expect(host).toHaveAttribute("data-ghost-next-locked", "true");
    expect((await exchanges(worker)).length).toBe(questions); // no new question: that ghost was waiting off screen

    await page.keyboard.press("Tab");
    await expect(send).toBeFocused();
    await expect(host).toHaveAttribute("data-ghost-next-parked", "true");
    await page.keyboard.press("Tab"); // native from here: Ghost has stepped aside
    await expect(send).not.toBeFocused();
    await expect(visibleGhost(page)).toHaveCount(0);
    // A click on the empty reply raises the alert synchronously; focus has already moved on without one.
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page).toHaveURL(EMAIL);
    await expectNothingSent(page);
  });
});
