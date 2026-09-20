/**
 * Maps the wire schema (`shared/src/walkTelemetry.ts`) onto the Sentry sink's vocabulary
 * (`server/src/observability/walkSink.ts`).
 *
 * The mapping lives here, at the call site, because walkSink.ts asks for exactly that: every field it
 * accepts is a count, a bucket or a closed-vocabulary name, and widening it to fit a second schema would
 * be how a label or a value eventually leaks into a metric tag.
 *
 * Nothing in this file can carry a label, a value, a URL, an origin or a page title: both vocabularies
 * are closed sets of string literals, so a leak would not compile.
 */
import { WALK_OUTCOMES, type GhostWalkOutcome, type WalkAction, type WalkOutcome as WireOutcome, type WalkSource, type WalkConfidenceBucket } from "@ghost/shared";
import type { ConfidenceBucket } from "../observability/names";
import { recordWalk } from "../observability/walkSink";
import type { GhostClass, GhostOutcome, GhostSource, WalkOutcome } from "../observability/walkSink";

/** What the user did. "escaped" and "refused" are both a no; only "typed-over" says they had a better answer. */
const OUTCOME: Record<WireOutcome, GhostOutcome> = {
  accepted: "accepted",
  "typed-over": "corrected",
  escaped: "dismissed",
  refused: "dismissed",
  unresolved: "skipped",
};

/** A proposal that writes into a field is a form ghost; a click is a next-action ghost. */
const CLASS: Record<WalkAction, GhostClass> = {
  fill: "form-field",
  select: "form-field",
  check: "form-field",
  click: "next-action",
};

const SOURCE: Record<WalkSource, GhostSource> = {
  offline: "heuristic",
  cache: "learned",
  server: "model",
  llm: "model",
  loop: "prior",
};

/** The wire buckets are finer than the product's, so they fold onto the gate: 0.85 high, 0.7 the gate itself. */
const BUCKET: Record<WalkConfidenceBucket, ConfidenceBucket> = {
  "95-plus": "high",
  "85-94": "high",
  "70-84": "guess",
  "55-69": "weak",
  "under-55": "weak",
};

export function isWireOutcome(value: string): value is WireOutcome {
  return (WALK_OUTCOMES as readonly string[]).includes(value);
}

export function toSinkOutcomes(walk: GhostWalkOutcome, surface: WalkOutcome["surface"]): WalkOutcome[] {
  return walk.proposals.map((proposal) => ({
    ghostClass: CLASS[proposal.action],
    source: SOURCE[proposal.source],
    bucket: BUCKET[proposal.confidence],
    outcome: OUTCOME[proposal.outcome],
    surface,
  }));
}

/**
 * The one line walkSink.ts asks for. Sends per-proposal metrics and one log line per walk, and is a
 * no-op when Sentry is off, so the caller never needs a condition of its own.
 */
export function reportWalkToSentry(walk: GhostWalkOutcome, surface: WalkOutcome["surface"] = "extension"): void {
  recordWalk(toSinkOutcomes(walk, surface));
}
