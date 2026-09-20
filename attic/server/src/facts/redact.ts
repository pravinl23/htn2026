import { isSensitive } from "@ghost/shared";

/**
 * Rule 3 of CLAUDE.md, applied before anything else looks at a document: a government ID, a card, a
 * credential or a health number is never extracted, so it is removed from the text BEFORE a code
 * extractor reads it and long before a prompt is built. Nothing sensitive ever reaches a model.
 *
 * Two passes, both blunt on purpose:
 *   1. A line that a person would read as sensitive ("SIN: ...", "Password ...", "Date of birth ...")
 *      goes whole, because the value is usually on the same line as the word.
 *   2. Card-shaped and ID-shaped runs of digits go wherever they appear, even on a line that says nothing.
 * Both are counted. The counts are the only thing that is ever logged or returned.
 */

export interface Redaction {
  /** The document with sensitive lines and values removed. */
  text: string;
  /** How many lines and values were removed. A count, never a value. */
  dropped: number;
}

/** 13 to 19 digits, written the way a card is (groups separated by spaces or hyphens). */
const CARD_LIKE = /\b(?:\d[ -]?){12,18}\d\b/g;
/** SSN (3-2-4) and SIN (3-3-3). A North American phone number is 3-3-4, so it does not match. */
const ID_LIKE = /\b\d{3}[ -]\d{2}[ -]\d{4}\b|\b\d{3}[ -]\d{3}[ -]\d{3}\b/g;
/** IBAN: two letters, two check digits, then 11 to 30 alphanumerics. */
const IBAN_LIKE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

const REMOVED = "[removed]";

/** Mirrors the card check in `shared/src/facts/graph.ts`: a card number's digits satisfy Luhn, a phone number's do not. */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function scrub(line: string): { line: string; dropped: number } {
  let dropped = 0;
  const replaced = line
    .replace(CARD_LIKE, (match) => {
      const digits = match.replace(/[ -]/g, "");
      if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return match;
      dropped++;
      return REMOVED;
    })
    .replace(ID_LIKE, () => {
      dropped++;
      return REMOVED;
    })
    .replace(IBAN_LIKE, () => {
      dropped++;
      return REMOVED;
    });
  return { line: replaced, dropped };
}

export function redactSensitive(text: string): Redaction {
  let dropped = 0;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      kept.push(line);
      continue;
    }
    // The line names something Ghost must never keep (password, SSN, card, health number, date of birth...).
    if (isSensitive({ label: line })) {
      dropped++;
      continue;
    }
    const scrubbed = scrub(line);
    dropped += scrubbed.dropped;
    kept.push(scrubbed.line);
  }
  return { text: kept.join("\n"), dropped };
}
