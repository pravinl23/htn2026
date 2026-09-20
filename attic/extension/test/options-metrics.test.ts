import { afterEach, describe, expect, it, vi } from "vitest";
import { resetMemoryStorage, saveSettings } from "../src/lib/storage";
import { readLocal, resetLocalMemory, writeLocal } from "../src/options/local-store";
import { METRICS_KEY, bucketIndex, buildMetricsView, calibrationError, formatCount, formatMs, formatPercent, normalizeLocalMetrics, normalizeServerMetrics, reliabilityBuckets } from "../src/options/metrics-math";
import type { CalibrationPair } from "../src/options/metrics-math";
import { mountMetrics } from "../src/options/metrics-section";
import { ONBOARDED_KEY, mountOnboarding } from "../src/options/onboarding";
import { PLOT, chartPoints, renderBucketTable, renderReliabilityChart } from "../src/options/reliability-chart";
import { OFFLINE_LABEL, mountStatusPill } from "../src/options/status-pill";

const pairs = (list: Array<[number, 0 | 1]>): CalibrationPair[] => list.map(([c, a]) => ({ c, a }));

const SERVER_SNAPSHOT = {
  latency: [
    { route: "/v1/predict/form", provider: "jev-gateway", count: 12, failures: 1, p50: 182.4, p95: 460, last: 175 },
    { route: "/v1/predict/form", provider: "cache", count: 30, failures: 0, p50: 0.4, p95: 1.2, last: 0.3 },
    { route: "<img src=x>", provider: "heuristic", count: 1, failures: 0, p50: 2, p95: 2, last: 2 },
  ],
  cache: { hits: 30, misses: 10, hitRate: 0.75 },
  counters: { ghostsShown: 4, ghostsAccepted: 1, keystrokesSaved: 9, clicksSaved: 1, acceptanceRate: 0.25 },
  calibration: { pairs: 2, buckets: Array.from({ length: 10 }, (_, i) => ({ min: i / 10, max: (i + 1) / 10, count: i === 8 ? 2 : 0, accepted: i === 8 ? 1 : 0, meanConfidence: i === 8 ? 0.85 : 0, acceptanceRate: i === 8 ? 0.5 : 0 })), recent: [] },
};

