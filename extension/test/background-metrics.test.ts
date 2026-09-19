// The worker's side of metrics: sanitize, accumulate into `ghost.metrics` (the shape the options page reads),
// forward to the server best effort. Also the profile read-modify-write learning depends on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardToServer, handleMetricsMessage, isMetricsMessage, recordMetrics, toServerEvent } from "../src/background/metrics";
import { sanitizeMetricsBatch, isGhostMessage } from "../src/lib/messages";
import type { MetricsBatch, MetricsPair } from "../src/lib/messages";
import { addMetrics, getMetrics, getProfile, MAX_CALIBRATION_PAIRS, METRICS_KEY, normalizeMetrics, resetMemoryStorage, SETTINGS_KEY, updateProfile } from "../src/lib/storage";
import { normalizeLocalMetrics } from "../src/options/metrics-math";
import { createChromeStorageMock } from "./chrome-mock";

const counters = (over: Partial<MetricsBatch["counters"]> = {}): MetricsBatch["counters"] => ({ ghostsShown: 0, ghostsAccepted: 0, keystrokesSaved: 0, clicksSaved: 0, ...over });
const pair = (over: Partial<MetricsPair> = {}): MetricsPair => ({ c: 0.9, a: 1, s: "server", cal: true, ...over });
const okFetch = () => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true })));
const server = async (): Promise<string> => "http://localhost:8788";

beforeEach(() => resetMemoryStorage());
afterEach(() => vi.unstubAllGlobals());

describe("sanitizeMetricsBatch", () => {
  it("keeps whole, bounded counters and well-formed pairs, and nothing else", () => {
    const batch = sanitizeMetricsBatch({
      counters: { ghostsShown: 3.7, ghostsAccepted: -2, keystrokesSaved: 1e12, clicksSaved: "4", evil: 1 },
      pairs: [pair(), { c: 1.2, a: 1 }, { c: 0.5, a: 2 }, { c: 0.5, a: 0, s: "<script>", cal: "yes" }, "junk"],
      value: "alex.chen.dev@example.com",
    });
    expect(batch).toEqual({
      counters: { ghostsShown: 3, ghostsAccepted: 0, keystrokesSaved: 100_000, clicksSaved: 0 },
      pairs: [pair(), { c: 0.5, a: 0, s: "unknown", cal: false }],
    });
  });

  it("is null for junk and for a batch with nothing in it", () => {
    expect(sanitizeMetricsBatch(null)).toBeNull();
    expect(sanitizeMetricsBatch({ counters: counters(), pairs: [] })).toBeNull();
  });

  it("takes at most 200 pairs per message", () => {
    expect(sanitizeMetricsBatch({ pairs: Array.from({ length: 500 }, () => pair()) })?.pairs).toHaveLength(200);
  });

  it("ghost:metrics is a known message", () => {
    expect(isGhostMessage({ type: "ghost:metrics", batch: {} })).toBe(true);
    expect(isMetricsMessage({ type: "ghost:metrics", batch: {} })).toBe(true);
    expect(isMetricsMessage({ type: "ghost:health" })).toBe(false);
  });
});

describe("ghost.metrics accumulation", () => {
  it("adds deltas up across batches in exactly the shape the options page reads", async () => {
    await addMetrics({ counters: counters({ ghostsShown: 14, ghostsAccepted: 10, keystrokesSaved: 180, clicksSaved: 4 }), pairs: [pair(), pair({ a: 0, s: "offline", cal: false })] });
    const stored = await addMetrics({ counters: counters({ ghostsShown: 3, ghostsAccepted: 1, keystrokesSaved: 20 }), pairs: [pair({ c: 0.8, s: "llm", cal: false })] });
    expect(stored).toEqual({
      ghostsShown: 17, ghostsAccepted: 11, keystrokesSaved: 200, clicksSaved: 4,
      calibration: [pair(), pair({ a: 0, s: "offline", cal: false }), pair({ c: 0.8, s: "llm", cal: false })],
    });
    expect(normalizeLocalMetrics(stored)).toEqual({
      ghostsShown: 17, ghostsAccepted: 11, keystrokesSaved: 200, clicksSaved: 4,
      calibration: [{ c: 0.9, a: 1 }, { c: 0.9, a: 0 }, { c: 0.8, a: 1 }],
    });
  });

  it("caps the calibration log at 1000 pairs, newest kept", async () => {
    for (let i = 0; i < 6; i++) await addMetrics({ counters: counters(), pairs: Array.from({ length: 200 }, (_, n) => pair({ c: (i * 200 + n) / 2000 })) });
    const { calibration } = await getMetrics();
    expect(calibration).toHaveLength(MAX_CALIBRATION_PAIRS);
    expect(calibration[0]?.c).toBe(200 / 2000);
    expect(calibration.at(-1)?.c).toBe(1199 / 2000);
  });

  it("does not lose a batch when several tabs report at once", async () => {
    await Promise.all(Array.from({ length: 8 }, () => addMetrics({ counters: counters({ ghostsAccepted: 1 }), pairs: [pair()] })));
    const stored = await getMetrics();
    expect(stored.ghostsAccepted).toBe(8);
    expect(stored.calibration).toHaveLength(8);
  });

  it("reads junk in storage as zeroes", () => {
    expect(normalizeMetrics("nope")).toEqual({ ...counters(), calibration: [] });
    expect(normalizeMetrics({ ghostsShown: -1, calibration: [{ c: 2, a: 1 }, pair()] })).toEqual({ ...counters(), calibration: [pair()] });
  });

  it("writes through chrome.storage.local under ghost.metrics", async () => {
    const mock = createChromeStorageMock();
    vi.stubGlobal("chrome", mock.chrome);
    await addMetrics({ counters: counters({ clicksSaved: 2 }), pairs: [] });
    expect(mock.store.get(METRICS_KEY)).toEqual({ ...counters({ clicksSaved: 2 }), calibration: [] });
  });
});

