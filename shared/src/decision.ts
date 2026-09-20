// Mirrors TypeSafe's System One (Jev) wire format exactly, so providers are swappable:
//   POST https://api.typesafe.ai/v1/systemone  { model: "jev-latest", state, questions }
// Source of truth: https://docs.typesafe.ai/api.md. Do not invent fields.

export type DecisionState = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

/**
 * A structured option description. Jev reads criteria literally rather than inferring intent, so
 * `not_for` is the only way to exclude a near-miss the option would otherwise legitimately cover.
 */
export interface CriterionDetail {
  what: string;
  not_for?: string;
  examples?: string;
}

/** A structured instruction. `task` is the question itself; the other clauses qualify it. */
export interface ChoiceInstructions {
  task: string;
  [clause: string]: string;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string | ChoiceInstructions;
  /** Option name -> description (or null). Max 255 options. Include "none" when the list may not cover the input. */
  criteria: Record<string, string | null | CriterionDetail>;
}

/**
 * Flattens structured instructions into one string. Jev takes the object; the LLM adapters describe a
 * contract in which `instructions` is a string, and a weaker model handed an object silently answers
 * `none` at confidence 0 for every question rather than failing loudly.
 */
export function instructionsText(instructions: string | ChoiceInstructions): string {
  if (typeof instructions === "string") return instructions;
  const { task, ...clauses } = instructions;
  return [task, ...Object.values(clauses)].join(" ");
}

/** Flattens a criterion for providers whose transport is a text prompt rather than Jev's typed criteria. */
export function criterionText(criterion: string | null | CriterionDetail): string | null {
  if (criterion === null || typeof criterion === "string") return criterion;
  const parts = [criterion.what];
  if (criterion.not_for) parts.push(`not for: ${criterion.not_for}`);
  if (criterion.examples) parts.push(`for example: ${criterion.examples}`);
  return parts.join("; ");
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** 2 to 10 level descriptions ordered low to high. */
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  /** Probability that the statement is true. Noul has no separate confidence. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Answers = Record<string, Answer>;

export interface DecisionResult {
  answers: Answers;
  provider: string;
  /** Model id reported by the provider, when any. */
  model?: string;
  /** False when confidence values are not calibrated probabilities (LLM adapters). */
  calibrated: boolean;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface DecisionProvider {
  readonly name: string;
  readonly calibrated: boolean;
  /** ONE call answers every question in parallel. Never loop one call per question. */
  decide(state: DecisionState, questions: Questions): Promise<DecisionResult>;
}

export const MAX_CHOICE_OPTIONS = 255;
export const JEV_MODEL = "jev-latest";
export const JEV_GATEWAY_MODEL = "typesafe-ai/jev";
