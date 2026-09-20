// Pure numbers behind the metrics tab. Everything that arrives here (storage, server) is untrusted,
// so each source goes through a normalizer that keeps finite, non-negative numbers and nothing else.

export const METRICS_KEY = "ghost.metrics";
export const BUCKET_COUNT = 10;
const MAX_PAIRS = 1000;
const MAX_LATENCY_ROWS = 50;

export interface Counters {
  ghostsShown: number;
  ghostsAccepted: number;
  keystrokesSaved: number;
  clicksSaved: number;
}

/** c: confidence the ghost was shown with, a: 1 accepted, 0 dismissed or overridden. */
export interface CalibrationPair {
  c: number;
  a: 0 | 1;
}

export interface LocalMetrics extends Counters {
  calibration: CalibrationPair[];
}

export interface ReliabilityBucket {
  min: number;
  max: number;
  count: number;
  accepted: number;
  meanConfidence: number;
  acceptanceRate: number;
}

export interface LatencyRow {
  route: string;
  provider: string;
  count: number;
  failures: number;
  p50: number;
  p95: number;
  last: number;
}

export interface ServerMetrics {
  latency: LatencyRow[];
  cache: { hits: number; misses: number };
  counters: Counters;
  buckets: ReliabilityBucket[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 80) : "";
}

function counters(raw: Record<string, unknown>): Counters {
  return { ghostsShown: count(raw.ghostsShown), ghostsAccepted: count(raw.ghostsAccepted), keystrokesSaved: count(raw.keystrokesSaved), clicksSaved: count(raw.clicksSaved) };
}

function pair(raw: unknown): CalibrationPair | null {
  if (!isRecord(raw) || typeof raw.c !== "number" || !Number.isFinite(raw.c) || raw.c < 0 || raw.c > 1) return null;
  if (raw.a !== 0 && raw.a !== 1) return null;
  return { c: raw.c, a: raw.a };
}

/** null when the key is absent or unusable (the writer is another module and may not have run yet). */
export function normalizeLocalMetrics(raw: unknown): LocalMetrics | null {
  if (!isRecord(raw)) return null;
  const pairs = Array.isArray(raw.calibration) ? raw.calibration.slice(-MAX_PAIRS) : [];
  return { ...counters(raw), calibration: pairs.map(pair).filter((p): p is CalibrationPair => p !== null) };
}

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? Math.min(1, part / whole) : null;
}

export function bucketIndex(confidence: number): number {
  return Math.min(BUCKET_COUNT - 1, Math.max(0, Math.floor(confidence * BUCKET_COUNT)));
}

function bucket(index: number, n: number, accepted: number, confidenceSum: number): ReliabilityBucket {
  return {
    min: index / BUCKET_COUNT,
    max: (index + 1) / BUCKET_COUNT,
    count: n,
    accepted,
    meanConfidence: n > 0 ? confidenceSum / n : 0,
    acceptanceRate: n > 0 ? accepted / n : 0,
  };
}

/** Always BUCKET_COUNT buckets: [0, 0.1) ... [0.9, 1]. A confidence of exactly 1 lands in the last one. */
export function reliabilityBuckets(pairs: CalibrationPair[]): ReliabilityBucket[] {
  const totals = Array.from({ length: BUCKET_COUNT }, () => ({ n: 0, accepted: 0, sum: 0 }));
  for (const p of pairs) {
    const t = totals[bucketIndex(p.c)];
    if (!t) continue;
    t.n += 1;
    t.accepted += p.a;
    t.sum += p.c;
  }
  return totals.map((t, i) => bucket(i, t.n, t.accepted, t.sum));
}

/** Expected calibration error: the count-weighted gap between predicted and observed. null without data. */
export function calibrationError(buckets: ReliabilityBucket[]): number | null {
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) return null;
  return buckets.reduce((sum, b) => sum + (b.count / total) * Math.abs(b.meanConfidence - b.acceptanceRate), 0);
}

