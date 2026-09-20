// Which of the three classes a question belongs to, derived in code from the label, the section heading,
// the option set and the field kind. See docs/answers.md section 1. No site names, no per-ATS rules:
// the same vocabulary decides on Greenhouse, Lever, Ashby, Workday, iCIMS and a hand-written careers page.
import type { FieldKind, FieldOption } from "../types";

/** What Ghost is allowed to do with a question. */
export type QuestionClass = "ordinary" | "protected" | "declaration";

/** What the question is about, when the vocabulary recognizes it. Drives the (country-qualified) fact key. */
export type QuestionTopic =
  | "gender"
  | "pronouns"
  | "ethnicity"
  | "hispanicLatino"
  | "veteranStatus"
  | "disabilityStatus"
  | "dateOfBirth"
  | "age"
  | "religion"
  | "sexualOrientation"
  | "maritalStatus"
  | "familyStatus"
  | "workAuthorization"
  | "requiresSponsorship"
  | "immigrationStatus"
  | "legalAge"
  | "criminalRecord"
  | "backgroundCheck"
  | "exportControl"
  | "securityClearance"
  | "nonCompete"
  | "certification";

/** The part of a captured field the answer engine reads. A `CapturedField` satisfies it. */
export interface QuestionField {
  label: string;
  kind: FieldKind;
  options?: FieldOption[];
  /** Section heading or helper text near the field. */
  context?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  autocomplete?: string;
  inputType?: string;
}

export interface Classification {
  class: QuestionClass;
  /** Why, in words the HUD and the options page can show. Never contains a value. */
  reason: string;
  topic?: QuestionTopic;
  /** ISO-ish code of the country the question names ("in the United States" -> "US"). */
  country?: string;
}

/** Lowercased and whitespace-collapsed, punctuation kept: country matching needs the dots in "U.S.". */
export function lowerText(text: string | undefined): string {
  return (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Vocabulary reads punctuation-free text: "Hispanic/Latino" becomes two words, "non-binary" one. */
export function probeText(text: string | undefined): string {
  return lowerText(text).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

// Order matters: the longer, more specific phrase is tested first ("Northern Ireland" is GB, not IE).
// A bare "us" is never a country ("tell us", "hear about us"): only "the US", "U.S." or "USA" count.
const COUNTRY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["GB", /\bnorthern ireland\b|\bunited kingdom\b|\bgreat britain\b|\bbritain\b|\bengland\b|\bscotland\b|\bwales\b|\bu\.\s?k\b|\bthe uk\b|\bin uk\b/],
  // "(US only)" is how a form scopes a question to one country; a bare "us" ("tell us", "hear about us") is not.
  ["US", /\bunited states\b|\bu\.\s?s\b|\busa\b|\bamerica\b|\bthe us\b|\bin us\b|\bus only\b/],
  ["CA", /\bcanada\b|\bcanadian\b/],
  ["EU", /\beuropean union\b|\bthe eu\b|\bin eu\b|\beea\b|\bschengen\b/],
  ["IE", /\bireland\b|\birish republic\b/],
  ["IN", /\bindia\b/],
  ["AU", /\baustralia\b/],
  ["NZ", /\bnew zealand\b/],
  ["DE", /\bgermany\b/],
  ["FR", /\bfrance\b/],
  ["NL", /\bnetherlands\b|\bholland\b/],
  ["CH", /\bswitzerland\b/],
  ["ES", /\bspain\b/],
  ["IT", /\bitaly\b/],
  ["SE", /\bsweden\b/],
  ["PL", /\bpoland\b/],
  ["PT", /\bportugal\b/],
  ["BE", /\bbelgium\b/],
  ["AT", /\baustria\b/],
  ["DK", /\bdenmark\b/],
  ["NO", /\bnorway\b/],
  ["FI", /\bfinland\b/],
  ["SG", /\bsingapore\b/],
  ["JP", /\bjapan\b/],
  ["KR", /\bsouth korea\b|\brepublic of korea\b/],
  ["CN", /\bchina\b/],
  ["HK", /\bhong kong\b/],
  ["MX", /\bmexico\b/],
  ["BR", /\bbrazil\b/],
  ["AR", /\bargentina\b/],
  ["ZA", /\bsouth africa\b/],
  ["AE", /\bunited arab emirates\b|\bthe uae\b|\bin uae\b|\bdubai\b|\babu dhabi\b/],
  ["IL", /\bisrael\b/],
  ["PH", /\bphilippines\b/],
  ["ID", /\bindonesia\b/],
  ["MY", /\bmalaysia\b/],
];

/** The country a question names, with the pattern that found it. Null when it names none. */
export function matchCountry(text: string | undefined): { code: string; pattern: RegExp } | null {
  const t = lowerText(text);
  if (t === "") return null;
  for (const [code, pattern] of COUNTRY_PATTERNS) if (pattern.test(t)) return { code, pattern };
  return null;
}

export function parseCountry(text: string | undefined): string | undefined {
  return matchCountry(text)?.code ?? undefined;
}

/**
 * Replaces every country phrase with one canonical token, so "in the U.S." and "in the United States"
 * hash alike while a Canadian question stays a different question.
 */
export function canonicalizeCountries(text: string): string {
  let out = text;
  for (const [code, pattern] of COUNTRY_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, "gi"), ` country${code} `);
  }
  return out;
}

