/**
 * The Sentry sink for walk telemetry.
 *
 * A "walk" is one Tab-Tab-Tab pass over a form or a page: every ghost Ghost proposed, and what the user did with it.
 * That is the outcome data the product is judged on, and the counters the prize asks for (proposed / accepted /
 * corrected, by class and by source) are exactly its aggregate.
 *
 * The walk telemetry modules themselves (`shared/src/walkTelemetry.ts`, `server/src/telemetry/walkOutcomes.ts`,
 * `server/src/routes/walkTelemetry.ts`) belong to another workflow and are NOT written here. This file is only the
 * sink: it takes an already-value-free outcome and moves it into Sentry as metrics plus one log line. Wiring it up is
 * one line wherever outcomes are recorded:
 *
 *     import { recordWalkOutcome } from "../observability/walkSink";
 *     recordWalkOutcome(outcome);   // no-op when Sentry is off
 *
 * If that module's own outcome type differs, map to `WalkOutcome` at the call site rather than widening this one:
 * every field here is a count, a bucket or a closed-vocabulary name on purpose.
 */
import type { ConfidenceBucket } from "./names";
import { count, isEnabled, log, type Attrs } from "./sentry";

/** What the user did with one ghost. "skipped" is Tab past it, "corrected" is typing over it. */
export type GhostOutcome = "accepted" | "corrected" | "skipped" | "dismissed";

/** Where the proposal came from. A closed list: never a locator, a label or a value. */
export type GhostSource = "fact" | "learned" | "heuristic" | "model" | "prior" | "guess";

/** What kind of thing was proposed. A closed list, matching the ghost classes the overlay draws. */
export type GhostClass = "form-field" | "free-text" | "next-action" | "command" | "vision-label" | "loop-step";

export interface WalkOutcome {
  ghostClass: GhostClass;
  source: GhostSource;
  bucket: ConfidenceBucket;
  outcome: GhostOutcome;
  /** Which client drew it. Never a URL, never a page title. */
  surface?: "extension" | "desktop" | "terminal";
  /** Milliseconds from the ghost appearing to the key press, when the client measured it. */
  decisionMs?: number;
}

const METRIC: Record<GhostOutcome, string> = {
  accepted: "ghost.accepted",
  corrected: "ghost.corrected",
  skipped: "ghost.skipped",
  dismissed: "ghost.dismissed",
};

/** One outcome. A no-op when Sentry is off, so the caller never needs a condition of its own. */
export function recordWalkOutcome(outcome: WalkOutcome): void {
  if (!isEnabled()) return;
  const attributes: Attrs = {
    "ghost.class": outcome.ghostClass,
    "ghost.source": outcome.source,
    "ghost.confidence.bucket": outcome.bucket,
    "ghost.surface": outcome.surface,
  };
  count(METRIC[outcome.outcome], 1, attributes);
  // Every proposal is counted once as proposed as well, so acceptance rate is one division in the Sentry UI.
  count("ghost.proposed", 1, attributes);
  if (outcome.decisionMs !== undefined) count("ghost.decision_ms", outcome.decisionMs, attributes);
}

/** A finished walk: the line that says whether a Tab-Tab-Tab pass actually filled the form. */
export function recordWalk(outcomes: WalkOutcome[]): void {
  if (!isEnabled() || outcomes.length === 0) return;
  let accepted = 0;
  let corrected = 0;
  let dismissed = 0;
  let skipped = 0;
  for (const outcome of outcomes) {
    recordWalkOutcome(outcome);
    if (outcome.outcome === "accepted") accepted += 1;
    if (outcome.outcome === "corrected") corrected += 1;
    if (outcome.outcome === "dismissed") dismissed += 1;
    if (outcome.outcome === "skipped") skipped += 1;
  }
  // Rejections are the signal the product learns from, so they belong in the line itself. Counting only
  // accepted and corrected made a walk where the user turned every ghost down read "0 accepted, 0 corrected".
  const rejected = corrected + dismissed;
  log("info", `walk: ${accepted} accepted, ${rejected} rejected (${corrected} typed over, ${dismissed} dismissed) of ${outcomes.length} ghosts`, {
    "ghost.proposed": outcomes.length,
    "ghost.accepted": accepted,
    "ghost.rejected": rejected,
    "ghost.corrected": corrected,
    "ghost.dismissed": dismissed,
    "ghost.skipped": skipped,
    "ghost.surface": outcomes[0]?.surface,
  });
}
