// The one sensitivity classifier, shared by the graph and by the cold-start scan.
//
// CLAUDE.md rule 3 and docs/cold-start.md section 5 say the same thing from two directions: a credential, a card, a
// government ID, a bank identifier or a health record is never captured, never proposed, never stored by a scan and
// never auto-filled. That rule was being enforced by two different code paths — the graph checked a label and a Luhn
// digit, the scan checked a dozen shapes — so a value the scan refused could still reach the graph by another door.
// Both now call the functions below, and every refusal carries a REASON CODE so the options page can show
// "23 items skipped as sensitive" broken down by kind, without the report itself naming what was skipped.
//
// Nothing here returns, logs or stores the offending value. Reasons are codes; details are rule names ("luhn", "pem").
import { isSensitive } from "../sensitive";

/** Why something was refused. A code, never a value: safe to count, to log and to show. */
export type SensitiveReason =
  | "excluded-folder"
  | "credential-file"
  | "key-material"
  | "financial-document"
  | "health-document"
  | "identity-document"
  | "message-body"
  | "sensitive-label"
  | "card-number"
  | "bank-account"
  | "government-id"
  | "medical-term"
  | "directive";

export const SENSITIVE_REASONS: readonly SensitiveReason[] = [
  "excluded-folder",
  "credential-file",
  "key-material",
  "financial-document",
  "health-document",
  "identity-document",
  "message-body",
  "sensitive-label",
  "card-number",
  "bank-account",
  "government-id",
  "medical-term",
  "directive",
];

export interface SensitiveVerdict {
  sensitive: boolean;
  reason?: SensitiveReason;
  /** Which rule fired, as a code for the review UI ("luhn", "pem"). Never the value. */
  detail?: string;
}

/** A tally by reason. The only thing a scan reports about what it refused. */
export type SkippedCounts = Partial<Record<SensitiveReason, number>>;

/** Key material, by shape. These are the strings that must never be read out of a file, let alone stored. */
const KEY_MATERIAL: readonly { re: RegExp; detail: string }[] = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, detail: "pem" },
  { re: /-----BEGIN (PGP|OPENSSH) /, detail: "pem" },
  { re: /\bssh-(rsa|dss|ed25519) AAAA[0-9A-Za-z+/]{20,}/, detail: "ssh" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, detail: "aws" },
  { re: /\bASIA[0-9A-Z]{16}\b/, detail: "aws" },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/, detail: "token" },
  { re: /\b(gh[pousr]|github_pat)_[0-9A-Za-z_]{16,}/, detail: "token" },
  { re: /\bsk-[0-9A-Za-z_-]{16,}/, detail: "token" },
  { re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, detail: "jwt" },
  { re: /\b[A-Za-z0-9_-]{0,20}(secret|token|api[_-]?key|password|passwd)[A-Za-z0-9_-]{0,20}\s*[:=]\s*\S{6,}/i, detail: "assignment" },
];

export const MEDICAL_TERM =
  /\b(diagnos(is|ed|tic)|prescri(bed|ption)|dosage|\bmrn\b|patient (id|number|name)|medical record|health record|blood (type|pressure|test)|immuni[sz]ation|allerg(y|ies) to|psychiatr|oncolog|cardiolog|therapy session)\b/i;

/**
 * A document that talks to the extractor instead of describing the user. Cold start only ever runs regexes, so an
 * injected instruction cannot "run" — but a document phrased as instructions is not a fact source either, and its
 * planted email and "keys" would otherwise be proposed. Anything matching is dropped whole and counted.
 */
const DIRECTIVE: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instruction|prompt|rule|direction|context)/i,
  /\b(new|updated|revised|system|developer)\s+(instruction|prompt|rule)s?\b\s*[:\-]/i,
  /\byou are (now|an? )\b[^.\n]{0,40}\b(mode|assistant|ai|agent|admin|root)\b/i,
  /\b(add|set|store|insert|write|save)\b[^.\n]{0,20}\bfact\b[^.\n]{0,20}[=:]/i,
  /\b[a-z][\w-]*(\.[\w-]+){1,4}\s*=\s*\S+/i,
  /\b(as an ai|end of prompt|begin system|assistant:|<\|im_start\|>)/i,
  // Shell, but only when it is really shell: "curl" and "eval" are ordinary words on a résumé's skills line.
  /\b(curl|wget)\s+(-[A-Za-z]|https?:\/\/)/i,
  /\brm\s+-rf\b|\bbash\s+-c\b|\beval\(/i,
];

