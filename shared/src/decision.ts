// Mirrors Jev's request shape: { model, state, questions } -> typed answers.
// Do not add fields here that Jev does not have; adapters translate if a provider differs.

export type DecisionState = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  id: string;
  type: "noul";
  question: string;
}

export interface ChoiceQuestion {
  id: string;
  type: "choice";
  question: string;
  /** Up to 255 options. Include "none" whenever the list might not cover the input. */
  options: string[];
}

export interface ScoreQuestion {
  id: string;
  type: "score";
  question: string;
  /** Plain-language description of the scale, e.g. "0 = irrelevant, 10 = exact match". */
  scale: string;
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  id: string;
  type: "noul";
  /** Probability of yes, 0..1. */
  probability: number;
  confidence: number;
}

export interface ChoiceAnswer {
  id: string;
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  id: string;
  type: "score";
  score: number;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionResult {
  answers: Answer[];
  provider: string;
  calibrated: boolean;
  latencyMs: number;
}

export interface DecisionProvider {
  readonly name: string;
  readonly calibrated: boolean;
  /** ONE call answers every question. Never loop one call per question. */
  decide(state: DecisionState, questions: Question[]): Promise<DecisionResult>;
}

export const MAX_CHOICE_OPTIONS = 255;
