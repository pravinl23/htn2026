// What Shabang proposes for a question, and what it learns when the user corrects it. See docs/answers.md 1-4 and 6.
//
// Three promises, in this order of priority:
//   1. Never invent a protected characteristic, and never sign a legal declaration the profile does not support.
//   2. Never give up on an ordinary question: a wrong guess costs one correction, and the correction is kept.
//   3. Never hide that a guess is a guess: `source: "guess"` renders dotted, stops hold-Tab, and asks to be checked.
import { mapFieldToFact } from "../heuristic";
import { matchOption, resolveFieldValue } from "../resolve";
import { NEEDS_TEXT, NONE, type CapturedField, type FieldOption, type GhostAction, type Profile } from "../types";
import {
  classifyQuestion,
  isAnswerableKind,
  isDeclineOption,
  matchCountry,
  probeText,
  type Classification,
  type QuestionClass,
  type QuestionField,
  type QuestionTopic,
} from "./classify";
import { questionSignature, usableOptions, type SignatureOptions } from "./signature";
import { fieldLooksSensitive, learnedConfidence, type LearnResult, type LearnedAnswer, type LearnedAnswerStore } from "./store";

/** Where a proposal came from. "none" means Shabang deliberately proposes nothing. */
export type AnswerSource = "fact" | "learned" | "guess" | "none";

/** A fact answers it outright. */
export const FACT_CONFIDENCE = 0.95;
/** The profile states the fact for its own country and the question asks about that country. */
export const OWN_COUNTRY_FACT_CONFIDENCE = 0.85;
/** The form's own "prefer not to answer" option, proposed only when the user turned that setting on. */
export const DECLINE_CONFIDENCE = 0.8;
/** The cap on anything Shabang guessed: always under a fact, always above the default threshold so it is visible. */
export const GUESS_CONFIDENCE = 0.72;
/** A legal declaration inferred rather than known: the most conservative answer, always flagged. */
export const DECLARATION_GUESS_CONFIDENCE = 0.7;
/**
 * The last rung of the ladder: a question that offers no neutral option and no conservative side, answered
 * with the least specific thing it offers. Below the default threshold on purpose, so it is drawn as a
 * dimmed long shot with its reason showing (docs/always-propose.md) -- and still one key to take or ignore.
 */
export const LONG_SHOT_CONFIDENCE = 0.6;

export interface AnswerSettings {
  /**
   * Answer protected questions with the form's OWN "prefer not to answer" option. ON by default, which is what
   * `DEFAULT_SETTINGS` ships and what docs/answers.md section 1 describes: declining is a true answer for
   * anyone, it completes the form, and one correction turns it into a disclosure if the user wants one.
   * Turning it off leaves every protected question to the user. Shabang never invents a characteristic either way.
   */
  answerProtectedWithDecline?: boolean;
}

export interface AnswerContext {
  profile: Profile;
  /** Answers the user gave before, keyed by question signature. */
  answers?: LearnedAnswerStore | null;
  settings?: AnswerSettings;
  /** A fact key the server (or the caller) already assigned to this field; NONE and NEEDS_TEXT are honoured. */
  factKey?: string;
  /** The company, when the client knows it: stripped from the signature so an answer carries to the next site. */
  company?: string;
}

export interface AnswerProposal {
  /** What to write, select or check. "" when `source` is "none". */
  value: string;
  /** For choice fields: the visible option text, so the HUD and a later site can match it. */
  optionLabel?: string;
  confidence: number;
  source: AnswerSource;
  class: QuestionClass;
  /** Why, in words the HUD can show. Never contains a value or a label. */
  reason: string;
  /** The key a correction to this question is learned under. */
  signature: string;
  action?: GhostAction;
  topic?: QuestionTopic;
  country?: string;
  /** The profile fact used, NEEDS_TEXT when the draft path should answer, absent otherwise. */
  factKey?: string;
  /** Hold-Tab stops here and the HUD says "check this": every guess, and every attestation. */
  needsReview: boolean;
}

