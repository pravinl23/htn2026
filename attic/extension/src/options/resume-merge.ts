// Pure logic behind the resume review table: what the server proposed -> rows -> merged profile.
import { FACT_DESCRIPTIONS } from "@ghost/shared";
import type { Profile } from "@ghost/shared";
import { FACT_KEY, looksSensitive } from "./validate";

export interface ReviewRow {
  key: string;
  /** Human description for canonical keys; "" for extra.* keys. */
  description: string;
  current: string;
  proposed: string;
  checked: boolean;
  canonical: boolean;
  /** The profile already holds exactly this value: nothing to merge, the checkbox is disabled. */
  unchanged: boolean;
}

const MAX_VALUE_CHARS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonical(key: string): boolean {
  return Object.hasOwn(FACT_DESCRIPTIONS, key);
}

function toRow(key: string, raw: unknown, current: Record<string, string>): ReviewRow | null {
  if (typeof raw !== "string" || !FACT_KEY.test(key) || looksSensitive(key)) return null;
  const proposed = raw.trim().slice(0, MAX_VALUE_CHARS);
  if (!proposed) return null;
  const canonical = isCanonical(key);
  const existing = Object.hasOwn(current, key) ? (current[key] ?? "") : "";
  const unchanged = existing === proposed;
  return { key, description: canonical ? (FACT_DESCRIPTIONS[key] ?? "") : "", current: existing, proposed, canonical, unchanged, checked: canonical && !unchanged };
}

function rank(row: ReviewRow, canonicalOrder: string[]): number {
  return row.canonical ? canonicalOrder.indexOf(row.key) : canonicalOrder.length;
}

/**
 * Canonical facts first (in FACT_DESCRIPTIONS order, checked unless unchanged), then extra.* and anything
 * else the server invented (unchecked). Sensitive-looking keys, non-strings and blanks never become rows.
 */
export function buildReviewRows(current: Record<string, string>, proposed: unknown): ReviewRow[] {
  if (!isRecord(proposed)) return [];
  const order = Object.keys(FACT_DESCRIPTIONS);
  const rows: ReviewRow[] = [];
  for (const [key, value] of Object.entries(proposed)) {
    const row = toRow(key, value, current);
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => rank(a, order) - rank(b, order) || a.key.localeCompare(b.key));
}

export function selectedRows(rows: ReviewRow[]): ReviewRow[] {
  return rows.filter((row) => row.checked && !row.unchanged && row.proposed.trim() !== "");
}

/** Checked rows overwrite or add facts; everything else in the profile (other facts, past answers) is kept. */
export function mergeReviewRows(profile: Profile, rows: ReviewRow[]): Profile {
  const facts = { ...profile.facts };
  for (const row of selectedRows(rows)) facts[row.key] = row.proposed.trim().slice(0, MAX_VALUE_CHARS);
  return { facts, pastAnswers: [...profile.pastAnswers] };
}
