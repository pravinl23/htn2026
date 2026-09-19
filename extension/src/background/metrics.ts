// Lifetime counters and the calibration log. Content scripts report deltas; the worker is the one writer
// of `ghost.metrics` (so tabs cannot lose each other's counts) and forwards a copy to the server.
import { COUNTER_NAMES, sanitizeMetricsBatch } from "../lib/messages";
import type { GhostMessage, MetricsBatch, MetricsCounters, MetricsReply } from "../lib/messages";
import { addMetrics } from "../lib/storage";
import type { StoredMetrics } from "../lib/storage";
import { serverBaseUrl } from "./serverClient";
import type { FetchLike } from "./serverClient";

export const FORWARD_TIMEOUT_MS = 3000;

export type MetricsMessage = Extract<GhostMessage, { type: "ghost:metrics" }>;

export interface MetricsDeps {
  fetch?: FetchLike;
  getServerUrl?: () => Promise<string | null>;
  save?: (batch: MetricsBatch) => Promise<StoredMetrics>;
  timeoutMs?: number;
}

/** Body of `POST /v1/metrics/event`. */
export interface ServerMetricsEvent {
  counters: MetricsCounters;
  calibration: Array<{ confidence: number; accepted: boolean }>;
}

export function isMetricsMessage(msg: unknown): msg is MetricsMessage {
  return (msg as { type?: unknown } | null)?.type === "ghost:metrics";
}

/**
 * The server's reliability numbers are about Jev's confidence, so only calibrated pairs go there. Local
 * storage keeps every pair with its source. null when the server would refuse the body as empty.
 */
export function toServerEvent(batch: MetricsBatch): ServerMetricsEvent | null {
  const calibration = batch.pairs.filter((p) => p.cal).map((p) => ({ confidence: p.c, accepted: p.a === 1 }));
  const counted = COUNTER_NAMES.some((name) => batch.counters[name] > 0);
  return counted || calibration.length > 0 ? { counters: batch.counters, calibration } : null;
}

/** Best effort: the server's copy lives in memory anyway, so a failure is dropped, not retried. */
export async function forwardToServer(batch: MetricsBatch, deps: MetricsDeps = {}): Promise<boolean> {
  const event = toServerEvent(batch);
  const base = event ? await (deps.getServerUrl ?? serverBaseUrl)().catch(() => null) : null;
  if (!event || !base) return false;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? FORWARD_TIMEOUT_MS);
  try {
    const response = await (deps.fetch ?? fetch)(`${base}/v1/metrics/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: abort.signal,
      credentials: "omit",
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function totalsOf(stored: StoredMetrics): MetricsCounters {
  const { ghostsShown, ghostsAccepted, keystrokesSaved, clicksSaved } = stored;
  return { ghostsShown, ghostsAccepted, keystrokesSaved, clicksSaved };
}

/** Storage first (that is what the reply waits for); the forward runs on its own and is returned for tests. */
export async function recordMetrics(raw: unknown, deps: MetricsDeps = {}): Promise<{ reply: MetricsReply; forwarded: Promise<boolean> }> {
  const batch = sanitizeMetricsBatch(raw);
  if (!batch) return { reply: { ok: false }, forwarded: Promise.resolve(false) };
  const forwarded = forwardToServer(batch, deps);
  try {
    return { reply: { ok: true, totals: totalsOf(await (deps.save ?? addMetrics)(batch)) }, forwarded };
  } catch {
    return { reply: { ok: false }, forwarded };
  }
}

export async function handleMetricsMessage(message: MetricsMessage, deps: MetricsDeps = {}): Promise<MetricsReply> {
  return (await recordMetrics(message.batch, deps)).reply;
}