/** Fact key bases for the topics a profile can legitimately state. Country-qualified for the declarations. */
const TOPIC_FACT_KEYS: Partial<Record<QuestionTopic, string>> = {
  workAuthorization: "workAuthorization",
  requiresSponsorship: "requiresSponsorship",
  immigrationStatus: "immigrationStatus",
  legalAge: "legalAge",
  criminalRecord: "criminalRecord",
  securityClearance: "securityClearance",
  gender: "gender",
  pronouns: "pronouns",
  ethnicity: "ethnicity",
  hispanicLatino: "hispanicLatino",
  veteranStatus: "veteranStatus",
  disabilityStatus: "disabilityStatus",
  religion: "religion",
  sexualOrientation: "sexualOrientation",
  maritalStatus: "maritalStatus",
};

/** Topics whose fact key is qualified by the country the question names (docs/answers.md section 2). */
const COUNTRY_QUALIFIED: ReadonlySet<QuestionTopic> = new Set<QuestionTopic>([
  "workAuthorization",
  "requiresSponsorship",
  "immigrationStatus",
  "legalAge",
]);

/**
 * The conservative answer to a declaration when the profile does not state one: always the side that claims
 * the LESS for the applicant, except where the answer is simply what is true for almost everyone and saying
 * otherwise would be the lie (legal age, no criminal record, no clearance).
 * `want` is about the SUBJECT of the question, before the label's own negation is applied.
 */
const DECLARATION_DEFAULTS: Partial<Record<QuestionTopic, { want: boolean; why: string }>> = {
  workAuthorization: { want: false, why: "the profile does not state authorization for this country" },
  requiresSponsorship: { want: true, why: "sponsorship needed rather than not, the answer that claims less" },
  legalAge: { want: true, why: "of legal working age, true for nearly every applicant" },
  criminalRecord: { want: false, why: "no record, true for nearly every applicant" },
  backgroundCheck: { want: true, why: "the routine consent this form asks of everyone" },
  certification: { want: true, why: "an attestation about what the applicant themselves provided" },
  securityClearance: { want: false, why: "the profile states no clearance" },
  exportControl: { want: false, why: "the profile states no export-control status" },
  nonCompete: { want: false, why: "the profile states no restrictive covenant" },
};

// Negations that flip the predicate ("...without sponsorship", "I have NOT been convicted"). "other than" and
// "except" are NOT here: "convicted of a crime other than a minor traffic violation" is not a negated question.
const NEGATED_QUESTION = /\bwithout\b|\bnot\b|\bunable\b|\bineligible\b|\bnever\b|\bno longer\b|\b(don|doesn|didn|haven|hasn|isn|aren|won|can) t\b/;

/**
 * A subordinate clause qualifies the noun in front of it, never the question's own predicate. In
 * "a felony THAT HAS NOT been expunged" the negation belongs to the expunging, and reading it as the
 * question's would answer "Yes, I have been convicted" -- a self-incriminating statement Shabang invented.
 * Only the head clause is read for negation.
 */
const SUBORDINATE_CLAUSE = /\b(?:that|which|who|whom|whose|where|when|unless|except|other than|apart from|aside from|besides)\b/;

/**
 * "without restriction" / "without limitation" qualify the SCOPE of an authorization; they do not negate it.
 * Reading them as a negation turns "authorized to work in the US without restriction" into "Yes" -- exactly the
 * flattering declaration docs/answers.md section 7 forbids. "without sponsorship" and "without a visa" DO negate
 * what is being asked about, so only the scope words are taken out.
 */
const SCOPE_QUALIFIER = /\bwithout\s+(?:any\s+)?(?:restriction|limitation|limit|condition|qualification|constraint|reservation|caveat|exception|further)s?\b/g;

/** The part of the label whose negation is the question's own. */
function headClause(label: string): string {
  return (label.split(SUBORDINATE_CLAUSE)[0] ?? label).replace(SCOPE_QUALIFIER, " ");
}

// "Do you require / need a work permit?" states the same thing as "are you authorized" the other way round.
const ASKS_WHAT_IS_NEEDED = /\b(require|requires|required|requiring|need|needs|needed|needing)\b/;
const INVERTS_ON_NEED: ReadonlySet<QuestionTopic> = new Set<QuestionTopic>(["workAuthorization", "immigrationStatus"]);

