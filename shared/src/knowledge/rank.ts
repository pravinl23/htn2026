// The API every predictor calls (docs/knowledge.md section 5).
//
//   rankActions(context, graph)        -> what to propose here, ranked, with a user-facing reason
//   recordOutcome(graph, ...)          -> taken | ignored | replaced, which is how the layer learns
//   matchFactsForField(field, graph)   -> which facts could fill this field
//
// The browser ranker and the native agent both call these; neither keeps its own memory. Three levels of evidence
// are blended in code (docs/knowledge.md section 2): this surface's own habits, then the same screen KIND learned
// anywhere else, then the shape-only prior that makes a brand-new screen useful on its first visit.
//
// docs/always-propose.md is the rule that outranks every heuristic here: if there are candidates, there is a
// ranking. Low confidence changes how a proposal LOOKS, never whether it exists.
import { matchFieldToFacts } from "../facts/match";
import type { MatchOptions } from "../facts/match";
import type { FactGraph } from "../facts/types";
import type { CapturedField } from "../types";
import { PREVIOUS_NONE, previousActionOf } from "./context";
import type { ActionRef, ActionRole, Context, HourBucket } from "./context";
import { HabitStore, daysSince, shapePriorWeight, takenInHour, totalOf } from "./habits";
import type { HabitCounts, KnowledgeGraph, Outcome } from "./habits";
import { SHAPE_PRIOR_UNLISTED } from "./habits";

/** Which level of evidence put this candidate where it is. The reason string is built from it. */
export type RankTier =
  /** This person, on this surface. */
  | "surface"
  /** This person, on screens shaped like this one, learned somewhere else. */
  | "kind"
  /** What anyone would want on a screen of this shape. */
  | "shape"
  /** Nothing knows anything about this one, and it is still proposed rather than hidden. */
  | "guess";

export interface RankedAction {
  id: string;
  role: ActionRole;
  /** 0 to 1, comparable with the confidence bands in docs/always-propose.md. */
  score: number;
  tier: RankTier;
  /** User-facing, and built only from roles, kinds and counts: it can never leak what a screen says. */
  reason: string;
  locked: boolean;
}

export interface RankOptions {
  /** Today, for the recency weighting. Passed in so ranking stays pure and testable. */
  now?: Date | number | string;
  /** Return at most this many. The default is everything, because hiding a candidate is not this layer's job. */
  limit?: number;
}

/** Laplace smoothing: one accept is evidence, never proof. This is what stops an accidental Tab from dominating. */
const SMOOTHING = 1;
/** Volume at which this surface's own history is half-trusted. */
const SURFACE_K = 2;
/** The same, for evidence borrowed from other surfaces: it takes more of it to move this screen. */
const KIND_K = 3;
/** How far fully-learned evidence may move a prior, up or down. */
const SPAN = 1.2;
/** Borrowed evidence is real but second-hand. */
const KIND_DISCOUNT = 0.75;
/** A replacement counts double against the thing that was replaced: the strongest signal in the layer. */
const REPLACED_WEIGHT = 2;
/** A backed-off count (same surface and kind, but a different previous action) is worth less than an exact one. */
const BACKOFF = 0.7;
/** Habits stay fresh for a month, then fade towards this floor rather than expiring outright. */
const RECENCY_FRESH_DAYS = 30;
const RECENCY_STALE_DAYS = 180;
const RECENCY_FLOOR = 0.5;
/** "You do this here at this time of day." Small on purpose: an hour bucket is a nudge, not a rule. */
const HOUR_BONUS = 0.03;
/**
 * How far "of everything they do here, this is most of it" may move a score. A rate alone cannot answer that: an
 * action Shabang proposed once and got right reads as a better habit than one the person takes three times in five
 * but turns down twice, because only a PROPOSED action can ever be turned down. The share is the counterweight,
 * and it is deliberately smaller than what evidence can do.
 */
