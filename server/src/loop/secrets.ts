/**
 * Text that has the SHAPE of a government ID or a payment card, whatever the field or the label next to it is called.
 * CLAUDE.md rule 3: such a value is never captured, predicted or filled, and it never reaches a model prompt.
 */

/** SSN (3-2-4), SIN (3-3-3) and any 13 to 19 digit run. Broad on purpose: a false positive only hides one value from the model. */
const SECRET_SHAPED = /\b\d{3}[- ]\d{2}[- ]\d{4}\b|\b\d{3}[- ]\d{3}[- ]\d{3}\b|\b(?:\d[ -]?){13,19}\b/;

const SSN = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/;
const SIN = /\b\d{3}[- ]\d{3}[- ]\d{3}\b/g;
const LONG_DIGIT_RUN = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Luhn checksum, the check digit scheme of payment cards and of the Canadian SIN. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function someLuhn(text: string, pattern: RegExp): boolean {
  return (text.match(pattern) ?? []).some((run) => passesLuhn(run.replace(/\D/g, "")));
}

/** Broad test used in front of a model prompt (typed values and page text alike). */
export function looksSecret(text: string): boolean {
  return SECRET_SHAPED.test(text);
}

/**
 * Narrow test used before ANY code reads a page fact (the heuristic included): an SSN shape, or a SIN / 13 to 19 digit
 * run whose check digit is valid. An order or tracking number of the same length almost never passes the checksum.
 */
export function isIdOrCardNumber(text: string): boolean {
  return SSN.test(text) || someLuhn(text, SIN) || someLuhn(text, LONG_DIGIT_RUN);
}