// An ordinary question the applicant answers about their own willingness. "Yes" commits nobody to a falsehood.
const WILLINGNESS =
  /\b(are|were) you (willing|able|open|comfortable|interested|available|happy|prepared)\b|\bwould you (be )?(willing|able|open|comfortable|interested|prepared|consider)\b|\bwilling to\b|\bopen to\b|\bcomfortable (with|working)\b|\bare you (ok|okay|fine) with\b|\bdo you (agree to|consent to)? ?(relocat|commut|travel|work on ?site|work in ?person)\w*\b|\bcan you (start|work|commit|attend|travel|commute|relocate)\b|\bavailable to (start|work|intern|travel)\b/;

// An option that states something legal rather than answering a question. Never picked as "the neutral one".
const DECLARATION_OPTION = /\bi (certify|agree|consent|authori[sz]e|acknowledge|declare|attest|understand)\b|\bunder penalt\w+\b/;

// Ranked neutral options for an ordinary question: "Other" answers the question, declining merely ends it.
const NEUTRAL_OPTIONS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^other\b|^something else\b|^not listed\b|^none of these apply\b/, 0],
  [/^none of the (above|below|these|listed)\b|^none$|^no other\b/, 1],
  [/^n a$|^not applicable\b|^does not apply\b/, 2],
  [/\bprefer not to\b|\bdecline to\b|\bdo not wish to\b|\bdon t wish to\b|\brather not say\b/, 3],
  [/^no preference\b|^unsure\b|^not sure\b|^i don t know\b|^undecided\b/, 4],
];

// Options that answer without narrowing anything down. Used only where a question offers no neutral option
// at all: the least specific thing it can be told is still an answer, and a visible guess costs one keystroke.
const BROAD_OPTION =
  /\btwo or more\b|\bmultiple\b|\bmixed\b|\bvarious\b|\bseveral\b|\bcombination\b|\bunspecified\b|\bunknown\b|\bnot specified\b|\bunsure\b|\bgeneral\b/;

const YES_VALUE = /^(true|yes|y|1|on|checked)$/i;
const NO_VALUE = /^(false|no|n|0|off|unchecked)$/i;
const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?$/;
const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0 };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** `resolveFieldValue` and `mapFieldToFact` want a captured field; a question carries everything they read. */
function asCapturedField(field: QuestionField): CapturedField {
  return { signature: "", rect: ZERO_RECT, ...field };
}

/** The country the profile itself is in, as an ISO-ish code, when it says. */
export function profileCountry(profile: Profile): string | undefined {
  return matchCountry(profile.facts["country"] ?? profile.facts["location"])?.code;
}

function factKeyFor(topic: QuestionTopic | undefined, country: string | undefined): string | undefined {
  if (!topic) return undefined;
  const base = TOPIC_FACT_KEYS[topic];
  if (!base) return undefined;
  return country && COUNTRY_QUALIFIED.has(topic) ? `${base}.${country}` : base;
}

interface FactHit {
  key: string;
  value: string;
  confidence: number;
  reason: string;
}

/**
 * The fact that answers a topic. A country-qualified key wins; the unqualified key is a fallback only when the
 * question names no country, or when it names the profile's OWN country (that is what the old key always meant).
 */
function topicFact(profile: Profile, topic: QuestionTopic, country: string | undefined): FactHit | null {
  const base = TOPIC_FACT_KEYS[topic];
  if (!base) return null;
  const qualified = factKeyFor(topic, country);
  if (qualified && qualified !== base) {
    const exact = profile.facts[qualified];
    if (exact) return { key: qualified, value: exact, confidence: FACT_CONFIDENCE, reason: `profile states ${topic} for this country` };
    const unqualified = profile.facts[base];
    if (unqualified && profileCountry(profile) === country) {
      return { key: base, value: unqualified, confidence: OWN_COUNTRY_FACT_CONFIDENCE, reason: `profile states ${topic} and lives in this country` };
    }
    return null;
  }
  const plain = profile.facts[base];
  if (plain) return { key: base, value: plain, confidence: FACT_CONFIDENCE, reason: `profile states ${topic}` };
  // The question names no country and the profile only states this topic for ONE, which is not an answer to it.
  // "Will you now or in the future require sponsorship?" is the commonest question on a US board and names
  // nowhere; answering it from `requiresSponsorship.CA` would put "No, I will not require sponsorship" on a US
  // form as a `fact` -- unflagged, above every threshold, and written by hold-Tab. docs/answers.md section 2
  // makes only the UNQUALIFIED key a fallback, and section 7 forbids the flattering side of a declaration.
  // So: no fact here. The conservative guess answers it, visibly, and one correction learns the real key.
  return null;
}