const SHARE_SPAN = 0.2;
/** And it counts for nothing until there is something to take a share OF: one or two accepts are not a habit. */
const SHARE_MIN = 2;
const SHARE_K = 3;
const SCORE_MIN = 0.05;
const SCORE_MAX = 0.97;

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function recency(counts: HabitCounts, now: Date | number | string): number {
  const age = daysSince(counts.lastSeen, now);
  if (!Number.isFinite(age) || age <= RECENCY_FRESH_DAYS) return 1;
  if (age >= RECENCY_STALE_DAYS) return RECENCY_FLOOR;
  const span = RECENCY_STALE_DAYS - RECENCY_FRESH_DAYS;
  return 1 - (1 - RECENCY_FLOOR) * ((age - RECENCY_FRESH_DAYS) / span);
}

interface Evidence {
  /** How far this evidence moves the prior, signed. */
  delta: number;
  /** How much evidence there is, for blending the levels. */
  volume: number;
  positive: boolean;
}

const NO_EVIDENCE: Evidence = { delta: 0, volume: 0, positive: false };

/**
 * Counters to a signed nudge. A taken lifts, an ignored lowers, a replaced lowers twice as hard, and the whole
 * nudge is scaled by how much evidence there is, so one observation is a hint and twenty are a habit.
 */
function evidenceOf(counts: HabitCounts, k: number, now: Date | number | string, scale = 1): Evidence {
  const positives = counts.taken;
  const negatives = counts.ignored + REPLACED_WEIGHT * counts.replaced;
  const volume = positives + negatives;
  if (volume === 0) return NO_EVIDENCE;
  const rate = (positives + SMOOTHING) / (volume + 2 * SMOOTHING);
  const weight = volume / (volume + k);
  const delta = weight * (rate - 0.5) * SPAN * recency(counts, now) * scale;
  return { delta, volume: volume * scale, positive: delta > 0 };
}

/** The exact key first; a screen the user has not been on after THIS action still learns from the same screen. */
function levelEvidence(exact: HabitCounts, backoff: HabitCounts, k: number, now: Date | number | string): Evidence {
  const direct = evidenceOf(exact, k, now);
  if (direct.volume > 0) return direct;
  return evidenceOf(backoff, k, now, BACKOFF);
}

function tierOf(surface: Evidence, kind: Evidence, kindFactor: number, prior: number): RankTier {
  if (surface.volume > 0 && Math.abs(surface.delta) >= Math.abs(kind.delta * kindFactor)) return "surface";
  if (kind.volume > 0) return "kind";
  return prior > 0 ? "shape" : "guess";
}

function reasonFor(tier: RankTier, positive: boolean): string {
  switch (tier) {
    case "surface":
      return positive ? "you usually do this here" : "you have passed on this here before";
    case "kind":
      return positive ? "you usually do this on a screen like this" : "you usually skip this on a screen like this";
    case "shape":
      return "people usually do this on a screen like this";
    case "guess":
      return "a guess: nothing here is more likely";
  }
}

interface Scored {
  row: RankedAction;
  prior: number;
  order: number;
  index: number;
  roleConfidence: number;
}

