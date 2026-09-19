export interface SensitiveProbe {
  inputType?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  /** True when the element or an ancestor carries data-ghost-sensitive / data-sensitive. */
  markedSensitive?: boolean;
}

const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/i;

/** Exported as source so the background worker can inline the same rules into a page-side check. */
export const SENSITIVE_TEXT_SOURCE = [
  "passw(or)?d", "passcode", "\\bpwd\\b", "\\bpin\\b", "\\botp\\b", "one[- ]time code", "verification code", "2fa", "\\bmfa\\b",
  "authenticat(ion|or) code", "recovery (phrase|code|key)",
  "\\bssn\\b", "social security", "\\bsin\\b", "social insurance", "national (id|insurance)", "\\bnino\\b",
  "passport", "driver'?s? licen[cs]e", "licen[cs]e number", "tax(payer)? id", "\\btin\\b", "\\bitin\\b",
  "government id", "health (card|number)", "\\bohip\\b",
  "card ?(number|num\\b|no\\b|#)", "credit card", "debit card", "name on (the )?card", "card ?holder",
  "\\bcc ?(num|number|no|exp|name|csc|cvv|cvc)", "\\bcvv\\d?\\b", "\\bcvc\\d?\\b", "\\bcsc\\b", "security code",
  "expir(y|ation|es)", "\\bmm ?/ ?yy",
  "routing", "account number", "\\biban\\b", "\\bswift\\b", "bank account",
  "secret", "api[- _]?key", "private key", "seed phrase",
].join("|");

const SENSITIVE_TEXT = new RegExp(SENSITIVE_TEXT_SOURCE, "i");

/** "card_number" and "cardNumber" read as words, and "S.I.N." as "SIN". */
export function sensitiveProbeText(parts: Array<string | undefined>): string {
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b(\w)\./g, "$1");
}

/** Rule 3: never capture, predict, or fill these. When in doubt, treat as sensitive. */
export function isSensitive(p: SensitiveProbe): boolean {
  if (p.markedSensitive) return true;
  if ((p.inputType ?? "").toLowerCase() === "password") return true;
  const ac = (p.autocomplete ?? "").trim();
  if (ac && ac.split(/\s+/).some((tok) => SENSITIVE_AUTOCOMPLETE.test(tok))) return true;
  return SENSITIVE_TEXT.test(sensitiveProbeText([p.name, p.id, p.label, p.placeholder]));
}