interface Expressed {
  action: GhostAction;
  value: string;
  optionLabel?: string;
  /** 1 for an exact match; below 1 when the option only roughly says it. */
  factor: number;
}

function expressChoice(options: FieldOption[], want: string): Expressed | null {
  const hit = matchOption(options, want);
  return hit ? { action: "select", value: hit.option.value, optionLabel: hit.option.label, factor: hit.score } : null;
}

function expressBoolean(field: QuestionField, yes: boolean): Expressed | null {
  const options = usableOptions(field.options);
  if (options.length > 0) return expressChoice(options, yes ? "yes" : "no");
  if (field.kind === "checkbox") return { action: "check", value: String(yes), factor: 1 };
  return null;
}

/** An answer the user gave before, said in this site's own words. Null when this field cannot carry it. */
function expressLearned(field: QuestionField, learned: LearnedAnswer): Expressed | null {
  const options = usableOptions(field.options);
  if (options.length > 0) {
    const byLabel = learned.optionLabel ? expressChoice(options, learned.optionLabel) : null;
    const matched = byLabel ?? expressChoice(options, learned.value);
    if (matched) return matched;
    // The user declined this question elsewhere. Declining is the same answer in anyone's wording.
    if (!isDeclineOption(learned.optionLabel ?? learned.value)) return null;
    const decline = declineOption(options);
    return decline ? { action: "select", value: decline.value, optionLabel: decline.label, factor: 1 } : null;
  }
  if (field.kind === "checkbox") {
    const value = learned.value.trim();
    if (YES_VALUE.test(value)) return { action: "check", value: "true", factor: 1 };
    if (NO_VALUE.test(value)) return { action: "check", value: "false", factor: 1 };
    return null;
  }
  if (field.kind === "date" || field.kind === "month") {
    const value = learned.value.trim();
    if (!ISO_DATE.test(value)) return null;
    return { action: "fill", value: field.kind === "month" ? value.slice(0, 7) : value, factor: 1 };
  }
  const resolved = resolveFieldValue(asCapturedField(field), "learnedAnswer", learned.value);
  return resolved ? { action: resolved.action, value: resolved.value, factor: resolved.confidenceFactor } : null;
}

/** The most neutral option this question offers, or null when every option is a claim about the applicant. */
export function neutralOption(options: readonly FieldOption[] | undefined): FieldOption | null {
  let best: { option: FieldOption; rank: number } | null = null;
  for (const option of usableOptions(options)) {
    const text = probeText(option.label);
    if (DECLARATION_OPTION.test(text)) continue;
    for (const [pattern, rank] of NEUTRAL_OPTIONS) {
      if (!pattern.test(text)) continue;
      if (!best || rank < best.rank) best = { option, rank };
      break;
    }
  }
  return best?.option ?? null;
}

/** The option that means "I am not answering this". The first answer Shabang gives to a protected question. */
export function declineOption(options: readonly FieldOption[] | undefined): FieldOption | null {
  return usableOptions(options).find((o) => isDeclineOption(o.label)) ?? null;
}

/**
 * The least specific option a question offers, for the rare question with no neutral option and no decline
 * (docs/answers.md section 1, docs/always-propose.md): a visible guess the user corrects in one keystroke
 * beats an empty field. Breadth wins ("Two or more races"); failing that the shortest label, which is the
 * one that qualifies itself the least. A declaration-style option is never picked: signing is the user's.
 */
