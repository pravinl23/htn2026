// Match any field against the fact graph.
//
// The whole point of the graph: this function knows nothing about résumés, job forms or key names. It
// compares what the field CALLS itself (accessible name, name/id, placeholder, autocomplete token) with
// what each fact calls itself (label and aliases). A shipping form, a support ticket, a conference signup
// and an address book entry all go through this one path, and a new fact works everywhere the moment it
// is stored.
//
// Discipline: a wrong ghost is worse than no ghost. Two facts that fit equally well, a leftover word that
// changes whose detail is being asked for, or a label that also names another fact, come back UNDER the
// default gate rather than as a guess. Guessing is the answer engine's job (docs/answers.md); the
// mapper's job is to be right, or to say that it is not sure.
import { isSensitive } from "../sensitive";
import type { CapturedField, FieldKind } from "../types";
import { kindsForFact } from "./defs";
import { matchableFacts } from "./graph";
import { OTHER_PARTY, OTHER_PARTY_SECTION, containsWords, leftoverWords, normalizeText, wordsOf } from "./text";
import type { Fact, FactCategory, FactGraph, FactMatch } from "./types";

/** A standard autocomplete token says what the field wants outright. */
export const AUTOCOMPLETE_CONFIDENCE = 0.97;
/** The field's name IS the fact's name. */
export const EXACT_CONFIDENCE = 0.95;
/** The field's name contains the fact's name ("Shipping postal code"). */
export const PHRASE_CONFIDENCE = 0.9;
/** Under the default 0.7 gate on purpose: offered to a model or a human, never fired as a ghost on its own. */
export const AMBIGUOUS_CONFIDENCE = 0.6;
/** A name/id/placeholder said it rather than the label. */
const HINT_PENALTY = 0.08;
/** Each word the fact's name does not account for ("SHIPPING postal code"). */
const LEFTOVER_PENALTY = 0.06;
const MAX_LEFTOVER_PENALTY = 0.24;

const NOT_FILLABLE: readonly FieldKind[] = ["button", "link", "file", "other"];

/** Words a label carries around a fact without changing which fact it is. */
const FILLER = new Set(
  "your my our please enter provide type the a an of and or is what field input form info information details value here required optional eg e g example format number no num txt text box data entry line shipping delivery mailing".split(
    " ",
  ),
);

/** Words that change WHOSE detail, or WHICH of several, is being asked for. They cap a match below the gate. */
const DOUBT = new Set(
  "work business corporate company employer school student university alternate alternative secondary backup recovery other others additional previous prior past last former old new emergency reference references spouse partner parent guardian manager recipient billing".split(
    " ",
  ),
);

/** Categories that describe the user personally: a label about someone else must not take one. */
const PERSONAL: readonly FactCategory[] = ["identity", "contact", "address", "links"];

/** Standard autocomplete tokens, expressed as the phrasing a fact would use. Sensitive tokens are absent. */
const AUTOCOMPLETE_PHRASES: Record<string, string> = {
  "given-name": "first name",
  "family-name": "last name",
  name: "full name",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "street-address": "street address",
  "address-line1": "street address",
  "address-line2": "apartment or suite",
  "address-level2": "city",
  "address-level1": "province",
  "postal-code": "postal code",
  country: "country",
  "country-name": "country",
  organization: "employer",
  "organization-title": "job title",
  url: "website",
};

/** Tokens that mean "this is a credential or a login": no fact belongs here, whatever the label says. */
const BLOCKED_AUTOCOMPLETE = /^(username|current-password|new-password|one-time-code|cc-|bday|sex)/;

export interface MatchOptions {
  /** Drop anything under this. Default 0.5, so a caller can see the near-misses and decide. */
  min?: number;
  /** How many matches to return. Default 5. */
  limit?: number;
  /** Restrict to these fact keys (what the caller is offering). Default: every non-sensitive fact. */
  keys?: readonly string[];
}

interface Probe {
  label: string;
  idents: string[];
  placeholder: string;
  context: string;
  autocomplete: string[];
}

