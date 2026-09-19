import { FACT_DESCRIPTIONS, isSensitive } from "@ghost/shared";
import { extractFactsByRegex, toYearMonth } from "../lib/resumeRegex";
import { LlmError, type LlmClient } from "./client";
import { extractMessages } from "./prompts";

export interface ExtractResult {
  facts: Record<string, string>;
  provider: string;
  latencyMs: number;
  fallbackFrom?: string;
}

const EXTRA_KEY = /^extra\.[A-Za-z][A-Za-z0-9_]{0,40}$/;
const MAX_EXTRAS = 12;
const MAX_VALUE_CHARS = 500;
const EXTRACT_TIMEOUT_MS = 20_000;
/** Contact details are cheap to hallucinate and easy to verify: the model's value must literally appear in the resume. */
const VERBATIM_KEYS = ["email", "github", "linkedin", "website"];
/** SSN (3-2-4) and SIN (3-3-3) shapes. Phone numbers are 3-3-4, so they do not match. */
const GOVERNMENT_ID = /\b\d{3}[- ]\d{2}[- ]\d{4}\b|\b\d{3}[- ]\d{3}[- ]\d{3}\b/;

export async function extractProfile(resumeText: string, client: LlmClient | undefined): Promise<ExtractResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const byRegex = extractFactsByRegex(resumeText);
  if (!client) return { facts: byRegex, provider: "regex", latencyMs: elapsed() };
  try {
    const raw = await client.chat({ messages: extractMessages(resumeText), maxTokens: 900, temperature: 0, json: true, timeoutMs: EXTRACT_TIMEOUT_MS });
    const byLlm = verifyAgainstResume(parseExtractedFacts(raw), resumeText);
    if (Object.keys(byLlm).length === 0) throw new LlmError("no usable facts");
    // Regex fills the gaps; the graduation date always comes from code when code could parse one.
    const facts = { ...byRegex, ...byLlm, ...(byRegex.graduationDate ? { graduationDate: byRegex.graduationDate } : {}) };
    return { facts, provider: client.name, latencyMs: elapsed() };
  } catch {
    return { facts: byRegex, provider: "regex", fallbackFrom: client.name, latencyMs: elapsed() };
  }
}

/** Accepts `{facts:{...}}` or a bare object, possibly wrapped in a code fence. Keeps only canonical keys plus `extra.*`. */
export function parseExtractedFacts(raw: string): Record<string, string> {
  const parsed = parseJsonObject(raw);
  const source = isRecord(parsed.facts) ? parsed.facts : parsed;
  const facts: Record<string, string> = {};
  let extras = 0;
  for (const [key, rawValue] of Object.entries(source)) {
    const value = cleanValue(rawValue);
    const known = Object.hasOwn(FACT_DESCRIPTIONS, key);
    if (!value || isSensitive({ name: key }) || !(known || EXTRA_KEY.test(key))) continue;
    if (!known && ++extras > MAX_EXTRAS) continue;
    facts[key] = value;
  }
  return normalizeGraduationDate(facts);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new LlmError("malformed response");
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  if (!isRecord(parsed)) throw new LlmError("malformed response");
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanValue(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") : "";
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_CHARS);
  if (!clean || GOVERNMENT_ID.test(clean)) return undefined;
  return /^(n\/?a|none|null|unknown|not (stated|specified|provided))$/i.test(clean) ? undefined : clean;
}

/** Models are unreliable with dates, so the model copies the date text and code turns it into YYYY-MM (or drops it). */
function normalizeGraduationDate(facts: Record<string, string>): Record<string, string> {
  const { graduationDate, ...rest } = facts;
  const parsed = graduationDate ? toYearMonth(graduationDate) : undefined;
  return parsed ? { ...rest, graduationDate: parsed } : rest;
}

function verifyAgainstResume(facts: Record<string, string>, resumeText: string): Record<string, string> {
  const haystack = resumeText.toLowerCase();
  const kept = { ...facts };
  for (const key of VERBATIM_KEYS) {
    const needle = kept[key]?.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
    if (needle !== undefined && !haystack.includes(needle)) delete kept[key];
  }
  return kept;
}
