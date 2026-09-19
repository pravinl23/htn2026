// Stage 2: the prediction server path. One call per form, a per-site cache, live confidence gating, and a
// silent fall back to the offline heuristic. Runs against the keyless server on 8788 (heuristic + template).
import { spawn } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import {
  EXPECTED, FORM_ROUTE, NEVER_FILLED, OFFLINE_GHOSTS, PROFILE_FIELDS, SERVER_GHOSTS,
  collectComplaints, expectFormState, expectGhosts, expectNotSubmitted, expectParkedOnSubmit, gotoForm, openForm, readFormState, scrollToForm, walk,
} from "../apply";
import {
  E2E_SERVER_URL, FORM_CACHE_KEY, HOST, KEYLESS_SERVER_ENV, SERVER_DIR,
  expect, patchSettings, readHud, readStorage, removeStorage, serverCalls, test,
} from "../fixtures";

const DEMO_ORIGIN = "http://localhost:5173";

async function expectHud(page: Page, expected: { provider: string; cache: string }): Promise<void> {
  await expect.poll(() => readHud(page)).toMatchObject({ visible: true, ...expected });
}

async function expectTabIsNative(page: Page): Promise<void> {
  await page.locator("#first-name").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#last-name")).toBeFocused();
  await expect(page.locator("#first-name")).toHaveValue("");
  await expect(page.locator("[data-ghost-hint]")).toHaveCount(0);
}

test.describe("stage 2: predictions from the server", () => {
  test.use({ serverUrl: E2E_SERVER_URL });

  test("the first visit makes exactly one form call, a reload makes none", async ({ page, worker }) => {
    const before = await serverCalls(FORM_ROUTE);
    await openForm(page, "/apply", SERVER_GHOSTS);
    await expectHud(page, { provider: "heuristic", cache: "miss" });
    expect(await serverCalls(FORM_ROUTE) - before).toBe(1);

    // The per-site cache holds one form for this origin: field signatures and fact KEYS, never a value.
    const cache = (await readStorage<Record<string, unknown>>(worker, FORM_CACHE_KEY)) ?? {};
    expect(Object.keys(cache).filter((key) => key.startsWith(`${DEMO_ORIGIN} `))).toHaveLength(1);
    expect(JSON.stringify(cache)).not.toMatch(/alex|chen\b|519|waterloo|example\.com|hack the north/i);

    await page.reload();
    await expectGhosts(page, SERVER_GHOSTS);
    await expectHud(page, { provider: "heuristic", cache: "hit" });
    expect(await serverCalls(FORM_ROUTE) - before).toBe(1);
  });

  test("every profile field fills correctly through the server path, and the walk still parks on a locked Submit", async ({ page }) => {
    const complaints = collectComplaints(page);
    const host = await openForm(page, "/apply", SERVER_GHOSTS);
    await expectHud(page, { provider: "heuristic", cache: "miss" });

    expect(await walk(page)).toBe(SERVER_GHOSTS - 1);
    await expectFormState(page, { ...EXPECTED, ...NEVER_FILLED });
    await expectParkedOnSubmit(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab"); // over-pressing must stay harmless
    await expectParkedOnSubmit(page);
    await expectNotSubmitted(page);
    expect(await host.getAttribute("data-ghost-error")).toBeNull();
    await expect(page.locator("#sin, #payroll-password, #consent").and(page.locator("[data-ghost-hint]"))).toHaveCount(0);
    expect(complaints).toEqual([]);
  });

  test("the jump pill: with the form below the fold, the first Tab only scrolls to it and fills nothing", async ({ page }) => {
    await gotoForm(page, "/apply");
    const host = await expectGhosts(page, SERVER_GHOSTS);
    await expect(page.locator("#first-name")).not.toBeInViewport();
    await expect(host).toHaveAttribute("data-ghost-jump", "true");

    await page.keyboard.press("Tab");
    await expect(page.locator("#first-name")).toBeFocused();
    await expect(page.locator("#first-name")).toBeInViewport({ ratio: 1 });
    await expect(host).toHaveAttribute("data-ghost-jump", "false");
    await expect(host).toHaveAttribute("data-ghost-accepted", "0");
    await expect(page.locator("#first-name")).toHaveValue("");

    await page.keyboard.press("Tab"); // now the ghost is on screen, so this one accepts it
    await expect(host).toHaveAttribute("data-ghost-accepted", "1");
    await expect(page.locator("#first-name")).toHaveValue(EXPECTED.firstName ?? "");
    await expectNotSubmitted(page);
  });

  test("a 0.99 threshold removes every ghost, live and on reload, without asking the server again", async ({ page, worker }) => {
    const before = await serverCalls(FORM_ROUTE);
    await openForm(page, "/apply", SERVER_GHOSTS);
    expect(await serverCalls(FORM_ROUTE) - before).toBe(1);

    await patchSettings(worker, { confidenceThreshold: 0.99 });
    await expectGhosts(page, 0);
    await expectTabIsNative(page);

    await page.reload();
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "idle");
    await expectGhosts(page, 0);
    await scrollToForm(page);
    await expectTabIsNative(page);

    await patchSettings(worker, { confidenceThreshold: 0.7 });
    await expectGhosts(page, SERVER_GHOSTS);
    expect(await serverCalls(FORM_ROUTE) - before).toBe(1); // re-gating reads the cache, never the server
    expect(Object.values(await readFormState(page)).filter((value) => value !== "" && value !== false)).toEqual([]);
    await expectNotSubmitted(page);
  });
});