interface TopicRule {
  topic: QuestionTopic;
  pattern: RegExp;
  /** Words that make it a different question entirely. */
  veto?: RegExp;
}

// A characteristic of the person that an employer may not decide on. Never guessed. Order: most specific first.
const PROTECTED_RULES: readonly TopicRule[] = [
  { topic: "dateOfBirth", pattern: /\bdate of birth\b|\bbirth ?date\b|\b(day|month|year) of birth\b|\bdob\b|\bwhen were you born\b/ },
  { topic: "sexualOrientation", pattern: /\bsexual orientation\b|\blgbtq?\w*\b|\btransgender\b|\bgender identity\b/ },
  { topic: "gender", pattern: /\bgender\b|\bsex\b/, veto: /\bsex offen|\bsame sex\b/ },
  { topic: "pronouns", pattern: /\bpronouns?\b/ },
  { topic: "hispanicLatino", pattern: /\bhispanic\b|\blatin[oax]\b|\blatine\b/ },
  {
    // "Do you identify as a member of an underrepresented group?" asks about race or origin without naming one.
    // A bare Yes/No answer set gives `looksLikeEeoScale` nothing to see, so the vocabulary has to carry it:
    // otherwise the question falls through to the ordinary guess, which would state a claim about the applicant.
    topic: "ethnicity",
    pattern:
      /\bethnic\w*\b|\brace\b|\bracial\b|\bvisible minorit\w+\b|\bminority group\b|\bindigenous\b|\baboriginal\b|\bfirst nations\b|\bnational origin\b|\bheritage\b|\bancestry\b|\bunder ?represented\b|\bbipoc\b|\bfirst generation\b|\bprotected (class|characteristic|group)\b/,
    veto: /\brace condition\b|\bracing\b/,
  },
  { topic: "veteranStatus", pattern: /\bveterans?\b|\bmilitary (service|status|experience)\b|\barmed forces\b|\bvevraa\b/ },
  {
    // "Do you require any accommodations?" asks about a disability without ever saying the word.
    topic: "disabilityStatus",
    pattern: /\bdisabilit\w+\b|\bdisabled\b|\bimpairment\b|\bchronic (illness|condition)\b|\b(reasonable|workplace|interview|special|any) accommodations?\b|\baccommodations?\b[^.?]{0,40}\b(interview|hiring|application|process|role|job)\b/,
    veto: /\bhousing\b|\bhotel\b|\blodging\b|\btravel accommodations?\b|\brelocation\b/,
  },
  { topic: "religion", pattern: /\breligio\w+\b|\bfaith\b|\bcreed\b/ },
  { topic: "maritalStatus", pattern: /\bmarital status\b|\bare you (married|single)\b|\bcivil partnership\b|\bspousal status\b/ },
  {
    // Pregnancy and family plans are protected in every jurisdiction that protects sex, and an employer asking
    // is the classic unlawful question. Ghost answers it the way it answers any other protected one: it declines.
    topic: "familyStatus",
    pattern:
      /\bpregnan\w*\b|\bmaternity\b|\bpaternity\b|\bparental leave\b|\bfamil(y|ial) status\b|\b(start|starting|have|having|expand\w*)\b[^.?]{0,15}\ba family\b|\bplan\w*\b[^.?]{0,20}\b(children|kids|a family)\b|\bdo you have (any )?(children|kids|dependents)\b|\bchild ?care (responsibilit|arrangement|needs)\w*\b|\bcaregiv\w+ (status|responsibilit\w+)\b/,
    veto: /\bparental leave policy\b/,
  },
  {
    topic: "age",
    pattern:
      /\bage\b|\bhow old are you\b|\bage (range|group|band|bracket|cohort)\b|\bwhich generation\b|\bgeneration do you\b|\bgeneration (x|y|z)\b|\bgen (x|y|z)\b|\bmillennial\w*\b|\bbaby boomer\w*\b/,
    veto: /\baverage\b/,
  },
];

