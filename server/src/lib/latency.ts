export interface LatencyStats {
  route: string;
  provider: string;
  count: number;
  /** Calls that failed or timed out. Their latency still counts: the user waited for it. */
  failures: number;
  p50: number;
  p95: number;
  last: number;
}

const WINDOW = 1000;

/** Nearest-rank percentile over an ascending list. Returns 0 for an empty list. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index] ?? 0;
}

interface Series {
  route: string;
  provider: string;
  count: number;
  failures: number;
  samples: number[];
}

/** Per route+provider latency log. Percentiles cover the most recent WINDOW samples; count covers everything. */
export class LatencyLog {
  private readonly series = new Map<string, Series>();

  record(route: string, provider: string, latencyMs: number, ok = true): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    const key = `${route}|${provider}`;
    const entry = this.series.get(key) ?? { route, provider, count: 0, failures: 0, samples: [] };
    entry.count += 1;
    if (!ok) entry.failures += 1;
    entry.samples.push(latencyMs);
    if (entry.samples.length > WINDOW) entry.samples.shift();
    this.series.set(key, entry);
  }

  snapshot(): LatencyStats[] {
    return [...this.series.values()].map((s) => {
      const sorted = [...s.samples].sort((a, b) => a - b);
      return {
        route: s.route,
        provider: s.provider,
        count: s.count,
        failures: s.failures,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        last: s.samples[s.samples.length - 1] ?? 0,
      };
    });
  }
}