function scoreCandidate(
  candidate: ActionRef,
  context: Context,
  habits: HabitStore,
  now: Date | number | string,
  order: number,
  familiarity: number,
  takenHere: number,
): Scored {
  const previousAction = previousActionOf(context);
  const prior = shapePriorWeight(context.screenKind, candidate.role, context.state ?? {});
  const base = prior > 0 ? prior : SHAPE_PRIOR_UNLISTED;

  const exactSurface = habits.stat({ surface: context.surface, screenKind: context.screenKind, previousAction, action: candidate.role });
  const anySurface = habits.surfaceStat(context.surface, context.screenKind, candidate.role);
  const surface = levelEvidence(exactSurface, anySurface, SURFACE_K, now);
  // "Of everything the person does on this screen, how much of it is this." Damped by how much there is to take a
  // share of, so one accidental accept is still a hint and not a habit.
  const observed = Math.max(0, takenHere - SHARE_MIN);
  const share = takenHere > 0 ? (anySurface.taken / takenHere) * (observed / (observed + SHARE_K)) : 0;

  const exactKind = habits.kindStat(context.screenKind, previousAction, candidate.role, context.surface);
  const anyKind = habits.kindAnyStat(context.screenKind, candidate.role, context.surface);
  const kind = levelEvidence(exactKind, anyKind, KIND_K, now);

  // Borrowed evidence fades as Shabang's history WITH THIS SCREEN grows, not as this one candidate's does. Damping
  // per candidate would leave the borrowed boost at full strength on everything the user has never taken here,
  // which is exactly how a habit learned elsewhere drowns out the one learned right here.
  const kindFactor = KIND_DISCOUNT * (1 - familiarity / (familiarity + SURFACE_K));
  const hourly = hourBonus(exactSurface, anySurface, context.hourBucket);
  const score = clamp(base + surface.delta + kind.delta * kindFactor + hourly + SHARE_SPAN * share, SCORE_MIN, SCORE_MAX);

  const tier = tierOf(surface, kind, kindFactor, prior);
  const positive = tier === "surface" ? surface.delta >= 0 : kind.delta >= 0;
  return {
    row: {
      id: candidate.id,
      role: candidate.role,
      score: round(score),
      tier,
      reason: reasonFor(tier, positive),
      locked: candidate.locked,
    },
    prior,
    order,
    index: candidate.index ?? Number.MAX_SAFE_INTEGER,
    roleConfidence: candidate.roleConfidence,
  };
}

function hourBonus(exact: HabitCounts, backoff: HabitCounts, bucket: HourBucket | undefined): number {
  if (takenInHour(exact, bucket) || takenInHour(backoff, bucket)) return HOUR_BONUS;
  return 0;
}

/**
 * Rank what is on screen. Works on any surface, in any client, with any graph, including an empty one: the shape
 * prior alone produces an order. Returns nothing only when there is nothing on screen to act on.
 */
export function rankActions(context: Context, graph: KnowledgeGraph, options: RankOptions = {}): RankedAction[] {
  const candidates = context.candidates ?? [];
  if (candidates.length === 0) return [];
  const habits = graph.habits instanceof HabitStore ? graph.habits : new HabitStore();
  const now = options.now ?? new Date();
  const familiarity = habits.surfaceVolume(context.surface, context.screenKind);
  const takenHere = habits.surfaceTaken(context.surface, context.screenKind);
  const scored = candidates.map((candidate, order) => scoreCandidate(candidate, context, habits, now, order, familiarity, takenHere));

  // Ties, in order: the shape's own opinion, then the reversible control before the locked one (one Tab beats a
  // deliberate click), then the first item of a repeated list, then the surer role guess, then capture order.
  scored.sort(
    (a, b) =>
      b.row.score - a.row.score ||
      b.prior - a.prior ||
      Number(a.row.locked) - Number(b.row.locked) ||
      a.index - b.index ||
      b.roleConfidence - a.roleConfidence ||
      a.order - b.order,
  );
  const limit = options.limit ?? scored.length;
  return scored.slice(0, Math.max(0, limit)).map((s) => s.row);
}

/** The best proposal, or null only when the screen offers nothing at all. */
export function bestAction(context: Context, graph: KnowledgeGraph, options: RankOptions = {}): RankedAction | null {
  return rankActions(context, graph, { ...options, limit: 1 })[0] ?? null;
}

/** docs/always-propose.md's table: confidence decides how a proposal LOOKS, never whether it is shown. */
export type ProposalLook = "ghost" | "guess" | "dim-guess";

export function proposalLook(score: number): ProposalLook {
  if (score >= 0.85) return "ghost";
  return score >= 0.7 ? "guess" : "dim-guess";
}

// ---------- learning ----------

