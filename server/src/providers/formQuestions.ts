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
} from "@shabang/shared";

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

/**
 * Every stored fact is about the applicant, but `FACT_DESCRIPTIONS` describes the KIND of value
 * ("phone number"), not whose it is. Jev reads criteria literally, so for a field labelled
 * "Emergency contact phone" a fact described as "phone number" genuinely does fit, and answering
 * `phone` is a correct answer to a question that forgot to say "the applicant's own". We stated the
 * constraint in the grader and not in the question, then scored the model on the gap.
 *
 * These entries say it out loud. Measured on the 10-field ambiguous form, live against jev-latest:
 * 55% -> 90% correct, and 8 wrong ghosts above the 0.7 gate -> 0.
 */
const OWNED_BY_APPLICANT = "the applicant's own ";

/** Descriptions that are clauses rather than noun phrases, so the prefix above cannot compose with them. */
const OWNED_DESCRIPTION: Record<string, string> = {
  referralSource: "how the applicant themselves heard about the company",
  workAuthorization: "whether the applicant is legally authorized to work in the country (yes/no)",
  requiresSponsorship: "whether the applicant requires visa sponsorship (yes/no)",
  "workAuthorization.CA": "whether the applicant is legally authorized to work in Canada (yes/no)",
  "requiresSponsorship.CA": "whether the applicant requires visa sponsorship in Canada (yes/no)",
};

const NOT_FOR: Record<string, string> = {
  phone: "not an emergency contact's, a reference's or anyone else's phone number",
  email: "not a referrer's, a manager's or anyone else's email address",
  website: "not an employer's, a school's or any company's website",
  lastName: "not a manager's, a reference's or anyone else's surname",
  firstName: "not a manager's, a reference's or anyone else's given name",
  fullName: "not another person's name",
  linkedin: "not another person's LinkedIn profile",
  github: "not another person's GitHub profile",
};

/**
 * `structured` states ownership and is what Jev and Baseten get: measured 53% -> 90% on the ambiguous form.
 * `plain` is the older, looser wording, kept for the small-chat-model fallback. Measured on gpt-4o-mini, EITHER
 * half of the structured form (the `not_for` criteria alone, or the `whose` instruction alone, or even the
 * ownership-prefixed `what` alone) makes it answer `none` for every field of a perfectly ordinary form. That is
 * a property of the model, not of the wording: the same text is what takes Jev from 53% to 90%.
 */
export type Wording = "structured" | "plain";

/** Providers whose transport is a small chat model, which the structured wording destabilises. */
export function wordingFor(providerName: string): Wording {
  return providerName === "llm" ? "plain" : "structured";
}

export function factCriteria(factKeys: string[], wording: Wording = "structured"): ChoiceQuestion["criteria"] {
  const criteria: ChoiceQuestion["criteria"] = {};
  if (wording === "plain") {
    for (const key of cleanFactKeys(factKeys)) criteria[key] = FACT_DESCRIPTIONS[key] ?? null;
    criteria[NEEDS_TEXT] = "free-text answer the applicant must write";
    criteria[NONE] = "no profile fact fits";
    return criteria;
  }
  for (const key of cleanFactKeys(factKeys)) {
    const base = FACT_DESCRIPTIONS[key];
    if (!base) {
      criteria[key] = null;
      continue;
    }
    const what = OWNED_DESCRIPTION[key] ?? OWNED_BY_APPLICANT + base;
    criteria[key] = NOT_FOR[key] ? { what, not_for: NOT_FOR[key] } : what;
  }
  criteria[NEEDS_TEXT] = {
    what: "the applicant must write a free-text answer in their own words",
    not_for: "a short factual value that is already known about the applicant",
  };
  // Described by what it IS, not as an absence: an option defined only as a gap attracts near-misses.
  criteria[NONE] = {
    what: "the field asks for something that is not a stored fact about the applicant themselves",
    examples: "a different person's contact details, a company's or employer's details, or a fact nobody has recorded about the applicant",
  };
  return criteria;
}

export function formQuestionName(index: number): string {
  return `f${index}`;
}

/** Builds the ONE batched decision for a form: a choice question per field, all sharing the same criteria. */
export function buildFormDecision(origin: string, fields: CapturedField[], factKeys: string[], wording: Wording = "structured"): FormDecision {
  const criteria = factCriteria(factKeys, wording);
  const questions: Questions = {};
  fields.forEach((_, i) => {
    questions[formQuestionName(i)] =
      wording === "plain"
        ? {
            type: "choice",
            criteria,
            instructions: `Which profile fact should fill the form field \`fields[${i}]\`? Answer ${NEEDS_TEXT} if the applicant must write a free-text answer, or ${NONE} if no profile fact fits.`,
          }
        : {
            type: "choice",
            criteria,
            instructions: {
              task: `The form field \`fields[${i}]\` is being filled in by the applicant. Which stored fact about the applicant belongs in it?`,
              whose:
                "Every option describes a fact about the applicant themselves. Read the field's label to see whose detail it asks for. " +
                "A label naming another person (an emergency contact, a referrer, a manager, a reference) or an organisation (an employer, a company) " +
                `asks for that party's detail, so the applicant's own matching fact is the wrong value: answer ${NONE}.`,
              free_text: `Answer ${NEEDS_TEXT} when the field asks the applicant to write prose in their own words.`,
              no_fit: `Answer ${NONE} when no stored fact about the applicant is the value this field asks for.`,
            },
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