function readProbe(field: CapturedField): Probe {
  return {
    label: normalizeText(field.label),
    idents: [field.name, field.id].map(normalizeText).filter((text) => text !== ""),
    placeholder: normalizeText(field.placeholder),
    context: normalizeText(field.context),
    autocomplete: (field.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean),
  };
}

/** Every phrasing a fact answers to, longest first so "work email" is tried before "email". */
function phrasesOf(fact: Fact): string[][] {
  const seen = new Set<string>();
  const phrases: string[][] = [];
  for (const text of [fact.label, ...fact.aliases]) {
    const words = wordsOf(normalizeText(text));
    const id = words.join(" ");
    if (words.length === 0 || seen.has(id)) continue;
    seen.add(id);
    phrases.push(words);
  }
  return phrases.sort((a, b) => b.length - a.length);
}

/**
 * Head word ("postal CODE", "work EMAIL") -> the facts that own it. A leftover head word means the label
 * names a second fact too ("Email address" is not the street address), which makes the match a guess.
 */
function headIndex(facts: readonly Fact[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const fact of facts) {
    for (const phrase of phrasesOf(fact)) {
      const head = phrase[phrase.length - 1];
      if (!head || FILLER.has(head)) continue;
      const owners = index.get(head) ?? new Set<string>();
      owners.add(fact.key);
      index.set(head, owners);
    }
  }
  return index;
}

function namesAnotherFact(leftover: readonly string[], key: string, heads: Map<string, Set<string>>): boolean {
  return leftover.some((word) => {
    const owners = heads.get(word);
    return owners ? [...owners].some((owner) => owner !== key) : false;
  });
}

function fitsKind(fact: Fact, kind: FieldKind): boolean {
  return (fact.kinds ?? kindsForFact(fact.value, fact.category)).includes(kind);
}

/** Shared words over the larger set: enough to say "these might be the same thing", never enough to fill. */
function overlap(a: readonly string[], b: readonly string[]): number {
  const wide = new Set(a);
  const narrow = new Set(b);
  let shared = 0;
  for (const word of narrow) if (wide.has(word)) shared++;
  return shared / Math.max(wide.size, narrow.size);
}

interface Hit {
  confidence: number;
  why: string;
}

interface PhraseContext {
  key: string;
  personal: boolean;
  context: string;
  heads: Map<string, Set<string>>;
  /** name and id are machine words: an extra word means they are about something else ("email_coupon"). */
  strict: boolean;
}

function scorePhrase(source: readonly string[], phrase: readonly string[], ctx: PhraseContext): Hit | null {
  // The veto reads the leftover words as written ("next OF kin"); the score ignores the filler in them.
  const rest = leftoverWords(source, phrase);
  const leftover = rest.filter((word) => !FILLER.has(word));
  if (containsWords(source, phrase)) {
    if (ctx.personal && (OTHER_PARTY.test(rest.join(" ")) || OTHER_PARTY_SECTION.test(ctx.context))) return null;
    if (source.length === phrase.length) return { confidence: EXACT_CONFIDENCE, why: "the field is named after this fact" };
    if (ctx.strict && leftover.length > 0) return null;
    if (leftover.some((word) => DOUBT.has(word))) return { confidence: AMBIGUOUS_CONFIDENCE, why: "the label may mean a different one of these" };
    if (namesAnotherFact(leftover, ctx.key, ctx.heads)) return { confidence: AMBIGUOUS_CONFIDENCE, why: "the label names another fact too" };
    return {
      confidence: PHRASE_CONFIDENCE - Math.min(MAX_LEFTOVER_PENALTY, LEFTOVER_PENALTY * leftover.length),
      why: "the field's name contains this fact's name",
    };
  }
  if (ctx.strict || phrase.length < 2) return null;
  if (ctx.personal && (OTHER_PARTY.test(source.join(" ")) || OTHER_PARTY_SECTION.test(ctx.context))) return null;
  return overlap(source, phrase) >= 0.6 ? { confidence: AMBIGUOUS_CONFIDENCE, why: "the wording only partly matches" } : null;
}

function best(a: Hit | null, b: Hit | null): Hit | null {
  if (!a) return b;
  if (!b) return a;
  return b.confidence > a.confidence ? b : a;
}

