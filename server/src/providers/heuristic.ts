import {
  NEEDS_TEXT,
  NONE,
  mapFieldToFact,
  type Answer,
  type Answers,
  type CapturedField,
  type ChoiceQuestion,
  type DecisionProvider,
  type DecisionState,
  type Question,
  type Questions,
} from "@shabang/shared";
import { isRecord } from "./errors";
import type { FormStateField } from "./formQuestions";
import { NEXT_QUESTION, pickNextFromMemory, type NextState } from "./nextQuestions";
import { spreadProbabilities } from "./probabilities";

const NAME = "heuristic";
const FORM_QUESTION = /^f(\d+)$/;
const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0 };

function choice(question: ChoiceQuestion, picked: string, confidence: number): Answer {
  const options = Object.keys(question.criteria);
  const offered = options.includes(picked);
  const value = offered ? picked : NONE;
  const resolved = offered ? confidence : 0;
  return { type: "choice", choice: value, probabilities: spreadProbabilities(options, value, resolved), confidence: resolved };
}

/** Reads `state.fields[i]` (the shape built by buildFormDecision) back into a field the shared mapper understands. */
function fieldFromState(state: DecisionState, index: number): CapturedField | undefined {
  const fields = isRecord(state) && Array.isArray(state.fields) ? state.fields : [];
  const raw: unknown = fields[index];
  if (!isRecord(raw) || typeof raw.label !== "string" || typeof raw.kind !== "string") return undefined;
  const field = raw as unknown as FormStateField;
  return {
    signature: `f${index}`,
    label: field.label,
    kind: field.kind,
    name: field.name,
    placeholder: field.placeholder,
    autocomplete: field.autocomplete,
    options: field.options?.map((label) => ({ value: label, label })),
    context: field.context,
    rect: ZERO_RECT,
  };
}

function answerFormQuestion(state: DecisionState, index: number, question: ChoiceQuestion): Answer {
  const field = fieldFromState(state, index);
  if (!field) return choice(question, NONE, 0);
  const factKeys = Object.keys(question.criteria).filter((key) => key !== NEEDS_TEXT && key !== NONE);
  const mapped = mapFieldToFact(field, factKeys);
  return choice(question, mapped.factKey, mapped.confidence);
}

function answerNextQuestion(state: DecisionState, question: ChoiceQuestion): Answer {
  if (!isRecord(state) || !Array.isArray(state.recentActions) || !Array.isArray(state.candidates)) return choice(question, NONE, 0);
  const pick = pickNextFromMemory(state as unknown as NextState);
  return choice(question, pick.candidateId, pick.confidence);
}

function answer(state: DecisionState, name: string, question: Question): Answer {
  if (question.type === "noul") return { type: "noul", noul: 0.5 };
  if (question.type === "score") return { type: "score", score: (question.criteria.length - 1) / 2, probabilities: {}, confidence: 0 };
  const form = FORM_QUESTION.exec(name);
  if (form) return answerFormQuestion(state, Number(form[1]), question);
  if (name === NEXT_QUESTION) return answerNextQuestion(state, question);
  return choice(question, NONE, 0);
}

/** Deterministic, keyless, offline. Understands the form state (questions f0..fN) and the next-action state (question "next"). */
export function createHeuristicProvider(): DecisionProvider {
  return {
    name: NAME,
    calibrated: false,
    async decide(state: DecisionState, questions: Questions) {
      const started = performance.now();
      const answers: Answers = {};
      for (const [name, question] of Object.entries(questions)) answers[name] = answer(state, name, question);
      return { answers, provider: NAME, calibrated: false, latencyMs: Math.round(performance.now() - started) };
    },
  };
}
