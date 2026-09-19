// Is this field required? Decided generically, from evidence both capture layers already collect.
// No site rules: the same reasoning has to work on Greenhouse, Lever, Ashby, Workday and a hand-written form.
import type { CapturedField } from "../types";

/**
 * Requiredness evidence a caller has but the captured field does not carry.
 * The extension and the desktop capture set `requiredMarker` / `sectionRequired` on the field itself;
 * callers that cannot extend the field (or that compute the section late) pass this instead.
 */
export interface RequiredEvidence {
  /** A required marker sits next to the label: a trailing "*", "(required)", or a marker element named "required". */
  requiredMarker?: boolean;
  /** The field's section or fieldset legend says every question in it is required. */
  sectionRequired?: boolean;
  /** Raw section legend / heading text, when the caller has it but has not interpreted it. */
  sectionText?: string;
}

/** Which piece of evidence made the field required, for the HUD and for debugging. */
export type RequiredSource = "flag" | "marker" | "label" | "section";

// A red asterisk is a marker whatever its colour; Ghost never reads colour.
const ASTERISK = "[*∗✱✳﹡＊]";
const TRAILING_ASTERISK = new RegExp(`${ASTERISK}\\s*$`, "u");
const LEADING_ASTERISK = new RegExp(`^\\s*${ASTERISK}\\s*\\S`, "u");
const STRIP_TRAILING = new RegExp(`\\s*${ASTERISK}+\\s*$`, "u");
const STRIP_LEADING = new RegExp(`^\\s*${ASTERISK}+\\s*`, "u");

const BRACKETED_REQUIRED = /[([{]\s*(required|required field|obligatoire|champ obligatoire)\s*[)\]}]/i;
const EXPLICIT_REQUIRED = /\b(this (field|question|answer) is required|required field|champs? obligatoire)\b/i;
// Only a marker-shaped trailing "required": the question "Is a visa required to work here?" is not a marker.
const SEPARATED_REQUIRED = /[-–—:·|,]\s*(required|obligatoire)\s*$/i;
const BARE_REQUIRED = /^(required|obligatoire)$/i;
const STRIP_BRACKETED = /\s*[([{]\s*(required|obligatoire)\s*[)\]}]\s*$/i;

const OPTIONAL_MARKER =
  /[([{]\s*(optional|facultatif|opcional|if applicable|not required)\s*[)\]}]|[-–—:·|,]\s*(optional|facultatif)\s*$|\boptional\s*$|^\s*optional\s*[:–—-]/i;

// "Fields marked with * are required" explains the marker; it does not make every field required.
const MARKER_LEGEND = /\b(marked|marqu|indicat|denot|asterisk|astérisque|starred|followed by)/i;
const ALL_REQUIRED_EN =
  /\b(all|every)\b[^.!?;]{0,40}?\b(fields?|questions?|answers?)\b[^.!?;]{0,40}?\b(are|is|must be)\s+(required|answered|completed|filled)/i;
const ALL_REQUIRED_FR = /\b(tous|toutes)\b[^.!?;]{0,40}?\bchamps?\b[^.!?;]{0,40}?\bobligatoires?\b/i;

/** A required marker in a label, a placeholder or a sibling marker's accessible name. */
export function hasRequiredMarker(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  return (
    TRAILING_ASTERISK.test(t) ||
    LEADING_ASTERISK.test(t) ||
    BRACKETED_REQUIRED.test(t) ||
    EXPLICIT_REQUIRED.test(t) ||
    SEPARATED_REQUIRED.test(t) ||
    BARE_REQUIRED.test(t)
  );
}

/** An explicit "(optional)" beside the label: it exempts the field from a section-wide required legend. */
export function hasOptionalMarker(text: string): boolean {
  const t = text.trim();
  return t !== "" && OPTIONAL_MARKER.test(t);
}

/** A legend that makes every question in its section required ("All fields are required"), not one that explains the asterisk. */
export function marksAllRequired(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  const beforeRequired = t.split(/\brequired\b|\bobligatoires?\b/i)[0] ?? t;
  if (MARKER_LEGEND.test(beforeRequired)) return false;
  return ALL_REQUIRED_EN.test(t) || ALL_REQUIRED_FR.test(t);
}

/** The evidence that makes this field required, or null when nothing does. */
export function requiredSource(field: CapturedField, evidence?: RequiredEvidence): RequiredSource | null {
  // The attribute (required / aria-required / AXRequired) is the page's own word and beats every heuristic.
  if (field.required === true) return "flag";
  // An explicit "(optional)" beats a marker the capture layer guessed at and any section-wide legend.
  if (hasOptionalMarker(field.label)) return null;
  if (evidence?.requiredMarker === true || field.requiredMarker === true) return "marker";
  if (hasRequiredMarker(field.label) || hasRequiredMarker(field.placeholder ?? "")) return "label";
  if (evidence?.sectionRequired === true || field.sectionRequired === true) return "section";
  if (marksAllRequired(evidence?.sectionText ?? "") || marksAllRequired(field.context ?? "")) return "section";
  return null;
}

export function isRequired(field: CapturedField, evidence?: RequiredEvidence): boolean {
  return requiredSource(field, evidence) !== null;
}

/** The label without its required marker, for the HUD ("Country", not "Country *"). */
export function displayLabel(field: CapturedField): string {
  const stripped = field.label
    .replace(STRIP_BRACKETED, "")
    .replace(STRIP_LEADING, "")
    .replace(STRIP_TRAILING, "")
    .trim();
  return stripped || field.label.trim() || field.signature;
}
