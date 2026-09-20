/**
 * The bridge from walk outcomes to Sentry.
 *
 * The extension must never hold a DSN, so nothing here talks to Sentry: it batches walk outcomes and POSTs
 * them to the Ghost server's telemetry route, and the server (which loads `.env`) is the one process that
 * turns them into spans and logs. This file owns the wire, not the telemetry itself: the walk outcome objects
 * are produced by `extension/src/content/walkTelemetry.ts`, which belongs to someone else. Call
 * `reportWalkOutcome(outcome)` from that module's existing sink and nothing else changes.
 *
 * Three promises this file keeps:
 *
 * 1. **Allowlist, not denylist.** `toWalkTelemetryEvent` rebuilds an event from scratch out of known keys
 *    with known shapes. A label, a field value, a learned answer, a URL or any unrecognised key is dropped,
 *    whatever the outcome object happens to carry now or grows later. Enum-shaped strings are mapped through
 *    fixed tables, so an unknown name becomes `"other"` rather than travelling as itself.
 * 2. **It never blocks the walk.** `record` is synchronous bookkeeping; sending happens on a timer, with a
 *    deadline, and a failure drops the batch instead of retrying. A telemetry outage must not cost a ghost.
 * 3. **Counts, durations, buckets and booleans.** Confidence travels as a bucket, never as the number that
 *    belongs to one specific field.
 */
import { CONFIDENT_TIER } from "@ghost/shared";
import { getSettings } from "../lib/storage";

/** Where the server listens for these (`server/src/routes/walkTelemetry.ts`). */
export const WALK_TELEMETRY_PATH = "/v1/telemetry/walk";

export const WALK_TELEMETRY_LIMITS = {
  /** Events per POST. */
  batch: 20,
  /** Events kept while the server is unreachable. Past this the oldest are dropped. */
  backlog: 60,
  /** How long a batch waits for company. */
  flushMs: 4000,
  /** A telemetry POST that takes longer than this is abandoned. */
  timeoutMs: 2000,
} as const;

// ---------- the wire shape ----------

export const WALK_OUTCOMES = [
  "shown", "accepted", "dismissed", "corrected", "skipped", "filled", "refused", "completed", "aborted", "timeout", "error", "other",
] as const;
export type WalkOutcome = (typeof WALK_OUTCOMES)[number];

export const WALK_SOURCES = [
  "offline", "server", "cache", "llm", "loop", "guess", "learned", "heuristic", "prior", "habit", "other",
] as const;
export type WalkSource = (typeof WALK_SOURCES)[number];

/** Provider names the server already reports on `/v1/health`, plus the two "no model" cases. */
export const WALK_PROVIDERS = [
  "typesafe", "jev-gateway", "baseten", "llm", "openai", "xai", "heuristic", "template", "none", "other",
] as const;
export type WalkProvider = (typeof WALK_PROVIDERS)[number];

/** `SkipReason` from `@ghost/shared`, plus "other". These are the "why was there no ghost" answers. */
export const WALK_REASONS = ["sensitive", "already-answered", "no-candidate", "paused", "other"] as const;
export type WalkReason = (typeof WALK_REASONS)[number];

export const WALK_SURFACES = ["web", "desktop", "terminal", "other"] as const;
export type WalkSurface = (typeof WALK_SURFACES)[number];

/** `GhostTier` bucketing, so a per-field confidence never travels as a number. */
export const CONFIDENCE_BUCKETS = ["confident", "guess", "long-shot"] as const;
export type ConfidenceBucket = (typeof CONFIDENCE_BUCKETS)[number];

/** Counts. Integers, clamped: a name and a number, never what was counted. */
export const WALK_COUNTS = ["ghosts", "accepted", "dismissed", "corrected", "locked", "steps", "fields"] as const;
export type WalkCount = (typeof WALK_COUNTS)[number];

/** Durations in milliseconds. */
export const WALK_DURATIONS = ["latencyMs", "walkMs", "firstGhostMs"] as const;
export type WalkDuration = (typeof WALK_DURATIONS)[number];

/** Booleans. */
export const WALK_FLAGS = ["calibrated", "fallback", "cached", "held", "synthetic"] as const;
export type WalkFlag = (typeof WALK_FLAGS)[number];

export type WalkTelemetryEvent = {
  outcome: WalkOutcome;
  source?: WalkSource;
  provider?: WalkProvider;
  reason?: WalkReason;
  surface?: WalkSurface;
  confidence?: ConfidenceBucket;
  /** Epoch milliseconds, for ordering on the server. */
  t?: number;
} & Partial<Record<WalkCount, number>> &
  Partial<Record<WalkDuration, number>> &
  Partial<Record<WalkFlag, boolean>>;

