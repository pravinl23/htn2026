// Playwright harness that loads the built Ghost extension (extension/dist) into Chromium.
//
// Working launch configuration (verified on macOS, Playwright 1.63, bundled Chromium):
//   chromium.launchPersistentContext("", {
//     channel: "chromium",          // full Chromium build: its new headless mode supports extensions
//     headless: true,               // the default headless shell does NOT load extensions; channel fixes that
//     args: ["--disable-extensions-except=<dist>", "--load-extension=<dist>"],
//   })
// Set GHOST_HEADED=1 to watch a run in a real window, GHOST_RECORD=1 to re-record the videos in docs/media.
import { test as base, chromium, expect } from "@playwright/test";
import type { BrowserContext, CDPSession, Page, Worker } from "@playwright/test";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIST = path.resolve(E2E_DIR, "../extension/dist");
export const SERVER_DIR = path.resolve(E2E_DIR, "../server");
export const VIDEO_DIR = path.resolve(E2E_DIR, "test-results/videos");
export const MEDIA_DIR = path.resolve(E2E_DIR, "../docs/media");
const MAX_VIDEO_BYTES = 3 * 1024 * 1024;
export const VIEWPORT = { width: 1280, height: 800 } as const;
export const DEMO_URL = "http://localhost:5173";
export const HOST = "#ghost-overlay-host";

/** The keyless prediction server playwright.config.ts starts (heuristic decisions, template text). */
export const E2E_SERVER_URL = "http://127.0.0.1:8788";
/**
 * The default: no server. Port 9 (discard) is on Chromium's unsafe-port list, so the worker's fetch fails at
 * once and can never reach a developer server (8787 may hold real keys). This keeps the Stage 1 specs on the
 * offline path whatever happens to be running on the machine.
 */
export const OFFLINE_SERVER_URL = "http://127.0.0.1:9";

/**
 * Environment of every prediction server a run starts. The forced providers make zero network calls, and the
 * blank keys win over ../.env (process env beats --env-file), so no test can ever spend a real key.
 */
export const KEYLESS_SERVER_ENV: Record<string, string> = {
  GHOST_PROVIDER: "heuristic",
  GHOST_DECISION_PROVIDER: "heuristic",
  GHOST_TEXT_PROVIDER: "template",
  TYPESAFE_API_KEY: "",
  AI_GATEWAY_API_KEY: "",
  BASETEN_API_KEY: "",
  OPENAI_API_KEY: "",
  XAI_API_KEY: "",
  BROWSERBASE_API_KEY: "",
  COMPOSIO_API_KEY: "",
};

export const SETTINGS_KEY = "ghost.settings";
export const PROFILE_KEY = "ghost.profile";
export const METRICS_KEY = "ghost.metrics";
export const FORM_CACHE_KEY = "ghost.formCache";

/** Mirrors GhostSettings; spelled out here so the harness does not import extension code. */
export interface SettingsPatch {
  enabled?: boolean;
  confidenceThreshold?: number;
  serverUrl?: string;
  showHud?: boolean;
  learningEnabled?: boolean;
}