export function leastSpecificOption(options: readonly FieldOption[] | undefined): FieldOption | null {
  let best: { option: FieldOption; rank: number; length: number } | null = null;
  for (const option of usableOptions(options)) {
    const text = probeText(option.label);
    if (DECLARATION_OPTION.test(text)) continue;
    const rank = BROAD_OPTION.test(text) ? 0 : 1;
    if (!best || rank < best.rank || (rank === best.rank && text.length < best.length)) {
      best = { option, rank, length: text.length };
    }
  }
  return best?.option ?? null;
}

/** The same proposal every long shot makes: pick `option`, say why, and ask to be checked. */
function longShot(skeleton: Skeleton, option: FieldOption, why: string): AnswerProposal {
  return proposal(
    skeleton,
    { action: "select", value: option.value, optionLabel: option.label, factor: 1 },
    "guess",
    LONG_SHOT_CONFIDENCE,
    why,
    { needsReview: true },
  );
}

function base(field: QuestionField, classification: Classification, signature: string): Omit<AnswerProposal, "value" | "confidence" | "source" | "reason" | "needsReview"> {
  const out: Omit<AnswerProposal, "value" | "confidence" | "source" | "reason" | "needsReview"> = {
    class: classification.class,
    signature,
  };
  if (classification.topic) out.topic = classification.topic;
  if (classification.country) out.country = classification.country;
  return out;
}

type Skeleton = ReturnType<typeof base>;

function nothing(skeleton: Skeleton, reason: string, factKey?: string): AnswerProposal {
  const out: AnswerProposal = { ...skeleton, value: "", confidence: 0, source: "none", reason, needsReview: false };
  if (factKey) out.factKey = factKey;
  return out;
}

/**
 * A fact or a learned answer said through an option that only roughly matches loses a tenth. A guess does not:
 * its confidence is already the floor the whole class is worth, and it must stay above the visibility threshold.
 * `matchOption` scores a yes/no answer 0.95, which is exact in meaning, not a rough match.
 */
function scaleConfidence(source: AnswerSource, confidence: number, factor: number): number {
  if (source === "guess") return round2(confidence);
  return round2(confidence * (factor >= 0.95 ? 1 : 0.9));
}

function proposal(skeleton: Skeleton, expressed: Expressed, source: AnswerSource, confidence: number, reason: string, extra: Partial<AnswerProposal> = {}): AnswerProposal {
  const out: AnswerProposal = {
    ...skeleton,
    value: expressed.value,
    confidence: scaleConfidence(source, confidence, expressed.factor),
    source,
    action: expressed.action,
    reason,
    needsReview: source === "guess",
    ...extra,
  };
  if (expressed.optionLabel) out.optionLabel = expressed.optionLabel;
  return out;
}

/** The ordinary fact this field wants, from the caller's assignment or, failing that, the offline heuristic. */
function ordinaryFactKey(field: QuestionField, ctx: AnswerContext): { key: string; confidence: number } | null {
  const given = ctx.factKey;
  if (given && given !== NONE) return { key: given, confidence: FACT_CONFIDENCE };
  const mapped = mapFieldToFact(asCapturedField(field), Object.keys(ctx.profile.facts));
  if (mapped.factKey === NONE) return null;
  return { key: mapped.factKey, confidence: Math.min(FACT_CONFIDENCE, mapped.confidence) };
}

function fromFact(field: QuestionField, skeleton: Skeleton, hit: FactHit): AnswerProposal | null {
  const options = usableOptions(field.options);
  const expressed = options.length > 0 ? expressChoice(options, hit.value) : null;
  const resolved = expressed ?? (() => {
    const r = resolveFieldValue(asCapturedField(field), hit.key, hit.value);
    return r ? { action: r.action, value: r.value, factor: r.confidenceFactor } : null;
  })();
  if (!resolved) return null;
  return proposal(skeleton, resolved, "fact", hit.confidence, hit.reason, { factKey: hit.key });
}

/** Section 3: the most conservative answer a question can be given without claiming anything for the applicant. */
function guess(field: QuestionField, classification: Classification, ctx: AnswerContext, skeleton: Skeleton): AnswerProposal {
  if (classification.class === "protected") return guessProtected(field, ctx, skeleton);
  if (classification.class === "declaration") return guessDeclaration(field, classification, skeleton);
  return guessOrdinary(field, skeleton);
}

