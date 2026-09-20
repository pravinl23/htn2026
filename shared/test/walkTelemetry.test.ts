import { describe, expect, it } from "vitest";
import {
  createGhostWalkReplayFixture,
  evaluateGhostWalkReplay,
  isReviewableWalk,
  sanitizeGhostWalkOutcome,
  sanitizeGhostWalkReplayFixture,
  walkConfidenceBucket,
  walkDurationBucket,
  walkLatencyBucket,
  walkOutcomeOf,
  walkProvider,
  walkSource,
} from "../src/walkTelemetry";
import type { GhostWalkOutcome } from "../src/walkTelemetry";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

const OUTCOME: GhostWalkOutcome = {
  schemaVersion: "ghost.walk-outcome.v1",
  runId: RUN_ID,
  state: "parked",
  reason: "locked-action",
  duration: "1s-4.9s",
  provider: "typesafe",
  latency: "250-499ms",
  proposals: [
    { index: 1, action: "fill", source: "server", calibrated: true, confidence: "95-plus", locked: false, outcome: "accepted" },
    { index: 2, action: "click", source: "offline", calibrated: false, confidence: "85-94", locked: true, outcome: "unresolved" },
  ],
  summary: { shown: 2, accepted: 1, dismissed: 0, locked: 1 },
};

describe("bucketing", () => {
  it("collapses raw numbers into coarse buckets and never leaks a precise value", () => {
    expect(walkConfidenceBucket(0.54)).toBe("under-55");
    expect(walkConfidenceBucket(0.7)).toBe("70-84");
    expect(walkConfidenceBucket(1)).toBe("95-plus");
    expect(walkConfidenceBucket(Number.NaN)).toBe("under-55");
    expect(walkConfidenceBucket(42)).toBe("95-plus");
    expect(walkLatencyBucket(null)).toBe("none");
    expect(walkLatencyBucket(99)).toBe("under-100ms");
    expect(walkLatencyBucket(5_000)).toBe("1s-plus");
    expect(walkDurationBucket(-5)).toBe("under-250ms");
    expect(walkDurationBucket(20_000)).toBe("15s-plus");
  });

  it("maps unknown providers, sources and dismissal reasons onto the closed vocabulary", () => {
    expect(walkProvider("typesafe")).toBe("typesafe");
    expect(walkProvider("some-new-vendor")).toBe("other");
    expect(walkProvider(undefined)).toBe("none");
    expect(walkSource("cache")).toBe("cache");
    expect(walkSource("wat")).toBe("offline");
    expect(walkOutcomeOf("escape")).toBe("escaped");
    expect(walkOutcomeOf("typed")).toBe("typed-over");
    expect(walkOutcomeOf("refused")).toBe("refused");
    expect(walkOutcomeOf("something-else")).toBe("unresolved");
  });
});

describe("sanitizeGhostWalkOutcome", () => {
  it("rebuilds a valid outcome from the allowlist and drops every unknown property", () => {
    const widened = {
      ...OUTCOME,
      goal: "apply to Northwind",
      url: "https://boards.greenhouse.io/x",
      origin: "https://boards.greenhouse.io",
      title: "Application",
      proposals: [{ ...OUTCOME.proposals[0], label: "Email", signature: "input#email", value: "alex@example.com" }, OUTCOME.proposals[1]],
    };
    const clean = sanitizeGhostWalkOutcome(widened);
    expect(clean).toEqual(OUTCOME);
    expect(JSON.stringify(clean)).not.toMatch(/greenhouse|alex@example|Email|signature|goal|title/i);
  });

  it("rejects anything outside the closed vocabulary or the declared bounds", () => {
    expect(sanitizeGhostWalkOutcome(null)).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, schemaVersion: "ghost.walk-outcome.v2" })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, runId: "not-a-uuid" })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, state: "exploded" })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, reason: "because" })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, provider: "" })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, proposals: [{ ...OUTCOME.proposals[0], action: "navigate" }] })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, proposals: [{ ...OUTCOME.proposals[0], source: "sideload" }] })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, proposals: [{ ...OUTCOME.proposals[0], confidence: 0.91 }] })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, proposals: [{ ...OUTCOME.proposals[0], index: 0 }] })).toBeNull();
  });

  it("requires proposal indexes to be strictly increasing", () => {
    const repeated = { ...OUTCOME, proposals: [OUTCOME.proposals[0], { ...OUTCOME.proposals[1], index: 1 }] };
    expect(sanitizeGhostWalkOutcome(repeated)).toBeNull();
  });

  it("refuses a summary that contradicts the proposals it claims to describe", () => {
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, summary: { shown: 1, accepted: 1, dismissed: 0, locked: 1 } })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, summary: { ...OUTCOME.summary, accepted: 0 } })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, summary: { ...OUTCOME.summary, locked: 0 } })).toBeNull();
    expect(sanitizeGhostWalkOutcome({ ...OUTCOME, summary: { shown: 2, accepted: 2, dismissed: 2, locked: 0 } })).toBeNull();
  });
});