interface ChromeStorageArea {
  get(key: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
interface ChromeStorageEvent {
  addListener(listener: () => void): void;
  removeListener(listener: () => void): void;
}
// Only ever touched inside worker.evaluate(), where the extension's service worker provides it.
declare const chrome: { storage: { local: ChromeStorageArea; onChanged: ChromeStorageEvent } };

interface VideoRequest {
  page: Page;
  fileName: string;
}

export type SaveVideo = (page: Page, fileName: string) => void;

interface GhostOptions {
  /** `ghost.settings.serverUrl`, written from the service worker before any page loads. */
  serverUrl: string;
  /** More settings to write with it (learningEnabled, confidenceThreshold...). */
  settings: SettingsPatch;
}

interface GhostFixtures {
  context: BrowserContext;
  extensionId: string;
  /** The extension's service worker: the one place a test can reach chrome.storage from. */
  worker: Worker;
  /** Registers a page whose recording is copied to docs/media/<fileName> once the context has closed. */
  saveVideo: SaveVideo;
  videoRequests: VideoRequest[];
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

async function assertExtensionBuilt(): Promise<void> {
  const manifest = path.join(EXTENSION_DIST, "manifest.json");
  if (!(await exists(manifest))) throw new Error(`Missing ${manifest}. Run "pnpm build" at the repo root first.`);
}

/**
 * Videos are only finalized when the context closes, so copying happens after close(). A video that is already
 * in docs/media is kept: every run re-encoding a tracked binary is noise in git. GHOST_RECORD=1 replaces them.
 */
async function copyVideos(requests: VideoRequest[]): Promise<void> {
  if (requests.length === 0) return;
  await mkdir(MEDIA_DIR, { recursive: true });
  for (const { page, fileName } of requests) {
    const target = path.join(MEDIA_DIR, path.basename(fileName));
    if (process.env.GHOST_RECORD !== "1" && (await exists(target))) continue;
    const source = await page.video()?.path();
    if (!source) throw new Error(`No video was recorded for ${fileName}`);
    const { size } = await stat(source);
    if (size > MAX_VIDEO_BYTES) throw new Error(`${fileName} is ${Math.round(size / 1024)} KB; videos in docs/media stay under 3 MB`);
    await copyFile(source, target);
  }
}

async function serviceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
}

/**
 * Install seeding (`saveSettings({})`) is a read-modify-write: a serverUrl written before it finishes is put
 * back to the default. So wait until `ghost.settings` exists, then patch it.
 */
async function waitForSeededSettings(worker: Worker): Promise<void> {
  await worker.evaluate((key) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`install seeding never wrote ${key}`)), 15_000);
    const check = (): void => void chrome.storage.local.get(key).then((got) => {
      if (got[key]) finish();
    });
    function finish(error?: Error): void {
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(check);
      if (error) reject(error);
      else resolve();
    }
    chrome.storage.onChanged.addListener(check);
    check();
  }), SETTINGS_KEY);
}

export async function readStorage<T = unknown>(worker: Worker, key: string): Promise<T | undefined> {
  return (await worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key)) as T | undefined;
}

/** Everything the extension has stored, for "this secret is nowhere" assertions. */
export async function readAllStorage(worker: Worker): Promise<Record<string, unknown>> {
  return worker.evaluate(() => chrome.storage.local.get(null));
}

export async function writeStorage(worker: Worker, key: string, value: unknown): Promise<void> {
  await worker.evaluate(({ k, v }) => chrome.storage.local.set({ [k]: v }), { k: key, v: value });
}

export async function removeStorage(worker: Worker, key: string): Promise<void> {
  await worker.evaluate((k) => chrome.storage.local.remove(k), key);
}

// ---------- which key accepts a ghost (docs/accept-key.md) ----------

/** `ghost.keys` in extension/src/lib/storage.ts. */
const KEYS_KEY = "ghost.keys";

/**
 * One tap of the Ghost key: right Option down, nothing in between, up (docs/accept-key.md section 3). This is
 * the key that accepts wherever Tab is not Ghost's - a click ghost, a locked action, an origin whose Tab has
 * never been watched. Chromium reports it exactly as a real tap does: key "Alt", code "AltRight", location 2.
 */
export async function ghostKey(page: Page): Promise<void> {
  await page.keyboard.down("AltRight");
  await page.keyboard.up("AltRight");
}

/**
 * Marks an origin as one Ghost has already watched a Tab press on and found free: the state every browser is
 * in after the user's first form walk on a site (docs/accept-key.md section 2, shared/src/keys/observe.ts).
 *
 * Specs that are about the WALK - does Tab accept, advance, stop at a lock - use this so they are not also
 * re-testing how an origin is first observed. What a BRAND-NEW origin does has its own spec
 * ("a brand-new origin is watched before Tab is ever taken" in stage1-form.spec.ts).
 *
 * Written as plain JSON on purpose: e2e does not depend on @ghost/shared, and `normalizeKeys` repairs
 * anything it does not recognise, so a drift in the stored shape shows up as a failing walk, not a silent pass.
 */
