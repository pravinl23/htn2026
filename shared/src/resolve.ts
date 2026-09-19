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

function formatDateForField(field: CapturedField, iso: string): string | null {
  const d = parseIsoDate(iso);
  if (!d) return iso;
  if (field.kind === "month") return `${d.year}-${pad(d.month)}`;
  if (field.kind === "date") return `${d.year}-${pad(d.month)}-${pad(d.day ?? 1)}`;
  const label = normalize(field.label);
  if (field.kind === "number" || (/\byear\b/.test(label) && !/month|date/.test(label))) return String(d.year);
  return `${MONTHS[d.month - 1]} ${d.year}`;
}

function tokens(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter((t) => t.length > 1));
}

function overlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

/** Pick the option that best expresses a fact value. Returns null when nothing fits well. */
export function matchOption(options: FieldOption[], factValue: string): { option: FieldOption; score: number } | null {
  const real = options.filter((o) => o.value !== "" && !/^(select|choose|please|--)/i.test(o.label.trim()));
  const target = normalize(factValue);
  const wantsYes = YES.test(factValue.trim());
  const wantsNo = NO.test(factValue.trim());
  let best: { option: FieldOption; score: number } | null = null;
  for (const option of real) {
    const label = normalize(option.label);
    const value = normalize(option.value);
    let score = 0;
    if (label === target || value === target) score = 1;
    else if (wantsYes || wantsNo) {
      const first = label.split(" ")[0] ?? "";
      const firstValue = value.split(" ")[0] ?? "";
      if ((wantsYes && (YES.test(first) || YES.test(firstValue))) || (wantsNo && (NO.test(first) || NO.test(firstValue)))) score = 0.95;
    } else if (label && (label.includes(target) || target.includes(label))) score = 0.88;
    else score = overlap(label, target) >= 0.5 ? 0.6 + 0.25 * overlap(label, target) : 0;
    if (!best || score > best.score) best = { option, score };
  }
  return best && best.score >= 0.7 ? best : null;
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
  if (isDate) value = formatDateForField(field, factValue) ?? factValue;
  else if (field.kind === "date" || field.kind === "month") return null;
  else if (field.kind === "number" && !/^-?\d+(\.\d+)?$/.test(value)) return null;
  else if (field.kind === "url" && !/^https?:\/\//i.test(value)) value = `https://${value}`;
  return { action: "fill", value, displayText: value, confidenceFactor: 1 };
}
