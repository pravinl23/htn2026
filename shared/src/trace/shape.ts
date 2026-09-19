import type { TraceEvent, TraceTarget } from "./types";

export const RAPID_CLICK_MS = 500;

/** label#kind for ordinary targets, LIST(sig) for list items (index removed), CELL(header) for grid cells (row removed). */
export function targetShape(target: TraceTarget | undefined): string {
  if (!target) return "";
  if (target.cell) return `CELL(${target.cell.colHeader})`;
  if (target.list) return `LIST(${target.list.listSignature})`;
  return `${target.label}#${target.kind}`;
}

/** type | pathPattern | targetShape. Values are never part of the key. */
export function shapeKey(e: TraceEvent): string {
  return `${e.type}|${e.pathPattern}|${targetShape(e.target)}`;
}

export function shapeKeys(events: readonly TraceEvent[]): string[] {
  return events.map(shapeKey);
}

/** Focus-only clicks on the page body: a click that hit nothing meaningful. */
export function isNoopEvent(e: TraceEvent): boolean {
  if (e.type !== "click") return false;
  const t = e.target;
  if (!t) return true;
  return t.label.trim() === "" && t.kind === "other" && !t.list && !t.cell;
}

function sameTarget(a: TraceEvent, b: TraceEvent): boolean {
  if (!a.target || !b.target) return false;
  return a.target.signature === b.target.signature && a.target.list?.index === b.target.list?.index;
}

function isRapidRepeat(prev: TraceEvent | undefined, e: TraceEvent): boolean {
  if (!prev || prev.type !== "click" || e.type !== "click") return false;
  return sameTarget(prev, e) && Math.abs(e.t - prev.t) <= RAPID_CLICK_MS;
}

/**
 * Drops no-op clicks, double clicks, and consecutive events with the same shape key.
 * Of a duplicate streak the LAST event wins, so a corrected input keeps its final value.
 */
export function filterNoise(events: readonly TraceEvent[]): TraceEvent[] {
  const kept: TraceEvent[] = [];
  for (const e of events) {
    if (isNoopEvent(e)) continue;
    const prev = kept[kept.length - 1];
    if (isRapidRepeat(prev, e)) continue;
    if (prev && shapeKey(prev) === shapeKey(e)) kept[kept.length - 1] = e;
    else kept.push(e);
  }
  return kept;
}
