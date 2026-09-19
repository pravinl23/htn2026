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

const SENSITIVE_TEXT = new RegExp(
  [
    "passw(or)?d", "passcode", "\\bpin\\b", "\\botp\\b", "one[- ]time code", "verification code", "2fa",
    "\\bssn\\b", "social security", "\\bsin\\b", "social insurance", "national (id|insurance)", "\\bnino\\b",
    "passport", "driver'?s? licen[cs]e", "licen[cs]e number", "tax(payer)? id", "\\btin\\b", "\\bitin\\b",
    "government id", "health card",
    "card ?number", "credit card", "debit card", "\\bcvv\\b", "\\bcvc\\b", "security code", "card expir",
    "routing", "account number", "\\biban\\b", "\\bswift\\b", "bank account",
    "secret", "api[- _]?key", "private key", "seed phrase",
  ].join("|"),
  "i",
);

/** Rule 3: never capture, predict, or fill these. When in doubt, treat as sensitive. */
export function isSensitive(p: SensitiveProbe): boolean {
  if (p.markedSensitive) return true;
  if ((p.inputType ?? "").toLowerCase() === "password") return true;
  const ac = (p.autocomplete ?? "").trim();
  if (ac && ac.split(/\s+/).some((tok) => SENSITIVE_AUTOCOMPLETE.test(tok))) return true;
  const text = [p.name, p.id, p.label, p.placeholder].filter(Boolean).join(" ").replace(/[_-]+/g, " ");
  return SENSITIVE_TEXT.test(text);
}