describe("forwarding to POST /v1/metrics/event", () => {
  it("sends counters plus ONLY the calibrated pairs, in the server's words", async () => {
    const fetchMock = okFetch();
    const batch: MetricsBatch = { counters: counters({ ghostsShown: 2 }), pairs: [pair({ c: 0.97 }), pair({ a: 0, s: "offline", cal: false }), pair({ c: 0.71, a: 0 })] };
    expect(await forwardToServer(batch, { fetch: fetchMock, getServerUrl: server })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:8788/v1/metrics/event");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      counters: counters({ ghostsShown: 2 }),
      calibration: [{ confidence: 0.97, accepted: true }, { confidence: 0.71, accepted: false }],
    });
  });

  it("does not bother the server with a body it would refuse as empty", async () => {
    const fetchMock = okFetch();
    const batch: MetricsBatch = { counters: counters(), pairs: [pair({ cal: false })] };
    expect(toServerEvent(batch)).toBeNull();
    expect(await forwardToServer(batch, { fetch: fetchMock, getServerUrl: server })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is best effort: a dead server, an error status or no server URL never fails the local write", async () => {
    const down = vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("fetch failed")));
    const { reply, forwarded } = await recordMetrics({ counters: counters({ ghostsAccepted: 1 }), pairs: [] }, { fetch: down, getServerUrl: server });
    expect(reply).toEqual({ ok: true, totals: counters({ ghostsAccepted: 1 }) });
    expect(await forwarded).toBe(false);
    const teapot = vi.fn<typeof fetch>(async () => new Response("{}", { status: 418 }));
    expect(await forwardToServer({ counters: counters({ ghostsShown: 1 }), pairs: [] }, { fetch: teapot, getServerUrl: server })).toBe(false);
    expect(await forwardToServer({ counters: counters({ ghostsShown: 1 }), pairs: [] }, { fetch: okFetch(), getServerUrl: async () => null })).toBe(false);
  });

  it("answers with the lifetime totals, and with ok:false for a batch that is not one", async () => {
    await addMetrics({ counters: counters({ keystrokesSaved: 1000 }), pairs: [] });
    const deps = { fetch: okFetch(), getServerUrl: server };
    expect(await handleMetricsMessage({ type: "ghost:metrics", batch: { counters: counters({ keystrokesSaved: 12 }), pairs: [] } }, deps))
      .toEqual({ ok: true, totals: counters({ keystrokesSaved: 1012 }) });
    expect(await handleMetricsMessage({ type: "ghost:metrics", batch: "junk" as unknown as MetricsBatch }, deps)).toEqual({ ok: false });
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it("reports ok:false when storage refuses the write", async () => {
    const save = vi.fn(async () => Promise.reject(new Error("quota")));
    const { reply } = await recordMetrics({ counters: counters({ ghostsShown: 1 }), pairs: [] }, { save, fetch: okFetch(), getServerUrl: server });
    expect(reply).toEqual({ ok: false });
  });
});

describe("the worker's router", () => {
  type Listener = (message: unknown, sender: { id?: string }, sendResponse: (reply: unknown) => void) => boolean;
  const ID = "ghostghostghostghostghostghostgh";

  async function loadWorker(fetchMock: typeof fetch) {
    const storage = createChromeStorageMock();
    storage.store.set(SETTINGS_KEY, { serverUrl: "http://localhost:8788" });
    const event = () => ({ addListener: vi.fn() });
    const onMessage = event();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", {
      ...storage.chrome,
      runtime: { id: ID, onInstalled: event(), onStartup: event(), onMessage, onConnect: event() },
      commands: { onCommand: event() },
      action: { onClicked: event(), setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined), setTitle: vi.fn(async () => undefined) },
    });
    vi.resetModules();
    await import("../src/background/index");
    return { listener: onMessage.addListener.mock.calls[0]?.[0] as Listener, storage };
  }

  it("records ghost:metrics from our own content script, and from nobody else", async () => {
    const fetchMock = okFetch();
    const { listener, storage } = await loadWorker(fetchMock);
    const message = { type: "ghost:metrics", batch: { counters: counters({ ghostsShown: 5 }), pairs: [pair()] } };
    expect(listener(message, { id: "a-web-page" }, vi.fn())).toBe(false);
    const reply = await new Promise((resolve) => expect(listener(message, { id: ID }, resolve)).toBe(true));
    expect(reply).toEqual({ ok: true, totals: counters({ ghostsShown: 5 }) });
    expect(storage.store.get(METRICS_KEY)).toEqual({ ...counters({ ghostsShown: 5 }), calibration: [pair()] });
    await vi.waitFor(() => expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8788/v1/metrics/event"));
  });
});

describe("updateProfile", () => {
  it("runs read-modify-writes one at a time against the latest profile, and null leaves storage alone", async () => {
    await Promise.all([
      updateProfile((p) => ({ ...p, facts: { ...p.facts, pronouns: "they/them" } })),
      updateProfile((p) => ({ ...p, facts: { ...p.facts, timezone: "America/Toronto" } })),
      updateProfile(() => null),
    ]);
    const { facts } = await getProfile();
    expect(facts.pronouns).toBe("they/them");
    expect(facts.timezone).toBe("America/Toronto");
    expect(facts.firstName).toBe("Alex");
  });

  it("keeps working after a write that threw", async () => {
    await expect(updateProfile(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await updateProfile((p) => ({ ...p, facts: { ...p.facts, city: "Toronto" } })))?.facts.city).toBe("Toronto");
  });
});
