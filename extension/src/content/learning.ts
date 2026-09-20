// Opt-in learning (settings.learningEnabled, off by default). What the user types into a field Ghost
// recognizes becomes a profile fact; what they write (or accept) in an essay field becomes a past answer.
// Every rule here errs toward learning nothing: a wrong fact turns into wrong ghosts on every later form.
import { FACT_DESCRIPTIONS, isSensitive, mapFormHeuristically, NEEDS_TEXT, NONE, recordCorrection } from "@ghost/shared";
import type { AnswerCorrectedEvent, CapturedField, FieldAssignment, FieldKind, GhostSettings, LearnedAnswerStore, PastAnswer, Profile } from "@ghost/shared";
import type { GhostEmitter } from "../lib/events";
import type { ServedAssignment } from "../lib/messages";
import { updateLearnedAnswers, updateProfile } from "../lib/storage";
import { captureFields, isElementSensitive } from "./capture";
import type { ToastRequest } from "./learnToast";

export const LEARN_MIN_CONFIDENCE = 0.85;
export const LEARN_DEBOUNCE_MS = 400;
export const MAX_PAST_ANSWERS = 50;
export const MAX_ANSWER_CHARS = 2000;
const MIN_ANSWER_CHARS = 20;
const MAX_FACT_CHARS = 200;
const MAX_QUESTION_CHARS = 300;
const FACT_KEY = /^[A-Za-z][\w.-]{0,63}$/;
/** Facts come from what is TYPED. A select's or radio's value is the site's own code, not the user's words. */
const TYPED_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(["text", "email", "tel", "url", "number", "date", "month"]);
const PROSE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(["text", "textarea"]);
const ANSWERABLE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox",
]);

export type LearnDecision =
  | { kind: "fact"; key: string; value: string }
  | { kind: "answer"; question: string; answer: string };

export interface LearnInput {
  field: CapturedField;
  value: string;
  /** The field's mapping (see `pickMapping`), or null when nobody recognized it. */
  mapping: FieldAssignment | null;
  profile: Profile;
  enabled: boolean;
}

// ---------- pure rules ----------

export function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = Number(digits[digits.length - 1 - i]);
    const doubled = i % 2 === 1 ? digit * 2 : digit;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** A card-like number (13 to 19 digits passing Luhn) or a 9-digit SIN/SSN-like number, anywhere in the text. */
export function looksSecret(value: string): boolean {
  for (const run of value.match(/\d(?:[ .-]?\d)+/g) ?? []) {
    const digits = run.replace(/\D/g, "");
    if (digits.length === 9) return true;
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return true;
  }
  return false;
}

function alnum(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** "+1 519 555 0142" and "5195550142" are one phone number: the profile's own spelling stays. */
export function sameValue(a: string, b: string): boolean {
  const [x, y] = [alnum(a), alnum(b)];
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short);
}

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;

