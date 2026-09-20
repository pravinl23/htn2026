// Turns controller events into counters and calibration pairs, and hands them to the background worker
// in batches. Numbers and the ghost's source only: no label, no signature, no value ever leaves here.
import type { Ghost } from "@ghost/shared";
import type { GhostEmitter } from "../lib/events";
import { COUNTER_NAMES, isMetricsReply, METRICS_LIMITS, zeroCounters } from "../lib/messages";
import type { GhostMessage, MetricsBatch, MetricsCounters, MetricsPair, MetricsReply } from "../lib/messages";

export const REPORT_INTERVAL_MS = 5000;
/** A worker that stays unreachable must not let the backlog grow without bound. */
const MAX_BACKLOG_PAIRS = METRICS_LIMITS.pairs * 5;

export type SendMetrics = (batch: MetricsBatch) => Promise<MetricsReply | null>;

export interface ReporterDeps {
  events: GhostEmitter;
  send: SendMetrics;
  /** True when a calibrated provider's answer stands behind this field's served assignment. */
  isCalibrated?: (signature: string) => boolean;
  /** Lifetime totals as stored when the page opened. */
  loadTotals?: () => Promise<MetricsCounters>;
  /** Lifetime totals, this page's unsent counts included. */
  onTotals?: (totals: MetricsCounters) => void;
  intervalMs?: number;
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
}

export class MetricsReporter {
  private counters = zeroCounters();
  private pairs: MetricsPair[] = [];
  private lifetime = zeroCounters();
  /** Sent but not yet acknowledged: still part of the lifetime total the HUD shows. */
  private inFlight = zeroCounters();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: ReporterDeps) {}

  start(): void {
    if (this.unsubscribe.length > 0) return;
    const { events } = this.deps;
    const win = this.deps.win ?? window;
    win.addEventListener("pagehide", this.onPageHide);
    this.unsubscribe = [
      events.on("ghosts:shown", ({ count }) => this.add({ ghostsShown: count })),
      events.on("ghost:accepted", ({ ghost }) => this.accepted(ghost)),
      events.on("ghost:dismissed", ({ ghost, reason }) => this.dismissed(ghost, reason)),
      () => win.removeEventListener("pagehide", this.onPageHide),
    ];
    void this.deps.loadTotals?.().then((totals) => this.setLifetime(totals), () => undefined);
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** What has not been sent yet. */
  pending(): MetricsBatch {
    return { counters: { ...this.counters }, pairs: [...this.pairs] };
  }

  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const batch: MetricsBatch = { counters: this.counters, pairs: this.pairs.slice(0, METRICS_LIMITS.pairs) };
    if (isEmpty(batch)) return;
    this.counters = zeroCounters();
    this.pairs = this.pairs.slice(METRICS_LIMITS.pairs);
    this.shift(this.inFlight, batch.counters, 1);
    const reply = await this.deps.send(batch).catch(() => null);
    this.shift(this.inFlight, batch.counters, -1);
    if (!reply?.ok) this.requeue(batch);
    else if (reply.totals) this.setLifetime(reply.totals);
    if (this.pairs.length > 0 || !reply?.ok) this.schedule();
  }

  private accepted(ghost: Ghost): void {
    if (ghost.locked) return;
    const typed = ghost.action === "fill";
    this.add({ ghostsAccepted: 1, keystrokesSaved: typed ? (ghost.value ?? "").length : 0, clicksSaved: typed ? 0 : 1 });
    this.judge(ghost, 1);
  }

  /** Escaped or typed over is the user saying no. A refused write (rule 9, a write that did not hold) says nothing. */
  private dismissed(ghost: Ghost, reason: "escape" | "typed" | "refused"): void {
    if (ghost.locked || reason === "refused") return;
    this.judge(ghost, 0);
    this.schedule();
  }

  private judge(ghost: Ghost, accepted: 0 | 1): void {
    const served = ghost.source === "server" || ghost.source === "cache";
    const cal = served && this.deps.isCalibrated?.(ghost.signature) === true;
    this.pairs.push({ c: Math.min(1, Math.max(0, ghost.confidence)), a: accepted, s: ghost.source, cal });
    if (this.pairs.length > MAX_BACKLOG_PAIRS) this.pairs.shift();
  }

  private add(delta: Partial<MetricsCounters>): void {
    this.shift(this.counters, delta, 1);
    this.publish();
    this.schedule();
  }

  private shift(target: MetricsCounters, delta: Partial<MetricsCounters>, sign: 1 | -1): void {
    for (const name of COUNTER_NAMES) target[name] += sign * (delta[name] ?? 0);
  }

  private requeue(batch: MetricsBatch): void {
    this.shift(this.counters, batch.counters, 1);
    this.pairs = [...batch.pairs, ...this.pairs].slice(-MAX_BACKLOG_PAIRS);
  }

  private setLifetime(totals: MetricsCounters): void {
    this.lifetime = { ...totals };
    this.publish();
  }

  private publish(): void {
    const totals = zeroCounters();
    for (const name of COUNTER_NAMES) totals[name] = this.lifetime[name] + this.inFlight[name] + this.counters[name];
    this.deps.onTotals?.(totals);
  }

  /** One timer from the first unsent event: an idle page never wakes up. */
  private schedule(): void {
    if (this.timer !== null || this.unsubscribe.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.intervalMs ?? REPORT_INTERVAL_MS);
  }

  private readonly onPageHide = (): void => void this.flush();
}

function isEmpty(batch: MetricsBatch): boolean {
  return batch.pairs.length === 0 && COUNTER_NAMES.every((name) => batch.counters[name] === 0);
}

/** Hover text of the HUD's "saved" item. */
export function savedTitle(totals: MetricsCounters): string {
  const n = (value: number): string => value.toLocaleString("en-US");
  return `Lifetime: ${n(totals.keystrokesSaved)} keystrokes and ${n(totals.clicksSaved)} clicks saved · ${n(totals.ghostsAccepted)} of ${n(totals.ghostsShown)} ghosts accepted`;
}

/** The worker is the one writer of `ghost.metrics`; a retired content script simply gets null. */
export const sendMetricsToWorker: SendMetrics = async (batch) => {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return null;
  const message: GhostMessage = { type: "ghost:metrics", batch };
  const reply: unknown = await chrome.runtime.sendMessage(message);
  return isMetricsReply(reply) ? reply : null;
};
