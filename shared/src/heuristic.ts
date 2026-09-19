import { NEEDS_TEXT, NONE, type CapturedField, type FieldAssignment, type FieldKind } from "./types";

type Kinds = readonly FieldKind[];

interface Rule {
  key: string;
  /** Field kinds this fact can sensibly land in: an email never goes onto a checkbox. */
  kinds: Kinds;
  /** Standard phrasings. */
  exact: RegExp;
  confidence: number;
  /** Plausible but less standard phrasings: still shown, with less certainty. */
  loose?: RegExp;
  looseConfidence?: number;
  /** Words that make it a different question ("phone type", "country code"): the rule does not apply. */
  veto?: RegExp;
  /** Words that leave it unclear whose detail or which polarity is asked for: kept below the default threshold. */
  doubt?: RegExp;
}

const TEXT: Kinds = ["text"];
const EMAIL: Kinds = ["text", "email"];
const PHONE: Kinds = ["text", "tel"];
const LINK: Kinds = ["text", "url"];
const TEXT_OR_SELECT: Kinds = ["text", "select"];
const YES_NO: Kinds = ["select", "radio", "checkbox"];
const ONE_OF: Kinds = ["text", "select", "radio"];
const WHEN: Kinds = ["text", "number", "month", "date", "select"];

const HINT_PENALTY = 0.08;
const DOUBTFUL = 0.6;
const UNKNOWN = 0.6;

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

// "Preferred name", "maiden name", "username": a name, but not the one in the profile.
const NAME_VARIANT = /\b(preferred|nick ?name|middle|maiden|previous|former|alias|other names?|phonetic|kana|pronunciation|user ?name|display|screen|pet)\b/;
// A bare "legal name" or "your name" next to these belongs to a company, or signs something.
const NOT_A_PERSON = new RegExp(
  `${NAME_VARIANT.source}|\\b(company|business|employer|school|university|college|institution|organi[sz]ation|entity|trading|brand|product|project|card|bank|signature|sign(ed|ing)?|initials|certify|attest)\\b`,
);
const ASKS_FOR_A_CODE = "^(\\w+ ){0,2}code$";
// "Without sponsorship", "any restrictions on your right to work": a yes/no fact would land on the wrong answer.
const POLARITY_TRAP = /\bwithout\b|\b(not|unable|cannot|never)\b|restrict|limitation|\bexpir/;