describe("isReviewableWalk", () => {
  it("keeps a healthy walk out of the review queue", () => {
    expect(isReviewableWalk(OUTCOME)).toBe(false);
  });

  it("flags an accepted locked proposal, a rejected confident calibrated one, and an abandoned walk", () => {
    const tookLock: GhostWalkOutcome = {
      ...OUTCOME,
      proposals: [{ ...OUTCOME.proposals[1], outcome: "accepted" }],
      summary: { shown: 1, accepted: 1, dismissed: 0, locked: 1 },
    };
    expect(isReviewableWalk(tookLock)).toBe(true);

    const rejectedConfident: GhostWalkOutcome = {
      ...OUTCOME,
      proposals: [{ ...OUTCOME.proposals[0], outcome: "typed-over" }],
      summary: { shown: 1, accepted: 0, dismissed: 1, locked: 0 },
    };
    expect(isReviewableWalk(rejectedConfident)).toBe(true);

    expect(isReviewableWalk({ ...OUTCOME, state: "abandoned", reason: "page-left" })).toBe(true);
  });

  it("does not flag an uncalibrated rejection: its confidence was never a promise", () => {
    const uncalibrated: GhostWalkOutcome = {
      ...OUTCOME,
      proposals: [{ ...OUTCOME.proposals[0], calibrated: false, outcome: "escaped" }],
      summary: { shown: 1, accepted: 0, dismissed: 1, locked: 0 },
    };
    expect(isReviewableWalk(uncalibrated)).toBe(false);
  });
});

describe("replay fixtures", () => {
  it("round-trips through sanitization and passes against its own observation", () => {
    const fixture = createGhostWalkReplayFixture(OUTCOME);
    expect(sanitizeGhostWalkReplayFixture(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
    expect(evaluateGhostWalkReplay(fixture)).toEqual({ passed: true, failures: [] });
  });

  it("refuses a fixture whose caseId, schema or safety invariant was tampered with", () => {
    const fixture = createGhostWalkReplayFixture(OUTCOME);
    expect(sanitizeGhostWalkReplayFixture({ ...fixture, caseId: "22222222-2222-4222-8222-222222222222" })).toBeNull();
    expect(sanitizeGhostWalkReplayFixture({ ...fixture, schemaVersion: "ghost.walk-replay.v2" })).toBeNull();
    expect(sanitizeGhostWalkReplayFixture({ ...fixture, expected: { ...fixture.expected, lockedAccepted: 1 } })).toBeNull();
    expect(sanitizeGhostWalkReplayFixture({ ...fixture, expected: { ...fixture.expected, actions: ["navigate"] } })).toBeNull();
  });

  it("scores a changed walk against the reviewed expectation, ignoring provider and timing", () => {
    const fixture = createGhostWalkReplayFixture(OUTCOME);
    const faster: GhostWalkOutcome = { ...OUTCOME, provider: "heuristic", latency: "under-100ms", duration: "under-250ms" };
    expect(evaluateGhostWalkReplay(fixture, faster).passed).toBe(true);

    const regressed: GhostWalkOutcome = { ...OUTCOME, state: "abandoned", reason: "page-left" };
    expect(evaluateGhostWalkReplay(fixture, regressed).failures).toEqual(["state:abandoned", "reason:page-left"]);
  });

  it("always fails a walk that accepted a locked proposal, even if the case did not ask about it", () => {
    const healthy = createGhostWalkReplayFixture({
      ...OUTCOME,
      proposals: [{ ...OUTCOME.proposals[1], outcome: "escaped" }],
      summary: { shown: 1, accepted: 0, dismissed: 1, locked: 1 },
    });
    const violated: GhostWalkOutcome = {
      ...OUTCOME,
      proposals: [{ ...OUTCOME.proposals[1], outcome: "accepted" }],
      summary: { shown: 1, accepted: 1, dismissed: 0, locked: 1 },
    };
    expect(evaluateGhostWalkReplay(healthy, violated).failures).toContain("locked-accepted:1");
  });
});
