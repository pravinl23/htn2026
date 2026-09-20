// Presence heartbeat (docs/server-api.md "/v1/presence"): "the extension is alive in this browser", so Ghost Desktop
// stays out of it. Fire and forget: a missing or slow server never surfaces to the user, and nothing is logged.
// The manifest has no "alarms" permission today, so the beat rides a setInterval plus every wake-up of the worker
// (any message from our own content scripts, which also ping every 30 s while a tab is visible).
import { getSettings, onStorageChanged } from "../lib/storage";
import { serverBaseUrl } from "./serverClient";
import type { FetchLike } from "./serverClient";

export const PRESENCE_INTERVAL_MS = 30_000;
/** A wake-up beats only when the last beat is older than this: at most one POST per 25 s. */
export const PRESENCE_MIN_GAP_MS = 25_000;
export const PRESENCE_TIMEOUT_MS = 3_000;
export const PRESENCE_ALARM = "ghost-presence";
/** C -> B, reply { ok: true }. A visible content script's "still here", so an idle worker keeps beating. */
export const PRESENCE_PING = "ghost:presence";

/** The names Ghost Desktop maps bundle ids to (desktop/src/GHServerClient.m). */
export type BrowserName = "chrome" | "chromium" | "arc" | "brave" | "edge" | "opera" | "vivaldi" | "firefox";

export interface BrowserHints {
  /** chrome.runtime.getURL(""). */
  extensionUrl?: string;
  /** navigator.userAgentData.brands[].brand */
  brands?: readonly string[];
  userAgent?: string;
}

