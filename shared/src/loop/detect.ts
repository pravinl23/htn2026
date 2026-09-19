import { filterNoise, shapeKey } from "../trace/shape";
import type { TraceEvent } from "../trace/types";
import type { LoopCandidate } from "./types";

export const LOOP_WINDOW_MS = 10 * 60 * 1000;
export const MIN_LOOP_LENGTH = 3;

export interface DetectOptions {
  windowMs?: number;
  minLength?: number;
  /** Restrict to one tab group. Default: every tab in the trace. */
  tabIds?: readonly number[];
}

function eligible(events: readonly TraceEvent[], now: number, opts: DetectOptions): TraceEvent[] {
  const since = now - (opts.windowMs ?? LOOP_WINDOW_MS);
  const tabs = opts.tabIds ? new Set(opts.tabIds) : null;
  return events.filter((e) => !e.synthetic && e.t >= since && e.t <= now && (!tabs || tabs.has(e.tabId)));
}

/** keys[n-2L .. n-L) == keys[n-L .. n) */
function tailRepeats(keys: readonly string[], length: number): boolean {
  const n = keys.length;
  if (length < 1 || 2 * length > n) return false;
  for (let i = n - length; i < n; i++) if (keys[i] !== keys[i - length]) return false;
  return true;
}

/**
 * Four or more repetitions show up as one long repeat: shrink to the smallest unit that still tiles the run.
 * Searched from 1 so a doubled two-step unit (A B A B) is seen for what it is and not reported as a four-step loop.
 */
function primitivePeriod(keys: readonly string[], length: number): number {
  const tail = keys.slice(keys.length - 2 * length);
  for (let p = 1; p < length; p++) {
    if (length % p !== 0) continue;
    if (tail.every((k, i) => i < p || k === tail[i - p])) return p;
  }
  return length;
}

/** docs/loops.md 3.2: same list index, same values. The item key is not evidence: without an index change there is no iterator. */
function sameDetail(a: TraceEvent, b: TraceEvent): boolean {
  return (a.value ?? "") === (b.value ?? "") && a.target?.list?.index === b.target?.list?.index;
}

/** A redo repeats the same item with the same values. A loop changes the list item or at least one value. */
function isRedo(runA: readonly TraceEvent[], runB: readonly TraceEvent[]): boolean {
  return runA.every((a, i) => {
    const b = runB[i];
    return b !== undefined && sameDetail(a, b);
  });
}

/**
 * Longest tandem repeat (L >= 3) at the tail of the user's own recent events.
 * `now` is a parameter so the function stays pure.
 */
export function detectLoop(events: readonly TraceEvent[], now: number, opts: DetectOptions = {}): LoopCandidate | null {
  const minLength = Math.max(1, opts.minLength ?? MIN_LOOP_LENGTH);
  const clean = filterNoise(eligible(events, now, opts));
  const keys = clean.map(shapeKey);
  const n = keys.length;
  for (let length = Math.floor(n / 2); length >= minLength; length--) {
    if (!tailRepeats(keys, length)) continue;
    const unit = primitivePeriod(keys, length);
    if (unit < minLength) continue; // the real unit is too short: a run must never hold two iterations
    const runA = clean.slice(n - 2 * unit, n - unit);
    const runB = clean.slice(n - unit);
    if (!isRedo(runA, runB)) return { length: unit, runA, runB };
  }
  return null;
}
