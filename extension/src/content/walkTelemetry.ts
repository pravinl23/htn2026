// Turns controller events into one redacted outcome per Tab walk. The events carry live elements, profile
// values, labels and signatures; nothing here copies any of them. A signature is used only as a local map
// key and never reaches the envelope. Reporting is best-effort: it can never fail or delay a walk.
import {
  GHOST_WALK_SCHEMA,
  sanitizeGhostWalkOutcome,
  walkConfidenceBucket,
  walkDurationBucket,
  walkLatencyBucket,
  walkOutcomeOf,
  walkProvider,
  walkSource,
} from "@ghost/shared";
import type { Ghost, GhostWalkOutcome, GhostWalkProposal, WalkReason, WalkState } from "@ghost/shared";
import type { GhostEmitter } from "../lib/events";
import type { PredictForm } from "./predict";

/** The schema's own ceiling. A pathological page cannot grow the envelope past it. */
const MAX_PROPOSALS = 200;

export interface WalkOutcomeReporterDeps {
  events: GhostEmitter;
  send(outcome: GhostWalkOutcome): void | Promise<unknown>;
  /** Ghosts still on screen when the walk ends; they are reported as `unresolved`. */
  remaining?: () => Ghost[];
  /** True when a calibrated provider stands behind this field's served assignment. */
  isCalibrated?: (signature: string) => boolean;
  now?: () => number;
  createRunId?: () => string;
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
}

interface ActiveWalk {
  runId: string;
  startedAt: number;
  shown: number;
  proposals: GhostWalkProposal[];
  provider: string | undefined;
  latencyMs: number | null;
}

export class WalkOutcomeReporter {
  private active?: ActiveWalk;
  private unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: WalkOutcomeReporterDeps) {}

  start(): void {
    if (this.unsubscribe.length > 0) return;
    const { events } = this.deps;
    const win = this.deps.win ?? window;
    win.addEventListener("pagehide", this.onPageHide);
    this.unsubscribe = [
      events.on("ghosts:shown", ({ count }) => this.shown(count)),
      events.on("ghost:accepted", ({ ghost }) => this.resolve(ghost, "accepted")),
      events.on("ghost:dismissed", ({ ghost, reason }) => this.resolve(ghost, walkOutcomeOf(reason))),
      events.on("walk:finished", () => this.finishWalk()),
      () => win.removeEventListener("pagehide", this.onPageHide),
    ];
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.finish("abandoned", "disabled");
  }

  /** Called by the predict wrapper so the walk knows which provider answered, and how fast. */
  notePrediction(provider: string | undefined, latencyMs: number | null): void {
    try {
      const walk = this.begin();
      walk.provider = provider;
      walk.latencyMs = latencyMs;
    } catch {
      // never let observability touch the walk
    }
  }

  private shown(count: number): void {
    try {
      const walk = this.begin();
      walk.shown = Math.min(MAX_PROPOSALS, walk.shown + Math.max(0, count));
    } catch {
      // ignore
    }
  }

  private resolve(ghost: Ghost, outcome: GhostWalkProposal["outcome"]): void {
    try {
      const walk = this.begin();
      if (walk.proposals.length >= MAX_PROPOSALS) return;
      walk.proposals.push({
        index: walk.proposals.length + 1,
        action: ghost.action,
        source: walkSource(ghost.source),
        calibrated: this.deps.isCalibrated?.(ghost.signature) === true,
        confidence: walkConfidenceBucket(ghost.confidence),
        locked: ghost.locked === true,
        outcome,
        ...(ghost.answer ? { answer: { ...ghost.answer } } : {}),
      });
      if (walk.shown < walk.proposals.length) walk.shown = walk.proposals.length;
    } catch {
      // ignore
    }
  }

  /** `walk:finished` means the walk is parked on a locked action or has run out of ghosts. */
  private finishWalk(): void {
    const parked = (this.deps.remaining?.() ?? []).some((ghost) => ghost.locked);
    if (parked) this.finish("parked", "locked-action");
    else this.finish("exhausted", "no-ghosts-left");
  }

  private readonly onPageHide = (): void => {
    this.finish("abandoned", "page-left");
  };

  private begin(): ActiveWalk {
    return (this.active ??= {
      runId: (this.deps.createRunId ?? defaultRunId)(),
      startedAt: this.now(),
      shown: 0,
      proposals: [],
      provider: undefined,
      latencyMs: null,
    });
  }

  private finish(state: WalkState, reason: WalkReason): void {
    const walk = this.active;
    this.active = undefined;
    // A walk that never showed anything is not an outcome; reporting it would be pure noise.
    if (!walk || walk.shown === 0) return;
    try {
      const unresolved = (this.deps.remaining?.() ?? []).slice(0, MAX_PROPOSALS - walk.proposals.length);
      const proposals = [...walk.proposals];
      for (const ghost of unresolved) {
        proposals.push({
          index: proposals.length + 1,
          action: ghost.action,
          source: walkSource(ghost.source),
          calibrated: this.deps.isCalibrated?.(ghost.signature) === true,
          confidence: walkConfidenceBucket(ghost.confidence),
          locked: ghost.locked === true,
          outcome: "unresolved",
          ...(ghost.answer ? { answer: { ...ghost.answer } } : {}),
        });
      }
      const accepted = proposals.filter((proposal) => proposal.outcome === "accepted").length;
      const dismissed = proposals.filter(
        (proposal) => proposal.outcome === "escaped" || proposal.outcome === "typed-over" || proposal.outcome === "refused",
      ).length;
      const raw: GhostWalkOutcome = {
        schemaVersion: GHOST_WALK_SCHEMA,
        runId: walk.runId,
        state,
        reason,
        duration: walkDurationBucket(this.now() - walk.startedAt),
        provider: walkProvider(walk.provider),
        latency: walkLatencyBucket(walk.latencyMs),
        proposals,
        summary: {
          shown: Math.max(walk.shown, proposals.length),
          accepted,
          dismissed,
          locked: proposals.filter((proposal) => proposal.locked).length,
        },
      };
      const outcome = sanitizeGhostWalkOutcome(raw);
      if (!outcome) return;
      Promise.resolve(this.deps.send(outcome)).catch(() => undefined);
    } catch {
      // Observability must never change a walk, including in old browsers without crypto.randomUUID.
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

function defaultRunId(): string {
  return crypto.randomUUID();
}

/**
 * Same predictor, same answers; the walk reporter just sees the provider and latency go by. Mirrors
 * `observePredictions` in servedLedger.ts so neither the controller nor the predictor learns about telemetry.
 */
export function observeWalkProvider(predict: PredictForm, reporter: WalkOutcomeReporter): PredictForm {
  return async (request) => {
    const answer = await predict(request);
    if (answer) reporter.notePrediction(answer.provider, answer.latencyMs);
    return answer;
  };
}
