// A stable, value-free, site-independent key for a question. Two sites asking the same thing must produce the
// same signature; two genuinely different questions must not collide. See docs/answers.md section 4.
import type { FieldKind, FieldOption } from "../types";
import { canonicalizeCountries, type QuestionField } from "./classify";

/**
 * Kinds are collapsed into families, because one ATS asks with a select what another asks with radios.
 * The family still separates a date question from a free-text one, whose answers are not interchangeable.
 */
export type KindFamily = "choice" | "boolean" | "text" | "number" | "date" | "other";

export function kindFamily(kind: FieldKind): KindFamily {
  if (kind === "select" || kind === "radio") return "choice";
  if (kind === "checkbox") return "boolean";
  if (kind === "number") return "number";
  if (kind === "date" || kind === "month") return "date";
  if (kind === "button" || kind === "link" || kind === "file" || kind === "other") return "other";
  return "text";
}

export interface SignatureOptions {
  /** The company name, when the client knows it: stripped wherever it appears. */
  company?: string;
}

// "(required)", a trailing asterisk and "select one" are chrome, not part of the question.
const BOILERPLATE = /\((?:\s*(?:required|optional|select one|choose one|check all that apply|if applicable)\s*)\)|\b(?:required|optional)\b|\*/gi;
// A trailing "at <Company>": the first word after "at" must be capitalized, so "at our office" survives.
const TRAILING_COMPANY = /\s+at\s+(?:[A-Z0-9][\w&.'’-]*)(?:\s+(?:[A-Z0-9][\w&.'’-]*|of|the|and|for|&))*\s*[?.!:]*\s*$/;
// "Viam - How did you hear about us?": a short leading label in front of a question.
const LEADING_LABEL = /^\s*([^:|–—-]{1,40}?)\s*[:|–—-]\s+(?=\S)/;
const STARTS_A_QUESTION =
  /^(how|what|why|which|when|where|who|whose|do|does|did|are|is|was|were|have|has|had|will|would|can|could|should|may|might|please|tell|describe|select|choose|would)\b/i;
const QUESTION_WORD = new RegExp(STARTS_A_QUESTION.source.replace(/^\^/, "\\b"), "i");

function stripCompanyName(text: string, company: string): string {
  const name = company.trim();
  if (name.length < 2) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\b${escaped}\\b('s)?`, "gi"), " ");
}

function stripLeadingLabel(text: string): string {
  const m = LEADING_LABEL.exec(text);
  if (!m) return text;
  const prefix = (m[1] ?? "").trim();
  const rest = text.slice(m[0].length);
  // Only a short label that is not itself part of the question, and only in front of an actual question.
  if (prefix === "" || prefix.split(/\s+/).length > 4 || QUESTION_WORD.test(prefix)) return text;
  return STARTS_A_QUESTION.test(rest.trim()) ? rest : text;
}

/**
 * The question as a key: company name gone, countries canonical ("U.S." and "the United States" alike,
 * Canada still different), punctuation collapsed, lowercased.
 */
export function normalizeQuestion(raw: string | undefined, opts: SignatureOptions = {}): string {
  let text = (raw ?? "").replace(/[‘’‛]/g, "'").replace(/[“”«»]/g, '"');
  if (opts.company) text = stripCompanyName(text, opts.company);
  text = text.replace(BOILERPLATE, " ").replace(/\s+/g, " ").trim();
  // Cross-ATS wording that changes tone, not meaning. Keeping it would strand a Greenhouse correction on
  // Greenhouse instead of reusing it on Amazon Jobs, Airbnb Careers, Lever or Workday.
  text = text.replace(/\blegally\b/gi, " ").replace(/\bfor any employer\b/gi, " ");
  text = stripLeadingLabel(text);
  text = text.replace(TRAILING_COMPANY, " ");
  text = canonicalizeCountries(text);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The options a user could actually pick: a placeholder row ("Select...", "--", an empty value) is not one. */
export function usableOptions(options: readonly FieldOption[] | undefined): FieldOption[] {
  return (options ?? []).filter((o) => o.value !== "" && !/^\s*(--+|select|choose|please|pick)\b/i.test(o.label));
}

function normalizeOption(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** FNV-1a, 8 hex characters. Deterministic across clients; nothing is ever reversed out of it. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Order-independent: two sites listing the same answers differently fingerprint the same. "" when there are none. */
export function optionsFingerprint(options: readonly FieldOption[] | undefined): string {
  const labels = [...new Set(usableOptions(options).map((o) => normalizeOption(o.label)).filter((l) => l !== ""))].sort();
  return labels.length === 0 ? "" : shortHash(labels.join(""));
}

/** Question text plus kind family, without the options. The fallback key when two sites word the options differently. */
export function questionTextSignature(field: QuestionField, opts: SignatureOptions = {}): string {
  return `${kindFamily(field.kind)}:${normalizeQuestion(field.label, opts)}`;
}

/** The full key: text signature plus a hash of the option labels when the question offers any. */
export function questionSignature(field: QuestionField, opts: SignatureOptions = {}): string {
  const base = questionTextSignature(field, opts);
  const fingerprint = optionsFingerprint(field.options);
  return fingerprint === "" ? base : `${base}#${fingerprint}`;
}

/** A question with no readable text is never learned: its signature would match anything worded like it. */
export function hasReadableQuestion(field: QuestionField, opts: SignatureOptions = {}): boolean {
  return normalizeQuestion(field.label, opts).replace(/\s/g, "").length >= 3;
}
