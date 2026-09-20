import { isSensitive } from "@ghost/shared";
import type { PastAnswer, Profile } from "@ghost/shared";

export type ProfileParseResult = { ok: true; profile: Profile } | { ok: false; error: string };

const fail = (error: string): ProfileParseResult => ({ ok: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "creditCardNumber" and "extra.card_number" are read as words, the way a field label would be. */
export function looksSensitive(factKey: string): boolean {
  const words = factKey.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ");
  return isSensitive({ label: words });
}

export const SENSITIVE_FACT_ERROR = "looks sensitive. Ghost never stores passwords, card numbers, or government IDs.";

function parseFacts(raw: unknown): Record<string, string> | string {
  if (!isRecord(raw)) return '"facts" must be an object of string values.';
  const facts: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") return `Fact "${key}" must be a string.`;
    if (looksSensitive(key)) {
      return `Fact "${key}" ${SENSITIVE_FACT_ERROR}`;
    }
    facts[key] = value;
  }
  return facts;
}

function parsePastAnswers(raw: unknown): PastAnswer[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return '"pastAnswers" must be an array.';
  const answers: PastAnswer[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item) || typeof item.question !== "string" || typeof item.answer !== "string") {
      return `pastAnswers[${index}] needs string "question" and "answer".`;
    }
    const answer: PastAnswer = { question: item.question, answer: item.answer };
    if (typeof item.origin === "string") answer.origin = item.origin;
    if (typeof item.savedAt === "string") answer.savedAt = item.savedAt;
    answers.push(answer);
  }
  return answers;
}

export function parseProfileJson(text: string): ProfileParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw)) return fail('Profile must be an object like { "facts": { ... }, "pastAnswers": [] }.');
  const facts = parseFacts(raw.facts);
  if (typeof facts === "string") return fail(facts);
  const pastAnswers = parsePastAnswers(raw.pastAnswers);
  if (typeof pastAnswers === "string") return fail(pastAnswers);
  return { ok: true, profile: { facts, pastAnswers } };
}

export function formatProfile(profile: Profile): string {
  return JSON.stringify(profile, null, 2);
}

export function parseServerUrl(text: string): string | null {
  try {
    const url = new URL(text.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export interface FactRow {
  key: string;
  value: string;
}

export type FactsResult = { ok: true; facts: Record<string, string> } | { ok: false; error: string };

/** Letters first, then letters, digits, dot, dash or underscore: "firstName", "extra.languages". Max 64 (server limit). */
export const FACT_KEY = /^[A-Za-z][\w.-]{0,63}$/;

/** Rows of the key/value editor into facts. Entirely blank rows (a fresh "Add fact") are skipped. */
export function collectFacts(rows: FactRow[]): FactsResult {
  const facts: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value.trim()) continue;
    if (!key) return { ok: false, error: "Give every fact a name." };
    if (!FACT_KEY.test(key)) return { ok: false, error: `"${key}" is not a valid name. Use letters, digits, dots or dashes, starting with a letter.` };
    if (Object.hasOwn(facts, key)) return { ok: false, error: `Fact "${key}" appears twice.` };
    if (looksSensitive(key)) return { ok: false, error: `Fact "${key}" ${SENSITIVE_FACT_ERROR}` };
    facts[key] = row.value;
  }
  return { ok: true, facts };
}
