// Opt-in learning (settings.learningEnabled, off by default). What the user types into a field Ghost
// recognizes becomes a profile fact; what they write (or accept) in an essay field becomes a past answer.
// Every rule here errs toward learning nothing: a wrong fact turns into wrong ghosts on every later form.
import { answerCounterName, FACT_DESCRIPTIONS, isSensitive, mapFormHeuristically, NEEDS_TEXT, NONE, questionSignature, staysOnThisMachine } from "@ghost/shared";
import type {
  CapturedField, FieldAssignment, FieldKind, Ghost, GhostSettings, LearnedAnswer, LearnedAnswerStore, LearnResult,
  PastAnswer, Profile,
} from "@ghost/shared";
import type { GhostEmitter } from "../lib/events";
import type { ServedAssignment } from "../lib/messages";
import { addAnswerCounters, getProfile, updateLearnedAnswers, updateProfile } from "../lib/storage";
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
/** Every field that can carry an answer the user gave (docs/answers.md section 4). Buttons and files cannot. */
const ANSWERABLE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox",
]);
export const ANSWER_TOAST = "Ghost will remember this answer";

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

/** The profile already answers this question with the same thing, so the user typing it is not a correction. */
function knownFact(profile: Profile, factKey: string, value: string): boolean {
  if (factKey === NONE || factKey === NEEDS_TEXT) return false;
  const known = profile.facts[factKey]?.trim() ?? "";
  return known !== "" && sameValue(known, value);
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
  // `profile.pastAnswers` is the one learned thing that LEAVES the machine: it rides in the /v1/ghost-text
  // body to help the next draft. A protected or declaration answer must never end up there (docs/answers.md
  // section 7), so it is not kept as a past answer at all. The learned-answer store still keeps it, locally.
  if (staysOnThisMachine(field)) return null;
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
  /** Read-modify-write of the learned answers (`ghost.answers`). Local only: nothing here leaves the machine. */
  updateAnswers?: typeof updateLearnedAnswers;
  /** The profile as storage holds it right now (another tab may have edited it). Defaults to `getProfile`. */
  latestProfile?: () => Promise<Profile>;
  /** Value-free answer counters (docs/answers.md section 6). */
  counters?: (deltas: Record<string, number>) => void;
  /** The company this page is for, so a question keeps the same signature on the next site. */
  company?: () => string | undefined;
  origin?: () => string;
  now?: () => Date;
  debounceMs?: number;
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
}

interface Pending {
  field: CapturedField;
  value: string;
  el: HTMLElement | null;
  timer: ReturnType<typeof setTimeout>;
}