export interface WalkTelemetryBatch {
  events: WalkTelemetryEvent[];
}

// ---------- the scrubber ----------

const MAX_COUNT = 100_000;
const MAX_DURATION_MS = 600_000;

/**
 * The names each field is read from. The first key that carries a usable value wins. Aliases exist because
 * the outcome objects are someone else's type: a rename there must not silently stop the telemetry, and it
 * must never turn into "forward whatever key you find".
 */
const COUNT_KEYS: Record<WalkCount, readonly string[]> = {
  ghosts: ["ghosts", "ghostCount", "ghostsShown", "shown"],
  accepted: ["accepted", "acceptedCount", "ghostsAccepted"],
  dismissed: ["dismissed", "dismissedCount", "ghostsDismissed"],
  corrected: ["corrected", "correctedCount"],
  locked: ["locked", "lockedCount", "locks"],
  steps: ["steps", "stepCount", "iterations"],
  fields: ["fields", "fieldCount"],
};

const DURATION_KEYS: Record<WalkDuration, readonly string[]> = {
  latencyMs: ["latencyMs", "latency", "durationMs", "ms"],
  walkMs: ["walkMs", "totalMs", "elapsedMs"],
  firstGhostMs: ["firstGhostMs", "firstMs", "ttfgMs"],
};

const FLAG_KEYS: Record<WalkFlag, readonly string[]> = {
  calibrated: ["calibrated"],
  fallback: ["fallback", "fellBack", "fallbackFrom"],
  cached: ["cached", "cache"],
  held: ["held", "hold", "holdToAccept"],
  synthetic: ["synthetic"],
};

const OUTCOME_KEYS = ["outcome", "result", "status", "kind", "type"] as const;
const SOURCE_KEYS = ["source", "ghostSource"] as const;
const PROVIDER_KEYS = ["provider", "decisionProvider"] as const;
const REASON_KEYS = ["reason", "skip", "skipReason"] as const;
const SURFACE_KEYS = ["surface", "client"] as const;
const CONFIDENCE_KEYS = ["confidence", "score", "tier"] as const;

function read(raw: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** A member of the table, or "other". Never the caller's own string. */
function pick<T extends string>(value: unknown, table: readonly T[], fallback: T | undefined): T | undefined {
  if (typeof value !== "string") return fallback;
  const found = table.find((name) => name === value.trim().toLowerCase());
  return found ?? fallback;
}

function count(value: unknown): number | undefined {
  const n = typeof value === "boolean" ? (value ? 1 : 0) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.round(n), MAX_COUNT);
}

function duration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.round(value), MAX_DURATION_MS);
}

/** Tiering matches `ghostTier` in `@ghost/shared`, with the default threshold. */
export function confidenceBucket(value: unknown, threshold = 0.7): ConfidenceBucket | undefined {
  if (typeof value === "string") return pick(value, CONFIDENCE_BUCKETS, undefined);
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < threshold) return "long-shot";
  return value < CONFIDENT_TIER ? "guess" : "confident";
}

/**
 * Rebuilds one wire event from an outcome object of unknown shape. Returns null when there is nothing
 * recognisable in it, so a stray object never travels as an empty event.
 */
export function toWalkTelemetryEvent(raw: unknown, now = Date.now()): WalkTelemetryEvent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const outcome = pick(read(input, OUTCOME_KEYS), WALK_OUTCOMES, "other");
  if (!outcome) return null;

  const event: WalkTelemetryEvent = { outcome, t: now };
  const source = pick(read(input, SOURCE_KEYS), WALK_SOURCES, undefined);
  const provider = pick(read(input, PROVIDER_KEYS), WALK_PROVIDERS, undefined);
  const reason = pick(read(input, REASON_KEYS), WALK_REASONS, undefined);
  const surface = pick(read(input, SURFACE_KEYS), WALK_SURFACES, undefined);
  const confidence = confidenceBucket(read(input, CONFIDENCE_KEYS));
  if (source) event.source = source;
  if (provider) event.provider = provider;
  if (reason) event.reason = reason;
  if (surface) event.surface = surface;
  if (confidence) event.confidence = confidence;

  let recognised = read(input, OUTCOME_KEYS) !== undefined || source !== undefined || reason !== undefined;
  for (const name of WALK_COUNTS) {
    const value = count(read(input, COUNT_KEYS[name]));
    if (value !== undefined) {
      event[name] = value;
      recognised = true;
    }
  }
  for (const name of WALK_DURATIONS) {
    const value = duration(read(input, DURATION_KEYS[name]));
    if (value !== undefined) {
      event[name] = value;
      recognised = true;
    }
  }
  for (const name of WALK_FLAGS) {
    const value = read(input, FLAG_KEYS[name]);
    // "fallbackFrom: 'baseten'" is a provider name where a flag is expected: it is still a yes.
    if (typeof value === "boolean") {
      event[name] = value;
      recognised = true;
    } else if (typeof value === "string" && value !== "") {
      event[name] = true;
      recognised = true;
    }
  }
  return recognised ? event : null;
}