function guessProtected(field: QuestionField, ctx: AnswerContext, skeleton: Skeleton): AnswerProposal {
  if (!ctx.settings?.answerProtectedWithDecline) {
    return nothing(skeleton, "protected characteristic: only you can answer this");
  }
  const decline = declineOption(field.options);
  if (decline) {
    // Not a guess: declining is a true answer for anyone, and the user asked for it in the settings.
    return proposal(
      skeleton,
      { action: "select", value: decline.value, optionLabel: decline.label, factor: 1 },
      "fact",
      DECLINE_CONFIDENCE,
      "declined by setting",
    );
  }
  // No way to decline at all, which is rare. Shabang still proposes (docs/answers.md section 1, and
  // docs/always-propose.md): flagged, drawn as a long shot, one keystroke to correct. An empty field here is
  // a form nobody can submit, which helps the user less than a guess they can see.
  const options = usableOptions(field.options);
  if (options.length > 0) {
    // A yes/no protected question has no neutral side, so the same principle as a declaration applies: the
    // answer that claims the least. Only a real yes/no set, never a lone checkbox, which is already answered.
    const negative = expressBoolean(field, false);
    if (negative && negative.action === "select" && negative.factor >= 0.9) {
      return proposal(skeleton, negative, "guess", LONG_SHOT_CONFIDENCE, "no way to decline this one: the answer that claims the least - check this", { needsReview: true });
    }
    const broad = leastSpecificOption(options);
    if (broad) return longShot(skeleton, broad, "no way to decline this one: the least specific option it offers - check this");
  }
  return nothing(skeleton, "protected characteristic with nothing to choose from: only you can answer this");
}

function guessDeclaration(field: QuestionField, classification: Classification, skeleton: Skeleton): AnswerProposal {
  const topic = classification.topic;
  // A consent to be screened is a permission the applicant GRANTS, not a fact about them, and an unticked box
  // is already an answer -- there is no empty state for Shabang to fill, exactly as for the bare consent box in
  // `guessOrdinary`. So Shabang does not tick "I consent to a credit check" or "I agree to a drug screen" on
  // anyone's behalf. A yes/no CONTROL is different: it has no unanswered state and the form cannot be sent
  // without one, so there the routine consent is still proposed, flagged, and hold-Tab stops on it.
  if (topic === "backgroundCheck" && field.kind === "checkbox") {
    return nothing(skeleton, "consent to be screened: ticking this is yours to do");
  }
  const fallback = topic ? DECLARATION_DEFAULTS[topic] : undefined;
  if (fallback) {
    const label = headClause(probeText(field.label));
    // "Do you REQUIRE a work permit?" asks the opposite of "are you authorized": needing one is the
    // conservative answer, exactly as needing sponsorship is.
    const inverted = topic !== undefined && INVERTS_ON_NEED.has(topic) && ASKS_WHAT_IS_NEEDED.test(label);
    const negated = NEGATED_QUESTION.test(label);
    const flips = (inverted ? 1 : 0) + (negated ? 1 : 0);
    const want = flips % 2 === 0 ? fallback.want : !fallback.want;
    const expressed = expressBoolean(field, want);
    if (expressed) {
      const reason = `no profile fact: ${fallback.why}${negated || inverted ? ", read against how the question is put" : ""} - check this`;
      return proposal(skeleton, expressed, "guess", DECLARATION_GUESS_CONFIDENCE, reason, { needsReview: true });
    }
  }
  // Not a yes/no: a category (visa class, clearance level). The neutral option is the only honest guess.
  const neutral = neutralOption(field.options);
  if (neutral) {
    return proposal(
      skeleton,
      { action: "select", value: neutral.value, optionLabel: neutral.label, factor: 1 },
      "guess",
      DECLARATION_GUESS_CONFIDENCE,
      "no profile fact: the option that declares the least - check this",
      { needsReview: true },
    );
  }
  // No yes/no side and no neutral option. Still propose: the option that narrows things down the least.
  const broad = leastSpecificOption(field.options);
  if (broad) return longShot(skeleton, broad, "no conservative answer to this one: the least specific option it offers - check this");
  return nothing(skeleton, "legal declaration with nothing to choose from: only you can answer this");
}

