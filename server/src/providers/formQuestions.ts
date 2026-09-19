import {
  FACT_DESCRIPTIONS,
  NEEDS_TEXT,
  NONE,
  isSensitive,
  type Answers,
  type CapturedField,
  type ChoiceQuestion,
  type FieldKind,
  type Questions,
} from "@ghost/shared";

const MAX_OPTIONS = 12;
const MAX_TEXT = 200;
const MAX_OPTION_TEXT = 60;
const NEVER_ASKED: ReadonlySet<FieldKind> = new Set<FieldKind>(["button", "link", "file", "other"]);

/** One entry of `state.fields`. Deliberately has no value, id, signature or rect: the model only needs what a person reads. */
export interface FormStateField {
  label: string;
  kind: FieldKind;
  name?: string;
  placeholder?: string;
  autocomplete?: string;
  options?: string[];
  context?: string;
}

// A type alias, not an interface: only aliases are assignable to DecisionState's Record<string, unknown>.
export type FormState = {
  page: { origin: string };
  fields: FormStateField[];
};

export interface FormDecision {
  state: FormState;
  /** Question `f<i>` is about `state.fields[i]`. */
  questions: Questions;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Buttons, links and file inputs are filtered in code. Sensitive fields are dropped again here as defense in depth. */
export function isModelCandidate(field: CapturedField): boolean {
  if (NEVER_ASKED.has(field.kind)) return false;
  return !isSensitive({
    inputType: field.inputType,
    autocomplete: field.autocomplete,
    name: field.name,
    id: field.id,
    label: field.label,
    placeholder: field.placeholder,
  });
}

export function toStateField(field: CapturedField): FormStateField {
  const out: FormStateField = { label: clip(field.label, MAX_TEXT), kind: field.kind };
  if (field.name) out.name = clip(field.name, MAX_TEXT);
  if (field.placeholder) out.placeholder = clip(field.placeholder, MAX_TEXT);
  if (field.autocomplete) out.autocomplete = clip(field.autocomplete, MAX_TEXT);
  if (field.options?.length) out.options = field.options.slice(0, MAX_OPTIONS).map((o) => clip(o.label, MAX_OPTION_TEXT));
  if (field.context) out.context = clip(field.context, MAX_TEXT);
  return out;
}

export function cleanFactKeys(factKeys: string[]): string[] {
  return [...new Set(factKeys)].filter((key) => key !== NEEDS_TEXT && key !== NONE);
}

export function factCriteria(factKeys: string[]): ChoiceQuestion["criteria"] {
  const criteria: ChoiceQuestion["criteria"] = {};
  for (const key of cleanFactKeys(factKeys)) criteria[key] = FACT_DESCRIPTIONS[key] ?? null;
  criteria[NEEDS_TEXT] = "free-text answer the applicant must write";
  criteria[NONE] = "no profile fact fits";
  return criteria;
}

export function formQuestionName(index: number): string {
  return `f${index}`;
}

/** Builds the ONE batched decision for a form: a choice question per field, all sharing the same criteria. */
export function buildFormDecision(origin: string, fields: CapturedField[], factKeys: string[]): FormDecision {
  const criteria = factCriteria(factKeys);
  const questions: Questions = {};
  fields.forEach((_, i) => {
    questions[formQuestionName(i)] = {
      type: "choice",
      instructions: `Which profile fact should fill the form field \`fields[${i}]\`? Answer ${NEEDS_TEXT} if the applicant must write a free-text answer, or ${NONE} if no profile fact fits.`,
      criteria,
    };
  });
  return { state: { page: { origin }, fields: fields.map(toStateField) }, questions };
}

export function readFormAnswer(answers: Answers, index: number, allowed: ChoiceQuestion["criteria"]): { factKey: string; confidence: number } | undefined {
  const answer = answers[formQuestionName(index)];
  if (answer?.type !== "choice" || !Object.hasOwn(allowed, answer.choice)) return undefined;
  if (!Number.isFinite(answer.confidence)) return undefined;
  return { factKey: answer.choice, confidence: Math.min(1, Math.max(0, answer.confidence)) };
}