// ---------- the transport ----------

export type WalkTelemetrySender = (batch: WalkTelemetryBatch) => Promise<boolean>;

/** `settings.serverUrl` without a trailing slash, or null when it is not a plain http(s) URL. */
export function normalizeBase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export interface FetchSenderDeps {
  fetch?: typeof fetch;
  /** Default: the server URL from settings. Null switches the bridge off for this page. */
  base?: () => Promise<string | null>;
  timeoutMs?: number;
}

/** One POST, with a deadline. Any failure answers false, and the batch is dropped by the caller. */
export function createFetchSender(deps: FetchSenderDeps = {}): WalkTelemetrySender {
  const base = deps.base ?? (async () => normalizeBase((await getSettings()).serverUrl));
  return async (batch) => {
    const url = await base().catch(() => null);
    if (!url) return false;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? WALK_TELEMETRY_LIMITS.timeoutMs);
    try {
      const response = await (deps.fetch ?? fetch)(`${url}${WALK_TELEMETRY_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        signal: abort.signal,
        credentials: "omit",
        cache: "no-store",
        keepalive: true,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface WalkTelemetryClientDeps {
  send?: WalkTelemetrySender;
  now?: () => number;
  flushMs?: number;
  maxBatch?: number;
  maxBacklog?: number;
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
}

/**
 * Batches scrubbed events and posts them. Everything about it is best-effort: a full queue drops its oldest
 * events, a failed POST drops its batch, and no caller ever waits.
 */
export class WalkTelemetryClient {
  private queue: WalkTelemetryEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private stopped = false;
  private readonly send: WalkTelemetrySender;
  private readonly now: () => number;
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly maxBacklog: number;
  private readonly win: Pick<Window, "addEventListener" | "removeEventListener"> | null;

  constructor(deps: WalkTelemetryClientDeps = {}) {
    this.send = deps.send ?? createFetchSender();
    this.now = deps.now ?? Date.now;
    this.flushMs = deps.flushMs ?? WALK_TELEMETRY_LIMITS.flushMs;
    this.maxBatch = deps.maxBatch ?? WALK_TELEMETRY_LIMITS.batch;
    this.maxBacklog = deps.maxBacklog ?? WALK_TELEMETRY_LIMITS.backlog;
    this.win = deps.win ?? (typeof window === "undefined" ? null : window);
    this.win?.addEventListener("pagehide", this.onPageHide);
  }

  /** Synchronous and total: scrub, queue, arm the timer. Never throws, never awaits. */
  record(outcome: unknown): void {
    if (this.stopped) return;
    let event: WalkTelemetryEvent | null = null;
    try {
      event = toWalkTelemetryEvent(outcome, this.now());
    } catch {
      event = null;
    }
    if (!event) return;
    this.queue.push(event);
    if (this.queue.length > this.maxBacklog) this.queue.splice(0, this.queue.length - this.maxBacklog);
    this.schedule();
  }

  /** What is queued but not yet sent (tests and the HUD). */
  pending(): readonly WalkTelemetryEvent[] {
    return [...this.queue];
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.sending || this.queue.length === 0) return;
    const batch: WalkTelemetryBatch = { events: this.queue.slice(0, this.maxBatch) };
    this.queue = this.queue.slice(this.maxBatch);
    this.sending = true;
    try {
      await this.send(batch);
    } catch {
      // dropped on purpose: telemetry never retries into a walk
    } finally {
      this.sending = false;
    }
    if (this.queue.length > 0) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.win?.removeEventListener("pagehide", this.onPageHide);
  }

  private schedule(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
  }

  private readonly onPageHide = (): void => void this.flush();
}

let shared: WalkTelemetryClient | null = null;

/** The page's one bridge, created on first use so a page that never walks never allocates it. */
export function walkTelemetryBridge(): WalkTelemetryClient {
  shared ??= new WalkTelemetryClient();
  return shared;
}

/**
 * The one line the walk telemetry owner needs: hand it an outcome object and forget about it. Safe to call
 * from anywhere in the walk, including inside a hot loop.
 */
export function reportWalkOutcome(outcome: unknown): void {
  walkTelemetryBridge().record(outcome);
}

/** Test seam. */
export function resetWalkTelemetryBridge(): void {
  shared?.stop();
  shared = null;
}