export class Learner {
  private readonly pending = new Map<string, Pending>();
  /** The ghost that was on a field when the user answered it: `answer.corrected` says whether it was a guess. */
  private readonly lastGhost = new Map<string, Ghost>();
  private unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: LearnerDeps) {}

  start(): void {
    if (this.unsubscribe.length > 0) return;
    const { events } = this.deps;
    const win = this.deps.win ?? window;
    win.addEventListener("pagehide", this.onPageHide);
    this.unsubscribe = [
      events.on("user:input", ({ field, value, el }) => this.consider(field, value, el)),
      // An accepted draft is an answer the user chose; if they edit it afterwards, that edit replaces it.
      events.on("ghost:accepted", ({ ghost, field }) => {
        this.countProposal(ghost, true);
        if (ghost.source === "llm" && ghost.action === "fill") this.consider(field, ghost.value ?? "", null);
      }),
      // Escaped or typed over: the proposal was shown and not taken. Numbers only, never a label or a value.
      events.on("ghost:dismissed", ({ ghost }) => {
        this.lastGhost.set(ghost.signature, ghost);
        if (ghost.source !== "llm") this.countProposal(ghost, false);
      }),
      () => win.removeEventListener("pagehide", this.onPageHide),
    ];
  }

  // ---------- section 6: value-free counters ----------

  private countProposal(ghost: Ghost, accepted: boolean): void {
    const cls = ghost.answerClass;
    const source = ghost.answerSource;
    if (!cls || !source) return; // not an answer-engine ghost: the ordinary metrics already count it
    this.count(answerCounterName({ event: "answer.proposed", class: cls, source, accepted, confidenceBucket: 0 }));
  }

  private count(name: string): void {
    (this.deps.counters ?? ((deltas) => void addAnswerCounters(deltas).catch(() => undefined)))({ [name]: 1 });
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  /** Runs everything still waiting on its debounce. Resolves once storage has it. */
  async flush(): Promise<void> {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) clearTimeout(entry.timer);
    await Promise.all(entries.map((entry) => this.commit(entry)));
  }

  /** Debounced per field: an edit, a blur, a return to fix a typo and another blur is ONE lesson. */
  private consider(field: CapturedField, value: string, el: HTMLElement | null): void {
    if (!this.deps.getSettings().learningEnabled || !ANSWERABLE_KINDS.has(field.kind)) return;
    const waiting = this.pending.get(field.signature);
    if (waiting) clearTimeout(waiting.timer);
    const entry: Pending = { field, value, el, timer: setTimeout(() => this.fire(field.signature), this.deps.debounceMs ?? LEARN_DEBOUNCE_MS) };
    this.pending.set(field.signature, entry);
  }

  private fire(signature: string): void {
    const entry = this.pending.get(signature);
    this.pending.delete(signature);
    if (entry) void this.commit(entry).catch((error: unknown) => console.debug("[ghost] learning skipped", error));
  }

  private async commit({ field, value, el }: Pending): Promise<void> {
    if (!this.deps.getSettings().learningEnabled) return;
    if (el?.isConnected && (this.deps.isSensitiveElement ?? isElementSensitive)(el)) return;
    // The profile is the better home for a value Ghost recognizes; its toast wins when both fire.
    const mapping = this.mappingFor(field);
    const toasted = await this.learnProfile(field, value, mapping);
    await this.rememberAnswer(field, value, mapping, !toasted);
  }

  /** The Stage 4 path: a typed value in a recognized field becomes a fact, an essay becomes a past answer. */
  private async learnProfile(field: CapturedField, value: string, mapping: FieldAssignment | null): Promise<boolean> {
    if (!TYPED_KINDS.has(field.kind) && !PROSE_KINDS.has(field.kind)) return false;
    const decide = (profile: Profile): LearnDecision | null => decideLearning({ field, value, mapping, profile, enabled: true });
    const first = decide(this.deps.getProfile());
    if (!first) return false;
    return first.kind === "fact" ? this.learnFact(decide) : this.learnAnswer(first);
  }

  /**
   * docs/answers.md section 4: what the user actually answered, keyed by a site-independent question
   * signature. It beats a guess and a profile fact for that question everywhere afterwards, and it never
   * leaves this machine. The store itself refuses an empty value, a sensitive field and anything secret.
   */
  private async rememberAnswer(field: CapturedField, value: string, mapping: FieldAssignment | null, withToast: boolean): Promise<void> {
    // Against what storage holds NOW, not the page's copy: the profile may have been edited in another tab.
    if (mapping && knownFact(await (this.deps.latestProfile ?? getProfile)(), mapping.factKey, value)) return;
    const update = this.deps.updateAnswers ?? updateLearnedAnswers;
    const company = this.deps.company?.();
    const input = {
      field,
      value,
      ...(optionLabelFor(field, value) ? { optionLabel: optionLabelFor(field, value) as string } : {}),
      origin: (this.deps.origin ?? (() => location.origin))(),
      now: (this.deps.now ?? (() => new Date()))().getTime(),
      ...(company ? { company } : {}),
    };
    const signature = questionSignature(field, company ? { company } : {});
    let learned: LearnedAnswer | null = null;
    let previous: LearnedAnswer | null = null;
    let changed = "refused" as LearnResult["changed"];
    await update((store) => {
      previous = store.getBySignature(signature);
      const result = store.add(input);
      learned = result.answer;
      changed = result.changed;
      return result.answer !== null;
    });
    const saved = learned as LearnedAnswer | null;
    if (!saved) return;
    const was = previous as LearnedAnswer | null;
    const ghost = this.lastGhost.get(field.signature);
    this.lastGhost.delete(field.signature);
    this.count(answerCounterName({
      event: "answer.corrected", class: saved.class, hadGhost: ghost !== undefined, wasGuess: ghost?.guess === true,
    }));
    // Saying it again is the same answer, not a new lesson: the count goes up, the chip stays away.
    if (withToast && (changed as LearnResult["changed"]) !== "repeated") {
      this.deps.toast?.({ text: ANSWER_TOAST, onUndo: () => void update((store) => undoLearnedAnswer(store, saved, was)) });
    }
  }

  /** The heuristic sees the whole form (a lone email box is a login, not a fact), over every key it knows. */
  private mappingFor(field: CapturedField): FieldAssignment | null {
    const captured = (this.deps.capture ?? captureFields)();
    const fields = captured.some((f) => f.signature === field.signature) ? captured : [...captured, field];
    const keys = [...new Set([...Object.keys(FACT_DESCRIPTIONS), ...Object.keys(this.deps.getProfile().facts)])];
    const offline = mapFormHeuristically(fields, keys).find((a) => a.signature === field.signature);
    return pickMapping(offline, this.deps.served?.(field.signature));
  }

  /** True when a toast was shown for it. */
  private async learnFact(decide: (profile: Profile) => LearnDecision | null): Promise<boolean> {
    const update = this.deps.update ?? updateProfile;
    let learned: { key: string; value: string; previous: string | undefined } | null = null;
    await update((profile) => {
      const decision = decide(profile); // again, against what storage holds NOW
      if (decision?.kind !== "fact") return null;
      learned = { key: decision.key, value: decision.value, previous: profile.facts[decision.key] };
      return { ...profile, facts: { ...profile.facts, [decision.key]: decision.value } };
    });
    const done = learned as { key: string; value: string; previous: string | undefined } | null;
    if (!done) return false;
    this.deps.toast?.({ text: `Ghost learned: ${done.key}`, onUndo: () => void update((p) => undoFact(p, done)) });
    return true;
  }

  private async learnAnswer(decision: Extract<LearnDecision, { kind: "answer" }>): Promise<boolean> {
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
    if (!saved) return false;
    this.deps.toast?.({ text: "Ghost saved this answer", onUndo: () => void update((p) => undoAnswer(p, entry, replaced)) });
    return true;
  }

  private readonly onPageHide = (): void => void this.flush().catch(() => undefined);
}

