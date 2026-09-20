// Stage 3: streamed free-text drafts. The template provider (no key) streams through exactly the same path
// as an LLM: content script -> ghost:text port -> worker -> POST /v1/ghost-text -> SSE back.
import type { Page } from "@playwright/test";
import {
  EXPECTED, NEVER_FILLED, OFFLINE_GHOSTS, SERVER_GHOSTS, TEXT_ROUTE,
  collectComplaints, expectFormState, expectGhosts, expectNotSubmitted, expectParkedOnSubmit, finishRequired, gotoForm, hostState, openForm, readFormState, walk,
} from "../apply";
import { E2E_SERVER_URL, HOST, expect, readGhostText, readHud, serverCalls, test } from "../fixtures";

const COMPANY = "Northwind Robotics";
const ESSAY_FIELDS = [
  { id: "why-northwind", key: "whyNorthwind" },
  { id: "project", key: "project" },
] as const;
/** Template leftovers: "[Company]", "{{role}}", "<name>", a fact that was not there. */
const PLACEHOLDER = /[[\]{}<>]|\bundefined\b|\bnull\b|\bTODO\b|lorem ipsum/i;
const VIDEO_PACE_MS = 300;
const VIDEO_READ_MS = 1700;

interface Timeline {
  formReady?: number;
  firstGhost?: number;
  firstDraft?: number;
  allDrafts?: number;
}

