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
}

export interface GhostSettings {
  enabled: boolean;
  confidenceThreshold: number;
  serverUrl: string;
  showHud: boolean;
  learningEnabled: boolean;
}

export const DEFAULT_SETTINGS: GhostSettings = {
  enabled: true,
  confidenceThreshold: 0.7,
  serverUrl: "http://localhost:8787",
  showHud: true,
  learningEnabled: false,
};
