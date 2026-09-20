import type { Answer, ChoiceAnswer, NoulAnswer, Question, Questions, ScoreAnswer } from "@shabang/shared";

/**
 * Self-consistency as a confidence signal: ask the same decision K times at temperature > 0 and read the vote.
 * Pure math, no I/O. Vote fractions are NOT an audited calibration, so providers that use this stay calibrated=false.
 */

export type ConfidenceSource = "consensus" | "logprobs";

/** One parsed model response: question name -> vote. choice: an offered option name, noul: boolean, score: a level index. Anything else is discarded. */
export type Sample = Record<string, unknown>;

/** Server-internal only: never part of the wire format in shared/src/decision.ts. */
export interface ConsensusInfo {
  confidenceSource: ConfidenceSource;
  /** Valid votes counted for this question. */
  votes: number;
  /** Samples the provider asked for (K). */
  expected: number;
  /** True when the top options tied. */
  tie?: boolean;
}

export type ConsensusAnswer = Answer & ConsensusInfo;

export interface ConsensusOptions {
  /** K: confidence is scaled by votes / expected, so a partial answer (deadline) is a less confident one. */
  expected: number;
  /** Total pseudo-votes shared evenly by the offered options. Default 1. */
  priorMass?: number;
}

const NONE = "none";
const DEFAULT_PRIOR_MASS = 1;

/**
 * Additive (Laplace) smoothing with ONE pseudo-vote shared by all offered options: (count + m/n) / (votes + m).
 * One pseudo-vote PER option would cap 3/3 agreement on a 13-option form question at 4/16 = 0.25 and gate every
 * ghost off; sharing it keeps unanimous votes high (3/3 -> 0.77, 5/5 -> 0.85) but never 1.0. Always sums to 1.
 */
export function smoothedFractions(counts: number[], priorMass = DEFAULT_PRIOR_MASS): number[] {
  const n = counts.length;
  if (n === 0) return [];
  const votes = counts.reduce((sum, c) => sum + c, 0);
  const mass = votes === 0 && priorMass <= 0 ? 1 : Math.max(0, priorMass);
  return counts.map((c) => (c + mass / n) / (votes + mass));
}

function coverage(votes: number, expected: number): number {
  return expected <= 0 ? 1 : Math.min(1, votes / expected);
}

function indexOfMax(values: number[]): { index: number; tied: number[] } {
  const max = Math.max(...values);
  const tied = values.flatMap((v, i) => (v === max ? [i] : []));
  return { index: tied[0] ?? 0, tied };
}

export function choiceConsensus(options: string[], votes: string[], opts: ConsensusOptions): (ChoiceAnswer & ConsensusInfo) | undefined {
  const valid = votes.filter((v) => options.includes(v));
  if (valid.length === 0 || options.length === 0) return undefined;
  const counts = options.map((o) => valid.filter((v) => v === o).length);
  const fractions = smoothedFractions(counts, opts.priorMass);
  const probabilities: Record<string, number> = {};
  options.forEach((o, i) => (probabilities[o] = fractions[i] ?? 0));
  const { index, tied } = indexOfMax(counts);
  const info = { confidenceSource: "consensus" as const, votes: valid.length, expected: opts.expected };
  const top = (fractions[index] ?? 0) * coverage(valid.length, opts.expected);
  if (tied.length === 1) return { type: "choice", choice: options[index] ?? NONE, probabilities, confidence: top, ...info };
  // A split vote is no decision. "none" means no ghost; without a none option the first tied option is named at confidence 0 so it can never pass a gate.
  if (options.includes(NONE)) return { type: "choice", choice: NONE, probabilities, confidence: top, tie: true, ...info };
  return { type: "choice", choice: options[index] ?? "", probabilities, confidence: 0, tie: true, ...info };
}

/** Smoothed fraction of yes votes, pulled toward 0.5 when fewer than K votes arrived. */
export function noulConsensus(votes: boolean[], opts: ConsensusOptions): (NoulAnswer & ConsensusInfo) | undefined {
  if (votes.length === 0) return undefined;
  const yes = votes.filter(Boolean).length;
  const [pYes = 0.5] = smoothedFractions([yes, votes.length - yes], opts.priorMass);
  const noul = 0.5 + (pYes - 0.5) * coverage(votes.length, opts.expected);
  return { type: "noul", noul, confidenceSource: "consensus", votes: votes.length, expected: opts.expected };
}

export function scoreConsensus(criteria: string[], votes: number[], opts: ConsensusOptions): (ScoreAnswer & ConsensusInfo) | undefined {
  const valid = votes.filter((v) => Number.isInteger(v) && v >= 0 && v < criteria.length);
  if (valid.length === 0) return undefined;
  const counts = criteria.map((_, level) => valid.filter((v) => v === level).length);
  const fractions = smoothedFractions(counts, opts.priorMass);
  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  criteria.forEach((text, level) => {
    probabilities[String(level)] = fractions[level] ?? 0;
    legend[String(level)] = text;
  });
  const { index, tied } = indexOfMax(counts);
  const score = valid.reduce((sum, v) => sum + v, 0) / valid.length;
  const confidence = (fractions[index] ?? 0) * coverage(valid.length, opts.expected);
  return { type: "score", score, probabilities, legend, confidence, confidenceSource: "consensus", votes: valid.length, expected: opts.expected, ...(tied.length > 1 ? { tie: true } : {}) };
}

function questionConsensus(question: Question, votes: unknown[], opts: ConsensusOptions): ConsensusAnswer | undefined {
  if (question.type === "choice") return choiceConsensus(Object.keys(question.criteria), votes.filter((v): v is string => typeof v === "string"), opts);
  if (question.type === "noul") return noulConsensus(votes.filter((v): v is boolean => typeof v === "boolean"), opts);
  return scoreConsensus(question.criteria, votes.filter((v): v is number => typeof v === "number"), opts);
}

/** A question with no valid vote gets no answer at all, so the caller keeps its own guess instead of a confident-looking none. */
export function consensus(questions: Questions, samples: Sample[], opts: ConsensusOptions): Record<string, ConsensusAnswer> {
  const answers: Record<string, ConsensusAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const votes = samples.flatMap((s) => (Object.hasOwn(s, name) ? [s[name]] : []));
    const answer = questionConsensus(question, votes, opts);
    if (answer) answers[name] = answer;
  }
  return answers;
}