function guessOrdinary(field: QuestionField, skeleton: Skeleton): AnswerProposal {
  const options = usableOptions(field.options);
  if (options.length > 0) {
    const neutral = neutralOption(options);
    if (neutral) {
      return proposal(
        skeleton,
        { action: "select", value: neutral.value, optionLabel: neutral.label, factor: 1 },
        "guess",
        GUESS_CONFIDENCE,
        "no profile fact: the most neutral option this question offers",
      );
    }
    const willing = WILLINGNESS.test(probeText(field.label));
    const yesNo = expressBoolean(field, willing);
    // Only a real yes/no set: "Remote / Hybrid / On-site" has no answer that claims nothing.
    if (yesNo && yesNo.factor >= 0.9) {
      const reason = willing
        ? "no profile fact: what most applicants answer, and it commits you to nothing untrue"
        : "no profile fact: the answer that claims the least";
      return proposal(skeleton, yesNo, "guess", GUESS_CONFIDENCE, reason);
    }
    // "Remote / Hybrid / On-site": no option claims nothing, so pick the one that claims the least and say so.
    const broad = leastSpecificOption(options);
    if (broad) return longShot(skeleton, broad, "no profile fact and no neutral option: the one that claims the least - check this");
    return nothing(skeleton, "no profile fact and nothing to choose from: needs your answer");
  }
  if (field.kind === "checkbox") return nothing(skeleton, "an unchecked box is already an answer: agreeing is yours to do");
  if (field.kind === "text" || field.kind === "textarea") return nothing(skeleton, "free text: the draft path answers this", NEEDS_TEXT);
  return nothing(skeleton, "no profile fact for this value: needs your answer");
}

/**
 * The answer Shabang proposes for one question: an answer the user gave before, then a profile fact, then the
 * most conservative guess. Pure: the same question, profile and store always produce the same proposal.
 */
export function proposeAnswer(field: QuestionField, ctx: AnswerContext): AnswerProposal {
  const classification = classifyQuestion(field);
  const opts: SignatureOptions = ctx.company ? { company: ctx.company } : {};
  const signature = questionSignature(field, opts);
  const skeleton = base(field, classification, signature);

  if (!isAnswerableKind(field.kind)) return nothing(skeleton, "this field carries no answer");
  if (fieldLooksSensitive(field)) return nothing(skeleton, "sensitive field: never predicted or filled");

  const learned = ctx.answers?.get(field, opts) ?? null;
  if (learned) {
    const expressed = expressLearned(field, learned);
    if (expressed) {
      const reason = learned.count >= 2 ? "you have answered this before, more than once" : "you answered this before";
      return proposal(skeleton, expressed, "learned", learnedConfidence(learned.count), reason);
    }
  }

  if (classification.class === "protected" || classification.class === "declaration") {
    const topic = classification.topic;
    const hit = topic ? topicFact(ctx.profile, topic, classification.country) : null;
    const fromProfile = hit ? fromFact(field, skeleton, hit) : null;
    if (fromProfile) return fromProfile;
    return guess(field, classification, ctx, skeleton);
  }

  const ordinary = ordinaryFactKey(field, ctx);
  if (ordinary && ordinary.key === NEEDS_TEXT) return nothing(skeleton, "free text: the draft path answers this", NEEDS_TEXT);
  if (ordinary) {
    const value = ctx.profile.facts[ordinary.key];
    const fromProfile = value
      ? fromFact(field, skeleton, { key: ordinary.key, value, confidence: ordinary.confidence, reason: "answered from your profile" })
      : null;
    if (fromProfile) return fromProfile;
  }
  return guess(field, classification, ctx, skeleton);
}

// ---------------------------------------------------------------------------
// Section 6: value-free counters. No label, no value, no origin ever rides along.
// ---------------------------------------------------------------------------