describe("reliabilityBuckets", () => {
  it("always returns ten buckets with edges every 0.1", () => {
    const buckets = reliabilityBuckets([]);
    expect(buckets).toHaveLength(10);
    expect(buckets.map((b) => b.min)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    expect(buckets.every((b) => b.count === 0 && b.acceptanceRate === 0 && b.meanConfidence === 0)).toBe(true);
  });

  it("puts boundaries in the upper bucket and 1.0 in the last one", () => {
    expect([0, 0.0999, 0.1, 0.7, 0.79, 0.8, 0.999, 1].map(bucketIndex)).toEqual([0, 0, 1, 7, 7, 8, 9, 9]);
    expect([-0.2, 1.4].map(bucketIndex)).toEqual([0, 9]);
  });

  it("computes count, mean confidence and observed acceptance per bucket", () => {
    const buckets = reliabilityBuckets(pairs([[0.72, 1], [0.74, 0], [0.78, 1], [0.76, 1], [0.95, 1], [1, 1], [0.91, 0]]));
    expect(buckets[7]).toMatchObject({ count: 4, accepted: 3, acceptanceRate: 0.75 });
    expect(buckets[7]?.meanConfidence).toBeCloseTo(0.75, 10);
    expect(buckets[9]).toMatchObject({ count: 3, accepted: 2 });
    expect(buckets[9]?.acceptanceRate).toBeCloseTo(2 / 3, 10);
    expect(buckets[8]?.count).toBe(0);
  });

  it("weights the calibration error by bucket size", () => {
    expect(calibrationError(reliabilityBuckets([]))).toBeNull();
    expect(calibrationError(reliabilityBuckets(pairs([[0.75, 1], [0.75, 1], [0.75, 1], [0.75, 0]])))).toBeCloseTo(0, 10);
    // three ghosts at 0.9 all dismissed (gap 0.9), one at 0.5 accepted (gap 0.5): (3 * 0.9 + 1 * 0.5) / 4
    expect(calibrationError(reliabilityBuckets(pairs([[0.9, 0], [0.9, 0], [0.9, 0], [0.5, 1]])))).toBeCloseTo(0.8, 10);
  });
});

describe("metrics normalizers", () => {
  it("treats an absent or malformed ghost.metrics as no data", () => {
    for (const raw of [undefined, null, "x", 4, []]) expect(normalizeLocalMetrics(raw)).toBeNull();
    expect(normalizeLocalMetrics({})).toEqual({ ghostsShown: 0, ghostsAccepted: 0, keystrokesSaved: 0, clicksSaved: 0, calibration: [] });
  });

  it("keeps valid counters and pairs, drops junk, and caps the log at 1000", () => {
    const raw = { ghostsShown: 10, ghostsAccepted: "7", keystrokesSaved: -3, clicksSaved: Number.NaN, calibration: [{ c: 0.8, a: 1 }, { c: 2, a: 1 }, { c: 0.5, a: true }, null, { c: 0.6, a: 0 }] };
    expect(normalizeLocalMetrics(raw)).toEqual({ ghostsShown: 10, ghostsAccepted: 0, keystrokesSaved: 0, clicksSaved: 0, calibration: [{ c: 0.8, a: 1 }, { c: 0.6, a: 0 }] });
    const many = Array.from({ length: 1500 }, () => ({ c: 0.9, a: 1 }));
    expect(normalizeLocalMetrics({ calibration: many })?.calibration).toHaveLength(1000);
  });

  it("normalizes the server snapshot and tolerates missing parts", () => {
    const server = normalizeServerMetrics(SERVER_SNAPSHOT);
    expect(server?.latency.map((r) => r.provider)).toEqual(["cache", "jev-gateway", "heuristic"]);
    expect(server?.cache).toEqual({ hits: 30, misses: 10 });
    expect(server?.buckets[8]).toMatchObject({ count: 2, accepted: 1, acceptanceRate: 0.5 });
    expect(normalizeServerMetrics(null)).toBeNull();
    expect(normalizeServerMetrics({})).toMatchObject({ latency: [], cache: { hits: 0, misses: 0 } });
    expect(normalizeServerMetrics({ latency: [{ route: 1 }, "x"], calibration: { buckets: "no" } })?.latency).toEqual([]);
  });
});

describe("buildMetricsView", () => {
  it("is all empty states with no data at all", () => {
    const view = buildMetricsView(null, null);
    expect(view).toMatchObject({ acceptanceRate: null, cacheHitRate: null, latency: [], calibrationPairs: 0, calibrationError: null });
    expect(view.buckets).toHaveLength(10);
  });

  it("prefers local counters and pairs, and takes latency and cache from the server", () => {
    const local = normalizeLocalMetrics({ ghostsShown: 20, ghostsAccepted: 15, keystrokesSaved: 412, clicksSaved: 6, calibration: [{ c: 0.75, a: 1 }] });
    const view = buildMetricsView(local, normalizeServerMetrics(SERVER_SNAPSHOT));
    expect(view.acceptanceRate).toBe(0.75);
    expect(view.counters.keystrokesSaved).toBe(412);
    expect(view.cacheHitRate).toBe(0.75);
    expect(view.calibrationPairs).toBe(1);
    expect(view.latency).toHaveLength(3);
  });

  it("falls back to the server's counters and buckets when nothing is stored locally", () => {
    const view = buildMetricsView(null, normalizeServerMetrics(SERVER_SNAPSHOT));
    expect(view.acceptanceRate).toBe(0.25);
    expect(view.calibrationPairs).toBe(2);
    expect(view.buckets[8]?.meanConfidence).toBeCloseTo(0.85, 10);
  });

  it("formats numbers for tiles and tables", () => {
    expect([formatPercent(null), formatPercent(0.756), formatPercent(1)]).toEqual(["–", "76%", "100%"]);
    expect([formatCount(0), formatCount(1284), formatCount(12_940), formatCount(4_200_000)]).toEqual(["0", "1,284", "12.9K", "4.2M"]);
    expect([formatMs(0.42), formatMs(182.4)]).toEqual(["0.4 ms", "182 ms"]);
  });
});

describe("reliability chart", () => {
  const buckets = reliabilityBuckets(pairs([[0.75, 1], [0.75, 1], [0.75, 0], [0.75, 0], [1, 1], [0, 0]]));

  it("places one point per non-empty bucket: x is predicted confidence, y is observed acceptance (up is higher)", () => {
    const points = chartPoints(buckets);
    expect(points).toHaveLength(3);
    const [low, mid, high] = points;
    expect([low?.x, low?.y]).toEqual([PLOT.left, PLOT.top + PLOT.size]);
    expect([mid?.x, mid?.y]).toEqual([PLOT.left + 0.75 * PLOT.size, PLOT.top + 0.5 * PLOT.size]);
    expect([high?.x, high?.y]).toEqual([PLOT.left + PLOT.size, PLOT.top]);
    expect(mid?.label).toBe("70–80% confidence: predicted 75%, accepted 50% (2 of 4)");
    expect(chartPoints(reliabilityBuckets([]))).toEqual([]);
  });

  it("draws the diagonal corner to corner, the series and focusable points", () => {
    const onFocus = vi.fn();
    const chart = renderReliabilityChart(buckets, onFocus);
    const diagonal = chart.querySelector(".diagonal");
    expect(["x1", "y1", "x2", "y2"].map((a) => Number(diagonal?.getAttribute(a)))).toEqual([PLOT.left, PLOT.top + PLOT.size, PLOT.left + PLOT.size, PLOT.top]);
    expect(chart.querySelector(".series")?.getAttribute("points")?.split(" ")).toHaveLength(3);
    const marks = [...chart.querySelectorAll<SVGGElement>(".point")];
    expect(marks).toHaveLength(3);
    expect(marks[1]?.getAttribute("tabindex")).toBe("0");
    expect(marks[1]?.querySelector("title")?.textContent).toMatch(/predicted 75%/);
    marks[1]?.dispatchEvent(new Event("focus"));
    expect(onFocus).toHaveBeenLastCalledWith("70–80% confidence: predicted 75%, accepted 50% (2 of 4)");
    marks[1]?.dispatchEvent(new Event("blur"));
    expect(onFocus).toHaveBeenLastCalledWith(null);
  });

  it("has no series line for a single point and a table row for every bucket", () => {
    expect(renderReliabilityChart(reliabilityBuckets(pairs([[0.8, 1]]))).querySelector(".series")).toBeNull();
    const rows = [...renderBucketTable(buckets).querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent));
    expect(rows).toHaveLength(10);
    expect(rows[7]).toEqual(["70–80%", "4", "75%", "50%"]);
    expect(rows[3]).toEqual(["30–40%", "0", "–", "–"]);
  });
});

