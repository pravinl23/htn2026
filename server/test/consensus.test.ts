import type { Questions } from "@ghost/shared";
import { describe, expect, it } from "vitest";
import { choiceConsensus, consensus, noulConsensus, scoreConsensus, smoothedFractions } from "../src/providers/consensus";

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const FORM_OPTIONS = ["firstName", "lastName", "email", "phone", "linkedin", "github", "website", "school", "degree", "graduationDate", "referralSource", "needs_text", "none"];

describe("smoothedFractions", () => {
  it("shares ONE pseudo-vote across the options and always sums to 1", () => {
    expect(smoothedFractions([3, 0])).toEqual([(3 + 0.5) / 4, 0.5 / 4]);
    for (const counts of [[3, 0, 0], [1, 1, 1], [0, 0, 0, 0], [5, 2, 1, 0, 0, 0, 0]]) {
      expect(sum(smoothedFractions(counts))).toBeCloseTo(1, 12);
    }
  });

  it("is uniform with no votes and never divides by zero, even with a zero prior", () => {
    expect(smoothedFractions([0, 0, 0, 0])).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(smoothedFractions([0, 0], 0)).toEqual([0.5, 0.5]);
    expect(smoothedFractions([], 1)).toEqual([]);
  });

  it("falls back to raw fractions when the prior mass is 0", () => {
    expect(smoothedFractions([2, 1, 1], 0)).toEqual([0.5, 0.25, 0.25]);
  });
});

describe("choiceConsensus", () => {
  it("3/3 agreement on a 13-option form question is high but never 1.0", () => {
    const answer = choiceConsensus(FORM_OPTIONS, ["email", "email", "email"], { expected: 3 });
    expect(answer).toMatchObject({ type: "choice", choice: "email", confidenceSource: "consensus", votes: 3, expected: 3 });
    expect(answer?.confidence).toBeCloseTo((3 + 1 / 13) / 4, 12); // 0.769
    expect(answer?.confidence).toBeGreaterThan(0.7);
    expect(answer?.confidence).toBeLessThan(1);
    expect(answer?.tie).toBeUndefined();
  });

  it("more unanimous samples mean more confidence, a dissenting vote means clearly less", () => {
    const conf = (votes: string[], expected: number): number => choiceConsensus(FORM_OPTIONS, votes, { expected })?.confidence ?? -1;
    expect(conf(Array(5).fill("email"), 5)).toBeGreaterThan(conf(Array(3).fill("email"), 3));
    expect(conf(["email", "email", "phone"], 3)).toBeCloseTo((2 + 1 / 13) / 4, 12); // 0.519: below the 0.7 gate
    expect(conf(["email", "email", "phone"], 3)).toBeLessThan(0.7);
  });

  it("probabilities cover every offered option and sum to 1", () => {
    const answer = choiceConsensus(FORM_OPTIONS, ["email", "email", "phone"], { expected: 3 });
    if (!answer) throw new Error("no answer");
    expect(Object.keys(answer.probabilities)).toEqual(FORM_OPTIONS);
    expect(sum(Object.values(answer.probabilities))).toBeCloseTo(1, 12);
    expect(answer.probabilities.email).toBeGreaterThan(answer.probabilities.phone ?? 1);
    expect(answer.probabilities.phone).toBeGreaterThan(answer.probabilities.none ?? 1);
    expect(answer.probabilities.none).toBeGreaterThan(0);
  });

  it("a tie answers none when none is offered", () => {
    const answer = choiceConsensus(["a", "b", "none"], ["a", "b"], { expected: 2 });
    expect(answer).toMatchObject({ choice: "none", tie: true, votes: 2 });
    expect(answer?.confidence).toBeLessThan(0.5);
  });

  it("a three-way tie is still none", () => {
    expect(choiceConsensus(["a", "b", "c", "none"], ["a", "b", "c"], { expected: 3 })).toMatchObject({ choice: "none", tie: true });
  });

  it("a tie without a none option names the first tied option at confidence 0, so it can never pass a gate", () => {
    const answer = choiceConsensus(["a", "b", "c"], ["c", "b"], { expected: 2 });
    expect(answer).toMatchObject({ choice: "b", confidence: 0, tie: true });
  });

  it("a tie that includes none itself resolves to none", () => {
    expect(choiceConsensus(["a", "none"], ["a", "none"], { expected: 2 })).toMatchObject({ choice: "none", tie: true });
  });

  it("discards codes that were never offered, and counts only the valid votes", () => {
    const answer = choiceConsensus(["a", "b", "none"], ["a", "first_name", "a", ""], { expected: 4 });
    expect(answer).toMatchObject({ choice: "a", votes: 2 });
    // (2 + 1/3) / 3 smoothed, then scaled by 2 valid votes out of 4 expected
    expect(answer?.confidence).toBeCloseTo(((2 + 1 / 3) / 3) * 0.5, 12);
  });

  it("returns no answer at all when every vote is invalid", () => {
    expect(choiceConsensus(["a", "b"], ["x", "y"], { expected: 2 })).toBeUndefined();
    expect(choiceConsensus(["a", "b"], [], { expected: 3 })).toBeUndefined();
    expect(choiceConsensus([], ["a"], { expected: 1 })).toBeUndefined();
  });

  it("partial samples (deadline) scale confidence by votes / K", () => {
    const full = choiceConsensus(FORM_OPTIONS, ["email", "email", "email"], { expected: 3 })?.confidence ?? 0;
    const two = choiceConsensus(FORM_OPTIONS, ["email", "email"], { expected: 3 });
    const one = choiceConsensus(FORM_OPTIONS, ["email"], { expected: 3 });
    expect(two?.confidence).toBeCloseTo(((2 + 1 / 13) / 3) * (2 / 3), 12);
    expect(one?.confidence).toBeCloseTo(((1 + 1 / 13) / 2) * (1 / 3), 12);
    expect(one?.confidence).toBeLessThan(two?.confidence ?? 0);
    expect(two?.confidence).toBeLessThan(full);
    expect(one).toMatchObject({ choice: "email", votes: 1, expected: 3 });
  });

  it("a single sample with K=1 is an answer without evidence: about one half, below the gate", () => {
    const answer = choiceConsensus(FORM_OPTIONS, ["email"], { expected: 1 });
    expect(answer?.confidence).toBeCloseTo((1 + 1 / 13) / 2, 12);
    expect(answer?.confidence).toBeLessThan(0.7);
  });

  it("extra samples beyond K never push coverage above 1", () => {
    const answer = choiceConsensus(["a", "b"], ["a", "a", "a", "a"], { expected: 3 });
    expect(answer?.confidence).toBeCloseTo((4 + 0.5) / 5, 12);
  });
});

