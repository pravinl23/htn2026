import {
  AGENT_OUTCOME_SCHEMA,
  agentConfidenceBucket,
  agentDurationBucket,
  agentLatencyBucket,
  createAgentReplayFixture,
  evaluateAgentReplay,
  sanitizeAgentReplayFixture,
  sanitizeAgentRunOutcome,
} from "../src/agentTelemetry";
import type { AgentRunOutcome } from "../src/agentTelemetry";
import { describe, expect, it } from "vitest";

const OUTCOME: AgentRunOutcome = {
  schemaVersion: AGENT_OUTCOME_SCHEMA,
  runId: "11111111-1111-4111-8111-111111111111",
  state: "blocked",
  reason: "low-confidence",
  duration: "250-999ms",
  steps: 1,
  decisions: [{
    step: 1,
    operation: "CLICK",
    provider: "typesafe",
    calibrated: true,
    fallback: false,
    confidence: "55-69",
    latency: "100-249ms",
    candidates: { total: 4, locked: 1, filled: 2, requiredOpen: 1, availableOperations: ["FILL", "CLICK"] },
  }],
  actions: [],
};

describe("agent run telemetry", () => {
  it("uses coarse, deterministic timing and confidence buckets", () => {
    expect([agentConfidenceBucket(0.54), agentConfidenceBucket(0.55), agentConfidenceBucket(0.7), agentConfidenceBucket(0.85), agentConfidenceBucket(0.95)])
      .toEqual(["under-55", "55-69", "70-84", "85-94", "95-plus"]);
    expect([agentLatencyBucket(99), agentLatencyBucket(100), agentLatencyBucket(250), agentLatencyBucket(500), agentLatencyBucket(1_000)])
      .toEqual(["under-100ms", "100-249ms", "250-499ms", "500-999ms", "1s-plus"]);
    expect([agentDurationBucket(249), agentDurationBucket(250), agentDurationBucket(1_000), agentDurationBucket(5_000), agentDurationBucket(15_000)])
      .toEqual(["under-250ms", "250-999ms", "1s-4.9s", "5s-14.9s", "15s-plus"]);
  });

  it("rebuilds from an allowlist and cannot retain sensitive extras", () => {
    const dirty = {
      ...OUTCOME,
      goal: "Apply to Secret Corp",
      url: "https://jobs.example/apply?token=hunter2",
      profile: { email: "sam@example.com" },
      decisions: [{ ...OUTCOME.decisions[0], targetId: "email", label: "Personal email", value: "sam@example.com" }],
      actions: [{ operation: "CLICK", ok: false, changed: false, error: "stale", targetLabel: "Submit Secret Corp" }],
    };
    const clean = sanitizeAgentRunOutcome(dirty);
    expect(clean).toEqual({ ...OUTCOME, actions: [{ operation: "CLICK", ok: false, changed: false, error: "stale" }] });
    const encoded = JSON.stringify(clean);
    expect(encoded).not.toMatch(/Secret|jobs\.example|hunter2|sam@example|targetId|label|value|goal|url|profile/);
  });

  it("rejects malformed, unbounded, or widened envelopes", () => {
    const bad = [
      { ...OUTCOME, runId: "user-supplied-secret" },
      { ...OUTCOME, steps: 41 },
      { ...OUTCOME, decisions: [{ ...OUTCOME.decisions[0], operation: "SHELL" }] },
      { ...OUTCOME, decisions: [{ ...OUTCOME.decisions[0], candidates: { ...OUTCOME.decisions[0]!.candidates, total: 1, locked: 2 } }] },
      { ...OUTCOME, actions: [{ operation: "CLICK", ok: true, changed: true, error: "raw browser exception" }] },
    ];
    for (const value of bad) expect(sanitizeAgentRunOutcome(value)).toBeNull();
  });

  it("turns reviewed outcomes into deterministic regression expectations", () => {
    const fixture = createAgentReplayFixture(OUTCOME);
    expect(sanitizeAgentReplayFixture({ ...fixture, private: "drop-me" })).toEqual(fixture);
    expect(sanitizeAgentReplayFixture({ ...fixture, expected: { ...fixture.expected, decisionOperations: ["SHELL"] } })).toBeNull();
    expect(evaluateAgentReplay(fixture)).toEqual({ passed: true, failures: [] });
    expect(evaluateAgentReplay(fixture, { ...OUTCOME, state: "done", reason: "completed", steps: 2 }))
      .toEqual({ passed: false, failures: ["state:done", "reason:completed", "steps:2>1"] });
  });
});
