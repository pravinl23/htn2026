import { LatencyLog, type LatencyStats } from "./latency";

export const COUNTER_NAMES = ["ghostsShown", "ghostsAccepted", "keystrokesSaved", "clicksSaved"] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];
export type Counters = Record<CounterName, number>;

export interface CalibrationPair {
  confidence: number;
  accepted: boolean;
}

export interface CalibrationBucket {
  min: number;
  max: number;
  count: number;
  accepted: number;
  meanConfidence: number;
  acceptanceRate: number;
}

export interface MetricsSnapshot {
  latency: LatencyStats[];
  cache: { hits: number; misses: number; hitRate: number };
  counters: Counters & { acceptanceRate: number };
  calibration: { pairs: number; buckets: CalibrationBucket[]; recent: CalibrationPair[] };
}

export const CACHE_SERIES = "cache";
const BUCKETS = 10;
const RECENT_PAIRS = 200;

interface BucketTotals {
  count: number;
  accepted: number;
  confidenceSum: number;
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

/** In-memory metrics for one server instance. Holds numbers only: never field values, profile values or keys. */
export class Metrics {
  readonly latency = new LatencyLog();
  private cacheHits = 0;
  private cacheMisses = 0;
  private readonly counters: Counters = { ghostsShown: 0, ghostsAccepted: 0, keystrokesSaved: 0, clicksSaved: 0 };
  private readonly buckets: BucketTotals[] = Array.from({ length: BUCKETS }, () => ({ count: 0, accepted: 0, confidenceSum: 0 }));
  private readonly recent: CalibrationPair[] = [];
  private pairs = 0;

  recordLatency(route: string, provider: string, latencyMs: number, ok = true): void {
    this.latency.record(route, provider, latencyMs, ok);
  }

  /**
   * Attributes one finished request. Cache hits get their own series, and a fallback is charged (as a failure) to the
   * provider that failed, so a 0 ms hit never flatters a model and a timeout never lands on the heuristic.
   * `recordedElsewhere` names a provider whose model calls are already recorded one by one.
   */
  recordRequest(route: string, result: { provider: string; latencyMs: number; cache?: "hit" | "miss"; fallbackFrom?: string }, recordedElsewhere?: string): void {
    if (result.cache === "hit") return this.recordLatency(route, CACHE_SERIES, result.latencyMs);
    const responsible = result.fallbackFrom ?? result.provider;
    if (responsible !== recordedElsewhere) this.recordLatency(route, responsible, result.latencyMs, !result.fallbackFrom);
  }

  recordCache(hit: boolean): void {
    if (hit) this.cacheHits += 1;
    else this.cacheMisses += 1;
  }

  addCounters(delta: Partial<Counters>): void {
    for (const name of COUNTER_NAMES) this.counters[name] += delta[name] ?? 0;
  }

  addCalibration(pairs: CalibrationPair[]): void {
    for (const pair of pairs) {
      const bucket = this.buckets[Math.min(BUCKETS - 1, Math.floor(pair.confidence * BUCKETS))];
      if (!bucket) continue;
      bucket.count += 1;
      bucket.accepted += pair.accepted ? 1 : 0;
      bucket.confidenceSum += pair.confidence;
      this.pairs += 1;
      this.recent.push({ confidence: pair.confidence, accepted: pair.accepted });
      if (this.recent.length > RECENT_PAIRS) this.recent.shift();
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      latency: this.latency.snapshot(),
      cache: { hits: this.cacheHits, misses: this.cacheMisses, hitRate: ratio(this.cacheHits, this.cacheHits + this.cacheMisses) },
      counters: { ...this.counters, acceptanceRate: ratio(this.counters.ghostsAccepted, this.counters.ghostsShown) },
      calibration: { pairs: this.pairs, buckets: this.bucketSnapshot(), recent: [...this.recent] },
    };
  }

  private bucketSnapshot(): CalibrationBucket[] {
    return this.buckets.map((b, i) => ({
      min: i / BUCKETS,
      max: (i + 1) / BUCKETS,
      count: b.count,
      accepted: b.accepted,
      meanConfidence: ratio(b.confidenceSum, b.count),
      acceptanceRate: ratio(b.accepted, b.count),
    }));
  }
}

const byConfig = new WeakMap<object, Metrics>();

/** Routes are registered separately but share one Metrics per app; the config object is the app's identity. */
export function getMetrics(config: object): Metrics {
  let metrics = byConfig.get(config);
  if (!metrics) {
    metrics = new Metrics();
    byConfig.set(config, metrics);
  }
  return metrics;
}