// Order matters: more specific rules first.
const RULES: Rule[] = [
  {
    key: "referralSource",
    kinds: ONE_OF,
    exact: /how did you (first )?(hear|find out|find|learn|come across|discover)|where did you (first )?(hear|find|learn|see)|how (have )?you heard|\bheard about\b|\breferral source\b|\bsource of referral\b/,
    confidence: 0.9,
    loose: /\bhear about (us|this|the)\b|^source$/,
    veto: /who referred|referred by|referr(er|al) (name|code|e ?mail|id)|employee referral|name of (the )?(person|employee)/,
  },
  {
    key: "requiresSponsorship",
    kinds: YES_NO,
    exact: /\b(requir\w+|need\w*)\b.{0,60}\bsponsor|\bsponsor\w*\b.{0,60}\b(visa|work|employment|immigration|h ?1 ?b)\b|\b(visa|immigration|work permit)\b.{0,30}\bsponsor/,
    confidence: 0.92,
    loose: /\bsponsorship\b/,
    looseConfidence: 0.78,
    veto: /sponsor(ed)? by|sponsor name|(event|corporate|our|gold|silver) sponsors?/,
    doubt: POLARITY_TRAP,
  },
  {
    key: "workAuthorization",
    kinds: YES_NO,
    exact: /authori[sz]ed to work|work authori[sz]ation|legally (able|authori[sz]ed|entitled|eligible|permitted|allowed)|eligible to work|\b(have|hold|possess)\b.{0,30}\b(right to work|work permit)|\bright to work\b/,
    confidence: 0.92,
    doubt: new RegExp(`${POLARITY_TRAP.source}|\\b(require|need)s?\\b`),
  },
  {
    key: "linkedin",
    kinds: LINK,
    exact: /\blinked ?in\b/,
    confidence: 0.97,
    veto: /\b(hear|heard|found|find|source|headline|connections?|followers?|share|follow|post|company page|apply (with|using|via))\b/,
  },
  {
    key: "github",
    kinds: LINK,
    exact: /\bgit ?hub\b/,
    confidence: 0.97,
    veto: /\b(repo(sitory)?|project|organi[sz]ation|org|issue|token|user ?name|handle|sponsors?|actions?)\b/,
  },
  {
    key: "fullName",
    kinds: TEXT,
    exact: /^(full ?)?name$|\bfull (legal )?name\b|\blegal (full )?name\b|\b(your|applicant'?s?|candidate'?s?) (full |legal |complete )*name\b|\bfirst ?(name )?(and|&|\+|,)? ?(last|family|sur) ?names?\b/,
    confidence: 0.9,
    veto: NOT_A_PERSON,
  },
  {
    key: "firstName",
    kinds: TEXT,
    exact: /\b(first|given|fore) ?names?\b|\bfname\b/,
    confidence: 0.95,
    loose: /^first$/,
    looseConfidence: 0.78,
    veto: NAME_VARIANT,
  },
  {
    key: "lastName",
    kinds: TEXT,
    exact: /\b(last|family|sur) ?names?\b|\blname\b/,
    confidence: 0.95,
    loose: /^last$/,
    looseConfidence: 0.78,
    veto: NAME_VARIANT,
  },
  {
    key: "email",
    kinds: EMAIL,
    exact: /\be ?mail\b/,
    confidence: 0.95,
    veto: /\be ?mail (me|us|my|updates?|alerts?|notifications?|preferences?|frequency|subject|body|template|signature|format|opt|subscription|digest|marketing|consent|permission|domain|provider|client)\b|\b(by|via|through) e ?mail\b|e ?mail or (user|phone|mobile)|\b(user ?name|or e ?mail|recipients?|invite|cc|bcc)\b|share with|^(to|from|reply to)$/,
    doubt: /\b(work|company|business|corporate|school|student|university|alternate|alternative|secondary|backup|recovery|other|additional|paypal|support|sales)\b/,
  },
  {
    key: "phone",
    kinds: PHONE,
    exact: /\b(phone|telephone|mobile|cell ?phone|cell|cellular|contact) ?(number|num|no|#)|\b(phone|telephone|mobile|cell ?phone|cell|tel)\b/,
    confidence: 0.95,
    veto: new RegExp(
      `${ASKS_FOR_A_CODE}|\\b(phone|mobile|device|number|line) type\\b|\\btype of (phone|number|device)\\b|\\b(ext|extension|carrier|provider|model|brand|os|plan|sms|consent|opt|fax|verification|app|version|friendly|interview|screen|availability)\\b|\\btext (me|messages?)\\b|\\bcall me\\b|best time|time to (call|reach)`,
    ),
    doubt: /\b(work|office|business|company|landline|alternate|alternative|secondary|other|additional|daytime|evening)\b/,
  },
  {
    key: "website",
    kinds: LINK,
    exact: /\bportfolio\b|\bpersonal (web ?site|site|url|page|blog)\b|\bweb ?site\b|\bhome ?page\b/,
    confidence: 0.9,
    loose: /^(url|link|links|blog|other (url|link)s?)$/,
    looseConfidence: 0.74,
    veto: /\b(company|employer|business|school|video|job|posting|source|upload|attach(ment)?|file|resume|cv|cover letter|drive|dropbox|calendly|image|photo|avatar|logo|callback|webhook|redirect|api|value|size|worth|invest\w*|manage\w*|twitter|facebook|instagram|tiktok|youtube)\b/,
    doubt: /\b(other|additional|secondary)\b/,
  },
  {
    key: "graduationDate",
    kinds: WHEN,
    exact: /\bgraduation\b|\bgraduating\b|\bgrad (date|year|month)\b|\bwhen (do|did|will) you (expect to )?graduate\b/,
    confidence: 0.9,
    loose: /\bclass (of|year)\b|\b(degree|program(me)?|studies) completion\b/,
    veto: /\b(high school|secondary|ceremony|gown|gpa|honou?rs|status|did you graduate|have you graduated)\b/,
  },
  {
    key: "degree",
    kinds: TEXT_OR_SELECT,
    exact: /^(degree|degree (type|level|name|earned|obtained|program(me)?|title|or program(me)?)|type of degree|program(me)? of study|qualification)$/,
    confidence: 0.9,
    loose: /\bdegree\b|^(academic |degree )?program(me)?( name)?$|\bprogram(me)? of study\b/,
    looseConfidence: 0.76,
    veto: /\b(gpa|grade|date|year|status|when|did you|do you|have you|completed?|finish(ed)?|temperature|angle|to what|what degree of|degrees of|level of education)\b/,
  },
  {
    key: "major",
    kinds: TEXT_OR_SELECT,
    exact: /^(major|majors|academic major|field of study|area of study|discipline|concentration|course of study|major (or )?field of study)$/,
    confidence: 0.9,
    loose: /\b(your|college|university|undergraduate|academic|declared|intended) major\b|\bmajor (field|area|subject)\b|\bfield of study\b|\barea of study\b|\bdiscipline\b/,
    looseConfidence: 0.76,
    veto: /\b(minor|disciplinary|action|record|accomplishments?|achievements?|challenges?)\b/,
  },
  {
    key: "school",
    kinds: TEXT_OR_SELECT,
    exact: /^(name of (your |the )?)?(current |most recent |educational |academic )?(school|university|college|institution|alma mater)(( or | and | )(school|university|college|institution))?( name| attended)?$/,
    confidence: 0.9,
    loose: /\b(school|university|college)\b/,
    looseConfidence: 0.74,
    veto: /\b(high|secondary|middle|elementary|primary|grade|graduate school|level|type|kind|years?|e ?mail|id|number|address|city|state|province|country|location|district|board|transcript|gpa|start|end|from|date|phone|website|url|clubs?|activities|bank|financial)\b/,
  },
  {
    key: "location",
    kinds: TEXT,
    exact: /^(current|present|your) location$|^(current )?(city|town) ?(and|&|or)? ?(state|province|region)( (province|territory))?$|\bwhere are you (currently )?(based|located)\b|\bcity and (state|province)\b|\bcurrent (location|city)\b/,
    confidence: 0.85,
    loose: /^location$/,
    looseConfidence: 0.78,
    veto: /\b(job|office|work|preferred|desired|interview|company|employer|school|university|campus|event|meeting|relocat\w*|willing|remote|onsite|store|branch|pickup|delivery|file|save|birth)\b/,
  },
  {
    key: "country",
    kinds: TEXT_OR_SELECT,
    exact: /^(current |home |your )?country( of residence| or region| region)?$|\bcountry of residence\b|\bcountry (where|in which) you (currently )?(live|reside)\b/,
    confidence: 0.9,
    loose: /\bcountry\b/,
    veto: new RegExp(
      `${ASKS_FOR_A_CODE}|\\b(phone|dial\\w*|calling|birth|born|citizen\\w*|nationality|origin|issu\\w+|passport|tax|bank|company|employer|employment|school|university|visa|authori[sz]ed|eligible|relocat\\w*|travel\\w*|visited)\\b`,
    ),
  },
  {
    key: "province",
    kinds: TEXT_OR_SELECT,
    exact: /^(address |mailing |home |current )?(state|province)( of residence)?$|^(state|province) (or )?(state|province|region|territory)( region)?$/,
    confidence: 0.9,
    loose: /\b(which|what|your|home|current|mailing) (state|province)\b|\b(state|province)\b.*\b(residence|live|reside|located|address)\b/,
    looseConfidence: 0.72,
    veto: /united states|\bstate (your|the|why|how|any|whether|if|a|an)\b|\b(statement|reason|status|licen[cs]e|issued|school|university|company|employer|employment|birth|bar)\b|\bstate of (mind|affairs|health)\b/,
  },
  {
    key: "city",
    kinds: TEXT,
    exact: /^(address |mailing |current |home )?(city|town|city (or )?town|town (or )?city)( of residence)?$/,
    confidence: 0.9,
    loose: /\b(which|what|your|home|current) (city|town)\b|\b(city|town)\b.*\b(residence|live|reside|located)\b/,
    looseConfidence: 0.72,
    veto: /\b(birth|born|school|university|company|employer|job|office|preferred|desired|relocat\w*|willing|sister|cities)\b/,
  },
];

const RULE_BY_KEY = new Map(RULES.map((rule) => [rule.key, rule]));
const PERSONAL = new Set(["firstName", "lastName", "fullName", "email", "phone", "linkedin", "github", "website", "location", "city", "province", "country"]);
const PLACE = new Set(["location", "city", "province", "country"]);

// Labels about someone or something other than the applicant.
const OTHER_PARTY =
  /\b(references?|referees?|referrer|referred|emergency|next of kin|manager|supervisor|recruiter|interviewer|parent|guardian|spouse|partner|mother|father|sibling|child|dependent|beneficiary|friend|colleague|co ?worker|employer|company|organi[sz]ation|business|vendor|landlord|doctor|physician|attorney|contact person|recipient|their|his|her)('?s)?\b/;
// Section headings are matched from their start: the nearest heading is often a job title, which may say anything.
const OTHER_PARTY_SECTION =
  /^(your |add |my |\d+ )?((professional|personal|character|employment|work) )?(references?|referees?|emergency contacts?|next of kin|referrals?|referred by|employee referral|parents?|guardians?|spouse|dependents?|beneficiar(y|ies)|co ?applicant)\b/;
const ELSEWHERE_SECTION =
  /^(your |add |my |\d+ )?((work|professional|employment|relevant|previous|prior|past) )?(experience|employment|work history|education|educational background|academic background|certifications?|projects?|positions?)\b/;
const DEMOGRAPHIC =
  /\b(gender|sex|race|racial|ethnic\w*|hispanic|latin[oax]|veteran|military (status|service)|disabilit\w+|disabled|pronouns?|sexual orientation|lgbtq?\w*|transgender|marital|religio\w+|age (range|group)|indigenous|aboriginal|first nations|visible minority|caste)\b/;
const DEMOGRAPHIC_SECTION = /^(voluntary |optional |us |u s )*(self identif\w+|equal (employment )?opportunit\w+|eeoc?\b|demographic|diversity (survey|questions?|information|data))/;
const NOT_MY_INBOX =
  /newsletter|subscri|mailing list|\bmce\b|notify me|keep me|send me|job alerts?|stay (in touch|updated|in the loop|connected)|get (updates|notified|the latest)|join (our|the) (list|waitlist)|^(sign|log) ?in\b|^login\b|welcome back|forgot|reset (your )?password/;
const SEARCH_LABEL = /^(search|find|filter|look ?up)\b|\bsearch$|\bsearch (for|by|jobs|our|the|this|all)\b|type to (search|filter)/;
const SEARCH_HINT = /\bsearch|\bquery\b|^q$|\bkeywords?\b|\bfilter\b|typeahead/;

const FREE_TEXT_PROMPT = /\bwhy\b|tell us|describe|explain|cover letter|anything else|what (makes|interests|excites)|about (yourself|a project|a time)|share (a|an|your)/;
// A model can write prose, never facts it does not have: pay, dates, counts, addresses, legal and demographic answers.
const FACTUAL_PROMPT =
  /\bsalary|compensation|\b(pay|rate|wage)\b|\bhow (many|much|soon)\b|\byears of\b|\bnumber of\b|\bdate\b|^when\b|notice period|\bavailab|\bgpa\b|\bage\b|\baddress\b|\breferences?\b|\bvisa\b|citizen|criminal|convict|felony|paste (your )?(resume|cv)|\bsignature\b/;
// In a one-line input, a closed question ("What is your current title?", "Do you...?") wants a fact, not prose.
const CLOSED_QUESTION =
  /^(who|when|which|what('s| is| are| was| were)? (your|the)|how (many|much|long|soon|often)|where (do|did|are|were|is)|(are|is|do|does|did|have|has|will|would|can|could|were|was) (you|your|there))\b/;
const CONSENT = /agree|consent|terms|privacy|acknowledge|certify|subscribe|newsletter|marketing/;

export function normalize(text: string | undefined): string {
  return (text ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_\-./:*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Name (first and last) - required" reads as "name", so anchored patterns can match a decorated label. */
function bare(text: string): string {
  return text
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(required|optional)\b/g, " ")
    .replace(/[^a-z0-9&' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Probe {
  label: string;
  /** name and id: machine words, trusted only when they say nothing beyond the fact ("email_coupon" is a coupon). */
  idents: string[];
  /** Identifiers plus the placeholder, which reads like a label and is matched like one. */
  hints: string[];
  context: string;
}

function readField(field: CapturedField): Probe {
  const label = normalize(field.label);
  const idents = [field.name, field.id].map(normalize).filter((ident) => ident !== "");
  const placeholder = normalize(field.placeholder);
  return { label, idents, hints: placeholder ? [...idents, placeholder] : idents, context: normalize(field.context) };
}

function assignment(field: CapturedField, factKey: string, confidence: number): FieldAssignment {
  return { signature: field.signature, factKey, confidence };
}

function isSearchBox(field: CapturedField, probe: Probe): boolean {
  if ((field.inputType ?? "").toLowerCase() === "search") return true;
  return SEARCH_LABEL.test(probe.label) || probe.hints.some((hint) => SEARCH_HINT.test(hint));
}

function isDemographic(probe: Probe): boolean {
  return [probe.label, ...probe.hints].some((text) => DEMOGRAPHIC.test(text)) || DEMOGRAPHIC_SECTION.test(probe.context);
}

/** True when this fact is the applicant's, but the field is about someone or somewhere else. */
function isAboutSomethingElse(key: string, probe: Probe): boolean {
  if (key === "email" && [probe.label, ...probe.hints, probe.context].some((text) => NOT_MY_INBOX.test(text))) return true;
  if (!PERSONAL.has(key)) return false;
  if ([probe.label, ...probe.idents].some((text) => OTHER_PARTY.test(text)) || OTHER_PARTY_SECTION.test(probe.context)) return true;
  return (PLACE.has(key) || key === "fullName") && ELSEWHERE_SECTION.test(probe.context);
}

// Words an identifier may carry besides the fact itself: "job_application[first_name]", "user_email_confirm", "urls[LinkedIn]".
const FILLER = new Set(
  "applicant candidate user your my job application system systemfield form field input contact personal info information details profile primary main edu education address number no num url urls link txt text box data entry value confirm confirmation verify repeat retype date year month name the of and a".split(" "),
);

function saysNothingElse(rule: Rule, ident: string): boolean {
  const rest = ident.replace(rule.exact, " ").split(/[^a-z]+/);
  return rest.every((word) => word === "" || FILLER.has(word));
}

function ruleConfidence(rule: Rule, text: string, allowLoose: boolean): number | null {
  const texts = [bare(text), text];
  if (texts.some((t) => rule.exact.test(t))) return rule.confidence;
  if (allowLoose && rule.loose && texts.some((t) => rule.loose?.test(t))) return rule.looseConfidence ?? 0.75;
  return null;
}

/** The label always has a say: "Phone type" vetoes a `phone` hint too. Bare forms let anchored vetoes see through decoration. */
function says(pattern: RegExp | undefined, probe: Probe, source: string): boolean {
  if (!pattern) return false;
  return [probe.label, bare(probe.label), source, bare(source)].some((text) => pattern.test(text));
}

type Usable = (key: string) => boolean;

function fromAutocomplete(field: CapturedField, usable: Usable): FieldAssignment | null {
  const tokens = (field.autocomplete ?? "").toLowerCase().split(/\s+/);
  if (tokens.includes("username")) return assignment(field, NONE, UNKNOWN); // a login, whatever the label says
  for (const token of tokens) {
    const key = AUTOCOMPLETE_TO_FACT[token];
    if (key && usable(key)) return assignment(field, key, 0.97);
  }
  return null;
}

/** Label first, then name/id/placeholder. Hints only count on a standard phrasing, and score a little lower. */
function fromRules(field: CapturedField, probe: Probe, usable: Usable): FieldAssignment | null {
  for (const source of [probe.label, ...probe.hints]) {
    const fromLabel = source === probe.label;
    for (const rule of RULES) {
      if (!usable(rule.key) || says(rule.veto, probe, source)) continue;
      const matched = ruleConfidence(rule, source, fromLabel);
      if (matched === null || (probe.idents.includes(source) && !saysNothingElse(rule, source))) continue;
      if (says(rule.doubt, probe, source)) return assignment(field, rule.key, DOUBTFUL);
      return assignment(field, rule.key, fromLabel ? matched : matched - HINT_PENALTY);
    }
  }
  return null;
}

/** An unlabelled (or foreign-language) email or tel input still says what it wants through its type. */
function fromInputType(field: CapturedField, probe: Probe, usable: Usable): FieldAssignment | null {
  const key = field.kind === "email" ? "email" : field.kind === "tel" ? "phone" : null;
  if (!key || !usable(key) || says(RULE_BY_KEY.get(key)?.veto, probe, probe.label)) return null;
  // A label that reads as some other fact ("Email" on a tel input) contradicts the type: neither wins.
  if (RULES.some((rule) => rule.key !== key && ruleConfidence(rule, probe.label, true) !== null)) return null;
  // The type alone decides only when the label cannot: missing, or not in a script these rules read.
  const unreadable = probe.label === "" || /[^\x00-\x7f]/.test(probe.label);
  return assignment(field, key, unreadable ? 0.8 : DOUBTFUL);
}

/** Deterministic label-keyword mapping. Used by the server heuristic provider and the offline fallback. */
export function mapFieldToFact(field: CapturedField, factKeys: string[]): FieldAssignment {
  if (field.kind === "button" || field.kind === "link" || field.kind === "file" || field.kind === "other") {
    return assignment(field, NONE, 0.99);
  }
  const probe = readField(field);
  if (field.kind === "checkbox" && CONSENT.test(probe.label)) return assignment(field, NONE, 0.99);
  // Confident on purpose: the server skips the model on a confident none, so these are never even asked about.
  if (isDemographic(probe)) return assignment(field, NONE, 0.99);
  if (isSearchBox(field, probe)) return assignment(field, NONE, 0.95);

  const usable: Usable = (key) =>
    factKeys.includes(key) && (RULE_BY_KEY.get(key)?.kinds.includes(field.kind) ?? true) && !isAboutSomethingElse(key, probe);

  const structural = fromAutocomplete(field, usable);
  if (structural) return structural;
  if (field.kind === "textarea") return mapFreeText(field, probe.label, 0.8);
  const mapped = fromRules(field, probe, usable) ?? fromInputType(field, probe, usable);
  if (mapped) return mapped;
  if (field.kind === "text" && asksForProse(probe.label)) return mapFreeText(field, probe.label, 0.75);
  return assignment(field, NONE, UNKNOWN);
}

function asksForProse(label: string): boolean {
  if (label.length <= 20 || CLOSED_QUESTION.test(label)) return false;
  return FREE_TEXT_PROMPT.test(label) || /\?$/.test(label);
}

function mapFreeText(field: CapturedField, label: string, base: number): FieldAssignment {
  if (FACTUAL_PROMPT.test(label)) return assignment(field, NONE, UNKNOWN);
  const prompt = FREE_TEXT_PROMPT.test(label) || (field.kind === "textarea" && /\?$/.test(label));
  return assignment(field, NEEDS_TEXT, prompt && field.kind === "textarea" ? 0.92 : base);
}

function isFact(a: FieldAssignment): boolean {
  return a.factKey !== NONE && a.factKey !== NEEDS_TEXT;
}

/** A page whose only mappable field is an email is a newsletter box or a login, not a form to fill. */
function dropLoneEmail(assignments: FieldAssignment[]): FieldAssignment[] {
  const facts = assignments.filter(isFact);
  if (facts.length !== 1 || facts[0]?.factKey !== "email") return assignments;
  return assignments.map((a) => (isFact(a) ? { ...a, factKey: NONE, confidence: UNKNOWN } : a));
}

/** "Website" and "Other website" must not both get the same URL: a loose match yields to a standard one. */
function dropLooseDuplicates(assignments: FieldAssignment[]): FieldAssignment[] {
  const standard = new Set(assignments.filter((a) => isFact(a) && a.confidence >= 0.85).map((a) => a.factKey));
  return assignments.map((a) => (isFact(a) && a.confidence < 0.85 && standard.has(a.factKey) ? { ...a, factKey: NONE, confidence: UNKNOWN } : a));
}

export function mapFormHeuristically(fields: CapturedField[], factKeys: string[]): FieldAssignment[] {
  return dropLooseDuplicates(dropLoneEmail(fields.map((f) => mapFieldToFact(f, factKeys))));
}