// A statement with legal weight. Never guessed: a wrong answer is a false statement on a legal form.
const DECLARATION_RULES: readonly TopicRule[] = [
  {
    topic: "requiresSponsorship",
    pattern: /\bsponsorship\b|\bsponsor\w*\b[^.?]{0,40}\b(visa|work|employment|immigration|h ?1 ?b)\b|\b(visa|immigration|work permit)\b[^.?]{0,30}\bsponsor\w*\b/,
    veto: /\bsponsored by\b|\bsponsor name\b|\b(event|corporate|gold|silver|title) sponsors?\b/,
  },
  {
    // "legally able to work" is a declaration; a bare "able to work weekends" is an ordinary availability question.
    topic: "workAuthorization",
    pattern: /\b(legally|lawfully) (authori[sz]ed|eligible|entitled|permitted|allowed|able)\b|\b(authori[sz]ed|eligible|entitled|permitted)\b[^.?]{0,20}\bto (work|be employed)\b|\bwork authori[sz]ation\b|\bauthori[sz]ation to work\b|\bright to work\b|\bwork permit\b|\bwork eligibility\b/,
  },
  {
    topic: "immigrationStatus",
    pattern: /\bvisa (status|type|category|class)\b|\bimmigration status\b|\bcitizenship status\b|\bare you a (citizen|permanent resident)\b|\bwork visa\b|\bgreen card\b|\bf ?1 ?(opt|cpt)\b|\bstem opt\b|\bopt (status|ead)\b|\bh ?1 ?b\b|\btn status\b/,
  },
  {
    topic: "legalAge",
    pattern: /\b(1[68]|eighteen|sixteen|21|twenty one)\b[^.?]{0,25}\b(years? (of age|old)|or older|or over|and over|and older)\b|\bare you (at least )?(1[68]|eighteen)\b|\blegal working age\b|\bof legal age\b/,
  },
  {
    topic: "criminalRecord",
    pattern: /\bcriminal\b|\bfelon(y|ies)\b|\bconvict\w*\b|\bmisdemean\w*\b|\bcrimes?\b|\bpled guilty\b|\bincarcerat\w*\b/,
  },
  { topic: "backgroundCheck", pattern: /\bbackground (check|screening|investigation)\b|\bdrug (test|screen\w*)\b|\bcredit check\b|\bright to work check\b/ },
  { topic: "exportControl", pattern: /\bexport (control|administration|regulations?)\b|\bitar\b|\bdeemed export\b|\bus person\b|\bdual national\b/ },
  { topic: "securityClearance", pattern: /\bsecurity clearance\b|\bclearance level\b|\bpolygraph\b|\btop secret\b|\bsci\b/ },
  { topic: "nonCompete", pattern: /\bnon ?compete\b|\bnon ?solicit\w*\b|\brestrictive covenant\b|\bconfidentiality agreement\b|\bgarden leave\b/ },
  {
    topic: "certification",
    pattern: /\bi certify\b|\bcertify that\b|\bunder penalt\w+\b|\battest\b|\bi declare\b|\bdeclare that\b|\btrue and (complete|accurate|correct)\b|\bto the best of my knowledge\b/,
  },
];

/** A voluntary self-identification block: the section that asks the protected questions. */
const SELF_ID =
  /\bself identif\w+\b|\bequal (employment )?opportunit\w*\b|\beeoc?\b|\bdemographic\w*\b|\bdiversity (survey|questions?|information|data|monitoring)\b|\bvoluntary disclosure\b|\bofccp\b/;

/**
 * An option that means "I am not answering this". Declining is a choice, never a claim about the person.
 * Every real EEO control offers one, but each ATS words it its own way, so all of the wordings are here:
 * Greenhouse alone ships "Decline To Self Identify", "I don't wish to answer" and "I do not want to answer".
 */
const DECLINE_OPTION = new RegExp(
  [
    "\\bprefer not to (say|answer|disclose|respond|identify|self identify|specify|state|provide)\\b",
    "\\bdecline to (self identify|identify|answer|state|disclose|respond|provide|specify)\\b",
    "\\b(do not|don t|dont|does not) (wish|want|choose|prefer) to (answer|disclose|identify|self identify|provide|say|specify|state)\\b",
    "\\bwish not to (answer|disclose|identify|self identify)\\b",
    "\\bchoose not to (disclose|answer|identify|self identify|provide|say)\\b",
    "\\b(would )?rather not (say|answer|disclose)\\b",
    "\\bnot disclosed?\\b",
    "\\bno answer\\b",
  ].join("|"),
);

/** Option text that only appears in a demographic answer set. */
const DEMOGRAPHIC_OPTION =
  /\b(male|female|non binary|man|woman|transgender|genderqueer|agender|asian|black|african american|white|caucasian|hispanic|latin[oax]|native hawaiian|native american|american indian|alaska native|pacific islander|two or more races|middle eastern|veterans?|protected veteran|disabilit\w+|disabled|heterosexual|straight|gay|lesbian|bisexual|queer)\b/;