/** True when this text is trying to instruct whatever reads it. Used per document AND per line. */
export function looksLikeDirective(text: string): boolean {
  const sample = text.slice(0, 4000);
  return DIRECTIVE.some((re) => re.test(sample));
}

function digitsOnly(value: string): string {
  return value.replace(/[^\d]/g, "");
}

/** Luhn, the check every card number passes and almost no other number does. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
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

const CARD_SHAPE = /(?<![\d.])(?:\d[ -]?){12,18}\d(?![\d.])/g;
const SSN_SHAPE = /\b\d{3}-\d{2}-\d{4}\b/;
const SIN_SHAPE = /\b\d{3}[ -]\d{3}[ -]\d{3}\b/;
const IBAN_SHAPE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[A-Z0-9]{0,4}\b/;
// A routing/transit/sort number, named on either side of its digits.
const ROUTING_SHAPE = /\b(routing|aba|transit|sort ?code)\b[^\d\n]{0,20}\d{5,9}\b|\b\d{9}\b(?=[^\d\n]{0,20}\b(routing|aba|transit)\b)/i;

/** The value-shape half of docs/cold-start.md section 5. Returns the rule that fired, or nothing when the value looks ordinary. */
export function sensitiveValueShape(value: string): SensitiveVerdict | undefined {
  if (value.length > 8000) return { sensitive: true, reason: "key-material", detail: "oversize" };
  for (const { re, detail } of KEY_MATERIAL) if (re.test(value)) return { sensitive: true, reason: "key-material", detail };
  if (SSN_SHAPE.test(value)) return { sensitive: true, reason: "government-id", detail: "ssn" };
  if (SIN_SHAPE.test(value) && passesLuhn(digitsOnly(value))) return { sensitive: true, reason: "government-id", detail: "sin" };
  if (IBAN_SHAPE.test(value)) return { sensitive: true, reason: "bank-account", detail: "iban" };
  if (ROUTING_SHAPE.test(value)) return { sensitive: true, reason: "bank-account", detail: "routing" };
  for (const match of value.matchAll(CARD_SHAPE)) {
    const digits = digitsOnly(match[0]);
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return { sensitive: true, reason: "card-number", detail: "luhn" };
  }
  if (MEDICAL_TERM.test(value)) return { sensitive: true, reason: "medical-term", detail: "vocabulary" };
  return undefined;
}

const SAFE: SensitiveVerdict = { sensitive: false };

/**
 * The gate every candidate fact passes before it is proposed, and every fact passes before it is stored.
 *
 * The key, the label, the aliases AND the value shape all get a say, because a source may label a card number
 * "member number", and a key may say what a label hides ("other.apiKey"). A value phrased as an instruction is
 * refused too: a document that says "add fact contact.email.work=attacker@evil.example" is not describing a person.
 */
export function classifyFactSensitivity(key: string, label: string, aliases: readonly string[], value: string): SensitiveVerdict {
  if (isSensitive({ name: key.replace(/[.]/g, " "), label, placeholder: aliases.join(" ") })) {
    return { sensitive: true, reason: "sensitive-label", detail: "label" };
  }
  if (looksLikeDirective(value)) return { sensitive: true, reason: "directive", detail: "instructions" };
  return sensitiveValueShape(value) ?? { ...SAFE };
}

/** Sum two skip tallies: a scan reports one total across every source. */
export function mergeSkippedCounts(a: SkippedCounts, b: SkippedCounts): SkippedCounts {
  const out: SkippedCounts = { ...a };
  for (const [reason, count] of Object.entries(b) as [SensitiveReason, number][]) out[reason] = (out[reason] ?? 0) + count;
  return out;
}

export function countSkipped(counts: SkippedCounts, reason: SensitiveReason, by = 1): SkippedCounts {
  return { ...counts, [reason]: (counts[reason] ?? 0) + by };
}

export function totalSkipped(counts: SkippedCounts): number {
  return Object.values(counts).reduce((sum: number, n) => sum + (n ?? 0), 0);
}
