import type { ValueTransform } from "./types";

/** How a typed value relates to a page fact's text. "exact" needs no transform. */
export type MatchMode = "exact" | ValueTransform;

/** Tried in this order, so the weakest transform that explains the evidence wins. */
export const MATCH_MODES: readonly MatchMode[] = ["exact", "trim", "number", "date-iso"];

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const WEEKDAY_PREFIX = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i;
const CURRENCY = /\b(usd|cad|eur|gbp|aud|nzd|jpy|inr|chf)\b|[$€£¥₹]/gi;

const ISO_DATE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ].*)?$/;
const MONTH_FIRST = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i;
const DAY_FIRST = /^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})$/i;
const NUMERIC_DATE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function monthFromName(name: string): number | null {
  const key = name.toLowerCase();
  if (key.length < 3) return null;
  const index = MONTH_NAMES.findIndex((m) => m === key || m.slice(0, 3) === key || (key === "sept" && m === "september"));
  return index < 0 ? null : index + 1;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function toIso(year: number, month: number | null, day: number): string | null {
  if (month === null || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function fullYear(text: string): number {
  const n = Number(text);
  if (text.length === 4) return n;
  return n < 70 ? 2000 + n : 1900 + n;
}

function numericDate(m: RegExpExecArray, dayFirst: boolean): string | null {
  const first = Number(m[1]);
  const second = Number(m[3]);
  const year = fullYear(m[4] ?? "");
  // One fixed reading per separator. Guessing day-first from "15/03" would accept a day-first page here and then
  // misread its ambiguous rows (04/05) during replay, so an impossible month is null, not a flipped date.
  const dmy = dayFirst || m[2] === ".";
  return dmy ? toIso(year, second, first) : toIso(year, first, second);
}

/**
 * Dates are parsed in code, never by a model. Handles "2026-09-03", "Sep 3, 2026", "3 September 2026",
 * "Thu, Sep 3rd 2026", "09/03/2026" (always month first unless opts.dayFirst, dots always mean day first).
 */
export function parseDateToIso(text: string, opts: { dayFirst?: boolean } = {}): string | null {
  const s = collapse(text).replace(WEEKDAY_PREFIX, "").replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  let m = ISO_DATE.exec(s);
  if (m) return toIso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = MONTH_FIRST.exec(s);
  if (m) return toIso(Number(m[3]), monthFromName(m[1] ?? ""), Number(m[2]));
  m = DAY_FIRST.exec(s);
  if (m) return toIso(Number(m[3]), monthFromName(m[2] ?? ""), Number(m[1]));
  m = NUMERIC_DATE.exec(s);
  return m ? numericDate(m, opts.dayFirst ?? false) : null;
}

function plainDigits(s: string): string | null {
  if (/^\d+(\.\d+)?$/.test(s)) return s;
  if (/^\.\d+$/.test(s)) return `0${s}`;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return s.replace(/,/g, "");
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s) || /^\d{1,3}(\.\d{3}){2,}$/.test(s)) return s.replace(/\./g, "").replace(",", ".");
  if (/^\d+,\d{1,2}$/.test(s)) return s.replace(",", ".");
  return null;
}

/** "$1,204.50" -> "1204.50", "(1.204,50 EUR)" -> "-1204.50". Keeps the source's decimals. Null when not purely numeric. */
export function canonicalNumberString(text: string): string | null {
  let s = text.trim().replace(/\u2212/g, "-"); // typographic minus, common in rendered tables
  let negative = false;
  if (/^\(.+\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(CURRENCY, "").replace(/\s+/g, "");
  if (s.startsWith("-") || s.startsWith("+")) {
    if (s.startsWith("-")) negative = !negative;
    s = s.slice(1);
  }
  const digits = plainDigits(s);
  if (digits === null) return null;
  return negative && Number(digits) !== 0 ? `-${digits}` : digits;
}

export function parseLooseNumber(text: string): number | null {
  const canonical = canonicalNumberString(text);
  return canonical === null ? null : Number(canonical);
}

function sameNumber(a: string, b: string): boolean {
  const x = parseLooseNumber(a);
  const y = parseLooseNumber(b);
  return x !== null && y !== null && Math.abs(x - y) < 1e-9;
}

/** The date transform always writes ISO, so it only explains a value the user also typed as ISO: replay must reproduce the user's own text. */
function explainsDate(typed: string, factText: string): boolean {
  const iso = parseDateToIso(factText);
  return iso !== null && iso === collapse(typed);
}

/** Does `factText` explain the value the user typed, under this mode? Empty values never match. */
export function matchesUnder(typed: string, factText: string, mode: MatchMode): boolean {
  if (typed.trim() === "" || factText.trim() === "") return false;
  if (mode === "exact") return typed === factText;
  if (mode === "trim") return collapse(typed).toLowerCase() === collapse(factText).toLowerCase();
  if (mode === "number") return sameNumber(typed, factText);
  return explainsDate(typed, factText);
}

/** Weakest mode under which the fact explains the typed value, or null. */
export function matchValue(typed: string, factText: string): { mode: MatchMode; transform?: ValueTransform } | null {
  for (const mode of MATCH_MODES) {
    if (!matchesUnder(typed, factText, mode)) continue;
    return mode === "exact" ? { mode } : { mode, transform: mode };
  }
  return null;
}

/** What the executor and the dry run write for a fact's text. Null when the text cannot be transformed. */
export function applyTransform(text: string, transform: ValueTransform | undefined): string | null {
  if (transform === undefined) return text;
  if (transform === "trim") return collapse(text);
  if (transform === "number") return canonicalNumberString(text);
  return parseDateToIso(text);
}