function serverBucket(raw: unknown, index: number): ReliabilityBucket {
  const r = isRecord(raw) ? raw : {};
  const n = Math.floor(count(r.count));
  const accepted = Math.min(n, Math.floor(count(r.accepted)));
  const lo = index / BUCKET_COUNT;
  const mean = Math.min((index + 1) / BUCKET_COUNT, Math.max(lo, count(r.meanConfidence)));
  return bucket(index, n, accepted, mean * n);
}

function latencyRow(raw: unknown): LatencyRow | null {
  if (!isRecord(raw) || !text(raw.route) || !text(raw.provider)) return null;
  return { route: text(raw.route), provider: text(raw.provider), count: count(raw.count), failures: count(raw.failures), p50: count(raw.p50), p95: count(raw.p95), last: count(raw.last) };
}

export function normalizeServerMetrics(raw: unknown): ServerMetrics | null {
  if (!isRecord(raw)) return null;
  const cache = isRecord(raw.cache) ? raw.cache : {};
  const calibration = isRecord(raw.calibration) ? raw.calibration : {};
  const rawBuckets = Array.isArray(calibration.buckets) ? calibration.buckets : [];
  const latency = (Array.isArray(raw.latency) ? raw.latency.slice(0, MAX_LATENCY_ROWS) : []).map(latencyRow).filter((r): r is LatencyRow => r !== null);
  return {
    latency: latency.sort((a, b) => a.route.localeCompare(b.route) || a.provider.localeCompare(b.provider)),
    cache: { hits: count(cache.hits), misses: count(cache.misses) },
    counters: counters(isRecord(raw.counters) ? raw.counters : {}),
    buckets: Array.from({ length: BUCKET_COUNT }, (_, i) => serverBucket(rawBuckets[i], i)),
  };
}

export interface MetricsView {
  counters: Counters;
  acceptanceRate: number | null;
  cacheHitRate: number | null;
  cache: { hits: number; misses: number };
  latency: LatencyRow[];
  buckets: ReliabilityBucket[];
  calibrationPairs: number;
  calibrationError: number | null;
}

function hasCounters(c: Counters): boolean {
  return c.ghostsShown + c.ghostsAccepted + c.keystrokesSaved + c.clicksSaved > 0;
}

/**
 * Local storage is the durable record (the server's copy is in memory and resets with it), so it wins
 * whenever it holds anything; the server's counters and buckets only fill in when local has nothing.
 */
export function buildMetricsView(local: LocalMetrics | null, server: ServerMetrics | null): MetricsView {
  const zero: Counters = { ghostsShown: 0, ghostsAccepted: 0, keystrokesSaved: 0, clicksSaved: 0 };
  const chosen = local && hasCounters(local) ? local : (server?.counters ?? local ?? zero);
  const localBuckets = reliabilityBuckets(local?.calibration ?? []);
  const useLocal = (local?.calibration.length ?? 0) > 0 || !server;
  const buckets = useLocal ? localBuckets : server.buckets;
  const cache = server?.cache ?? { hits: 0, misses: 0 };
  return {
    counters: { ghostsShown: chosen.ghostsShown, ghostsAccepted: chosen.ghostsAccepted, keystrokesSaved: chosen.keystrokesSaved, clicksSaved: chosen.clicksSaved },
    acceptanceRate: ratio(chosen.ghostsAccepted, chosen.ghostsShown),
    cacheHitRate: ratio(cache.hits, cache.hits + cache.misses),
    cache,
    latency: server?.latency ?? [],
    buckets,
    calibrationPairs: buckets.reduce((sum, b) => sum + b.count, 0),
    calibrationError: calibrationError(buckets),
  };
}

export function formatPercent(value: number | null): string {
  return value === null ? "–" : `${Math.round(value * 100)}%`;
}

export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

export function formatMs(value: number): string {
  return value >= 10 ? `${Math.round(value)} ms` : `${Math.round(value * 10) / 10} ms`;
}