const $ = <T extends HTMLElement>(testId: string): T => {
  const el = document.querySelector<T>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`missing ${testId}`);
  return el;
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const jsonReply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const offline = (): typeof fetch => vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;

describe("metrics tab", () => {
  let stop: (() => void) | undefined;
  const mount = (fetchMock: typeof fetch, refreshMs = 60_000): HTMLElement => {
    const panel = document.createElement("section");
    document.body.replaceChildren(panel);
    stop = mountMetrics(panel, { fetch: fetchMock, serverUrl: "http://localhost:8788", refreshMs });
    return panel;
  };

  afterEach(() => {
    stop?.();
    stop = undefined;
    document.body.replaceChildren();
    resetLocalMemory();
    resetMemoryStorage();
    vi.useRealTimers();
  });

  it("renders empty states when ghost.metrics is absent and the server is down", async () => {
    const panel = mount(offline());
    await settle();
    expect(panel.dataset.loaded).toBe("true");
    expect($("metric-acceptance").textContent).toContain("–");
    expect($("metric-acceptance").textContent).toContain("No ghosts shown yet");
    expect($("metric-keystrokes").querySelector("strong")?.textContent).toBe("0");
    expect($("metric-cache").textContent).toContain("No cacheable calls yet");
    expect($("latency-empty").textContent).toMatch(/Start the server with pnpm dev/);
    expect($("reliability-empty").textContent).toMatch(/No calibration data yet/);
    expect(document.querySelector('[data-testid="reliability-chart"]')).toBeNull();
  });

  it("shows counters, the latency table and the chart, inserting server strings as text", async () => {
    await writeLocal(METRICS_KEY, { ghostsShown: 20, ghostsAccepted: 15, keystrokesSaved: 412, clicksSaved: 6, calibration: [{ c: 0.75, a: 1 }, { c: 0.78, a: 0 }, { c: 0.95, a: 1 }] });
    const fetchMock = vi.fn(async () => jsonReply(SERVER_SNAPSHOT));
    const panel = mount(fetchMock as unknown as typeof fetch);
    await settle();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:8788/v1/metrics");
    expect($("metric-acceptance").querySelector("strong")?.textContent).toBe("75%");
    expect($("metric-acceptance").textContent).toContain("15 of 20 ghosts");
    expect($("metric-keystrokes").querySelector("strong")?.textContent).toBe("412");
    expect($("metric-clicks").querySelector("strong")?.textContent).toBe("6");
    expect($("metric-cache").querySelector("strong")?.textContent).toBe("75%");
    const rows = [...$("latency-table").querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => td.textContent));
    expect(rows[1]).toEqual(["/v1/predict/form", "jev-gateway", "12", "1", "182 ms", "460 ms", "175 ms"]);
    expect(rows[2]?.[0]).toBe("<img src=x>");
    expect(panel.querySelector("img")).toBeNull();
    expect($("reliability-chart").querySelectorAll(".point")).toHaveLength(2);
    expect($("reliability-readout").textContent).toMatch(/^3 ghosts · calibration error \d+%/);
  });

  it("follows ghost.metrics as it changes and keeps an opened table open across refreshes", async () => {
    await writeLocal(METRICS_KEY, { ghostsShown: 1, ghostsAccepted: 1, keystrokesSaved: 5, clicksSaved: 0, calibration: [{ c: 0.9, a: 1 }] });
    const panel = mount(offline());
    await settle();
    const details = panel.querySelector("details");
    if (details) details.open = true;
    $("metrics-refresh").click();
    await settle();
    expect(panel.querySelector("details")).toBe(details);
    await writeLocal(METRICS_KEY, { ghostsShown: 2, ghostsAccepted: 1, keystrokesSaved: 5, clicksSaved: 0, calibration: [{ c: 0.9, a: 1 }, { c: 0.72, a: 0 }] });
    expect($("metric-acceptance").querySelector("strong")?.textContent).toBe("50%");
    expect($("reliability-chart").querySelectorAll(".point")).toHaveLength(2);
  });

  it("refreshes every 5 seconds only while the tab is showing, and stops when torn down", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonReply(SERVER_SNAPSHOT));
    const panel = mount(fetchMock as unknown as typeof fetch, 5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    panel.hidden = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    panel.hidden = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    stop?.();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("server status pill", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    document.body.replaceChildren();
    resetMemoryStorage();
  });

  it("shows the provider and whether its confidence is calibrated", async () => {
    const fetchMock = vi.fn(async () => jsonReply({ ok: true, provider: "jev-gateway", calibrated: true, textProvider: "xai", version: "0.1.0" }));
    stop = mountStatusPill(document.body, { fetch: fetchMock as unknown as typeof fetch, serverUrl: "http://localhost:8788" });
    await settle();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:8788/v1/health");
    expect($("server-status").dataset.state).toBe("online");
    expect($("server-status-label").textContent).toBe("jev-gateway · calibrated");
  });

  it("says not calibrated for the heuristic and offline when the server is down", async () => {
    stop = mountStatusPill(document.body, { fetch: vi.fn(async () => jsonReply({ ok: true, provider: "heuristic", calibrated: false })) as unknown as typeof fetch, serverUrl: "http://x" });
    await settle();
    expect($("server-status-label").textContent).toBe("heuristic · not calibrated");
    stop();
    stop = mountStatusPill(document.body, { fetch: offline(), serverUrl: "http://x" });
    await settle();
    expect($("server-status").dataset.state).toBe("offline");
    expect($("server-status-label").textContent).toBe(OFFLINE_LABEL);
  });

  it("checks again, against the new URL, when the server URL setting changes", async () => {
    const fetchMock = vi.fn(async () => jsonReply({ ok: true, provider: "heuristic", calibrated: false }));
    stop = mountStatusPill(document.body, { fetch: fetchMock as unknown as typeof fetch });
    await settle();
    await saveSettings({ serverUrl: "http://localhost:9000" });
    await settle();
    expect(fetchMock.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual(["http://localhost:8787/v1/health", "http://localhost:9000/v1/health"]);
  });
});