export async function observedTabFree(worker: Worker, origin: string = DEMO_URL): Promise<void> {
  await writeStorage(worker, KEYS_KEY, {
    acceptKey: "auto",
    ghostKey: "right-option",
    memory: {
      max: 300,
      entries: [
        { id: origin, tab: "free", probes: { free: 2, taken: 0 }, presses: { tab: 0, ghost: 0 }, missed: 0, run: null, flips: 0, pinned: false },
      ],
    },
  });
}

/** What Ghost has observed about Tab on one origin, for a spec that is about the observing itself. */
export async function tabStateFor(worker: Worker, origin: string = DEMO_URL): Promise<string> {
  const keys = await readStorage<{ memory?: { entries?: Array<{ id: string; tab: string }> } }>(worker, KEYS_KEY);
  return (keys?.memory?.entries ?? []).find((entry) => entry.id === origin)?.tab ?? "unknown";
}

/** Open pages react through chrome.storage.onChanged, exactly as they do when the options page saves. */
export async function patchSettings(worker: Worker, patch: SettingsPatch): Promise<void> {
  await worker.evaluate(async ({ key, change }) => {
    const current = (await chrome.storage.local.get(key))[key];
    await chrome.storage.local.set({ [key]: { ...(current as object), ...change } });
  }, { key: SETTINGS_KEY, change: patch });
}

export const test = base.extend<GhostFixtures & GhostOptions>({
  serverUrl: [OFFLINE_SERVER_URL, { option: true }],
  settings: [{}, { option: true }],

  videoRequests: async ({}, use) => {
    await use([]);
  },

  context: async ({ videoRequests, serverUrl, settings }, use) => {
    await assertExtensionBuilt();
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: process.env.GHOST_HEADED !== "1",
      viewport: VIEWPORT,
      recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
      args: [`--disable-extensions-except=${EXTENSION_DIST}`, `--load-extension=${EXTENSION_DIST}`],
    });
    const worker = await serviceWorker(context);
    await waitForSeededSettings(worker);
    await patchSettings(worker, { ...settings, serverUrl });
    await use(context);
    await context.close();
    await copyVideos(videoRequests);
  },

  worker: async ({ context }, use) => {
    await use(await serviceWorker(context));
  },

  extensionId: async ({ worker }, use) => {
    const id = new URL(worker.url()).host;
    if (!id) throw new Error(`Could not parse an extension id from ${worker.url()}`);
    await use(id);
  },

  saveVideo: async ({ videoRequests }, use) => {
    await use((page, fileName) => {
      videoRequests.push({ page, fileName });
    });
  },
});

// ---------- the overlay's closed shadow root ----------

interface DomNode {
  nodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

const sessions = new WeakMap<Page, Promise<CDPSession>>();

function cdp(page: Page): Promise<CDPSession> {
  let session = sessions.get(page);
  if (!session) sessions.set(page, (session = page.context().newCDPSession(page)));
  return session;
}

function findHost(node: DomNode): DomNode | null {
  const attrs = node.attributes ?? [];
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (attrs[i] === "id" && attrs[i + 1] === HOST.slice(1)) return node;
  }
  for (const child of node.children ?? []) {
    const found = findHost(child);
    if (found) return found;
  }
  return null;
}

/**
 * Runs `fn` against the overlay's CLOSED shadow root. Page script cannot do this (that is the point of closed,
 * and extension-loads.spec.ts proves it); the DevTools protocol can, which is how the HUD, the ghost text and
 * the learning toast are asserted without adding page-readable hooks. Returns null while there is no overlay.
 * `fn` is serialized: it must not close over anything.
 */
