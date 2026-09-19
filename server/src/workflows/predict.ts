import type { ActionCandidate, ContextSnapshot, DecisionProvider, WorkflowState, WorkflowSuggestion } from "@ghost/shared";

export interface WorkflowThresholds {
  high: number;
  medium: number;
}

export interface WorkflowPrediction {
  suggestion?: WorkflowSuggestion;
  selectedCandidate?: ActionCandidate;
  alternatives: Array<{ actionId: string; title: string; confidence: number }>;
}

function deterministicChoice(candidates: ActionCandidate[]): { id: string; confidence: number } {
  const actionable = candidates.find((candidate) => candidate.id !== "no_action");
  return actionable ? { id: actionable.id, confidence: 0.92 } : { id: "no_action", confidence: 1 };
}

export async function requestWorkflowPrediction(
  provider: DecisionProvider,
  context: ContextSnapshot,
  state: WorkflowState,
  candidates: ActionCandidate[],
  thresholds: WorkflowThresholds,
): Promise<WorkflowPrediction> {
  const deterministic = deterministicChoice(candidates);
  let selected = deterministic;
  let providerName = provider.name;
  let calibrated = provider.calibrated;
  let probabilities: Record<string, number> = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.id === deterministic.id ? deterministic.confidence : 0]));

  if (provider.name !== "heuristic" && candidates.length > 1) {
    const criteria = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        `${candidate.description} Required inputs are prepared by code. Appropriate when: ${candidate.suggestWhen} Exclude when: ${candidate.excludeWhen} Safety: ${candidate.safety}; confirmation: ${candidate.confirmation}.`,
      ]),
    );
    try {
      const result = await provider.decide(
        {
          app: context.activeApplication,
          windowTitle: context.windowTitle,
          focusedElement: context.focusedElement ? { role: context.focusedElement.role, label: context.focusedElement.label } : undefined,
          nearbyText: context.nearbyText,
          workflow: { kind: state.kind, step: state.step, priorResults: state.history.map((item) => ({ actionId: item.actionId, ok: item.ok, facts: item.facts })) },
          candidates: candidates.map((candidate) => ({ id: candidate.id, title: candidate.title, safety: candidate.safety })),
        },
        { next_workflow_action: { type: "choice", instructions: "Select the single most likely next atomic action from the supplied candidates. Never invent an action or any parameter. Prefer no_action when the evidence is weak.", criteria } },
      );
      const answer = result.answers.next_workflow_action;
      if (answer?.type === "choice" && candidates.some((candidate) => candidate.id === answer.choice)) {
        selected = { id: answer.choice, confidence: answer.confidence };
        probabilities = answer.probabilities;
        providerName = result.provider;
        calibrated = result.calibrated;
      }
    } catch {
      providerName = `${provider.name}-fallback`;
      calibrated = false;
    }
  }

  const alternatives = candidates
    .filter((candidate) => candidate.id !== "no_action" && candidate.id !== selected.id)
    .map((candidate) => ({ actionId: candidate.id, title: candidate.title, confidence: probabilities[candidate.id] ?? 0 }))
    .filter((item) => item.confidence >= thresholds.medium)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  if (selected.id === "no_action" || selected.confidence < thresholds.medium) return { alternatives, suggestion: undefined, selectedCandidate: undefined };
  const chosen = candidates.find((candidate) => candidate.id === selected.id);
  if (!chosen) return { alternatives };
  const suggestion: WorkflowSuggestion = {
    workflowId: state.id,
    action: { ...chosen, available: chosen.available },
    preview: chosen.preview,
    confidence: selected.confidence,
    provider: providerName,
    calibrated,
    alternatives: selected.confidence >= thresholds.high ? [] : alternatives,
    simulated: chosen.simulated === true,
  };
  delete (suggestion.action as Partial<ActionCandidate>).preparedArguments;
  delete (suggestion.action as Partial<ActionCandidate>).preview;
  delete (suggestion.action as Partial<ActionCandidate>).simulated;
  return { suggestion, selectedCandidate: chosen, alternatives };
}
