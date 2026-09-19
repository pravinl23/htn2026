import type { AgentDecisionRequest, AgentDecisionResponse, DecisionProvider } from "@ghost/shared";
import { buildAgentDecision, readAgentDecision } from "./agentQuestions";
import { DECISION_TIMEOUT_MS, withDeadline } from "./timeout";

export interface AgentPredictorOptions {
  provider: DecisionProvider;
  timeoutMs?: number;
  onModelCall?: (info: { provider: string; latencyMs: number; questions: number; calibrated: boolean; ok: boolean }) => void;
}

function blocked(provider: string, calibrated: boolean, latencyMs: number, fallbackFrom?: string): AgentDecisionResponse {
  return {
    operation: "BLOCKED",
    confidence: provider === "heuristic" ? 0.99 : 0,
    operationConfidence: provider === "heuristic" ? 0.99 : 0,
    provider,
    calibrated,
    latencyMs,
    ...(fallbackFrom ? { fallbackFrom } : {}),
  };
}

/**
 * A deliberately narrow no-key path for local development and deterministic e2e. It may apply only
 * locally prepared field values; it never clicks page actions or supplies a value of its own.
 */
function offlineDecision(request: AgentDecisionRequest, latencyMs: number): AgentDecisionResponse {
  const candidate = request.candidates.find((item) =>
    item.kind === "field" && !item.locked && !item.filled && item.operations.length > 0,
  );
  const operation = candidate?.operations[0];
  if (candidate && operation) {
    return {
      operation,
      targetId: candidate.id,
      confidence: 1,
      operationConfidence: 1,
      targetConfidence: 1,
      provider: "heuristic",
      calibrated: false,
      latencyMs,
    };
  }
  const unresolvedRequired = request.candidates.filter((item) => item.kind === "field" && item.required && !item.filled);
  const goalAllowsPartial = /safe local value|everything (?:you|it) can|leave .*?(?:untouched|alone|empty)|skip/i.test(request.goal);
  if (unresolvedRequired.length > 0 && !goalAllowsPartial) return blocked("heuristic", false, latencyMs);
  return {
    operation: "DONE",
    confidence: 1,
    operationConfidence: 1,
    provider: "heuristic",
    calibrated: false,
    latencyMs,
  };
}

/** One Jev call chooses both an operation and every speculative compatible target head. */
export function createAgentPredictor(options: AgentPredictorOptions): (req: AgentDecisionRequest) => Promise<AgentDecisionResponse> {
  const { provider, timeoutMs = DECISION_TIMEOUT_MS, onModelCall } = options;
  return async (request) => {
    const started = performance.now();
    if (provider.name === "heuristic") return offlineDecision(request, Math.round(performance.now() - started));
    const decision = buildAgentDecision(request);
    const callStarted = performance.now();
    try {
      const result = await withDeadline(timeoutMs, () => provider.decide(decision.state, decision.questions));
      const answer = readAgentDecision(result.answers, decision.targets);
      if (!answer) throw new Error("unusable answer");
      onModelCall?.({ provider: provider.name, latencyMs: Math.round(performance.now() - callStarted), questions: Object.keys(decision.questions).length, calibrated: provider.calibrated, ok: true });
      return { ...answer, provider: result.provider, calibrated: result.calibrated, latencyMs: Math.round(performance.now() - started) };
    } catch {
      onModelCall?.({ provider: provider.name, latencyMs: Math.round(performance.now() - callStarted), questions: Object.keys(decision.questions).length, calibrated: provider.calibrated, ok: false });
      return blocked("heuristic", false, Math.round(performance.now() - started), provider.name);
    }
  };
}