function scoreFact(fact: Fact, probe: Probe, field: CapturedField, heads: Map<string, Set<string>>): Hit | null {
  if (!fitsKind(fact, field.kind)) return null;
  const phrases = phrasesOf(fact);
  const base = { key: fact.key, personal: PERSONAL.includes(fact.category), context: probe.context, heads };
  let hit: Hit | null = null;

  for (const token of probe.autocomplete) {
    const phrase = AUTOCOMPLETE_PHRASES[token];
    if (!phrase) continue;
    const wanted = wordsOf(normalizeText(phrase)).join(" ");
    if (phrases.some((p) => p.join(" ") === wanted)) {
      hit = best(hit, { confidence: AUTOCOMPLETE_CONFIDENCE, why: `the field's autocomplete token is "${token}"` });
    }
  }

  const label = wordsOf(probe.label);
  for (const phrase of phrases) hit = best(hit, scorePhrase(label, phrase, { ...base, strict: false }));

  // The placeholder reads like a label; name and id are machine words. Both score under the label itself.
  const hints = [{ words: wordsOf(probe.placeholder), strict: false }, ...probe.idents.map((ident) => ({ words: wordsOf(ident), strict: true }))];
  for (const source of hints) {
    if (source.words.length === 0) continue;
    for (const phrase of phrases) {
      const scored = scorePhrase(source.words, phrase, { ...base, strict: source.strict });
      if (scored) hit = best(hit, { confidence: Math.max(0, scored.confidence - HINT_PENALTY), why: scored.why });
    }
  }
  return hit;
}

/**
 * Rank the facts that could fill this field, best first.
 * Returns nothing at all for a sensitive field, for a credential field, and for anything that is not a
 * fillable input. Sensitive FACTS are never offered, whatever the field asks.
 */
export function matchFieldToFacts(field: CapturedField, graph: FactGraph, opts: MatchOptions = {}): FactMatch[] {
  const min = opts.min ?? 0.5;
  const limit = opts.limit ?? 5;
  if (NOT_FILLABLE.includes(field.kind)) return [];
  const probe = readProbe(field);
  if (
    isSensitive({
      inputType: field.inputType,
      autocomplete: field.autocomplete,
      name: field.name,
      id: field.id,
      label: field.label,
      placeholder: field.placeholder,
    })
  ) {
    return [];
  }
  if (probe.autocomplete.some((token) => BLOCKED_AUTOCOMPLETE.test(token))) return [];

  const facts = matchableFacts(graph).filter((fact) => !opts.keys || opts.keys.includes(fact.key));
  const heads = headIndex(facts);
  const matches: FactMatch[] = [];
  for (const fact of facts) {
    const hit = scoreFact(fact, probe, field, heads);
    if (hit && hit.confidence >= min) matches.push({ key: fact.key, confidence: hit.confidence, why: hit.why });
  }
  matches.sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));

  // Two facts that fit equally well are a coin flip. Say so instead of flipping it. Two facts holding the
  // same value are not a coin flip: either one writes the same thing.
  const [first, second] = matches;
  const sameValue = first && second && normalizeText(graph.facts[first.key]?.value) === normalizeText(graph.facts[second.key]?.value);
  if (first && second && !sameValue && first.confidence - second.confidence < 0.02 && first.confidence > AMBIGUOUS_CONFIDENCE) {
    for (const m of [first, second]) {
      m.confidence = AMBIGUOUS_CONFIDENCE;
      m.why = "two facts fit this field equally well";
    }
  }
  return matches.filter((m) => m.confidence >= min).slice(0, limit);
}

/** The single best fact for a field, or null when nothing clears `min` (default: the 0.7 gate). */
export function bestFactForField(field: CapturedField, graph: FactGraph, min = 0.7): FactMatch | null {
  return matchFieldToFacts(field, graph, { min, limit: 1 })[0] ?? null;
}

/** The heuristic re-uses this to decide whether a label about someone else rules a fact out. */
export function isPersonalCategory(category: FactCategory): boolean {
  return PERSONAL.includes(category);
}