/**
 * The visible option text behind a chosen value, so the same answer can be matched on a site that spells
 * its options differently. A checkbox has no options: "true"/"false" is the whole answer.
 */
export function optionLabelFor(field: CapturedField, value: string): string | undefined {
  const options = field.options;
  if (!options || options.length === 0) return undefined;
  const hit = options.find((o) => o.value === value) ?? options.find((o) => o.label === value);
  return hit?.label;
}

/**
 * Undo of a remembered answer: only while the store still holds exactly what was just written, so a
 * correction made since (another tab, the options page) is never rolled back. The answer it replaced comes
 * back as a fresh entry; its count starts again, which is the honest thing to say about an undone lesson.
 */
export function undoLearnedAnswer(store: LearnedAnswerStore, learned: LearnedAnswer, previous: LearnedAnswer | null): boolean {
  const now = store.getBySignature(learned.signature);
  if (!now || now.value !== learned.value || now.updatedAt !== learned.updatedAt) return false;
  store.forget(learned.signature);
  if (!previous) return true;
  store.add({
    field: { label: previous.label, kind: previous.kind },
    value: previous.value,
    ...(previous.optionLabel ? { optionLabel: previous.optionLabel } : {}),
    ...(previous.origins[0] ? { origin: previous.origins[0] } : {}),
    class: previous.class,
  });
  return true;
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
