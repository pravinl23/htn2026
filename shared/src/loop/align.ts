import { shapeKey } from "../trace/shape";
import type { FactsByUrl, TraceEvent } from "../trace/types";
import type { LoopCandidate, StepPage } from "./types";

export interface Pair {
  a: TraceEvent;
  b: TraceEvent;
}

export interface IteratorHit {
  pairIndex: number;
  listSignature: string;
  indexA: number;
  indexB: number;
}

export interface Context {
  /** Pairs rotated so the iterator click comes first. */
  rotated: Pair[];
  /** Positions at or after this one happened BEFORE the item click in their run, so they belong to the previous item. */
  wrappedStart: number;
  iterator: IteratorHit;
  listPage: StepPage;
  facts: FactsByUrl;
  patternByUrl: Map<string, string>;
}

export function alignRuns(c: LoopCandidate): Pair[] | null {
  if (c.runA.length === 0 || c.runA.length !== c.runB.length) return null;
  const pairs: Pair[] = [];
  for (const [i, a] of c.runA.entries()) {
    const b = c.runB[i];
    if (!b || shapeKey(a) !== shapeKey(b)) return null;
    pairs.push({ a, b });
  }
  return pairs;
}

export function listIndexes(p: Pair): { listSignature: string; indexA: number; indexB: number } | null {
  const la = p.a.target?.list;
  const lb = p.b.target?.list;
  if (!la || !lb || la.listSignature !== lb.listSignature || la.index === lb.index) return null;
  return { listSignature: la.listSignature, indexA: la.index, indexB: lb.index };
}

export function findIterator(pairs: Pair[]): IteratorHit | null {
  for (const [pairIndex, p] of pairs.entries()) {
    const hit = p.a.type === "click" ? listIndexes(p) : null;
    if (hit) return { pairIndex, ...hit };
  }
  return null;
}

export function makeContext(pairs: Pair[], iterator: IteratorHit, facts: FactsByUrl): Context | null {
  const rotated = [...pairs.slice(iterator.pairIndex), ...pairs.slice(0, iterator.pairIndex)];
  const click = rotated[0]?.a;
  if (!click) return null;
  const patternByUrl = new Map<string, string>();
  for (const p of pairs) for (const e of [p.a, p.b]) patternByUrl.set(e.url, e.pathPattern);
  const listPage = { origin: click.origin, pathPattern: click.pathPattern };
  return { rotated, wrappedStart: pairs.length - iterator.pairIndex, iterator, listPage, facts, patternByUrl };
}

export function isAction(p: Pair | undefined): boolean {
  return p !== undefined && p.a.type !== "navigate" && p.a.type !== "tabswitch" && listIndexes(p) === null;
}

/**
 * Detection can fire mid-cycle: run B's item is open but the wrapped steps (done before the item click in each run)
 * have not happened for it yet. "opened": nothing but opening was done, so the run restarts at that item.
 * "half-done": some of its actions already happened, so neither skipping nor restarting it is safe.
 */
export function lastItemState(ctx: Context): "done" | "opened" | "half-done" {
  const wrappedActions = ctx.rotated.slice(ctx.wrappedStart).some(isAction);
  if (!wrappedActions) return "done";
  return ctx.rotated.slice(0, ctx.wrappedStart).some(isAction) ? "half-done" : "opened";
}
