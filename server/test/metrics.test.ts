import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { LatencyLog, percentile } from "../src/lib/latency";
import { getMetrics, Metrics, type MetricsSnapshot } from "../src/lib/metrics";
import { sampleFormRequest } from "../src/providers/sampleForm";

describe("latency log", () => {
  it("computes nearest-rank percentiles", () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });

  it("tracks count, p50, p95 and last per route and provider", () => {
    const log = new LatencyLog();
    for (const ms of [100, 300, 200, 1000, 150]) log.record("/v1/predict/form", "typesafe", ms);
    log.record("/v1/predict/form", "heuristic", 2);
    log.record("/v1/predict/form", "heuristic", Number.NaN);
    expect(log.snapshot()).toEqual([
      { route: "/v1/predict/form", provider: "typesafe", count: 5, failures: 0, p50: 200, p95: 1000, last: 150 },
      { route: "/v1/predict/form", provider: "heuristic", count: 1, failures: 0, p50: 2, p95: 2, last: 2 },
    ]);
  });

  it("counts failed calls and keeps their latency in the percentiles", () => {
    const log = new LatencyLog();
    log.record("/v1/predict/form", "typesafe", 120);
    log.record("/v1/predict/form", "typesafe", 2500, false);
    expect(log.snapshot()).toEqual([{ route: "/v1/predict/form", provider: "typesafe", count: 2, failures: 1, p50: 120, p95: 2500, last: 2500 }]);
  });
});

describe("Metrics", () => {
  it("aggregates counters, cache hit rate and calibration buckets", () => {
    const metrics = new Metrics();
    metrics.recordCache(true);
    metrics.recordCache(false);
    metrics.recordCache(true);
    metrics.recordCache(true);
    metrics.addCounters({ ghostsShown: 10, ghostsAccepted: 4 });
    metrics.addCounters({ ghostsAccepted: 1, keystrokesSaved: 120 });
    metrics.addCalibration([
      { confidence: 0.95, accepted: true },
      { confidence: 0.91, accepted: false },
      { confidence: 1, accepted: true },
      { confidence: 0.72, accepted: true },
    ]);
    const snap = metrics.snapshot();
    expect(snap.cache).toEqual({ hits: 3, misses: 1, hitRate: 0.75 });
    expect(snap.counters).toEqual({ ghostsShown: 10, ghostsAccepted: 5, keystrokesSaved: 120, clicksSaved: 0, acceptanceRate: 0.5 });
    expect(snap.calibration.pairs).toBe(4);
    expect(snap.calibration.buckets).toHaveLength(10);
    expect(snap.calibration.buckets[9]).toMatchObject({ min: 0.9, max: 1, count: 3, accepted: 2 });
    expect(snap.calibration.buckets[9]?.acceptanceRate).toBeCloseTo(2 / 3);
    expect(snap.calibration.buckets[7]).toMatchObject({ count: 1, accepted: 1, meanConfidence: 0.72 });
  });

  it("is shared per config object and isolated between apps", () => {
    const a = {};
    expect(getMetrics(a)).toBe(getMetrics(a));
    expect(getMetrics(a)).not.toBe(getMetrics({}));
  });
});

describe("metrics routes", () => {
  const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("reports predict latency (p50/p95) and the cache hit rate", async () => {
    const app = createApp(loadConfig({}));
    await post(app, "/v1/predict/form", sampleFormRequest());
    await post(app, "/v1/predict/form", sampleFormRequest());
    await post(app, "/v1/predict/next", { origin: "http://localhost:5173", url: "http://localhost:5173/", recentActions: [], candidates: [] });

    const res = await app.request("/v1/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsSnapshot;
    expect(body.cache).toEqual({ hits: 1, misses: 1, hitRate: 0.5 });
    const stats = { failures: 0, p50: expect.any(Number), p95: expect.any(Number), last: expect.any(Number) };
    expect(body.latency).toEqual([
      { route: "/v1/predict/form", provider: "heuristic", count: 1, ...stats },
      { route: "/v1/predict/form", provider: "cache", count: 1, ...stats },
      { route: "/v1/predict/next", provider: "heuristic", count: 1, ...stats },
    ]);
  });

  it("accepts client counters and calibration pairs", async () => {
    const app = createApp(loadConfig({}));
    const first = await post(app, "/v1/metrics/event", { counters: { ghostsShown: 3, ghostsAccepted: 2, keystrokesSaved: 41 }, calibration: [{ confidence: 0.97, accepted: true }] });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    await post(app, "/v1/metrics/event", { counters: { ghostsShown: 1, clicksSaved: 1 } });
    await post(app, "/v1/metrics/event", { calibration: [{ confidence: 0.75, accepted: false }] });

    const body = (await (await app.request("/v1/metrics")).json()) as MetricsSnapshot;
    expect(body.counters).toEqual({ ghostsShown: 4, ghostsAccepted: 2, keystrokesSaved: 41, clicksSaved: 1, acceptanceRate: 0.5 });
    expect(body.calibration.pairs).toBe(2);
    expect(body.calibration.recent).toEqual([{ confidence: 0.97, accepted: true }, { confidence: 0.75, accepted: false }]);
  });

  it("rejects bad events with 400 and leaves the counters untouched", async () => {
    const app = createApp(loadConfig({}));
    const bad: unknown[] = [
      "{not json",
      {},
      { counters: { ghostsShown: -1 } },
      { counters: { ghostsShown: "3" } },
      { counters: { passwordsSeen: 1 } },
      { calibration: [{ confidence: 1.5, accepted: true }] },
      { calibration: [{ confidence: 0.5, accepted: "yes" }] },
      { calibration: Array.from({ length: 501 }, () => ({ confidence: 0.5, accepted: true })) },
    ];
    for (const body of bad) expect((await post(app, "/v1/metrics/event", body)).status).toBe(400);
    const snap = (await (await app.request("/v1/metrics")).json()) as MetricsSnapshot;
    expect(snap.counters.ghostsShown).toBe(0);
    expect(snap.calibration.pairs).toBe(0);
  });
});