export interface OutcomeOptions {
  at?: Date | number | string;
  /** Several at once, for a cold-start scan handing over aggregates instead of one row per action. */
  count?: number;
}

/** An id from the candidate list, a ref, or a bare role for an action the client saw but never proposed. */
export type ActionLike = string | ActionRef | { role: ActionRole };

function roleOf(action: ActionLike, context: Context): ActionRole | null {
  if (typeof action === "string") {
    const match = context.candidates.find((candidate) => candidate.id === action);
    if (match) return match.role;
    return action === "" ? null : (action as ActionRole);
  }
  return action.role ?? null;
}

/**
 * Every proposal outcome and every observed action lands here (docs/knowledge.md section 4). `replaced` is the
 * strongest signal the layer has: use `recordReplacement` so the action the user chose INSTEAD is learned in the
 * same breath as the one they turned down.
 */
export function recordOutcome(graph: KnowledgeGraph, context: Context, action: ActionLike, outcome: Outcome, options: OutcomeOptions = {}): void {
  const role = roleOf(action, context);
  if (!role) return;
  const record: { at?: Date | number | string; count?: number; hourBucket?: HourBucket } = { hourBucket: context.hourBucket };
  if (options.at !== undefined) record.at = options.at;
  if (options.count !== undefined) record.count = options.count;
  graph.habits.record(
    { surface: context.surface, screenKind: context.screenKind, previousAction: previousActionOf(context), action: role },
    outcome,
    record,
  );
}

/** The user did something else instead: the proposal is demoted and what they actually did is learned. */
export function recordReplacement(graph: KnowledgeGraph, context: Context, proposed: ActionLike, actual: ActionLike, options: OutcomeOptions = {}): void {
  const proposedRole = roleOf(proposed, context);
  const actualRole = roleOf(actual, context);
  if (proposedRole && proposedRole !== actualRole) recordOutcome(graph, context, { role: proposedRole }, "replaced", options);
  if (actualRole) recordOutcome(graph, context, { role: actualRole }, "taken", options);
}

/** The user arrived somewhere. Counts and an hour bucket: this is the "surfaces" half of the layer. */
export function recordVisit(graph: KnowledgeGraph, context: Context, at: Date | number | string = new Date()): void {
  graph.habits.noteVisit(context.surface, context.screenKind, context.hourBucket, at);
}

// ---------- facts ----------

export interface FieldFactMatch {
  key: string;
  confidence: number;
  /** User-facing, and value-free: it names the evidence, never the value. */
  reason: string;
}

/**
 * Which facts could fill this field (docs/knowledge.md section 5). The matcher knows nothing about résumés or job
 * forms: it compares what the field calls itself with what each fact calls itself, so a shipping form, a support
 * ticket and a conference signup all go through this one path.
 */
export function matchFactsForField(field: CapturedField, graph: KnowledgeGraph | { facts: FactGraph }, options: MatchOptions = {}): FieldFactMatch[] {
  return matchFieldToFacts(field, graph.facts, options).map((match) => ({ key: match.key, confidence: match.confidence, reason: match.why }));
}

/** What the habit key for this moment is, for a caller that wants to look one up directly. */
export function habitKeyFor(context: Context, action: ActionRole): { surface: string; screenKind: string; previousAction: string; action: ActionRole } {
  return {
    surface: context.surface,
    screenKind: context.screenKind,
    previousAction: context.previousAction ?? PREVIOUS_NONE,
    action,
  };
}

/** How much this graph has learned, for the options page and for the tests. Counts only. */
export function knowledgeStats(graph: KnowledgeGraph): { facts: number; habits: number; surfaces: number; observations: number } {
  let observations = 0;
  for (const entry of graph.habits.list()) observations += totalOf(entry.counts);
  return {
    facts: Object.keys(graph.facts.facts).length,
    habits: graph.habits.size,
    surfaces: graph.habits.surfaceCount,
    observations,
  };
}
