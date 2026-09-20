// What the user themselves answered, keyed by a site-independent question signature. Local only:
// a learned answer, a protected value or a declaration never leaves the machine (docs/answers.md section 4).
import { isSensitive } from "../sensitive";
import type { FieldKind } from "../types";
import { classifyQuestion, probeText, type QuestionClass, type QuestionField } from "./classify";
import { hasReadableQuestion, questionSignature, questionTextSignature, type SignatureOptions } from "./signature";

export const MAX_LEARNED_ANSWERS = 500;
export const MAX_LEARNED_VALUE_CHARS = 2000;
export const MAX_LEARNED_LABEL_CHARS = 300;
export const MAX_LEARNED_ORIGINS = 3;
/** The user said it once. */
export const LEARNED_CONFIDENCE_ONCE = 0.86;
/** The user said it again: they meant it. */
export const LEARNED_CONFIDENCE_REPEATED = 0.94;

export interface LearnedAnswer {
  signature: string;
  /** The same key without the option fingerprint, so another site's wording of the options still matches. */
  textSignature: string;
  /** The question as last seen, for the options page. Never a value from anywhere else. */
  label: string;
  kind: FieldKind;
  /** Exactly what the user chose or typed. */
  value: string;
  /** For choice fields: the visible option text, so a different site's option values can be matched. */
  optionLabel?: string;
  /** How many times the user has given this answer. */
  count: number;
  updatedAt: string;
  /** Up to 3 origins where it was used, for the options page. */
  origins: string[];
  class: QuestionClass;
}

export interface LearnedAnswersSnapshot {
  max: number;
  /** Least recently used first. */
  answers: LearnedAnswer[];
}

export interface LearnInput {
  field: QuestionField;
  /** What the user chose or typed. */
  value: string;
  /** The visible option text, when the field is a select or a radio group. */
  optionLabel?: string;
  origin?: string;
  /** Milliseconds since the epoch. */
  now?: number;
  /** Overrides the derived class (the caller may already have classified the field). */
  class?: QuestionClass;
  company?: string;
}

export type LearnRefusal = "empty" | "unreadable-question" | "sensitive-field" | "secret-value" | "not-answerable";

