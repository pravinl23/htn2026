/**
 * The model call, as its own span.
 *
 * This is the span the prize asks for: an AI call with the provider and the model on it, inside the request that
 * needed it. It wraps `DecisionProvider.decide`, which is the ONE place a form, a next action or a shell command is
 * decided, so the trace answers the question the whole product is about: of the milliseconds a ghost took to appear,
 * how many were the model and how many were Shabang's own code?
 *
 * The state and the questions are never touched. Only their SHAPE (how many questions) leaves.
 */
import type { DecisionProvider, DecisionResult, Questions } from "@shabang/shared";
import { confidenceBucket, decideSpanName, genAiSystem, type ConfidenceBucket } from "./names";
import { DECISION_TIMEOUT_MS } from "../providers/timeout";
import { count, distribution, isEnabled, log, span, type Attrs } from "./sentry";

/** A decision that takes longer than this was already at risk of being thrown away by the caller's deadline. */
const SLOW_FRACTION = 0.8;

function answerBuckets(result: DecisionResult): Record<ConfidenceBucket, number> {
  const buckets: Record<ConfidenceBucket, number> = { high: 0, guess: 0, weak: 0, none: 0 };
  for (const answer of Object.values(result.answers)) {
    // A noul answer has no separate confidence; its probability is the closest thing to one.
    const confidence = answer.type === "noul" ? answer.noul : answer.confidence;
    buckets[confidenceBucket(confidence)] += 1;
  }
  return buckets;
}

/**
 * Wraps a provider so every decision is a span, a distribution sample and (when it went wrong) a warning.
 * With Sentry off the provider is returned untouched, so there is not even a wrapper object in the hot path.
 */
export function instrumentDecisionProvider(provider: DecisionProvider, deadlineMs: number = DECISION_TIMEOUT_MS): DecisionProvider {
  if (!isEnabled()) return provider;
  const system = genAiSystem(provider.name);
  const name = decideSpanName(provider.name);

  return {
    name: provider.name,
    calibrated: provider.calibrated,
    decide(state, questions: Questions): Promise<DecisionResult> {
      const questionCount = Object.keys(questions).length;
      const base: Attrs = {
        "gen_ai.system": system,
        // MUST be a well-known value from the GenAI semantic conventions, or Sentry's Agents view never
        // recognises the span and the whole AI-monitoring product stays empty. "decide" is our word, not theirs.
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": name,
        "ghost.operation": "decide",
        "ghost.provider": provider.name,
        "ghost.questions": questionCount,
        "ghost.calibrated_provider": provider.calibrated,
      };
      return span({ name, op: "gen_ai.invoke_agent", attributes: base }, async (active) => {
        const started = performance.now();
        try {
          const result = await provider.decide(state, questions);
          const latencyMs = Math.round(performance.now() - started);
          const buckets = answerBuckets(result);
          active.setAttributes({
            "gen_ai.request.model": result.model,
            "gen_ai.usage.input_tokens": result.usage?.inputTokens,
            "gen_ai.usage.output_tokens": result.usage?.outputTokens,
            "ghost.answers": Object.keys(result.answers).length,
            "ghost.unanswered": Math.max(0, questionCount - Object.keys(result.answers).length),
            "ghost.calibrated": result.calibrated,
            "ghost.confidence.high": buckets.high,
            "ghost.confidence.guess": buckets.guess,
            "ghost.confidence.weak": buckets.weak,
            "ghost.latency_ms": latencyMs,
          });
          record(provider.name, result.model, latencyMs, true);
          if (latencyMs >= deadlineMs * SLOW_FRACTION) {
            log("warn", `${provider.name} answered in ${latencyMs}ms, close to the ${deadlineMs}ms deadline`, {
              ...base,
              "gen_ai.request.model": result.model,
              "ghost.latency_ms": latencyMs,
              "ghost.deadline_ms": deadlineMs,
            });
          }
          return result;
        } catch (err) {
          const latencyMs = Math.round(performance.now() - started);
          const reason = err instanceof Error ? err.name : "error";
          active.setAttributes({ "ghost.latency_ms": latencyMs, "ghost.failure": reason });
          active.setStatus(false, reason);
          record(provider.name, undefined, latencyMs, false);
          // The user still gets a ghost (the heuristic answers), so this is a warning about quality, not an error.
          log("warn", `${provider.name} failed after ${latencyMs}ms; the heuristic answers instead`, {
            ...base,
            "ghost.latency_ms": latencyMs,
            "ghost.failure": reason,
          });
          throw err;
        }
      });
    },
  };
}

function record(provider: string, model: string | undefined, latencyMs: number, ok: boolean): void {
  const attributes: Attrs = { "ghost.provider": provider, "gen_ai.request.model": model, "ghost.ok": ok };
  distribution("ghost.decision.latency", latencyMs, "millisecond", attributes);
  count("ghost.decision", 1, attributes);
}
