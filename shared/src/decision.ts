// Mirrors TypeSafe's System One (Jev) wire format exactly, so providers are swappable:
//   POST https://api.typesafe.ai/v1/systemone  { model: "jev-latest", state, questions }
// Source of truth: https://docs.typesafe.ai/api.md. Do not invent fields.

export type DecisionState = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option name -> description (or null). Max 255 options. Include "none" when the list may not cover the input. */
  criteria: Record<string, string | null>;
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