/** Detection order from docs/server-api.md. Arc and Vivaldi usually present themselves as Chrome (see presenceNames); their UA token is a bonus. */
export function detectBrowser(hints: BrowserHints): BrowserName {
  if (hints.extensionUrl?.startsWith("moz-extension://")) return "firefox";
  const brands = new Set((hints.brands ?? []).map((brand) => brand.trim().toLowerCase()));
  const ua = hints.userAgent ?? "";
  if (brands.has("microsoft edge") || /\bEdg\//.test(ua)) return "edge";
  if (brands.has("opera") || /\bOPR\//.test(ua)) return "opera";
  if (brands.has("brave")) return "brave";
  if (brands.has("vivaldi") || /\bVivaldi\//.test(ua)) return "vivaldi";
  if (brands.has("arc") || /\bArc\//.test(ua)) return "arc";
  if (brands.has("google chrome")) return "chrome";
  return "chromium";
}

/**
 * The names one heartbeat is sent under. Arc and Vivaldi present themselves as Chrome or Chromium (no brand, no UA
 * token), and Ghost Desktop matches a name exactly, so a Chrome-family browser that could not be told apart also
 * beats as "arc" and "vivaldi". Otherwise Desktop would draw a second ghost and fight the content script for Tab in
 * those browsers. The price: while this extension is alive, Desktop also stays out of an Arc or Vivaldi WITHOUT it
 * (a missing ghost, never a double one). A recognized browser beats under its own name only.
 */
export function presenceNames(browser: BrowserName): BrowserName[] {
  return browser === "chrome" || browser === "chromium" ? [browser, "arc", "vivaldi"] : [browser];
}

function browserHints(): BrowserHints {
  const nav = (globalThis as { navigator?: { userAgent?: string; userAgentData?: { brands?: Array<{ brand?: unknown }> } } }).navigator;
  const brands = (nav?.userAgentData?.brands ?? []).map((b) => (typeof b.brand === "string" ? b.brand : ""));
  let extensionUrl: string | undefined;
  try {
    extensionUrl = chrome.runtime.getURL("");
  } catch {
    extensionUrl = undefined;
  }
  return { extensionUrl, brands, userAgent: nav?.userAgent ?? "" };
}

export interface PresenceDeps {
  browser: BrowserName;
  version?: string;
  fetch?: FetchLike;
  getServerUrl?: () => Promise<string | null>;
  isEnabled?: () => Promise<boolean>;
  now?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface Presence {
  /** POSTs now while Ghost is enabled. A call during an in-flight beat queues one refresh; never rejects. */
  beat(): Promise<boolean>;
  /** The worker woke up (a message, a settings change): beats unless the last beat is younger than 25 s. */
  wake(): Promise<boolean>;
  /** First beat right away, then every 30 s for as long as the worker lives. */
  start(): void;
  stop(): void;
}

export function createPresence(deps: PresenceDeps): Presence {
  const now = deps.now ?? Date.now;
  const isEnabled = deps.isEnabled ?? (async () => (await getSettings()).enabled);
  const bodies = presenceNames(deps.browser).map((browser) => JSON.stringify(deps.version ? { client: "extension", browser, version: deps.version } : { client: "extension", browser }));
  let lastBeat = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<boolean> | null = null;
  let refreshQueued = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function post(base: string, body: string, signal: AbortSignal): Promise<boolean> {
    try {
      const response = await (deps.fetch ?? fetch)(`${base}/v1/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal,
        credentials: "omit",
        cache: "no-store",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** True when the server took the beat under the detected name (the first one). */
  async function send(): Promise<boolean> {
    if (!(await isEnabled().catch(() => false))) return false; // to hand the browser back to Desktop, just stop beating
    const base = await (deps.getServerUrl ?? serverBaseUrl)().catch(() => null);
    if (!base) return false;
    lastBeat = now();
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), deps.timeoutMs ?? PRESENCE_TIMEOUT_MS);
    try {
      const [own = false] = await Promise.all(bodies.map((body) => post(base, body, abort.signal)));
      return own;
    } finally {
      clearTimeout(deadline);
    }
  }

  function launch(): Promise<boolean> {
    const request = send();
    inFlight = request;
    void request.finally(() => {
      if (inFlight === request) inFlight = null;
      if (refreshQueued) {
        refreshQueued = false;
        launch();
      }
    });
    return request;
  }

  const presence: Presence = {
    async beat() {
      if (!inFlight) return launch();
      // Settings can change while the startup beat is still resolving its old server URL. Coalescing that change
      // into the old request leaves the newly configured server unaware for 30 seconds, so preserve one refresh.
      refreshQueued = true;
      const active = inFlight;
      await active;
      return (inFlight as Promise<boolean> | null) ?? false;
    },
    wake() {
      return now() - lastBeat < PRESENCE_MIN_GAP_MS ? Promise.resolve(false) : presence.beat();
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void presence.beat(), deps.intervalMs ?? PRESENCE_INTERVAL_MS);
      void presence.beat();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return presence;
}

function isPresencePing(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === PRESENCE_PING;
}

/**
 * Production wiring, called synchronously at worker start. Only a real extension worker beats: without
 * chrome.runtime.getManifest (other modules' unit tests) this does nothing and returns null.
 */
export function registerPresence(): Presence | null {
  const runtime = typeof chrome === "undefined" ? undefined : chrome.runtime;
  if (!runtime || typeof runtime.getManifest !== "function") return null;
  const manifest = runtime.getManifest();
  const presence = createPresence({ browser: detectBrowser(browserHints()), version: manifest.version });
  const alarms = manifest.permissions?.includes("alarms") ? chrome.alarms : undefined;
  if (alarms?.create && alarms.onAlarm) {
    alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === PRESENCE_ALARM) void presence.beat();
    });
    void Promise.resolve(alarms.create(PRESENCE_ALARM, { periodInMinutes: 0.5 })).catch(() => undefined);
    void presence.beat();
  } else {
    presence.start();
  }
  runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== runtime.id) return false;
    void presence.wake(); // a sleeping worker was just woken: the interval died with it
    if (isPresencePing(message)) sendResponse({ ok: true });
    return false;
  });
  onStorageChanged((changes) => {
    // Switched (back) on, or pointed at another server: tell it right away. Settings change rarely, so no throttle.
    if (changes.settings?.enabled) void presence.beat();
  });
  return presence;
}