export async function overlayEval<T, A = undefined>(page: Page, fn: (root: ShadowRoot, arg: A) => T, arg?: A): Promise<T | null> {
  const session = await cdp(page);
  const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  const shadowId = findHost(root)?.shadowRoots?.[0]?.nodeId;
  if (shadowId === undefined) return null;
  const { object } = await session.send("DOM.resolveNode", { nodeId: shadowId });
  if (!object.objectId) return null;
  const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function (arg) { return (${fn.toString()})(this, arg); }`,
    arguments: [{ value: arg }],
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`overlayEval failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value as T;
}

export interface HudView {
  visible: boolean;
  provider: string;
  cache: string;
  latency: string;
  saved: string;
  savedTitle: string;
  /** The draft row: null until a draft has finished. */
  draft: { provider: string; firstToken: string; total: string } | null;
}

export async function readHud(page: Page): Promise<HudView | null> {
  return overlayEval(page, (root) => {
    const hud = root.querySelector(".hud");
    const main = root.querySelector<HTMLElement>(".hud-main");
    if (!hud || !main) return null;
    const value = (name: string): string => root.querySelector(`.hud .item.${name} .v`)?.textContent ?? "";
    const draftRow = root.querySelector<HTMLElement>(".hud-text");
    return {
      visible: hud.getAttribute("data-visible") === "true" && !main.hidden,
      provider: value("provider"),
      cache: value("cache"),
      latency: value("latency"),
      saved: value("saved"),
      savedTitle: root.querySelector(".hud .item.saved")?.getAttribute("title") ?? "",
      draft: draftRow && !draftRow.hidden ? { provider: value("text-provider"), firstToken: value("first-token"), total: value("text-total") } : null,
    };
  });
}

export interface GhostTextView {
  text: string;
  mode: string;
  streaming: boolean;
  /** How many lines of the field's own line-height the ghost text takes. */
  lines: number;
  drawn: boolean;
}

/** The ghost drawn for the field whose id is `fieldId` (matched through the signature the overlay stamps on its node). */
export async function readGhostText(page: Page, fieldId: string): Promise<GhostTextView | null> {
  return overlayEval(page, (root, id) => {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(".ghost[data-signature]"));
    const node = nodes.find((el) => (el.getAttribute("data-signature") ?? "").split("|").includes(id));
    const label = node?.querySelector<HTMLElement>(".label");
    if (!node || !label) return null;
    const style = getComputedStyle(label);
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    return {
      text: label.textContent ?? "",
      mode: node.getAttribute("data-mode") ?? "",
      streaming: node.getAttribute("data-streaming") === "true",
      lines: Math.round(label.scrollHeight / lineHeight),
      drawn: getComputedStyle(node).visibility !== "hidden",
    };
  }, fieldId);
}

export async function readToast(page: Page): Promise<string | null> {
  return overlayEval(page, (root) => root.querySelector(".learn-toast span")?.textContent ?? null);
}

// ---------- the prediction server's own counters ----------

interface LatencySeries {
  route: string;
  provider: string;
  count: number;
}

export interface ServerMetrics {
  latency: LatencySeries[];
  cache: { hits: number; misses: number };
  counters: { ghostsShown: number; ghostsAccepted: number; keystrokesSaved: number; clicksSaved: number };
  calibration: { pairs: number };
}

export async function serverMetrics(baseUrl: string = E2E_SERVER_URL): Promise<ServerMetrics> {
  const response = await fetch(`${baseUrl}/v1/metrics`);
  if (!response.ok) throw new Error(`GET /v1/metrics answered ${response.status}`);
  return (await response.json()) as ServerMetrics;
}

/** Requests the server has answered on `route`, whoever answered them (the heuristic, or its own cache). */
export async function serverCalls(route: string, baseUrl: string = E2E_SERVER_URL): Promise<number> {
  const { latency } = await serverMetrics(baseUrl);
  return latency.filter((series) => series.route === route).reduce((sum, series) => sum + series.count, 0);
}

export { expect };
