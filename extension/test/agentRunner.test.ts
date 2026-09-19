import type { AgentCandidate, AgentDecisionResponse } from "@ghost/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/content/agentRunner";
import type { AgentObservation } from "../src/content/agentRunner";

function candidate(partial: Partial<AgentCandidate> = {}): AgentCandidate {
  return {
    id: "first",
    kind: "field",
    label: "First name",
    required: true,
    locked: false,
    filled: false,
    operations: ["FILL"],
    ...partial,
  };
}

function decision(partial: Partial<AgentDecisionResponse> = {}): AgentDecisionResponse {
  return {
    operation: "FILL",
    targetId: "first",
    confidence: 0.95,
    operationConfidence: 0.98,
    targetConfidence: 0.95,
    provider: "jev",
    calibrated: true,
    latencyMs: 12,
    ...partial,
  };
}

function observation(fingerprint: string, candidates = [candidate()], execute = vi.fn(async () => ({ ok: true }))): AgentObservation {
  return {
    page: { origin: "https://jobs.example", url: "https://jobs.example/apply", title: "Apply" },
    candidates,
    fingerprint,
    execute,
  };
}

describe("AgentRunner", () => {
  it("observes, chooses, freshness-checks, executes, verifies change, then stops on DONE", async () => {
    let filled = false;
    const execute = vi.fn(async () => {
      filled = true;
      return { ok: true };
    });
    const observe = vi.fn(() => observation(filled ? "filled" : "empty", [candidate({ filled, operations: filled ? [] : ["FILL"] })], execute));
    const decide = vi.fn()
      .mockResolvedValueOnce(decision())
      .mockResolvedValueOnce(decision({ operation: "DONE", targetId: undefined, targetConfidence: undefined }));
    const updates = vi.fn();
    const result = await new AgentRunner({ observe, decide, confidenceThreshold: () => 0.7, onUpdate: updates }).run("Fill the application");

    expect(result.state).toBe("done");
    expect(result.history).toEqual([{ operation: "FILL", targetId: "first", targetLabel: "First name", ok: true, changed: true }]);
    expect(execute).toHaveBeenCalledExactlyOnceWith("FILL", "first");
    expect(decide).toHaveBeenCalledTimes(2);
    expect(updates).toHaveBeenCalledWith(expect.objectContaining({
      state: "running",
      step: 1,
      candidateSummary: { total: 1, locked: 0, filled: 0, requiredOpen: 1, availableOperations: ["FILL"] },
    }));
    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ state: "done", step: 2 }));
  });

  it("discards a stale choice without executing it", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    let reads = 0;
    const observe = () => observation(++reads === 1 ? "old" : "new", [candidate()], execute);
    const decide = vi.fn()
      .mockResolvedValueOnce(decision())
      .mockResolvedValueOnce(decision({ operation: "DONE", targetId: undefined, targetConfidence: undefined }));
    const result = await new AgentRunner({ observe, decide, confidenceThreshold: () => 0.7 }).run("Fill it");

    expect(execute).not.toHaveBeenCalled();
    expect(result.state).toBe("done");
    expect(result.history[0]).toMatchObject({ operation: "FILL", ok: false, changed: true, error: "stale" });
  });

  it("fails closed on low confidence and on an invalid target", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const low = await new AgentRunner({
      observe: () => observation("a", [candidate()], execute),
      decide: async () => decision({ confidence: 0.69, calibrated: false }),
      confidenceThreshold: () => 0.7,
    }).run("Fill it");
    expect(low).toMatchObject({ state: "blocked", reason: "low-confidence" });

    const locked = await new AgentRunner({
      observe: () => observation("a", [candidate({ locked: true })], execute),
      decide: async () => decision(),
      confidenceThreshold: () => 0.7,
    }).run("Fill it");
    expect(locked).toMatchObject({ state: "blocked", reason: "target-invalid" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops after three WAIT decisions make no progress", async () => {
    const result = await new AgentRunner({
      observe: () => observation("same"),
      decide: async () => decision({ operation: "WAIT", targetId: undefined, targetConfidence: undefined }),
      confidenceThreshold: () => 0.7,
      wait: async () => undefined,
    }).run("Wait for it");
    expect(result).toMatchObject({ state: "blocked", step: 3, reason: "no-progress" });
    expect(result.history).toHaveLength(3);
  });
});
