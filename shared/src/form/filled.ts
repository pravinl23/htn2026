// Does this field already hold an answer? Only what capture actually reports counts.
// Unknown means NOT filled: the gate's job is to never propose a step the page would reject,
// so an uncertain field withholds a terminal action instead of unlocking one.
import type { CapturedField, FieldOption } from "../types";

const CHECKED = /^(true|checked|on|yes|1)$/i;
/** Mirrors the placeholder filter in ../resolve.ts (matchOption): an option that asks you to pick is not an answer. */
const PLACEHOLDER_LABEL = /^(select|choose|please|--)/i;
/** A file input with nothing attached still reports chrome of its own. */
const NO_FILE = /^(no file (chosen|selected)|choose file|browse|upload|attach|drag|drop|aucun fichier)/i;

/** An option that stands for "nothing picked yet". */
export function isPlaceholderOption(option: FieldOption): boolean {
  return option.value === "" || PLACEHOLDER_LABEL.test(option.label.trim());
}

/** The same rule applied to a raw captured value ("Select...", "-- Choose one --"). */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  return v === "" || PLACEHOLDER_LABEL.test(v);
}

/** The value names one of the captured options (by value or by visible label), and that option is a real answer. */
function isChosenOption(field: CapturedField, value: string): boolean {
  const options = field.options;
  if (!options || options.length === 0) return true; // nothing to check against: a non-empty value is the only evidence
  const v = value.toLowerCase();
  return options.some((o) => !isPlaceholderOption(o) && (o.value.trim().toLowerCase() === v || o.label.trim().toLowerCase() === v));
}

export function isFilled(field: CapturedField): boolean {
  const value = (field.value ?? "").trim();
  switch (field.kind) {
    case "checkbox":
      return CHECKED.test(value);
    case "radio":
      // A radio group is captured as one field whose value is the checked option.
      return value !== "" && isChosenOption(field, value);
    case "select":
      return !isPlaceholderValue(value) && isChosenOption(field, value);
    case "file":
      return value !== "" && !NO_FILE.test(value);
    case "button":
    case "link":
      return false; // an action, not an answer
    case "other":
      // A custom widget (a react-select combobox, a date picker): the value it reports is the only evidence there is.
      return !isPlaceholderValue(value);
    default:
      return value !== "";
  }
}
