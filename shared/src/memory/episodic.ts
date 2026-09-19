import type { FieldKind } from "../types";
import { filterNoise, shapeKey, targetShape } from "../trace/shape";
import type { TraceEvent, TraceEventType } from "../trace/types";

export const EPISODIC_MAX_PAIRS = 300;
export const EPISODIC_TOP_K = 5;
export const MEMORY_CONFIDENCE_ONCE = 0.75;
export const MEMORY_CONFIDENCE_REPEATED = 0.9;
export const MEMORY_CONFIDENCE_SITE_RECENT = 0.65;
export const MEMORY_CONFIDENCE_SITE_REPEATED = 0.8;
/** Two different actions followed this state equally often: below the default threshold, so no ghost. */
export const MEMORY_CONFIDENCE_AMBIGUOUS = 0.5;
const SUMMARY_KEYS = 3;

/** What the user did next. Never holds a typed value. */
export interface EpisodicAction {
  type: TraceEventType;
  targetShape: string;
  label: string;
  signature?: string;
  kind?: FieldKind;
  locked?: boolean;
}

export interface EpisodicPair {
  /** pathPattern plus the last 3 shape keys, see stateSummary. */
  summary: string;
  action: EpisodicAction;
  /** How many times this action followed this summary. */
  count: number;
}

/** Same shape as the /v1/predict/next candidates. */
export interface NextCandidate {
  id: string;
  kind: "button" | "link" | "field";
  label: string;
  locked: boolean;
  context?: string;
  /** Value-free structural group (for example a repeated result list). */
  group?: string;
}

export interface MemoryPrediction {
  candidateId: string;
  confidence: number;
}

export interface EpisodicSnapshot {
  max: number;
  /** Least recently used first. */
  pairs: EpisodicPair[];
}

/** pathPattern + the last 3 event shape keys (noise removed, synthetic events included). */
export function stateSummary(events: readonly TraceEvent[], pathPattern: string): string {
  const keys = filterNoise(events).slice(-SUMMARY_KEYS).map(shapeKey);
  return [pathPattern, ...keys].join(" > ");
}

export function actionFromEvent(e: TraceEvent): EpisodicAction | null {
  const t = e.target;
  if (!t) return null;
  return { type: e.type, targetShape: targetShape(t), label: t.label, signature: t.signature, kind: t.kind, locked: t.locked };
}