describe("noulConsensus", () => {
  it("is the smoothed fraction of yes votes", () => {
    expect(noulConsensus([true, true, true], { expected: 3 })).toMatchObject({ type: "noul", noul: 3.5 / 4, votes: 3 });
    expect(noulConsensus([false, false, false], { expected: 3 })).toMatchObject({ noul: 0.5 / 4 });
    expect(noulConsensus([true, false], { expected: 2 })).toMatchObject({ noul: 0.5 });
  });

  it("is pulled toward 0.5 when fewer than K votes arrived", () => {
    const answer = noulConsensus([true], { expected: 3 });
    expect(answer).toMatchObject({ type: "noul", votes: 1 });
    if (!answer) throw new Error("no answer");
    expect(answer.noul).toBeCloseTo(0.5 + (0.75 - 0.5) / 3, 12);
  });

  it("has no answer without votes", () => {
    expect(noulConsensus([], { expected: 3 })).toBeUndefined();
  });
});

describe("scoreConsensus", () => {
  const LEVELS = ["low", "medium", "high"];

  it("reports the mean, a smoothed distribution, the legend and a confidence", () => {
    const answer = scoreConsensus(LEVELS, [2, 2, 1], { expected: 3 });
    if (!answer) throw new Error("no answer");
    expect(answer.score).toBeCloseTo(5 / 3, 12);
    expect(answer.legend).toEqual({ "0": "low", "1": "medium", "2": "high" });
    expect(Object.keys(answer.probabilities)).toEqual(["0", "1", "2"]);
    expect(sum(Object.values(answer.probabilities))).toBeCloseTo(1, 12);
    expect(answer.confidence).toBeCloseTo((2 + 1 / 3) / 4, 12);
    expect(answer).toMatchObject({ confidenceSource: "consensus", votes: 3 });
  });

  it("discards levels outside the scale and fractional votes", () => {
    const answer = scoreConsensus(LEVELS, [2, 7, -1, 1.5, 2], { expected: 5 });
    expect(answer).toMatchObject({ score: 2, votes: 2 });
    expect(scoreConsensus(LEVELS, [9], { expected: 1 })).toBeUndefined();
  });

  it("flags a tie between levels but still reports the mean", () => {
    expect(scoreConsensus(LEVELS, [0, 2], { expected: 2 })).toMatchObject({ score: 1, tie: true });
  });
});

describe("consensus over a whole decision", () => {
  const QUESTIONS: Questions = {
    route: { type: "choice", instructions: "Route it.", criteria: { billing: null, shipping: null, none: null } },
    refunded: { type: "noul", instructions: "Refunded?" },
    urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
  };

  it("votes per question, so one bad code in a sample does not throw the rest of that sample away", () => {
    const answers = consensus(
      QUESTIONS,
      [
        { route: "billing", refunded: true, urgency: 2 },
        { route: "BILLING!", refunded: true, urgency: 2 },
        { route: "billing", refunded: false, urgency: 1 },
      ],
      { expected: 3 },
    );
    expect(answers.route).toMatchObject({ type: "choice", choice: "billing", votes: 2 });
    expect(answers.refunded).toMatchObject({ type: "noul", votes: 3 });
    expect(answers.urgency).toMatchObject({ type: "score", votes: 3 });
  });

  it("ignores votes of the wrong type and questions nobody asked", () => {
    const answers = consensus(QUESTIONS, [{ route: 3, refunded: "yes", urgency: "2", extra: "x" }, { route: "shipping" }], { expected: 2 });
    expect(Object.keys(answers)).toEqual(["route"]);
    expect(answers.route).toMatchObject({ choice: "shipping", votes: 1 });
  });

  it("leaves a question out when it got no valid vote, so the caller keeps its own guess", () => {
    expect(consensus(QUESTIONS, [], { expected: 3 })).toEqual({});
    expect(consensus(QUESTIONS, [{ refunded: true }], { expected: 3 })).not.toHaveProperty("route");
  });

  it("is not fooled by inherited property names", () => {
    const question: Questions[string] = { type: "choice", instructions: "?", criteria: { a: null, none: null } };
    const questions: Questions = Object.fromEntries([["constructor", question]]);
    expect(consensus(questions, [{}], { expected: 1 })).toEqual({});
  });
});
