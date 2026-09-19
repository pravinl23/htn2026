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

const NUMBER = "(number|num\\b|no\\b|#|code)";
const SCHOOL_WORDS = "\\b(graduat|education|degree|school|universit|college)";
// "MM/YY" is how cards write an expiry. "MM/YYYY" is too, except next to education words: "Expected graduation (MM/YYYY)".
const CARD_DATE_HINT = `\\bmm ?/ ?yy(?!yy)|(?<!${SCHOOL_WORDS}.{0,60})\\bmm ?/ ?yyyy(?!.{0,80}${SCHOOL_WORDS})`;
// The bank code, not the programming language ("Swift experience", "SwiftUI").
const SWIFT_CODE = "(?<!\\b(with|in|using|know|of) )\\bswift\\b(?! ?(ui\\b|experience|develop|program|language|skill|engineer))";

/** Exported as source so the background worker can inline the same rules into a page-side check. */
export const SENSITIVE_TEXT_SOURCE = [
  "passw(or)?d", "passcode", "\\bpwd\\b", "\\bpin\\b", "\\bpin ?(code|number)", "\\botp\\b", "one[- ]time code", "verification code", "2fa", "\\bmfa\\b",
  "authenticat(ion|or) code", "recovery (phrase|code|key)",
  "security (question|answer|word|phrase)", "challenge (question|answer)", "memorable (word|information|place|date|name)", "maiden name",
  "date of birth", "\\bbirth ?(date|day|year)", "(day|month|year) of birth", "\\bdob\\b",
  "\\bssn\\b", "social security", "\\bsin\\b", "social insurance", "national (id|identity|identification|insurance|registration)", "\\bnino\\b",
  "identity (card|number|document)", "aadha?ar", "\\bnric\\b", "\\bcpf\\b", "\\btfn\\b", "tax file", `\\bnhs ?${NUMBER}`, `medicare ?${NUMBER}`, `\\bpan ?(card|${NUMBER})`,
  "passport", "driver'?s? licen[cs]e", "licen[cs]e number", "tax(payer)? id", "\\btin\\b", "\\bitin\\b",
  "government id", "health (card|number)", "\\bohip\\b",
  "card ?(number|num\\b|no\\b|#)", "credit card", "debit card", "name on (the )?card", "card ?holder",
  "\\bcc ?(num|number|no|exp|name|csc|cvv|cvc)", "cvv\\d?\\b", "cvc\\d?\\b", "\\bcsc\\b", "\\bcvn\\b", "\\bcvd\\b", "security (code|number)",
  "card (verification|security|validation)", "verification (value|number)",
  "expir(y|ation|es)", "\\bexp ?(date|month|year)", "valid (thru|through|until)", "good (thru|through)", CARD_DATE_HINT,
  "routing", "account number", "\\biban\\b", SWIFT_CODE, "\\bbic\\b", "bank account", `\\bbank(ing)? ?(acct|${NUMBER}|details|info)`,
  `\\bbranch ?${NUMBER}`, `\\btransit ?${NUMBER}`, `\\binstitution ?${NUMBER}`, "sort ?code", "\\bbsb\\b", "\\bifsc\\b", "\\bclabe\\b",
  "\\bsecrets?\\b", "api[- _]?key", "private key", "seed phrase",
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
