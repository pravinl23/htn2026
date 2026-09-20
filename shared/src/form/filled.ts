// Does this field already hold an answer? Only what capture actually reports counts.
// Unknown means NOT filled: the gate's job is to never propose a step the page would reject,
// so an uncertain field withholds a terminal action instead of unlocking one.
//
// Unknown is also not EMPTY, and the difference matters: the gate refuses to unlock Submit on an unknown
// field, but `reconcileAccepted` must never throw away the user's own accepted answer over one
// (a lazily-populated combobox reports no options at all, which is silence, not an empty control).
import type { CapturedField, FieldOption } from "../types";

const CHECKED = /^(true|checked|on|yes|1)$/i;
/**
 * A control that is still asking you to pick. The canonical list is the one in `../answers/signature.ts`
 * (`usableOptions`) plus the instruction form a custom widget shows in place of a value ("Click to select").
 * Leading whitespace is tolerated: a widget's reported value is rarely trimmed.
 */
const PLACEHOLDER_LABEL = /^\s*(?:--+|(?:select|choose|please|pick|(?:click|tap) to (?:select|choose|pick))\b)/i;
/** A file input with nothing attached still reports chrome of its own. */
const NO_FILE = /^(no file (chosen|selected)|choose file|browse|upload|attach|drag|drop|aucun fichier)/i;

/** What capture can actually tell us about a field: it holds an answer, it holds none, or it did not say. */
export type FilledState = "filled" | "empty" | "unknown";

/** An option that stands for "nothing picked yet". */
export function isPlaceholderOption(option: FieldOption): boolean {
  return option.value === "" || PLACEHOLDER_LABEL.test(option.label.trim());
}

/** The same rule applied to a raw captured value ("Select...", "-- Choose one --", "Click to select"). */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  return v === "" || PLACEHOLDER_LABEL.test(v);
}

/** The value names one of the captured options (by value or by visible label), and that option is a real answer. */
function chosenOption(field: CapturedField, value: string): FilledState {
  const options = field.options;
  // No option list at all is silence, not evidence: a lazily-populated select captures this way before it opens.
  if (!options || options.length === 0) return "unknown";
  const v = value.toLowerCase();
  const hit = options.some((o) => !isPlaceholderOption(o) && (o.value.trim().toLowerCase() === v || o.label.trim().toLowerCase() === v));
  return hit ? "filled" : "empty";
}

/**
 * Everything the gate and the accepted-set reconciliation are allowed to know about a field.
 * Never guesses in the page's favour: what capture did not report reads as "unknown".
 */
export function filledState(field: CapturedField): FilledState {
  const value = (field.value ?? "").trim();
  switch (field.kind) {
    case "checkbox":
      return CHECKED.test(value) ? "filled" : "empty";
    case "radio":
      // A radio group is captured as one field whose value is the checked option.
      if (isPlaceholderValue(value)) return "empty";
      return chosenOption(field, value);
    case "select":
      if (isPlaceholderValue(value)) return "empty";
      return chosenOption(field, value);
    case "file":
      return value !== "" && !NO_FILE.test(value) ? "filled" : "empty";
    case "button":
    case "link":
      return "empty"; // an action, not an answer
    case "other":
      // A custom widget (a react-select combobox, a date picker): the value it reports is the only evidence there is.
      return isPlaceholderValue(value) ? "empty" : "filled";
    default:
      return value === "" ? "empty" : "filled";
  }
}

export function isFilled(field: CapturedField): boolean {
  return filledState(field) === "filled";
}

/** Only a control capture positively reports as holding nothing. "Unknown" is never empty. */
export function isDefinitelyEmpty(field: CapturedField): boolean {
  return filledState(field) === "empty";
}
