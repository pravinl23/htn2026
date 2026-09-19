import { NEEDS_TEXT, NONE, type CapturedField, type FieldAssignment } from "./types";

interface Rule {
  key: string;
  pattern: RegExp;
  confidence: number;
}

const AUTOCOMPLETE_TO_FACT: Record<string, string> = {
  "given-name": "firstName",
  "family-name": "lastName",
  name: "fullName",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "address-level2": "city",
  "address-level1": "province",
  country: "country",
  "country-name": "country",
};

// Order matters: more specific rules first.
const RULES: Rule[] = [
  { key: "linkedin", pattern: /linked ?in/, confidence: 0.97 },
  { key: "github", pattern: /git ?hub/, confidence: 0.97 },
  { key: "requiresSponsorship", pattern: /sponsor/, confidence: 0.92 },
  {
    key: "workAuthorization",
    pattern: /authori[sz]ed to work|work authori[sz]ation|legally (able|authori[sz]ed|entitled|eligible|permitted)|eligible to work|right to work|work permit/,
    confidence: 0.92,
  },
  { key: "referralSource", pattern: /how did you (hear|find|learn)|where did you (hear|find)|referral source|heard about/, confidence: 0.85 },
  { key: "firstName", pattern: /first name|given name|\bfname\b|forename|\bfirst\b/, confidence: 0.95 },
  { key: "lastName", pattern: /last name|family name|surname|\blname\b|\blast\b/, confidence: 0.95 },
  { key: "fullName", pattern: /full name|legal name|your name|^name$|^name\b/, confidence: 0.9 },
  { key: "email", pattern: /e ?mail/, confidence: 0.95 },
  { key: "phone", pattern: /phone|mobile|telephone|\bcell\b|\btel\b/, confidence: 0.95 },
  { key: "website", pattern: /portfolio|website|personal (site|url|page)|homepage|\bblog\b|\burl\b/, confidence: 0.88 },
  { key: "graduationDate", pattern: /graduat|grad date|grad year|completion date/, confidence: 0.9 },
  { key: "school", pattern: /school|university|college|institution|alma mater/, confidence: 0.9 },
  { key: "degree", pattern: /degree|program(me)? of study|\bprogram(me)?\b|qualification/, confidence: 0.88 },
  { key: "major", pattern: /\bmajor\b|field of study|discipline|concentration|area of study/, confidence: 0.88 },
  { key: "location", pattern: /location|where are you (based|located)|city and (state|province)/, confidence: 0.85 },
  { key: "country", pattern: /country/, confidence: 0.9 },
  { key: "province", pattern: /province|\bstate\b|region/, confidence: 0.85 },
  { key: "city", pattern: /\bcity\b|\btown\b/, confidence: 0.85 },
];

// Labels about someone or something other than the applicant.
const OTHER_PARTY = /reference|referee|emergency|manager|supervisor|recruiter|parent|guardian|spouse|partner|company|employer|organi[sz]ation name|friend/;
const FREE_TEXT_PROMPT = /\bwhy\b|tell us|describe|explain|cover letter|anything else|what (makes|interests|excites)|about (yourself|a project|a time)|share (a|an|your)|\?$/;
const CONSENT = /agree|consent|terms|privacy|acknowledge|certify|subscribe|newsletter|marketing/;

export function normalize(text: string | undefined): string {
  return (text ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_\-./:*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function assignment(field: CapturedField, factKey: string, confidence: number): FieldAssignment {
  return { signature: field.signature, factKey, confidence };
}

/** Deterministic label-keyword mapping. Used by the server heuristic provider and the offline fallback. */
export function mapFieldToFact(field: CapturedField, factKeys: string[]): FieldAssignment {
  if (field.kind === "button" || field.kind === "link" || field.kind === "file" || field.kind === "other") {
    return assignment(field, NONE, 0.99);
  }
  const label = normalize(field.label);
  const hints = normalize([field.name, field.id, field.placeholder].filter(Boolean).join(" "));
  if (field.kind === "checkbox" && CONSENT.test(label)) return assignment(field, NONE, 0.99);

  const has = (key: string) => factKeys.includes(key);
  const otherParty = OTHER_PARTY.test(label);

  const acTokens = (field.autocomplete ?? "").toLowerCase().split(/\s+/);
  for (const tok of acTokens) {
    const key = AUTOCOMPLETE_TO_FACT[tok];
    if (key && has(key) && !otherParty) return assignment(field, key, 0.97);
  }

  if (field.kind === "textarea") return assignment(field, NEEDS_TEXT, FREE_TEXT_PROMPT.test(label) ? 0.92 : 0.8);

  for (const source of [label, hints]) {
    if (!source) continue;
    for (const rule of RULES) {
      if (!has(rule.key) || !rule.pattern.test(source)) continue;
      let confidence = source === label ? rule.confidence : rule.confidence - 0.08;
      if (otherParty) confidence *= 0.5;
      return assignment(field, rule.key, confidence);
    }
  }

  if (!otherParty) {
    if (field.kind === "email" && has("email")) return assignment(field, "email", 0.85);
    if (field.kind === "tel" && has("phone")) return assignment(field, "phone", 0.85);
  }
  if (field.kind === "text" && FREE_TEXT_PROMPT.test(label) && label.length > 20) {
    return assignment(field, NEEDS_TEXT, 0.75);
  }
  return assignment(field, NONE, 0.6);
}

export function mapFormHeuristically(fields: CapturedField[], factKeys: string[]): FieldAssignment[] {
  return fields.map((f) => mapFieldToFact(f, factKeys));
}
