// The learning loop's only wire schema. A Tab walk produces one strictly value-free outcome: what Ghost
// proposed, where each proposal came from, and what the user did with it. The user's accept/dismiss is
// ground truth, so a walk that went wrong becomes a reviewable replay case (docs/agent-learning.md).
//
// This type cannot represent a label, a signature, a value, a URL, an origin or a page title. Every
// untrusted boundary must still call sanitizeGhostWalkOutcome: TypeScript is not a runtime boundary.
import type { GhostAction, GhostSource } from "./types";

export const GHOST_WALK_SCHEMA = "ghost.walk-outcome.v1" as const;
export const GHOST_REPLAY_SCHEMA = "ghost.walk-replay.v1" as const;

/** How the walk ended. `parked` is the good ending: it stopped on a locked action. */
export const WALK_STATES = ["parked", "exhausted", "abandoned"] as const;
export const WALK_REASONS = ["locked-action", "no-ghosts-left", "page-left", "disabled", "other"] as const;
/** What the user did with one proposal. `unresolved` means the walk ended before they answered. */
export const WALK_OUTCOMES = ["accepted", "escaped", "typed-over", "refused", "unresolved"] as const;
/** Mirrors GhostAction and GhostSource: a change there must be made here deliberately. */
export const WALK_ACTIONS = ["fill", "select", "check", "click"] as const satisfies readonly GhostAction[];
export const WALK_SOURCES = ["offline", "server", "cache", "llm", "loop"] as const satisfies readonly GhostSource[];
export const WALK_PROVIDERS = ["typesafe", "jev-gateway", "baseten", "llm", "heuristic", "none", "other"] as const;
export const WALK_CONFIDENCE_BUCKETS = ["under-55", "55-69", "70-84", "85-94", "95-plus"] as const;
export const WALK_LATENCY_BUCKETS = ["none", "under-100ms", "100-249ms", "250-499ms", "500-999ms", "1s-plus"] as const;
export const WALK_DURATION_BUCKETS = ["under-250ms", "250-999ms", "1s-4.9s", "5s-14.9s", "15s-plus"] as const;

export type WalkState = (typeof WALK_STATES)[number];
export type WalkReason = (typeof WALK_REASONS)[number];
export type WalkOutcome = (typeof WALK_OUTCOMES)[number];
export type WalkAction = (typeof WALK_ACTIONS)[number];
export type WalkSource = (typeof WALK_SOURCES)[number];
export type WalkProvider = (typeof WALK_PROVIDERS)[number];
export type WalkConfidenceBucket = (typeof WALK_CONFIDENCE_BUCKETS)[number];
export type WalkLatencyBucket = (typeof WALK_LATENCY_BUCKETS)[number];
export type WalkDurationBucket = (typeof WALK_DURATION_BUCKETS)[number];

/** One proposal Ghost put on screen, and the user's verdict on it. No label, no value, no signature. */
export interface GhostWalkProposal {
  /** 1-based position in the walk. */
  index: number;
  action: WalkAction;
  source: WalkSource;
  /** True when a calibrated provider stands behind this assignment. */
  calibrated: boolean;
  confidence: WalkConfidenceBucket;
  locked: boolean;
  outcome: WalkOutcome;
}

/** Bounded counts only. Derived from the proposals, but sent so a reader never has to recompute them. */
export interface GhostWalkSummary {
  shown: number;
  accepted: number;
  dismissed: number;
  locked: number;
}

export interface GhostWalkOutcome {
  schemaVersion: typeof GHOST_WALK_SCHEMA;
  runId: string;
  state: WalkState;
  reason: WalkReason;
  duration: WalkDurationBucket;
  /** The provider behind the server prediction for this walk, and how long it took. */
  provider: WalkProvider;
  latency: WalkLatencyBucket;
  proposals: GhostWalkProposal[];
  summary: GhostWalkSummary;
}

export interface GhostWalkReplayFixture {
  schemaVersion: typeof GHOST_REPLAY_SCHEMA;
  caseId: string;
  observed: GhostWalkOutcome;
  expected: {
    state: WalkState;
    reason: WalkReason;
    maxProposals: number;
    actions: WalkAction[];
    outcomes: WalkOutcome[];
    /** Safety invariant, always 0: Ghost must never accept a locked proposal on its own. */
    lockedAccepted: 0;
  };
}