describe("onboarding card", () => {
  afterEach(() => {
    document.body.replaceChildren();
    resetLocalMemory();
  });

  it("shows on first run with the key semantics, privacy promises and the demo link", async () => {
    await mountOnboarding(document.body);
    const text = $("onboarding").textContent ?? "";
    for (const phrase of ["Tab", "Esc", "Hold", "locked action", "never read, predicted, filled or learned", "API keys stay on the local Ghost server"]) expect(text).toContain(phrase);
    const demo = $<HTMLAnchorElement>("onboarding-demo");
    expect(demo.getAttribute("href")).toBe("http://localhost:5173");
    expect(demo.rel).toContain("noopener");
  });

  it("stays dismissed after Got it, and the footer button brings it back", async () => {
    const reopen = document.createElement("button");
    const host = document.createElement("div");
    document.body.append(host, reopen);
    await mountOnboarding(host, reopen);
    $("onboarding-dismiss").click();
    expect(host.childElementCount).toBe(0);
    expect(await readLocal(ONBOARDED_KEY)).toBe(true);
    const second = document.createElement("div");
    await mountOnboarding(second);
    expect(second.childElementCount).toBe(0);
    reopen.click();
    expect(host.querySelector('[data-testid="onboarding"]')).not.toBeNull();
  });
});
