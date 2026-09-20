import { describe, expect, it } from "vitest";
import { evaluateGhostLearningReplay, sanitizeGhostLearningReplayFixture } from "../src/learningReplay";

const fixture = {
  schemaVersion: "ghost.learning-replay.v1",
  caseId: "cross-site-auth",
  profile: { facts: { country: "Canada", "workAuthorization.CA": "no" }, pastAnswers: [] },
  correction: {
    surface: "greenhouse",
    field: { label: "Are you legally authorized to work in Canada?", kind: "select", options: [{ value: "0", label: "No" }, { value: "1", label: "Yes" }] },
    value: "1",
    optionLabel: "Yes",
  },
  targets: [{
    surface: "airbnb",
    field: { label: "Are you authorized to work in Canada?", kind: "select", options: [{ value: "n", label: "No" }, { value: "y", label: "Yes" }] },
    expected: { source: "learned", value: "y", optionLabel: "Yes", needsReview: false },
  }],
};

describe("learning replay", () => {
  it("runs the real store and proposal policy across differently worded sites", () => {
    const clean = sanitizeGhostLearningReplayFixture(fixture);
    expect(clean).not.toBeNull();
    expect(evaluateGhostLearningReplay(clean!)).toMatchObject({ passed: true, failures: [] });
  });

  it("fails an expectation the policy did not produce and rejects widened fixtures", () => {
    const wrong = structuredClone(fixture);
    wrong.targets[0]!.expected.value = "n";
    expect(evaluateGhostLearningReplay(sanitizeGhostLearningReplayFixture(wrong)!).failures).toEqual(["target:0:value"]);
    expect(sanitizeGhostLearningReplayFixture({ ...fixture, caseId: "../../secret" })).toBeNull();
  });
});