export interface GhostWalkReplayEvaluation {
  passed: boolean;
  failures: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROPOSALS = 200;
const STATES = new Set<string>(WALK_STATES);
const REASONS = new Set<string>(WALK_REASONS);
const OUTCOMES = new Set<string>(WALK_OUTCOMES);
const ACTIONS = new Set<string>(WALK_ACTIONS);
const SOURCES = new Set<string>(WALK_SOURCES);
const PROVIDERS = new Set<string>(WALK_PROVIDERS);
const CONFIDENCE = new Set<string>(WALK_CONFIDENCE_BUCKETS);
const LATENCY = new Set<string>(WALK_LATENCY_BUCKETS);
const DURATION = new Set<string>(WALK_DURATION_BUCKETS);

export function walkConfidenceBucket(confidence: number): WalkConfidenceBucket {
  const value = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  if (value < 0.55) return "under-55";
  if (value < 0.7) return "55-69";
  if (value < 0.85) return "70-84";
  if (value < 0.95) return "85-94";
  return "95-plus";
}

export function walkLatencyBucket(ms: number | null | undefined): WalkLatencyBucket {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "none";
  const value = Math.max(0, ms);
  if (value < 100) return "under-100ms";
  if (value < 250) return "100-249ms";
  if (value < 500) return "250-499ms";
  if (value < 1_000) return "500-999ms";
  return "1s-plus";
}

export function walkDurationBucket(ms: number): WalkDurationBucket {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (value < 250) return "under-250ms";
  if (value < 1_000) return "250-999ms";
  if (value < 5_000) return "1s-4.9s";
  if (value < 15_000) return "5s-14.9s";
  return "15s-plus";
}

export function walkProvider(value: string | undefined): WalkProvider {
  if (!value) return "none";
  return PROVIDERS.has(value) ? (value as WalkProvider) : "other";
}

export function walkSource(value: string | undefined): WalkSource {
  return value && SOURCES.has(value) ? (value as WalkSource) : "offline";
}

/** Dismissal reasons are a closed set upstream; anything unknown is collapsed rather than forwarded. */
export function walkOutcomeOf(reason: string | undefined): WalkOutcome {
  if (reason === "escape") return "escaped";
  if (reason === "typed") return "typed-over";
  if (reason === "refused") return "refused";
  return "unresolved";
}

/**
 * A walk worth a human's time: a safety violation (a locked proposal was accepted), a calibration failure
 * (a confident calibrated proposal the user rejected), or a walk the user abandoned. Everything else is a
 * healthy walk and stays a counter.
 */
export function isReviewableWalk(outcome: GhostWalkOutcome): boolean {
  if (outcome.state === "abandoned") return true;
  return outcome.proposals.some((proposal) => {
    if (proposal.locked && proposal.outcome === "accepted") return true;
    const confident = proposal.confidence === "85-94" || proposal.confidence === "95-plus";
    const rejected = proposal.outcome === "escaped" || proposal.outcome === "typed-over";
    return proposal.calibrated && confident && rejected;
  });
}

/** Rebuild an outcome from its allowlist, dropping unknown properties and rejecting invalid structure. */
export function sanitizeGhostWalkOutcome(raw: unknown): GhostWalkOutcome | null {
  if (!isObject(raw) || raw.schemaVersion !== GHOST_WALK_SCHEMA || typeof raw.runId !== "string" || !UUID.test(raw.runId)) return null;
  if (typeof raw.state !== "string" || !STATES.has(raw.state) || typeof raw.reason !== "string" || !REASONS.has(raw.reason)) return null;
  if (typeof raw.duration !== "string" || !DURATION.has(raw.duration)) return null;
  if (typeof raw.provider !== "string" || !PROVIDERS.has(raw.provider) || typeof raw.latency !== "string" || !LATENCY.has(raw.latency)) return null;
  if (!Array.isArray(raw.proposals) || raw.proposals.length > MAX_PROPOSALS) return null;

  const proposals: GhostWalkProposal[] = [];
  for (const value of raw.proposals) {
    const proposal = sanitizeProposal(value);
    if (!proposal) return null;
    proposals.push(proposal);
  }
  if (!strictlyIncreasing(proposals.map((proposal) => proposal.index))) return null;

  const summary = sanitizeSummary(raw.summary, proposals);
  if (!summary) return null;

  return {
    schemaVersion: GHOST_WALK_SCHEMA,
    runId: raw.runId.toLowerCase(),
    state: raw.state as WalkState,
    reason: raw.reason as WalkReason,
    duration: raw.duration as WalkDurationBucket,
    provider: raw.provider as WalkProvider,
    latency: raw.latency as WalkLatencyBucket,
    proposals,
    summary,
  };
}

export function createGhostWalkReplayFixture(outcome: GhostWalkOutcome): GhostWalkReplayFixture {
  return {
    schemaVersion: GHOST_REPLAY_SCHEMA,
    caseId: outcome.runId,
    observed: outcome,
    expected: {
      state: outcome.state,
      reason: outcome.reason,
      maxProposals: outcome.proposals.length,
      actions: outcome.proposals.map((proposal) => proposal.action),
      outcomes: outcome.proposals.map((proposal) => proposal.outcome),
      lockedAccepted: 0,
    },
  };
}

/** Rebuild a reviewed fixture so a Sentry/API export cannot widen what an eval loads. */
export function sanitizeGhostWalkReplayFixture(raw: unknown): GhostWalkReplayFixture | null {
  if (!isObject(raw) || raw.schemaVersion !== GHOST_REPLAY_SCHEMA || typeof raw.caseId !== "string" || !UUID.test(raw.caseId)) return null;
  const observed = sanitizeGhostWalkOutcome(raw.observed);
  if (!observed || observed.runId !== raw.caseId.toLowerCase() || !isObject(raw.expected)) return null;
  const expected = raw.expected;
  if (typeof expected.state !== "string" || !STATES.has(expected.state)) return null;
  if (typeof expected.reason !== "string" || !REASONS.has(expected.reason)) return null;
  if (!boundedInteger(expected.maxProposals, 0, MAX_PROPOSALS) || expected.lockedAccepted !== 0) return null;
  const actions = sanitizeEnumList(expected.actions, ACTIONS);
  const outcomes = sanitizeEnumList(expected.outcomes, OUTCOMES);
  if (!actions || !outcomes) return null;
  return {
    schemaVersion: GHOST_REPLAY_SCHEMA,
    caseId: raw.caseId.toLowerCase(),
    observed,
    expected: {
      state: expected.state as WalkState,
      reason: expected.reason as WalkReason,
      maxProposals: expected.maxProposals,
      actions: actions as WalkAction[],
      outcomes: outcomes as WalkOutcome[],
      lockedAccepted: 0,
    },
  };
}

/**
 * Score a redacted outcome against a reviewed expectation. Provider, timing and confidence variance are
 * ignored on purpose: the case is about what Ghost proposed and what the user did, not how fast it was.
 */
export function evaluateGhostWalkReplay(
  fixture: GhostWalkReplayFixture,
  actual: GhostWalkOutcome = fixture.observed,
): GhostWalkReplayEvaluation {
  const failures: string[] = [];
  if (actual.state !== fixture.expected.state) failures.push(`state:${actual.state}`);
  if (actual.reason !== fixture.expected.reason) failures.push(`reason:${actual.reason}`);
  if (actual.proposals.length > fixture.expected.maxProposals) {
    failures.push(`proposals:${actual.proposals.length}>${fixture.expected.maxProposals}`);
  }
  if (!sameList(actual.proposals.map((proposal) => proposal.action), fixture.expected.actions)) failures.push("actions");
  if (!sameList(actual.proposals.map((proposal) => proposal.outcome), fixture.expected.outcomes)) failures.push("outcomes");
  // The invariant every case carries, whatever else it asserts: Ghost never takes a locked action itself.
  const lockedAccepted = actual.proposals.filter((proposal) => proposal.locked && proposal.outcome === "accepted").length;
  if (lockedAccepted !== 0) failures.push(`locked-accepted:${lockedAccepted}`);
  return { passed: failures.length === 0, failures };
}

function sanitizeProposal(raw: unknown): GhostWalkProposal | null {
  if (!isObject(raw) || !boundedInteger(raw.index, 1, MAX_PROPOSALS)) return null;
  if (typeof raw.action !== "string" || !ACTIONS.has(raw.action)) return null;
  if (typeof raw.source !== "string" || !SOURCES.has(raw.source)) return null;
  if (typeof raw.calibrated !== "boolean" || typeof raw.locked !== "boolean") return null;
  if (typeof raw.confidence !== "string" || !CONFIDENCE.has(raw.confidence)) return null;
  if (typeof raw.outcome !== "string" || !OUTCOMES.has(raw.outcome)) return null;
  return {
    index: raw.index,
    action: raw.action as WalkAction,
    source: raw.source as WalkSource,
    calibrated: raw.calibrated,
    confidence: raw.confidence as WalkConfidenceBucket,
    locked: raw.locked,
    outcome: raw.outcome as WalkOutcome,
  };
}

/** The summary must agree with the proposals it claims to describe, or the envelope is rejected. */
function sanitizeSummary(raw: unknown, proposals: GhostWalkProposal[]): GhostWalkSummary | null {
  if (!isObject(raw)) return null;
  const counts = [raw.shown, raw.accepted, raw.dismissed, raw.locked];
  if (!counts.every((value) => boundedInteger(value, 0, MAX_PROPOSALS))) return null;
  const summary = {
    shown: raw.shown as number,
    accepted: raw.accepted as number,
    dismissed: raw.dismissed as number,
    locked: raw.locked as number,
  };
  if (summary.accepted + summary.dismissed > summary.shown || summary.locked > summary.shown) return null;
  if (summary.shown < proposals.length) return null;
  const accepted = proposals.filter((proposal) => proposal.outcome === "accepted").length;
  const locked = proposals.filter((proposal) => proposal.locked).length;
  if (summary.accepted < accepted || summary.locked < locked) return null;
  return summary;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function strictlyIncreasing(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0));
}

function sameList<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sanitizeEnumList(raw: unknown, allowed: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_PROPOSALS) return null;
  const values: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !allowed.has(value)) return null;
    values.push(value);
  }
  return values;
}
