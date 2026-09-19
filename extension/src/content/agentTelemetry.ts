import {
  AGENT_OUTCOME_SCHEMA,
  agentActionError,
  agentConfidenceBucket,
  agentDurationBucket,
  agentLatencyBucket,
  agentOutcomeProvider,
  agentOutcomeReason,
  sanitizeAgentRunOutcome,
} from "@ghost/shared";
import type { AgentOutcomeDecision, AgentRunOutcome } from "@ghost/shared";
import type { AgentRunUpdate } from "./agentRunner";

interface AgentOutcomeReporterDeps {
  send(outcome: AgentRunOutcome): void | Promise<unknown>;
  now?: () => number;
  createRunId?: () => string;
}

interface ActiveRun {
  runId: string;
  startedAt: number;
  decisions: Map<number, AgentOutcomeDecision>;
}

/**
 * Converts UI-facing runner updates into a deliberately lossy terminal envelope. The update contains a goal,
 * labels and target IDs; this class never copies any of them. Reporting is best-effort and cannot affect a run.
 */
export class AgentOutcomeReporter {
  private active?: ActiveRun;

  constructor(private readonly deps: AgentOutcomeReporterDeps) {}

  onUpdate(update: AgentRunUpdate): void {
    try {
      if (update.state === "running" && update.step === 0) this.active = this.start();
      const active = this.active ?? (this.active = this.start());
      if (update.state === "running") {
        if (update.decision && update.candidateSummary) {
          active.decisions.set(update.step, {
            step: update.step,
            operation: update.decision.operation,
            provider: agentOutcomeProvider(update.decision.provider),
            calibrated: update.decision.calibrated,
            fallback: update.decision.fallbackFrom !== undefined,
            confidence: agentConfidenceBucket(update.decision.confidence),
            latency: agentLatencyBucket(update.decision.latencyMs),
            candidates: update.candidateSummary,
          });
        }
        return;
      }

      const raw: AgentRunOutcome = {
        schemaVersion: AGENT_OUTCOME_SCHEMA,
        runId: active.runId,
        state: update.state,
        reason: agentOutcomeReason(update.reason, update.state),
        duration: agentDurationBucket(this.now() - active.startedAt),
        steps: Math.max(0, Math.min(40, update.step)),
        decisions: [...active.decisions.values()].sort((left, right) => left.step - right.step),
        actions: update.history.slice(0, 40).map((action) => ({
          operation: action.operation,
          ok: action.ok,
          changed: action.changed,
          ...(agentActionError(action.error) ? { error: agentActionError(action.error) } : {}),
        })),
      };
      this.active = undefined;
      const outcome = sanitizeAgentRunOutcome(raw);
      if (!outcome) return;
      Promise.resolve(this.deps.send(outcome)).catch(() => undefined);
    } catch {
      // Observability must never change agent behavior, including in old browsers without crypto.randomUUID.
    }
  }

  private start(): ActiveRun {
    return { runId: (this.deps.createRunId ?? defaultRunId)(), startedAt: this.now(), decisions: new Map() };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

function defaultRunId(): string {
  return crypto.randomUUID();
}