export function learnedConfidence(count: number): number {
  return count >= 2 ? LEARNED_CONFIDENCE_REPEATED : LEARNED_CONFIDENCE_ONCE;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = Number(digits[digits.length - 1 - i]);
    const doubled = i % 2 === 1 ? digit * 2 : digit;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/**
 * A card-like number (13 to 19 digits passing Luhn) or a 9-digit SIN/SSN-like number, anywhere in the text.
 * Same rule as the extension's `looksSecret`; kept here so both clients refuse the same values.
 */
export function looksSecretValue(value: string): boolean {
  for (const run of value.match(/\d(?:[ .-]?\d)+/g) ?? []) {
    const digits = run.replace(/\D/g, "");
    if (digits.length === 9) return true;
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/** Rule 3 for a question: a password, a card, a government ID or anything marked sensitive is never touched. */
export function fieldLooksSensitive(field: QuestionField): boolean {
  const probe = {
    label: field.label,
    name: field.name,
    id: field.id,
    placeholder: field.placeholder,
    autocomplete: field.autocomplete,
    inputType: field.inputType,
  };
  return isSensitive(probe) || isSensitive({ label: field.context });
}

/** Why this answer may not be learned, or null when it may. */
export function refuseLearning(field: QuestionField, value: string, optionLabel?: string, opts: SignatureOptions = {}): LearnRefusal | null {
  if (value.trim() === "") return "empty";
  if (field.kind === "button" || field.kind === "link" || field.kind === "file" || field.kind === "other") return "not-answerable";
  if (!hasReadableQuestion(field, opts)) return "unreadable-question";
  if (fieldLooksSensitive(field)) return "sensitive-field";
  if (looksSecretValue(value) || looksSecretValue(optionLabel ?? "")) return "secret-value";
  return null;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function copy(a: LearnedAnswer): LearnedAnswer {
  return { ...a, origins: [...a.origins] };
}

function sameAnswer(a: LearnedAnswer, value: string, optionLabel: string | undefined): boolean {
  if (probeText(a.value) !== probeText(value)) return false;
  return probeText(a.optionLabel ?? "") === probeText(optionLabel ?? "");
}

export interface LearnResult {
  answer: LearnedAnswer | null;
  changed: "added" | "repeated" | "replaced" | "refused";
  /** Set when `changed` is "refused". */
  refusal?: LearnRefusal;
}

/**
 * Pure, JSON-serializable store of learned answers. Array order is recency: adding or repeating an answer
 * moves it to the end, and the cap drops the least recently used.
 */
export class LearnedAnswerStore {
  private answers: LearnedAnswer[];
  readonly max: number;

  constructor(max: number | null = MAX_LEARNED_ANSWERS, answers: readonly LearnedAnswer[] = []) {
    this.max = typeof max === "number" && Number.isFinite(max) ? Math.max(1, Math.floor(max)) : MAX_LEARNED_ANSWERS;
    this.answers = answers.slice(-this.max).map(copy);
  }

  get size(): number {
    return this.answers.length;
  }

  /** Least recently used first. Callers never hold the store's own objects. */
  list(): LearnedAnswer[] {
    return this.answers.map(copy);
  }

  /** Null when the answer may not be learned (see `refuseLearning`), with the refusal saying why. */
  add(input: LearnInput): LearnResult {
    const { field, value, optionLabel } = input;
    const opts: SignatureOptions = input.company ? { company: input.company } : {};
    const refusal = refuseLearning(field, value, optionLabel, opts);
    if (refusal !== null) return { answer: null, changed: "refused", refusal };

    const signature = questionSignature(field, opts);
    const at = this.answers.findIndex((a) => a.signature === signature);
    const previous = at >= 0 ? this.answers[at] : undefined;
    const repeated = previous !== undefined && sameAnswer(previous, value, optionLabel);
    const learned: LearnedAnswer = {
      signature,
      textSignature: questionTextSignature(field, opts),
      label: clip(field.label.trim(), MAX_LEARNED_LABEL_CHARS),
      kind: field.kind,
      value: clip(value.trim(), MAX_LEARNED_VALUE_CHARS),
      count: repeated ? (previous?.count ?? 0) + 1 : 1,
      updatedAt: new Date(input.now ?? Date.now()).toISOString(),
      origins: mergeOrigins(previous?.origins ?? [], input.origin),
      class: input.class ?? classifyQuestion(field).class,
    };
    const trimmedOption = optionLabel?.trim();
    if (trimmedOption) learned.optionLabel = clip(trimmedOption, MAX_LEARNED_VALUE_CHARS);
    if (at >= 0) this.answers.splice(at, 1);
    this.answers.push(learned);
    this.prune();
    return { answer: copy(learned), changed: previous === undefined ? "added" : repeated ? "repeated" : "replaced" };
  }

  /** Exact signature first, then the same question with differently worded options. */
  get(field: QuestionField, opts: SignatureOptions = {}): LearnedAnswer | null {
    const exact = this.getBySignature(questionSignature(field, opts));
    if (exact) return exact;
    const text = questionTextSignature(field, opts);
    for (let i = this.answers.length - 1; i >= 0; i--) {
      const a = this.answers[i];
      if (a && a.textSignature === text) return copy(a);
    }
    return null;
  }

  getBySignature(signature: string): LearnedAnswer | null {
    const found = this.answers.find((a) => a.signature === signature);
    return found ? copy(found) : null;
  }

  forget(signature: string): boolean {
    const at = this.answers.findIndex((a) => a.signature === signature);
    if (at < 0) return false;
    this.answers.splice(at, 1);
    return true;
  }

  /** "Forget everything learned here". Returns how many answers went. */
  forgetOrigin(origin: string): number {
    const before = this.answers.length;
    this.answers = this.answers.filter((a) => !a.origins.includes(origin));
    return before - this.answers.length;
  }

  /** Drops the least recently used down to `max`. Returns how many went. */
  prune(max: number = this.max): number {
    const limit = Math.max(1, Math.floor(max));
    const extra = this.answers.length - limit;
    if (extra <= 0) return 0;
    this.answers.splice(0, extra);
    return extra;
  }

  toJSON(): LearnedAnswersSnapshot {
    return { max: this.max, answers: this.answers.map(copy) };
  }

  static fromJSON(snapshot: LearnedAnswersSnapshot | null | undefined): LearnedAnswerStore {
    if (!snapshot || !Array.isArray(snapshot.answers)) return new LearnedAnswerStore();
    const answers = snapshot.answers.filter(isLearnedAnswer);
    return new LearnedAnswerStore(snapshot.max, answers);
  }
}

function mergeOrigins(existing: readonly string[], origin: string | undefined): string[] {
  const out = [...existing];
  if (origin && origin.trim() !== "" && !out.includes(origin)) out.push(origin);
  return out.slice(-MAX_LEARNED_ORIGINS);
}

/** A snapshot read from disk or chrome.storage is data, not a promise: anything malformed is dropped. */
function isLearnedAnswer(value: unknown): value is LearnedAnswer {
  const a = value as Partial<LearnedAnswer> | null;
  if (!a || typeof a !== "object") return false;
  return (
    typeof a.signature === "string" &&
    a.signature !== "" &&
    typeof a.textSignature === "string" &&
    typeof a.label === "string" &&
    typeof a.kind === "string" &&
    typeof a.value === "string" &&
    typeof a.count === "number" &&
    Number.isFinite(a.count) &&
    typeof a.updatedAt === "string" &&
    Array.isArray(a.origins) &&
    a.origins.every((o) => typeof o === "string") &&
    (a.class === "ordinary" || a.class === "protected" || a.class === "declaration")
  );
}