// ---------- a server that goes away ----------

const SPARE_URL = "http://127.0.0.1:8789";

async function healthy(baseUrl: string): Promise<boolean> {
  return fetch(`${baseUrl}/v1/health`).then((response) => response.ok, () => false);
}

interface SpareServer {
  stop(): Promise<void>;
}

/** A second keyless server this spec owns, because the one Playwright manages cannot be taken down mid-run. */
async function startSpareServer(): Promise<SpareServer> {
  if (await healthy(SPARE_URL)) throw new Error(`${SPARE_URL} is already in use; stop that server first`);
  // tsx is started directly (no pnpm, no --env-file): .env is never read and the whole process group can be signalled.
  const child = spawn(path.join(SERVER_DIR, "node_modules/.bin/tsx"), ["src/index.ts"], {
    cwd: SERVER_DIR,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...KEYLESS_SERVER_ENV, PORT: new URL(SPARE_URL).port },
  });
  const stop = async (): Promise<void> => {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await expect.poll(() => healthy(SPARE_URL), { timeout: 15_000 }).toBe(false);
  };
  await expect.poll(() => healthy(SPARE_URL), { timeout: 30_000 }).toBe(true);
  return { stop };
}

const spareTest = test.extend<{ spareServer: SpareServer }>({
  serverUrl: SPARE_URL,
  spareServer: async ({}, use) => {
    const server = await startSpareServer();
    await use(server);
    await server.stop();
  },
});

spareTest.describe("stage 2: the server goes down mid-session", () => {
  spareTest("Ghost falls back to the offline heuristic without a word", async ({ page, worker, spareServer }) => {
    const complaints = collectComplaints(page);
    await openForm(page, "/apply", SERVER_GHOSTS);
    await expectHud(page, { provider: "heuristic", cache: "miss" });

    await spareServer.stop();
    await removeStorage(worker, FORM_CACHE_KEY); // otherwise the per-site cache would answer and hide the outage

    await gotoForm(page, "/apply");
    const host = await expectGhosts(page, OFFLINE_GHOSTS);
    await scrollToForm(page);
    await expectHud(page, { provider: "offline-heuristic", cache: "offline" });
    expect(await host.getAttribute("data-ghost-error")).toBeNull();

    expect(await walk(page)).toBe(PROFILE_FIELDS);
    await expectFormState(page, { ...EXPECTED, ...NEVER_FILLED, whyNorthwind: "", project: "" });
    await expectParkedOnSubmit(page);
    await expectNotSubmitted(page);
    expect(await host.getAttribute("data-ghost-error")).toBeNull();
    expect(await readStorage(worker, FORM_CACHE_KEY)).toBeUndefined(); // a failed call caches nothing
    expect(complaints).toEqual([]);
  });
});
