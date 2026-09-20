export type FieldKind =
  | "text" | "email" | "tel" | "url" | "number" | "date" | "month"
  | "textarea" | "select" | "radio" | "checkbox" | "file" | "button" | "link" | "other";

export interface FieldOption {
  value: string;
  label: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A visible interactive element as seen by capture. Sensitive fields are never captured at all. */
export interface CapturedField {
  /** Stable across reloads of the same page: built from tag, type, name, id, label and form position. */
  signature: string;
  /** Accessible name (aria-label, aria-labelledby, label[for], wrapping label, placeholder, nearby text). */
  label: string;
  kind: FieldKind;
  inputType?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  /** Options for select and radio groups. A radio group is captured as ONE field. */
  options?: FieldOption[];
  required?: boolean;
  /** Capture saw a required marker beside the label: a trailing "*", "(required)", or a marker element named "required". */
  requiredMarker?: boolean;
  /** The field sits in a section whose legend marks every question in it required. */
  sectionRequired?: boolean;
  /**
   * Which form on the page this field belongs to, when capture can tell: the owning `<form>` (honouring a
   * `form=` attribute, so a sticky submit bar declared outside the form still belongs to it), or "-" for a
   * control that belongs to no form at all. Undefined means capture did not say, and the gate then assumes
   * the field could belong to any form -- the safe direction (shared/src/form/gate.ts).
   */
  formId?: string;
  value?: string;
  rect: Rect;
  /** Irreversible action (submit, send, pay, delete...). Needs explicit Enter or click, never Tab. */
  locked?: boolean;
  /** Short surrounding text (section heading, helper text) that may help disambiguate. */
  context?: string;
}

export interface PastAnswer {
  question: string;
  answer: string;
  origin?: string;
  savedAt?: string;
}

export interface Profile {
  facts: Record<string, string>;
  pastAnswers: PastAnswer[];
}

export const NEEDS_TEXT = "needs_text";
export const NONE = "none";

export interface FieldAssignment {
  signature: string;
  /** A profile fact key, NEEDS_TEXT for free-text fields, or NONE. */
  factKey: string;
  confidence: number;
}

export interface FormPredictRequest {
  origin: string;
  formSignature: string;
  fields: CapturedField[];
  factKeys: string[];
}

export interface FormPredictResponse {
  assignments: FieldAssignment[];
  provider: string;
  /** False for providers whose confidence is not calibrated (OpenAI-style adapters). */
  calibrated: boolean;
  latencyMs: number;
}

export type GhostAction = "fill" | "select" | "check" | "click";
export type GhostSource = "offline" | "server" | "cache" | "llm" | "loop";

/**
 * How sure a proposal is, and therefore how it is DRAWN (docs/always-propose.md). The confidence threshold
 * picks the tier; it never decides whether a ghost exists. Ghost always proposes something it can see.
 *
 * | tier        | drawn as                                                            |
 * | ----------- | ------------------------------------------------------------------- |
 * | confident   | today's look; hold-to-accept walks straight through it               |
 * | guess       | dotted underline plus a "guess" chip; hold-to-accept stops here      |
 * | long-shot   | the same, dimmed, with the reason in the HUD                         |
 */
export type GhostTier = "confident" | "guess" | "long-shot";

/** At or above this a proposal is an ordinary ghost: a fact, or an answer the user confirmed twice. */
export const CONFIDENT_TIER = 0.85;

/**
 * The tier a proposal is drawn at. Below the user's threshold it is a long-shot, never nothing: raising the
 * threshold dims proposals rather than silencing them. `guessed` forces at least the "guess" tier for an
 * answer the engine inferred rather than knew, however confident the number looks.
 */
export function ghostTier(confidence: number, threshold: number, guessed = false): GhostTier {
  if (confidence < threshold) return "long-shot";
  if (guessed || confidence < CONFIDENT_TIER) return "guess";
  return "confident";
}

/**
 * The complete list of reasons a control gets NO ghost (docs/always-propose.md). Nothing else may drop a
 * proposal: being unsure is a reason to draw a guess, never a reason to show nothing. Grep for `SkipReason`
 * to find every place a proposal is allowed to disappear.
 */
export type SkipReason =
  /** Password, payment card or government ID: never captured, never proposed, never filled. */
  | "sensitive"
  /** The field already carries a value (or a ticked box). Ghost never overwrites what is there. */
  | "already-answered"
  /** Nothing to propose with: no fact, no learned answer, no option to pick, no draft, no control. */
  | "no-candidate"
  /** Ghost is switched off or paused for this page or app. */
  | "paused";

/** A named refusal to propose. The type makes every silent `return null` impossible to write by accident. */
export interface GhostSkip {
  readonly skip: SkipReason;
}

/** One step of the fallback chain: a proposal, a named skip, or null meaning "try the next fallback". */
export type GhostStep = Ghost | GhostSkip | null;

export function skipGhost(reason: SkipReason): GhostSkip {
  return { skip: reason };
}

/** Generic in the proposal type, so the desktop's own `DesktopGhost` union narrows through it too. */
export function isSkip<T extends object>(step: T | GhostSkip | null): step is GhostSkip {
  return step !== null && "skip" in step;
}

/**
 * What a question is, as far as Ghost is allowed to answer it (docs/answers.md section 1). Structurally the
 * same union as `QuestionClass` in ./answers/classify; spelled here so `Ghost` does not depend on that module.
 */
export type AnswerClass = "ordinary" | "protected" | "declaration";

/** One precomputed suggestion. Tab walks these in memory. */
export interface Ghost {
  signature: string;
  action: GhostAction;
  /** Value to write (fill), option value (select/radio), "true"/"false" (check). Unused for click. */
  value?: string;
  /** Text rendered as gray ghost text. */
  displayText: string;
  confidence: number;
  locked: boolean;
  source: GhostSource;
  /** True while free text is still streaming in. */
  pending?: boolean;
  /**
   * How this one is drawn (docs/always-propose.md). Absent means "confident": the ordinary look. Every
   * ghost the planner builds carries one, so the threshold styles a proposal instead of deleting it.
   */
  tier?: GhostTier;
  /**
   * Ghost inferred this rather than knowing it, or it came in under the threshold (docs/answers.md section 3
   * and docs/always-propose.md). A guess is drawn with a dotted underline and a "guess" chip, and hold-to-
   * accept always stops at the first one. Set for every tier other than "confident".
   */
  guess?: boolean;
  /** Why, in words the HUD can show for a long-shot. Never contains a value or a label. */
  reason?: string;
  /** Set when the answer engine produced this ghost: drives the "check this" badge on a declaration. */
  answerClass?: AnswerClass;
  /** Where the answer engine got it. Only ever a counter name, never reported with a label or a value. */
  answerSource?: "fact" | "learned" | "guess";
}

export interface GhostSettings {
  enabled: boolean;
  /**
   * Where the "confident" look ends and a guess begins (docs/always-propose.md). It changes HOW a proposal
   * is drawn, never WHETHER it exists: below it a proposal becomes a dimmed long-shot that hold-to-accept
   * stops at, and it is still one key to take and one key to ignore.
   */
  confidenceThreshold: number;
  serverUrl: string;
  showHud: boolean;
  learningEnabled: boolean;
  /**
   * Answer a protected question (gender, race, veteran or disability status...) with the form's OWN
   * "prefer not to answer" option. On by default (docs/answers.md section 1): declining is a true answer
   * for anyone and it completes the form. Ghost never invents a characteristic either way.
   */
  answerProtectedWithDecline: boolean;
}

export const DEFAULT_SETTINGS: GhostSettings = {
  enabled: true,
  confidenceThreshold: 0.7,
  serverUrl: "http://localhost:8787",
  showHud: true,
  learningEnabled: false,
  answerProtectedWithDecline: true,
};