export function actionKey(a: EpisodicAction): string {
  return `${a.type}|${a.signature ?? ""}|${a.targetShape}`;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

export function jaccard(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const tok of x) if (y.has(tok)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Callers never hold the store's own objects, so nothing outside can change a count or an action. */
function copyPair(p: EpisodicPair): EpisodicPair {
  return { ...p, action: { ...p.action } };
}

/** Pure, JSON-serializable (summary, action) memory. Array order is recency: adding or re-observing a pair moves it to the end. */
export class EpisodicStore {
  private pairs: EpisodicPair[];
  readonly max: number;

  /** A cap that is not a finite number (NaN, null from a corrupt snapshot) falls back to the default: the bound always holds. */
  constructor(max: number | null = EPISODIC_MAX_PAIRS, pairs: readonly EpisodicPair[] = []) {
    this.max = typeof max === "number" && Number.isFinite(max) ? Math.max(1, Math.floor(max)) : EPISODIC_MAX_PAIRS;
    this.pairs = pairs.slice(-this.max).map(copyPair);
  }

  get size(): number {
    return this.pairs.length;
  }

  add(summary: string, action: EpisodicAction): void {
    const key = actionKey(action);
    const at = this.pairs.findIndex((p) => p.summary === summary && actionKey(p.action) === key);
    const count = at >= 0 ? (this.pairs[at]?.count ?? 0) + 1 : 1;
    if (at >= 0) this.pairs.splice(at, 1);
    this.pairs.push({ summary, action: { ...action }, count });
    if (this.pairs.length > this.max) this.pairs.splice(0, this.pairs.length - this.max);
  }

  /** Exact summary matches first (most frequent, then most recent), then the most similar by Jaccard over tokens. */
  retrieve(summary: string, k: number = EPISODIC_TOP_K): EpisodicPair[] {
    const scored = this.pairs.map((pair, recency) => ({
      pair,
      recency,
      exact: pair.summary === summary,
      similarity: jaccard(pair.summary, summary),
    }));
    return scored
      .filter((s) => s.exact || s.similarity > 0)
      .sort((x, y) =>
        x.exact !== y.exact ? (x.exact ? -1 : 1)
        : x.exact ? y.pair.count - x.pair.count || y.recency - x.recency
        : y.similarity - x.similarity || y.recency - x.recency)
      .slice(0, Math.max(0, k))
      .map((s) => copyPair(s.pair));
  }

  /** Most recently observed pairs first, regardless of state. Callers must enforce site isolation. */
  recent(k: number = EPISODIC_TOP_K): EpisodicPair[] {
    return this.pairs.slice(-Math.max(0, k)).reverse().map(copyPair);
  }

  predict(summary: string, candidates: readonly NextCandidate[]): MemoryPrediction {
    return predictFromMemory(summary, candidates, this.retrieve(summary, this.max));
  }

  toJSON(): EpisodicSnapshot {
    return { max: this.max, pairs: this.pairs.map(copyPair) };
  }

  static fromJSON(snapshot: EpisodicSnapshot | null | undefined): EpisodicStore {
    if (!snapshot || !Array.isArray(snapshot.pairs)) return new EpisodicStore();
    return new EpisodicStore(snapshot.max, snapshot.pairs);
  }
}

function candidateKind(kind: FieldKind | undefined): NextCandidate["kind"] {
  if (kind === "button" || kind === "link") return kind;
  return "field";
}

function findCandidate(action: EpisodicAction, candidates: readonly NextCandidate[]): NextCandidate | null {
  const bySignature = candidates.find((c) => c.id === action.signature);
  if (bySignature) return bySignature;
  const label = action.label.trim().toLowerCase();
  if (label === "") return null;
  const byLabel = candidates.filter((c) => c.kind === candidateKind(action.kind) && c.label.trim().toLowerCase() === label);
  if (byLabel.length === 1) return byLabel[0] ?? null;
  // Feeds, search results and product grids change item labels on every visit. A stable, value-free list shape
  // lets recent site memory learn "the user acts in this result group" without learning one site's DOM.
  const byGroup = candidates.filter((c) => c.kind === candidateKind(action.kind) && c.group === action.targetShape);
  return byGroup[0] ?? null;
}

const POSITIVE_INTENT = [
  /\b(search|find|look up|browse|discover)\b/,
  /\b(continue|next|proceed|checkout|place (?:the |your )?order|confirm|pay|purchase|submit|send|post|upload|save|finish|done|apply|book|reserve)\b/,
  /\b(play|watch|open|start|view|read|full ?screen|expand)\b/,
];
const NEGATIVE_INTENT = /\b(back|cancel|close|dismiss|delete|remove|sign ?out|log ?out|unsubscribe|clear|reset)\b/;
const CHROME_INTENT = /\b(home|logo|account|profile|settings|help|menu|navigation)\b/;

export interface PreviousCandidateAction {
  type?: string;
  label?: string;
  signature?: string;
}

/** Site-agnostic cold-start salience based on accessible semantics, never hostnames or selectors. */
export function nextCandidatePriority(candidate: NextCandidate, previous?: PreviousCandidateAction): number {
  const text = `${candidate.label} ${candidate.context ?? ""}`.toLowerCase();
  let score = candidate.kind === "button" ? 24 : candidate.kind === "field" ? 18 : 0;
  if (POSITIVE_INTENT[0]?.test(text)) score += candidate.kind === "field" ? 80 : 45;
  if (POSITIVE_INTENT[1]?.test(text)) score += 70;
  if (POSITIVE_INTENT[2]?.test(text)) score += 45;
  if (candidate.group) score += 8;
  if (NEGATIVE_INTENT.test(text)) score -= 90;
  if (CHROME_INTENT.test(text)) score -= 30;
  const previousLabel = previous?.label?.toLowerCase() ?? "";
  if (previous?.signature === candidate.id || (previousLabel !== "" && previousLabel === candidate.label.toLowerCase())) score -= 120;
  // After committing a discovery field, advance into its result group instead of suggesting the same field again.
  if (/\b(search|find|look up|browse|discover)\b/.test(previousLabel)) {
    if (candidate.group) score += 60;
    if (candidate.kind === "link" || candidate.kind === "button") score += 20;
    if (candidate.kind === "field") score -= 35;
  }
  // Media controls are a generic state transition: play/watch commonly precedes a viewing-mode action.
  if (/\b(play|watch|start)\b/.test(previousLabel) && /\b(full ?screen|expand|theater|cinema)\b/.test(text)) score += 75;
  return score;
}

/** Highest semantic priority first, stable for ties. */
export function rankNextCandidates<T extends NextCandidate>(candidates: readonly T[], previous?: PreviousCandidateAction): T[] {
  return candidates
    .map((candidate, order) => ({ candidate, order, score: nextCandidatePriority(candidate, previous) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ candidate }) => candidate);
}

interface Tally {
  candidate: NextCandidate;
  count: number;
  /** Position in `memory`, which arrives best first (as retrieve returns it). */
  rank: number;
}

function tally(summary: string, candidates: readonly NextCandidate[], memory: readonly EpisodicPair[]): Tally[] {
  const byCandidate = new Map<string, Tally>();
  for (const [rank, pair] of memory.entries()) {
    if (pair.summary !== summary) continue;
    const candidate = findCandidate(pair.action, candidates);
    if (!candidate) continue;
    const seen = byCandidate.get(candidate.id);
    if (seen) seen.count += pair.count;
    else byCandidate.set(candidate.id, { candidate, count: pair.count, rank });
  }
  return [...byCandidate.values()].sort((x, y) => y.count - x.count || x.rank - y.rank);
}

/**
 * The heuristic next-action predictor: if this exact state summary was followed by an action before and that action's
 * target is among the candidates, propose it. 0.75 when seen once, 0.9 when seen twice or more.
 */
export function predictFromMemory(
  summary: string,
  candidates: readonly NextCandidate[],
  memory: readonly EpisodicPair[],
): MemoryPrediction {
  const [best, runnerUp] = tally(summary, candidates, memory);
  if (!best) return { candidateId: "none", confidence: 0 };
  if (runnerUp && runnerUp.count === best.count) return { candidateId: best.candidate.id, confidence: MEMORY_CONFIDENCE_AMBIGUOUS };
  const confidence = best.count >= 2 ? MEMORY_CONFIDENCE_REPEATED : MEMORY_CONFIDENCE_ONCE;
  return { candidateId: best.candidate.id, confidence };
}

/**
 * Site-level fallback for a state that has never occurred before. The newest compatible real user action wins;
 * repetition raises confidence, but never above an exact-state memory. `memory` must already belong to one origin.
 */
export function predictFromRecentSiteMemory(
  candidates: readonly NextCandidate[],
  memory: readonly EpisodicPair[],
): MemoryPrediction {
  let newest: NextCandidate | null = null;
  let observations = 0;
  for (const pair of memory) {
    const candidate = findCandidate(pair.action, candidates);
    if (!candidate) continue;
    if (!newest) newest = candidate;
    if (candidate.id === newest.id) observations += pair.count;
  }
  if (!newest) return { candidateId: "none", confidence: 0 };
  return {
    candidateId: newest.id,
    confidence: observations >= 2 ? MEMORY_CONFIDENCE_SITE_REPEATED : MEMORY_CONFIDENCE_SITE_RECENT,
  };
}