/** The value as the profile should hold it, or null when it cannot be this fact. */
export function factValueFor(key: string, raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_FACT_CHARS || /[\r\n]/.test(value)) return null;
  if (key === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
  if (key === "phone") return /^[+(\d][\d\s().+-]*$/.test(value) && value.replace(/\D/g, "").length >= 7 ? value : null;
  if (key === "github" || key === "linkedin" || key === "website") return /^\S+\.\S+$/.test(value) ? value : null;
  if (key === "firstName" || key === "lastName" || key === "fullName") return /[\d@]/.test(value) || value.length > 80 ? null : value;
  if (key !== "graduationDate") return value;
  // Dates are parsed in code everywhere else: only the ISO shape the resolver reads is worth keeping.
  const slashed = /^(0?[1-9]|1[0-2])\s*\/\s*(\d{4})$/.exec(value);
  if (slashed) return `${slashed[2]}-${(slashed[1] ?? "").padStart(2, "0")}`;
  return ISO_DATE.test(value) ? value : null;
}

function fieldLooksSensitive(field: CapturedField): boolean {
  const { label, name, id, placeholder, autocomplete, inputType, context } = field;
  return isSensitive({ label, name, id, placeholder, autocomplete, inputType }) || isSensitive({ label: context });
}

/**
 * Which mapping learning trusts. A served answer naming a fact wins unless the offline heuristic is just
 * as sure of a DIFFERENT fact (then nobody is trusted); a calibrated "not a fact" is believed too.
 */
export function pickMapping(offline: FieldAssignment | undefined, served: ServedAssignment | undefined): FieldAssignment | null {
  const sure = (a: FieldAssignment | undefined): a is FieldAssignment => a !== undefined && a.confidence >= LEARN_MIN_CONFIDENCE;
  if (sure(served) && sure(offline) && served.factKey !== offline.factKey && offline.factKey !== NONE) return null;
  if (sure(served) && (served.factKey !== NONE || served.calibrated === true)) return served;
  return offline ?? null;
}

/** Every NEVER of the learning contract lives here. null = learn nothing. */
export function decideLearning(input: LearnInput): LearnDecision | null {
  const { field, mapping, profile } = input;
  if (!input.enabled || !mapping || mapping.confidence < LEARN_MIN_CONFIDENCE || mapping.factKey === NONE) return null;
  if (fieldLooksSensitive(field) || looksSecret(input.value)) return null;
  if (mapping.factKey === NEEDS_TEXT) return decideAnswer(field, input.value);
  const key = mapping.factKey;
  if (!TYPED_KINDS.has(field.kind) || !FACT_KEY.test(key) || isSensitive({ label: key })) return null;
  const value = factValueFor(key, input.value);
  if (value === null) return null;
  const known = profile.facts[key]?.trim() ?? "";
  return known !== "" && sameValue(known, value) ? null : { kind: "fact", key, value };
}

function decideAnswer(field: CapturedField, raw: string): LearnDecision | null {
  const question = field.label.trim().slice(0, MAX_QUESTION_CHARS);
  const answer = raw.trim().slice(0, MAX_ANSWER_CHARS);
  if (!PROSE_KINDS.has(field.kind) || !question || answer.length < MIN_ANSWER_CHARS) return null;
  return { kind: "answer", question, answer };
}

export function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** One answer per question (newest wins), newest last, at most MAX_PAST_ANSWERS: the oldest fall off. */
export function mergePastAnswer(list: PastAnswer[], entry: PastAnswer): PastAnswer[] {
  const key = normalizeQuestion(entry.question);
  const clipped = { ...entry, answer: entry.answer.slice(0, MAX_ANSWER_CHARS) };
  return [...list.filter((item) => normalizeQuestion(item.question) !== key), clipped].slice(-MAX_PAST_ANSWERS);
}

// ---------- the subscriber ----------

export interface LearnerDeps {
  events: GhostEmitter;
  getSettings: () => GhostSettings;
  getProfile: () => Profile;
  /** What the server or the per-site cache said about a field. */
  served?: (signature: string) => ServedAssignment | undefined;
  toast?: (request: ToastRequest) => void;
  capture?: () => CapturedField[];
  isSensitiveElement?: (el: Element) => boolean;
  update?: typeof updateProfile;
  /** Site-independent correction store. Values remain in chrome.storage.local and never enter telemetry. */
  updateAnswers?: typeof updateLearnedAnswers;
  /** Optional value-free counter seam. */
  onAnswerEvent?: (event: AnswerCorrectedEvent) => void;
  origin?: () => string;
  now?: () => Date;
  debounceMs?: number;
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
}

interface Pending {
  field: CapturedField;
  value: string;
  el: HTMLElement | null;
  correction: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export class Learner {
  private readonly pending = new Map<string, Pending>();
  private readonly previous = new Map<string, { source: "fact" | "learned" | "guess" }>();
  private unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: LearnerDeps) {}

  start(): void {
    if (this.unsubscribe.length > 0) return;
    const { events } = this.deps;
    const win = this.deps.win ?? window;
    win.addEventListener("pagehide", this.onPageHide);
    this.unsubscribe = [
      events.on("user:input", ({ field, value, el }) => this.consider(field, value, el, true)),
      events.on("ghost:dismissed", ({ ghost, reason }) => {
        if (reason === "typed" && ghost.answer) this.previous.set(ghost.signature, { source: ghost.answer.source });
      }),
      // An accepted draft is an answer the user chose; if they edit it afterwards, that edit replaces it.
      events.on("ghost:accepted", ({ ghost, field }) => {
        if (ghost.source === "llm" && ghost.action === "fill") this.consider(field, ghost.value ?? "", null, false);
      }),
      () => win.removeEventListener("pagehide", this.onPageHide),
    ];
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.previous.clear();
  }

  /** Runs everything still waiting on its debounce. Resolves once storage has it. */
  async flush(): Promise<void> {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) clearTimeout(entry.timer);
    await Promise.all(entries.map((entry) => this.commit(entry)));
  }

  /** Debounced per field: an edit, a blur, a return to fix a typo and another blur is ONE lesson. */
  private consider(field: CapturedField, value: string, el: HTMLElement | null, correction: boolean): void {
    if (!this.deps.getSettings().learningEnabled || !ANSWERABLE_KINDS.has(field.kind)) return;
    const waiting = this.pending.get(field.signature);
    if (waiting) clearTimeout(waiting.timer);
    const entry: Pending = { field, value, el, correction, timer: setTimeout(() => this.fire(field.signature), this.deps.debounceMs ?? LEARN_DEBOUNCE_MS) };
    this.pending.set(field.signature, entry);
  }

  private fire(signature: string): void {
    const entry = this.pending.get(signature);
    this.pending.delete(signature);
    if (entry) void this.commit(entry).catch((error: unknown) => console.debug("[ghost] learning skipped", error));
  }

  private async commit({ field, value, el, correction }: Pending): Promise<void> {
    if (!this.deps.getSettings().learningEnabled) return;
    if (el?.isConnected && (this.deps.isSensitiveElement ?? isElementSensitive)(el)) return;
    const mapping = this.mappingFor(field);
    if (correction) await this.learnCorrection(field, value, optionLabel(field, value), this.previous.get(field.signature) ?? null);
    this.previous.delete(field.signature);
    const decide = (profile: Profile): LearnDecision | null => decideLearning({ field, value, mapping, profile, enabled: true });
    const first = decide(this.deps.getProfile());
    if (!first) return;
    if (first.kind === "fact") await this.learnFact(decide);
    else await this.learnAnswer(first);
  }

  private async learnCorrection(
    field: CapturedField,
    value: string,
    selectedLabel: string | undefined,
    previous: { source: "fact" | "learned" | "guess" } | null,
  ): Promise<void> {
    const update = this.deps.updateAnswers ?? updateLearnedAnswers;
    let event: AnswerCorrectedEvent | undefined;
    await update((store: LearnedAnswerStore) => {
      const result = recordCorrection(field, value, store, {
        optionLabel: selectedLabel,
        origin: (this.deps.origin ?? (() => location.origin))(),
        now: (this.deps.now ?? (() => new Date()))().getTime(),
        previous,
      });
      event = result.event;
      return result.changed !== "refused";
    });
    if (event) this.deps.onAnswerEvent?.(event);
  }

  /** The heuristic sees the whole form (a lone email box is a login, not a fact), over every key it knows. */
  private mappingFor(field: CapturedField): FieldAssignment | null {
    const captured = (this.deps.capture ?? captureFields)();
    const fields = captured.some((f) => f.signature === field.signature) ? captured : [...captured, field];
    const keys = [...new Set([...Object.keys(FACT_DESCRIPTIONS), ...Object.keys(this.deps.getProfile().facts)])];
    const offline = mapFormHeuristically(fields, keys).find((a) => a.signature === field.signature);
    return pickMapping(offline, this.deps.served?.(field.signature));
  }

  private async learnFact(decide: (profile: Profile) => LearnDecision | null): Promise<void> {
    const update = this.deps.update ?? updateProfile;
    let learned: { key: string; value: string; previous: string | undefined } | null = null;
    await update((profile) => {
      const decision = decide(profile); // again, against what storage holds NOW
      if (decision?.kind !== "fact") return null;
      learned = { key: decision.key, value: decision.value, previous: profile.facts[decision.key] };
      return { ...profile, facts: { ...profile.facts, [decision.key]: decision.value } };
    });
    const done = learned as { key: string; value: string; previous: string | undefined } | null;
    if (done) this.deps.toast?.({ text: `Ghost learned: ${done.key}`, onUndo: () => void update((p) => undoFact(p, done)) });
  }

  private async learnAnswer(decision: Extract<LearnDecision, { kind: "answer" }>): Promise<void> {
    const update = this.deps.update ?? updateProfile;
    const entry: PastAnswer = {
      question: decision.question,
      answer: decision.answer,
      origin: (this.deps.origin ?? (() => location.origin))(),
      savedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
    };
    let replaced: PastAnswer | undefined;
    const saved = await update((profile) => {
      replaced = profile.pastAnswers.find((item) => normalizeQuestion(item.question) === normalizeQuestion(entry.question));
      if (replaced?.answer === entry.answer) return null; // nothing new: no write, no toast
      return { ...profile, pastAnswers: mergePastAnswer(profile.pastAnswers, entry) };
    });
    if (saved) this.deps.toast?.({ text: "Ghost saved this answer", onUndo: () => void update((p) => undoAnswer(p, entry, replaced)) });
  }

  private readonly onPageHide = (): void => void this.flush().catch(() => undefined);
}

/** Only while the fact still holds what was learned: an edit made since (options page, another tab) stays. */
export function undoFact(profile: Profile, learned: { key: string; value: string; previous: string | undefined }): Profile | null {
  if (profile.facts[learned.key] !== learned.value) return null;
  const facts = { ...profile.facts };
  if (learned.previous === undefined) delete facts[learned.key];
  else facts[learned.key] = learned.previous;
  return { ...profile, facts };
}

export function undoAnswer(profile: Profile, entry: PastAnswer, replaced: PastAnswer | undefined): Profile | null {
  const index = profile.pastAnswers.findIndex((item) => item.question === entry.question && item.answer === entry.answer);
  if (index < 0) return null;
  const pastAnswers = profile.pastAnswers.filter((_, i) => i !== index);
  return { ...profile, pastAnswers: replaced ? mergePastAnswer(pastAnswers, replaced) : pastAnswers };
}

function optionLabel(field: CapturedField, value: string): string | undefined {
  return field.options?.find((option) => option.value === value)?.label;
}
