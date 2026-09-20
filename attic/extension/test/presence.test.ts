// The /v1/presence heartbeat: what it sends, when, and that it never surfaces a failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_ALARM, PRESENCE_INTERVAL_MS, PRESENCE_PING, createPresence, detectBrowser, presenceNames, registerPresence } from "../src/background/presence";
import type { Presence } from "../src/background/presence";
import { resetMemoryStorage, saveSettings } from "../src/lib/storage";

const BASE = "http://127.0.0.1:8788";
const okFetch = () => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true })));

function sent(fetchMock: ReturnType<typeof okFetch>, call = 0): { url: string; init: RequestInit; body: unknown } {
  const [url, init] = fetchMock.mock.calls[call] ?? [];
  return { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) };
}

/** How many beats went out under `browser` (a Chrome-family beat also goes out as "arc" and "vivaldi"). */
function beats(fetchMock: ReturnType<typeof okFetch>, browser: string): number {
  return fetchMock.mock.calls.filter(([, init]) => (JSON.parse(String(init?.body)) as { browser?: string }).browser === browser).length;
}

/** Lets the awaited settings/url lookups inside a beat run under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

let presence: Presence | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  resetMemoryStorage();
});
afterEach(() => {
  presence?.stop();
  presence = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("detectBrowser", () => {
  it("follows the documented order: Firefox by url, then Edge, Opera, Brave, Chrome brands, else chromium", () => {
    expect(detectBrowser({ extensionUrl: "moz-extension://1234/", brands: ["Google Chrome"] })).toBe("firefox");
    expect(detectBrowser({ brands: ["Not A(Brand", "Chromium", "Microsoft Edge"] })).toBe("edge");
    expect(detectBrowser({ brands: ["Chromium", "Opera"] })).toBe("opera");
    expect(detectBrowser({ brands: ["Brave", "Chromium"] })).toBe("brave");
    expect(detectBrowser({ brands: ["Google Chrome", "Chromium", "Not_A Brand"] })).toBe("chrome");
    expect(detectBrowser({ brands: ["Chromium", "Not_A Brand"] })).toBe("chromium");
    expect(detectBrowser({})).toBe("chromium");
  });

  it("falls back to user agent tokens where brands say nothing (Edge, Opera, Vivaldi, Arc)", () => {
    const chrome = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    expect(detectBrowser({ userAgent: `${chrome} Edg/130.0.0.0` })).toBe("edge");
    expect(detectBrowser({ userAgent: `${chrome} OPR/115.0.0.0` })).toBe("opera");
    expect(detectBrowser({ userAgent: `${chrome} Vivaldi/7.0` })).toBe("vivaldi");
    expect(detectBrowser({ userAgent: `${chrome} Arc/1.60` })).toBe("arc");
    expect(detectBrowser({ userAgent: chrome })).toBe("chromium");
  });
});

describe("createPresence", () => {
  const deps = (fetchMock: typeof fetch, over: Partial<Parameters<typeof createPresence>[0]> = {}) => ({
    browser: "chrome" as const, version: "0.1.0", fetch: fetchMock, getServerUrl: async () => BASE, isEnabled: async () => true, ...over,
  });

  it("beats once on start and every 30 s after, as JSON with the documented body", async () => {
    const fetchMock = okFetch();
    presence = createPresence(deps(fetchMock));
    presence.start();
    await flush();
    expect(beats(fetchMock, "chrome")).toBe(1);
    const first = sent(fetchMock);
    expect(first.url).toBe(`${BASE}/v1/presence`);
    expect(first.init.method).toBe("POST");
    expect(first.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(first.init.credentials).toBe("omit");
    expect(first.body).toEqual({ client: "extension", browser: "chrome", version: "0.1.0" });

    await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS);
    expect(beats(fetchMock, "chrome")).toBe(2);
    await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS * 2);
    expect(beats(fetchMock, "chrome")).toBe(4);
  });

  it("sends nothing while Ghost is disabled, and picks up again once it is enabled", async () => {
    const fetchMock = okFetch();
    let enabled = false;
    presence = createPresence(deps(fetchMock, { isEnabled: async () => enabled }));
    presence.start();
    await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS * 3);
    expect(fetchMock).not.toHaveBeenCalled();
    enabled = true;
    await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS);
    expect(beats(fetchMock, "chrome")).toBe(1);
  });

  it("is silent when the server is down, answers an error, or is not configured", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(createPresence(deps(down)).beat()).resolves.toBe(false);
    const refused = vi.fn<typeof fetch>(async () => new Response("{}", { status: 403 }));
    await expect(createPresence(deps(refused)).beat()).resolves.toBe(false);
    const nowhere = okFetch();
    await expect(createPresence(deps(nowhere, { getServerUrl: async () => null })).beat()).resolves.toBe(false);
    expect(nowhere).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
  });

  it("gives up on a hanging server after its deadline", async () => {
    const hanging = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const beat = createPresence(deps(hanging, { timeoutMs: 1000 })).beat();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(beat).resolves.toBe(false);
  });

  it("wake() beats at most once per 25 s, however often the worker is woken", async () => {
    const fetchMock = okFetch();
    let clock = 1_000_000;
    presence = createPresence(deps(fetchMock, { now: () => clock }));
    await presence.wake();
    await presence.wake();
    clock += 10_000;
    await presence.wake();
    expect(beats(fetchMock, "chrome")).toBe(1);
    clock += 16_000;
    await presence.wake();
    expect(beats(fetchMock, "chrome")).toBe(2);
  });

  it("omits the version when there is none", async () => {
    const fetchMock = okFetch();
    await createPresence(deps(fetchMock, { version: undefined, browser: "brave" })).beat();
    expect(sent(fetchMock).body).toEqual({ client: "extension", browser: "brave" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // a recognized browser beats under its own name only
  });

  it("a Chrome-family browser that cannot be told apart also beats as arc and vivaldi, so Ghost Desktop stands down there", async () => {
    // Arc and Vivaldi report Chrome or Chromium brands and no UA token: Desktop matches names exactly.
    expect(presenceNames("chrome")).toEqual(["chrome", "arc", "vivaldi"]);
    expect(presenceNames("chromium")).toEqual(["chromium", "arc", "vivaldi"]);
    for (const own of ["edge", "opera", "brave", "arc", "vivaldi", "firefox"] as const) expect(presenceNames(own)).toEqual([own]);

    const fetchMock = okFetch();
    await expect(createPresence(deps(fetchMock, { browser: "chromium" })).beat()).resolves.toBe(true);
    const bodies = fetchMock.mock.calls.map((_call, i) => sent(fetchMock, i).body);
    expect(bodies).toEqual([
      { client: "extension", browser: "chromium", version: "0.1.0" },
      { client: "extension", browser: "arc", version: "0.1.0" },
      { client: "extension", browser: "vivaldi", version: "0.1.0" },
    ]);
    for (let i = 0; i < 3; i++) expect(sent(fetchMock, i).init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("the beat reports the detected name's result; a look-alike's failure is silent", async () => {
    const lookAlikeDown = vi.fn<typeof fetch>(async (_url, init) =>
      new Response("{}", { status: (JSON.parse(String(init?.body)) as { browser: string }).browser === "chrome" ? 200 : 400 }));
    await expect(createPresence(deps(lookAlikeDown)).beat()).resolves.toBe(true);
    const ownDown = vi.fn<typeof fetch>(async (_url, init) =>
      new Response("{}", { status: (JSON.parse(String(init?.body)) as { browser: string }).browser === "chrome" ? 500 : 200 }));
    await expect(createPresence(deps(ownDown)).beat()).resolves.toBe(false);
  });
});

describe("registerPresence", () => {
  type Listener = (message: unknown, sender: { id?: string }, sendResponse: (reply: unknown) => void) => boolean;

  function stubChrome(permissions: string[]) {
    const onMessage = { addListener: vi.fn() };
    const alarms = { create: vi.fn(async () => undefined), onAlarm: { addListener: vi.fn() } };
    vi.stubGlobal("chrome", {
      runtime: { id: "ghost-id", onMessage, getURL: () => "chrome-extension://ghost-id/", getManifest: () => ({ version: "0.1.0", permissions }) },
      alarms,
    });
    return { onMessage, alarms };
  }

  it("does nothing outside a real extension worker (no getManifest)", () => {
    vi.stubGlobal("chrome", { runtime: { id: "ghost-id", onMessage: { addListener: vi.fn() } } });
    expect(registerPresence()).toBeNull();
  });

  it("without the alarms permission: beats on worker start, on an interval, and answers the content ping", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { onMessage, alarms } = stubChrome(["storage", "debugger"]);
    presence = registerPresence();
    expect(presence).not.toBeNull();
    await flush();
    expect(beats(fetchMock, "chromium")).toBe(1); // the first beat, on worker start
    expect(sent(fetchMock).url).toBe("http://localhost:8787/v1/presence"); // the default serverUrl
    expect(alarms.create).not.toHaveBeenCalled();

    const listener = onMessage.addListener.mock.calls[0]?.[0] as Listener;
    const reply = vi.fn();
    expect(listener({ type: PRESENCE_PING }, { id: "ghost-id" }, reply)).toBe(false);
    expect(reply).toHaveBeenCalledWith({ ok: true });
    expect(listener({ type: PRESENCE_PING }, { id: "a-web-page" }, reply)).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
    await flush();
    expect(beats(fetchMock, "chromium")).toBe(1); // throttled: the last beat is younger than 25 s

    await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS);
    expect(beats(fetchMock, "chromium")).toBe(2);
  });

  it("a settings change (switched on, another server) beats right away, inside the 25 s window too", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    stubChrome(["storage"]);
    presence = registerPresence();
    await flush();
    expect(beats(fetchMock, "chromium")).toBe(1);
    const calls = fetchMock.mock.calls.length;
    await saveSettings({ serverUrl: BASE });
    await flush();
    expect(beats(fetchMock, "chromium")).toBe(2);
    expect(sent(fetchMock, calls).url).toBe(`${BASE}/v1/presence`);
    await saveSettings({ enabled: false });
    await flush();
    expect(beats(fetchMock, "chromium")).toBe(2); // switched off: silence, and Desktop takes the browser back
  });

  it("with the alarms permission: a 30 s alarm drives the beat", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const { alarms } = stubChrome(["storage", "alarms"]);
    presence = registerPresence();
    await flush();
    expect(alarms.create).toHaveBeenCalledWith(PRESENCE_ALARM, { periodInMinutes: 0.5 });
    expect(beats(fetchMock, "chromium")).toBe(1);
    const onAlarm = alarms.onAlarm.addListener.mock.calls[0]?.[0] as (alarm: { name: string }) => void;
    onAlarm({ name: "something-else" });
    onAlarm({ name: PRESENCE_ALARM });
    await flush();
    expect(beats(fetchMock, "chromium")).toBe(2);
  });
});