/** Page-side stopwatch: the host's data-ghost-count is the one thing the page can see of Ghost, and it is enough. */
async function installTimeline(page: Page): Promise<void> {
  await page.addInitScript(({ hostId, offlineGhosts, essays }) => {
    const marks: Record<string, number> = {};
    (window as unknown as { __ghostTimeline: Record<string, number> }).__ghostTimeline = marks;
    const mark = (name: string): void => {
      if (!(name in marks)) marks[name] = performance.now();
    };
    const check = (): void => {
      if (document.getElementById("application-form")) mark("formReady");
      const count = Number(document.getElementById(hostId)?.getAttribute("data-ghost-count") ?? "0");
      if (count > 0) mark("firstGhost");
      if (count > offlineGhosts) mark("firstDraft");
      if (count >= offlineGhosts + essays) mark("allDrafts");
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-ghost-count"] });
  }, { hostId: HOST.slice(1), offlineGhosts: OFFLINE_GHOSTS, essays: ESSAY_FIELDS.length });
}

async function readTimeline(page: Page): Promise<Required<Timeline>> {
  const marks = await page.evaluate(() => (window as unknown as { __ghostTimeline?: Timeline }).__ghostTimeline ?? {});
  const { formReady, firstGhost, firstDraft, allDrafts } = marks;
  if (formReady === undefined || firstGhost === undefined || firstDraft === undefined || allDrafts === undefined) {
    throw new Error(`The timeline is incomplete: ${JSON.stringify(marks)}`);
  }
  return { formReady, firstGhost, firstDraft, allDrafts };
}

/** The draft as the overlay draws it over the textarea: several lines, first person, about this company. */
async function expectDraftGhost(page: Page, fieldId: string): Promise<string> {
  await page.locator(`#${fieldId}`).scrollIntoViewIfNeeded();
  await expect.poll(async () => (await readGhostText(page, fieldId))?.drawn ?? false).toBe(true);
  const ghost = await readGhostText(page, fieldId);
  if (!ghost) throw new Error(`No ghost is drawn over #${fieldId}`);
  expect(ghost.mode).toBe("multiline");
  expect(ghost.streaming).toBe(false);
  expect(ghost.lines).toBeGreaterThanOrEqual(2);
  expect(ghost.text.length).toBeGreaterThan(120);
  expect(ghost.text).toContain(COMPANY);
  expect(ghost.text).not.toMatch(PLACEHOLDER);
  await expect(page.locator(`#${fieldId}`)).toHaveAttribute("data-ghost-hint", /.*/);
  return ghost.text;
}

/** Like walk(), but checks each draft where the walk meets it and lingers there, so the recording shows the draft before Tab writes it. */
async function walkReadingDrafts(page: Page): Promise<{ presses: number; drafts: Record<string, string> }> {
  const host = page.locator(HOST);
  const drafts: Record<string, string> = {};
  for (let presses = 0; presses < 40; presses++) {
    const state = await hostState(page);
    if (state.count === 0 || state.locked) return { presses, drafts };
    const essay = ESSAY_FIELDS.find((field) => state.current.split("|").includes(field.id));
    if (essay) {
      drafts[essay.key] = await expectDraftGhost(page, essay.id);
      await page.waitForTimeout(VIDEO_READ_MS);
    }
    await page.keyboard.press("Tab");
    await expect(host).toHaveAttribute("data-ghost-accepted", String(state.accepted + 1));
    await page.waitForTimeout(essay ? VIDEO_READ_MS / 2 : VIDEO_PACE_MS);
  }
  throw new Error("The walk did not reach the lock");
}

test.describe("stage 3: free-text drafts as ghost text", () => {
  test.use({ serverUrl: E2E_SERVER_URL });

  test("both essays get a multi-line draft about the company, and Tab writes the whole draft into React state", async ({ page, saveVideo }) => {
    saveVideo(page, "stage3-ghost-text.webm");
    const complaints = collectComplaints(page);
    const textCallsBefore = await serverCalls(TEXT_ROUTE);
    await installTimeline(page);
    await gotoForm(page, "/apply");
    await expectGhosts(page, SERVER_GHOSTS);

    const t = await readTimeline(page);
    const hud = await readHud(page);
    console.log(
      `[stage3 latency] first ghost visible ${Math.round(t.firstGhost - t.formReady)} ms after the form rendered · ` +
      `first draft ready ${Math.round(t.firstDraft - t.formReady)} ms · both drafts ${Math.round(t.allDrafts - t.formReady)} ms · ` +
      `HUD: draft via ${hud?.draft?.provider ?? "?"}, first token ${hud?.draft?.firstToken ?? "?"}, total ${hud?.draft?.total ?? "?"}`,
    );
    // Generous ceilings: the point is "drafts are there before the user reaches them", not a benchmark.
    expect(t.firstGhost - t.formReady).toBeLessThan(1500);
    expect(t.allDrafts - t.formReady).toBeLessThan(4000);
    expect(hud?.draft?.provider).toBe("template");
    expect(await serverCalls(TEXT_ROUTE) - textCallsBefore).toBe(ESSAY_FIELDS.length); // speculative: both asked for before any Tab

    // The form starts below the fold: the pill offers the jump, and that Tab only scrolls and focuses.
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-jump", "true");
    await page.waitForTimeout(900); // video only: a beat on the job posting with the pill showing
    await page.keyboard.press("Tab");
    await expect(page.locator("#first-name")).toBeFocused();
    await expect(page.locator("#first-name")).toBeInViewport({ ratio: 1 });
    await expect(host).toHaveAttribute("data-ghost-jump", "false");
    await page.waitForTimeout(700); // video only

    const { presses, drafts } = await walkReadingDrafts(page);
    expect(presses).toBe(SERVER_GHOSTS);
    expect(Object.keys(drafts).sort()).toEqual(ESSAY_FIELDS.map((field) => field.key).sort());
    expect(drafts.whyNorthwind).not.toBe(drafts.project);

    // The page's own state holds exactly what the ghost showed: the native-setter path works for a long multi-line value too.
    await expectFormState(page, { ...EXPECTED, ...NEVER_FILLED, ...drafts });
    for (const field of ESSAY_FIELDS) await expect(page.locator(`#${field.id}`)).toHaveValue(drafts[field.key] ?? "");
    await finishRequired(page); // both essays are drafted, so only the privacy box was still missing
    await expectParkedOnSubmit(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
    await expectParkedOnSubmit(page);
    await expectNotSubmitted(page);
    expect(await page.locator(HOST).getAttribute("data-ghost-error")).toBeNull();
    expect(complaints).toEqual([]);
    await page.waitForTimeout(1200); // video only: linger on the lock badge
  });

  test("typing in an essay overrides its draft, and the rest of the walk never writes over it", async ({ page }) => {
    const mine = "Robots that ship.";
    await openForm(page, "/apply", SERVER_GHOSTS);
    await page.locator("#why-northwind").click();
    await expectDraftGhost(page, "why-northwind");

    await page.keyboard.type(mine);
    await expectGhosts(page, SERVER_GHOSTS - 1);
    expect(await readGhostText(page, "why-northwind")).toBeNull();
    await expect(page.locator("#why-northwind")).not.toHaveAttribute("data-ghost-hint", /.*/);

    expect(await walk(page)).toBe(SERVER_GHOSTS - 1);
    await expectFormState(page, { ...EXPECTED, ...NEVER_FILLED, whyNorthwind: mine });
    expect(String((await readFormState(page)).project)).toContain(COMPANY);
    await finishRequired(page);
    await expectParkedOnSubmit(page);
    await expectNotSubmitted(page);
  });

  test("Escape dismisses a draft and leaves the textarea empty", async ({ page }) => {
    await openForm(page, "/apply", SERVER_GHOSTS);
    await page.locator("#why-northwind").click();
    await expectDraftGhost(page, "why-northwind");
    await page.keyboard.press("Escape");
    await expectGhosts(page, SERVER_GHOSTS - 1);
    expect(await readGhostText(page, "why-northwind")).toBeNull();

    expect(await walk(page)).toBe(SERVER_GHOSTS - 1);
    await expectFormState(page, { ...EXPECTED, ...NEVER_FILLED, whyNorthwind: "" });
    expect(String((await readFormState(page)).project)).toContain(COMPANY);
    await finishRequired(page); // the escaped essay is required too: the user writes it themselves
    await expectParkedOnSubmit(page);
    await expectNotSubmitted(page);
  });
});