export function isDeclineOption(label: string | undefined): boolean {
  return DECLINE_OPTION.test(probeText(label));
}

/** Options that read as an EEO scale: a decline option next to demographic answers. */
export function looksLikeEeoScale(options: readonly FieldOption[] | undefined): boolean {
  const labels = (options ?? []).map((o) => probeText(o.label));
  return labels.some((l) => DECLINE_OPTION.test(l)) && labels.some((l) => DEMOGRAPHIC_OPTION.test(l));
}

interface Hit {
  topic: QuestionTopic;
  where: string;
}

function firstMatch(rules: readonly TopicRule[], sources: ReadonlyArray<readonly [string, string]>): Hit | null {
  for (const [where, text] of sources) {
    if (text === "") continue;
    for (const rule of rules) {
      if (rule.pattern.test(text) && !(rule.veto?.test(text) ?? false)) return { topic: rule.topic, where };
    }
  }
  return null;
}

function withCountry(result: Classification, country: string | undefined): Classification {
  return country ? { ...result, country } : result;
}

/**
 * Ordinary unless the protected or declaration vocabulary matches. When both match, the declaration wins
 * (its answer is a legal statement, and declining it is not a neutral option) UNLESS the field sits in a
 * voluntary self-identification block or its options are an EEO scale, where the protected rules are the
 * ones written for it. Either way the question is never guessed.
 */
export function classifyQuestion(field: QuestionField): Classification {
  const label = probeText(field.label);
  const context = probeText(field.context);
  const sources: ReadonlyArray<readonly [string, string]> = [
    ["label", label],
    ["section", context],
  ];
  const country = parseCountry(field.label) ?? parseCountry(field.context);

  const declaration = firstMatch(DECLARATION_RULES, sources);
  const protectedHit = firstMatch(PROTECTED_RULES, sources);
  const selfId = SELF_ID.test(label) || SELF_ID.test(context);
  const eeoScale = looksLikeEeoScale(field.options);

  const protectedResult = (): Classification => {
    if (protectedHit) {
      return { class: "protected", reason: `${protectedHit.where} asks about ${protectedHit.topic}`, topic: protectedHit.topic };
    }
    const why = selfId ? "sits in a voluntary self-identification section" : "offers an EEO answer scale with a decline option";
    return { class: "protected", reason: `question ${why}` };
  };

  if (declaration && (selfId || eeoScale) && protectedHit) return withCountry(protectedResult(), country);
  if (declaration) {
    return withCountry(
      { class: "declaration", reason: `${declaration.where} asks for a legal declaration about ${declaration.topic}`, topic: declaration.topic },
      country,
    );
  }
  if (protectedHit || selfId || eeoScale) return withCountry(protectedResult(), country);
  return withCountry({ class: "ordinary", reason: "no protected characteristic and no legal declaration" }, country);
}

/**
 * A question about a protected characteristic. Ghost answers these (with the form's own way of declining),
 * but it never mentions one to a server: the desktop client has enforced this since it shipped
 * (`desktop/core/predict.ts`), and `isProtectedQuestion` is the one rule both clients now share.
 *
 * Wider than the classifier on purpose, exactly as the desktop's own guard is: a question whose OPTIONS are
 * demographic is protected for the purpose of what leaves the machine, even when it offers no way to decline
 * and the label gives nothing away. This decides disclosure only, never how a question is answered.
 */
export function isProtectedQuestion(field: QuestionField): boolean {
  if (field.kind === "button" || field.kind === "link") return false;
  if (classifyQuestion(field).class === "protected") return true;
  return (field.options ?? []).some((o) => DEMOGRAPHIC_OPTION.test(probeText(o.label)) || DEMOGRAPHIC_OPTION.test(probeText(o.value)));
}

/**
 * A question whose text, options and answer all stay on this machine (docs/answers.md section 7).
 * Protected characteristics AND legal declarations qualify: "Explain the circumstances of any conviction"
 * or "describe the accommodations you need" is a disclosure whether it rides along as a question or as an
 * answer, so neither is sent to `/v1/ghost-text`, kept in `profile.pastAnswers`, or drafted by a server.
 * Learning still keeps them, locally, in the learned-answer store: that is the user's own answer, on their disk.
 */
export function staysOnThisMachine(field: QuestionField): boolean {
  const questionClass = classifyQuestion(field).class;
  return questionClass === "protected" || questionClass === "declaration";
}

/** Kinds that can never carry an answer. */
export function isAnswerableKind(kind: FieldKind): boolean {
  return kind !== "button" && kind !== "link" && kind !== "file" && kind !== "other";
}
