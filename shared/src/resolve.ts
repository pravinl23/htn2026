import { normalize } from "./heuristic";
import type { CapturedField, FieldOption, GhostAction } from "./types";

export interface ResolvedValue {
  action: GhostAction;
  value: string;
  displayText: string;
  /** Multiplied into the assignment confidence (option matching can be fuzzy). */
  confidenceFactor: number;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const YES = /^(y|yes|true|1)$/i;
const NO = /^(n|no|false|0)$/i;

/** Dates are parsed in code, never by a model. Accepts "YYYY-MM" or "YYYY-MM-DD". */
export function parseIsoDate(iso: string): { year: number; month: number; day?: number } | null {
  const m = iso.trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return m[3] ? { year, month, day: Number(m[3]) } : { year, month };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Null when the field wants more than the fact knows: a day of the month is never invented. */
function formatDateForField(field: CapturedField, iso: string): string | null {
  const d = parseIsoDate(iso);
  if (!d) return iso;
  if (field.kind === "month") return `${d.year}-${pad(d.month)}`;
  if (field.kind === "date") return d.day === undefined ? null : `${d.year}-${pad(d.month)}-${pad(d.day)}`;
  const label = normalize(field.label);
  if (field.kind === "number" || (/\byear\b/.test(label) && !/month|date/.test(label))) return String(d.year);
  return `${MONTHS[d.month - 1]} ${d.year}`;
}

const STOPWORDS = new Set(["of", "the", "and", "in", "at", "for", "to", "or", "an"]);
const YES_WORD = /^(y|yes|true)$/i;
const NO_WORD = /^(n|no|false)$/i;

function words(text: string): string[] {
  return normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function keywords(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length > 1 && !STOPWORDS.has(w)));
}

/** Shared keywords over the LARGER set: "University of Toronto" is not "University of Waterloo". */
function overlap(a: string, b: string): number {
  const ta = keywords(a);
  const tb = keywords(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

/** Whole words in order, never substrings: the state code "AR" is not inside "Ontario". */
function containsWords(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, j) => haystack[i + j] === w)) return true;
  }
  return false;
}

function containmentScore(label: string, target: string): number {
  const lw = words(label);
  const tw = words(target);
  if (containsWords(lw, tw)) return 0.88; // "Hack the North 2026" says "Hack the North"
  // The option is only part of the fact: it must carry most of it ("University" is not "University of Waterloo").
  return containsWords(tw, lw) && overlap(label, target) > 0.5 ? 0.88 : 0;
}

/** Yes/no reads the option's first word, or a 1/0 style VALUE ("1-2 years" is not a yes). */
function yesNoScore(option: FieldOption, wantsYes: boolean): number {
  const word = wantsYes ? YES_WORD : NO_WORD;
  const first = words(option.label)[0] ?? "";
  const value = option.value.trim();
  return word.test(first) || (wantsYes ? YES : NO).test(value) ? 0.95 : 0;
}

function optionScore(option: FieldOption, factValue: string): number {
  const target = normalize(factValue);
  const label = normalize(option.label);
  if (label === target || normalize(option.value) === target) return 1;
  const wantsYes = YES.test(factValue.trim());
  if (wantsYes || NO.test(factValue.trim())) return yesNoScore(option, wantsYes);
  const contained = containmentScore(label, target);
  if (contained > 0) return contained;
  const shared = overlap(label, target);
  return shared >= 0.6 ? 0.6 + 0.25 * shared : 0;
}

/** Pick the option that best expresses a fact value. Null when nothing fits well, or when two options fit equally. */
export function matchOption(options: FieldOption[], factValue: string): { option: FieldOption; score: number } | null {
  const real = options.filter((o) => o.value !== "" && !/^(select|choose|please|--)/i.test(o.label.trim()));
  const scored = real.map((option) => ({ option, score: optionScore(option, factValue) })).sort((a, b) => b.score - a.score);
  const [best, runnerUp] = scored;
  if (!best || best.score < 0.7) return null;
  // "Yes, as a citizen" vs "Yes, with a permit": picking one would be a guess. Exact duplicates are the same answer.
  if (runnerUp && runnerUp.score === best.score && best.score < 1) return null;
  return best;
}

function resolveDateOption(field: CapturedField, iso: string): ResolvedValue | null {
  const d = parseIsoDate(iso);
  if (!d || !field.options) return null;
  const label = normalize(field.label);
  const candidates = /month/.test(label) && !/year/.test(label)
    ? [MONTHS[d.month - 1]!, pad(d.month), String(d.month)]
    : [`${MONTHS[d.month - 1]} ${d.year}`, String(d.year)];
  for (const c of candidates) {
    const hit = matchOption(field.options, c);
    if (hit) return { action: "select", value: hit.option.value, displayText: hit.option.label, confidenceFactor: hit.score };
  }
  return null;
}

/** Assignments may come from a model: a name never goes into an email input, nor prose into a phone or url input. */
function fitsInputType(kind: CapturedField["kind"], value: string): boolean {
  if (kind === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (kind === "tel") return /\d{3}/.test(value.replace(/\D/g, "")) && !/[a-z]{4}/i.test(value);
  if (kind === "url") return /^[^\s@]+\.[^\s@]+$/.test(value);
  return true;
}

/** Turn a fact value into the concrete thing to write into this field. Null when it cannot be expressed. */
export function resolveFieldValue(field: CapturedField, factKey: string, factValue: string): ResolvedValue | null {
  if (!factValue) return null;
  const isDate = parseIsoDate(factValue) !== null && /date|graduat/i.test(factKey);

  if (field.kind === "select" || field.kind === "radio") {
    if (isDate) return resolveDateOption(field, factValue);
    const hit = matchOption(field.options ?? [], factValue);
    if (!hit) return null;
    return { action: "select", value: hit.option.value, displayText: hit.option.label, confidenceFactor: hit.score };
  }
  if (field.kind === "checkbox") {
    if (!YES.test(factValue) && !NO.test(factValue)) return null;
    const checked = YES.test(factValue);
    return { action: "check", value: String(checked), displayText: checked ? "✓" : "☐", confidenceFactor: 0.9 };
  }
  if (field.kind === "file" || field.kind === "button" || field.kind === "link" || field.kind === "other") return null;

  let value = factValue;
  if (isDate) {
    const formatted = formatDateForField(field, factValue);
    if (formatted === null) return null;
    value = formatted;
  } else if (field.kind === "date" || field.kind === "month") return null;
  else if (field.kind === "number" && !/^-?\d+(\.\d+)?$/.test(value)) return null;
  else if (!fitsInputType(field.kind, value)) return null;
  else if (field.kind === "url" && !/^https?:\/\//i.test(value)) value = `https://${value}`;
  return { action: "fill", value, displayText: value, confidenceFactor: 1 };
}