export interface AnswerProposedEvent {
  event: "answer.proposed";
  class: QuestionClass;
  source: "fact" | "learned" | "guess";
  accepted: boolean;
  /** The confidence it was shown with, floored to a tenth: 0.7, 0.8, 0.9. */
  confidenceBucket: number;
}

export interface AnswerCorrectedEvent {
  event: "answer.corrected";
  class: QuestionClass;
  /** Was a ghost on the field when the user answered it? */
  hadGhost: boolean;
  /** Was that ghost a guess (rather than a fact or something learned)? */
  wasGuess: boolean;
}

export type AnswerEvent = AnswerProposedEvent | AnswerCorrectedEvent;

export function confidenceBucket(confidence: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  return Math.floor(clamped * 10) / 10;
}

/** Null for a proposal that was never shown: "none" is not a counted proposal. */
export function answerProposedEvent(proposal: AnswerProposal, accepted: boolean): AnswerProposedEvent | null {
  if (proposal.source === "none") return null;
  return {
    event: "answer.proposed",
    class: proposal.class,
    source: proposal.source,
    accepted,
    confidenceBucket: confidenceBucket(proposal.confidence),
  };
}

/**
 * The flat counter name this event increments on the local path (`ghost.metrics`, `POST /v1/metrics/event`),
 * which takes counter names and numbers only. `ANSWER_COUNTER_NAMES` is the whole closed set of them.
 */
export function answerCounterName(event: AnswerEvent): string {
  if (event.event === "answer.corrected") return `answer.corrected.${event.class}`;
  return `answer.${event.accepted ? "accepted" : "proposed"}.${event.class}.${event.source}`;
}

const CLASSES: readonly QuestionClass[] = ["ordinary", "protected", "declaration"];
const SOURCES: ReadonlyArray<"fact" | "learned" | "guess"> = ["fact", "learned", "guess"];

/** Every counter name the answer engine can produce: the allowlist both clients and the server need. */
export const ANSWER_COUNTER_NAMES: readonly string[] = [
  ...CLASSES.flatMap((c) => SOURCES.flatMap((s) => [`answer.proposed.${c}.${s}`, `answer.accepted.${c}.${s}`])),
  ...CLASSES.map((c) => `answer.corrected.${c}`),
];

export interface CorrectionOptions {
  /** Milliseconds since the epoch. */
  now?: number;
  /** The visible option text the user picked, when the field is a select or a radio group. */
  optionLabel?: string;
  /** Where it happened; kept only for the options page's "forget everything learned here". */
  origin?: string;
  company?: string;
  /** The proposal that was on the field when the user answered, when there was one. */
  previous?: AnswerProposal | null;
}

export interface CorrectionResult {
  /** The same store, updated in place, so callers can chain. */
  store: LearnedAnswerStore;
  learned: LearnedAnswer | null;
  changed: LearnResult["changed"];
  refusal?: LearnResult["refusal"];
  /** The value-free counter for this correction. */
  event: AnswerCorrectedEvent;
}

/**
 * The user answered a question themselves: keep it, keyed by the question rather than the site, so the same
 * question is answered everywhere afterwards. Values that look like secrets are never kept (see `refuseLearning`).
 */
export function recordCorrection(
  field: QuestionField,
  chosenValue: string,
  store: LearnedAnswerStore,
  when: number | CorrectionOptions = {},
): CorrectionResult {
  const opts: CorrectionOptions = typeof when === "number" ? { now: when } : when;
  const classification = classifyQuestion(field);
  const input = {
    field,
    value: chosenValue,
    class: classification.class,
    ...(opts.optionLabel !== undefined ? { optionLabel: opts.optionLabel } : {}),
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    ...(opts.company !== undefined ? { company: opts.company } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
  const result = store.add(input);
  const previous = opts.previous ?? null;
  const out: CorrectionResult = {
    store,
    learned: result.answer,
    changed: result.changed,
    event: {
      event: "answer.corrected",
      class: classification.class,
      hadGhost: previous !== null && previous.source !== "none",
      wasGuess: previous?.source === "guess",
    },
  };
  if (result.refusal) out.refusal = result.refusal;
  return out;
}
