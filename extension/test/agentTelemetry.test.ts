import { describe, expect, it, vi } from "vitest";
import { AgentOutcomeReporter } from "../src/content/agentTelemetry";
import type { AgentRunUpdate } from "../src/content/agentRunner";

const UUID = "22222222-2222-4222-8222-222222222222";

describe("AgentOutcomeReporter", () => {
  it("reports one allowlisted terminal envelope with no goal, page, target, label, value, or raw error", () => {
    const send = vi.fn();
    let now = 1_000;
    const reporter = new AgentOutcomeReporter({ send, now: () => now, createRunId: () => UUID });
    const base: Pick<AgentRunUpdate, "goal" | "history"> = { goal: "Apply to Secret Corp for sam@example.com", history: [] };
    reporter.onUpdate({ ...base, state: "running", step: 0 });
    reporter.onUpdate({
      ...base,
      state: "running",
      step: 1,
      decision: {
        operation: "CLICK",
        targetId: "submit-secret",
        confidence: 0.68,
        operationConfidence: 0.9,
        targetConfidence: 0.68,
        provider: "unexpected-private-provider",
        calibrated: true,
        latencyMs: 120,
        fallbackFrom: "jev-gateway-private",
      },
      candidateSummary: { total: 3, locked: 1, filled: 1, requiredOpen: 1, availableOperations: ["FILL", "CLICK"] },
    });
    now = 1_700;
    reporter.onUpdate({
      ...base,
      state: "blocked",
      step: 1,
      reason: "Protocol error: sam@example.com could not click Secret Corp",
      history: [{ operation: "CLICK", targetId: "submit-secret", targetLabel: "Submit Secret Corp", ok: false, changed: false, error: "Protocol error: sam@example.com" }],
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual({
      schemaVersion: "ghost.agent-run.v1",
      runId: UUID,
      state: "blocked",
      reason: "execute-failed",
      duration: "250-999ms",
      steps: 1,
      decisions: [{
        step: 1,
        operation: "CLICK",
        provider: "other",
        calibrated: true,
        fallback: true,
        confidence: "55-69",
        latency: "100-249ms",
        candidates: { total: 3, locked: 1, filled: 1, requiredOpen: 1, availableOperations: ["FILL", "CLICK"] },
      }],
      actions: [{ operation: "CLICK", ok: false, changed: false, error: "execute-failed" }],
    });
    expect(JSON.stringify(send.mock.calls[0]?.[0])).not.toMatch(/Secret|sam@example|submit-secret|Protocol|goal|target|label|value|url/i);
  });

  it("swallows reporting failures so observability cannot fail the run", () => {
    const reporter = new AgentOutcomeReporter({ send: () => { throw new Error("offline"); }, createRunId: () => UUID });
    expect(() => reporter.onUpdate({ state: "done", step: 0, goal: "private", history: [] })).not.toThrow();
  });
});
