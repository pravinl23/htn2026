// Sourcing the graph from what the user already has (docs/profile-sources.md sections 2 and 3).
//
// This is the CODE half of the extraction pipeline: deterministic, offline, no model, no network. Given
// text or a JSON object the caller fetched through the user's own authorization — a GitHub profile, a
// vCard, a mail signature block, a personal site — it returns PROPOSALS. Nothing here writes to the graph:
// the user reviews proposals and accepts them (`applyProposals`), and `upsertFact` has the final say on
// conflicts and on sensitivity.
//
// Three promises: the fetched text is never kept (only the extracted value and a short evidence snippet),
// nothing sensitive is ever proposed, and every proposal names where it came from.
import { isSensitiveFact } from "./graph";
import { factDefFor, labelFromKey } from "./defs";
import { normalizeText } from "./text";
import type { FactProposal, FactSource } from "./types";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 7 to 15 digits, the way people write a phone number. Anything longer is not a phone and is left alone.
const PHONE = /(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{2,4}(?:[ .-]\d{2,4}){1,4}/g;
const URL = /https?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi;
const GITHUB_URL = /^https?:\/\/(www\.)?github\.com\/[^/\s]+\/?$/i;
const LINKEDIN_URL = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/\s]+\/?$/i;
const TWITTER_URL = /^https?:\/\/(www\.)?(twitter\.com|x\.com)\/[^/\s]+\/?$/i;
const SOCIAL = /(facebook|instagram|tiktok|youtube|medium|reddit|discord|slack)\.com/i;
/** "Software Engineer at Northwind Robotics", "Software Engineer, Northwind Robotics". */
const TITLE_AND_EMPLOYER = /^([A-Z][\w/&.+ -]{2,40}?)\s*(?:,|\bat\b|\||@)\s*([A-Z][\w&.,'+ -]{2,40})$/;

const MAX_EVIDENCE = 120;

function evidenceOf(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, MAX_EVIDENCE);
}

/** A proposal, with the label and aliases its key is known by, dropped if it turns out to be sensitive. */
function propose(key: string, value: string, source: FactSource, confidence: number, evidence?: string): FactProposal | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const def = factDefFor(key);
  const label = def?.label ?? labelFromKey(key);
  if (isSensitiveFact(key, label, def?.aliases ?? [], trimmed)) return null;
  const proposal: FactProposal = { key, value: trimmed, source, label, confidence, aliases: def?.aliases ?? [] };
  if (def?.category) proposal.category = def.category;
  if (evidence) proposal.evidence = evidenceOf(evidence);
  return proposal;
}

function push(into: FactProposal[], proposal: FactProposal | null): void {
  if (proposal && !into.some((existing) => existing.key === proposal.key)) into.push(proposal);
}

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

/** The first phone-shaped run of digits, if the text holds one at all. */
export function findPhone(text: string): string | null {
  for (const candidate of text.match(PHONE) ?? []) {
    const digits = digitsOf(candidate);
    if (digits.length < 7 || digits.length > 15) continue;
    // A date, a version or a money amount is not a phone number.
    if (/^\d{4}[ .-]\d{2}[ .-]\d{2}$/.test(candidate.trim())) continue;
    return candidate.trim();
  }
  return null;
}

export function findEmails(text: string): string[] {
  return [...new Set((text.match(EMAIL) ?? []).map((email) => email.replace(/[.,;:]$/, "")))];
}

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url.replace(/[.,;:)]+$/, "") : `https://${url.replace(/[.,;:)]+$/, "")}`;
}

/** Which link a URL is: the three Ghost has keys for, then a personal site, or nothing worth keeping. */
export function classifyLink(url: string): "github" | "linkedin" | "links.twitter" | "website" | null {
  const clean = normalizeUrl(url);
  if (GITHUB_URL.test(clean)) return "github";
  if (LINKEDIN_URL.test(clean)) return "linkedin";
  if (TWITTER_URL.test(clean)) return "links.twitter";
  if (SOCIAL.test(clean) || /github\.com|linkedin\.com/i.test(clean)) return null;
  return "website";
}

export interface GitHubProfile {
  login?: string;
  name?: string | null;
  email?: string | null;
  blog?: string | null;
  company?: string | null;
  location?: string | null;
  twitter_username?: string | null;
  bio?: string | null;
}

/**
 * A public GitHub profile, as its REST API returns it. The caller fetches it (no auth needed for a
 * username the user gave); this turns it into proposals.
 */
export function factsFromGitHubProfile(profile: GitHubProfile): FactProposal[] {
  const login = (profile.login ?? "").trim();
  if (login === "") return [];
  const source: FactSource = { kind: "github", login };
  const out: FactProposal[] = [];
  push(out, propose("github", `https://github.com/${login}`, source, 0.95, `github.com/${login}`));
  const name = (profile.name ?? "").trim();
  if (name !== "") {
    push(out, propose("fullName", name, source, 0.8, `name: ${name}`));
    const parts = name.split(/\s+/);
    if (parts.length === 2 && parts[0] && parts[1]) {
      push(out, propose("firstName", parts[0], source, 0.7, `name: ${name}`));
      push(out, propose("lastName", parts[1], source, 0.7, `name: ${name}`));
    }
  }
  if (profile.email) push(out, propose("email", profile.email, source, 0.85, `public email: ${profile.email}`));
  if (profile.blog && classifyLink(profile.blog) === "website") {
    push(out, propose("website", normalizeUrl(profile.blog), source, 0.8, `blog: ${profile.blog}`));
  }
  if (profile.company) push(out, propose("work.employer.current", profile.company.replace(/^@/, ""), source, 0.7, `company: ${profile.company}`));
  if (profile.location) push(out, propose("location", profile.location, source, 0.7, `location: ${profile.location}`));
  if (profile.twitter_username) {
    push(out, propose("links.twitter", `https://x.com/${profile.twitter_username}`, source, 0.8, `twitter: @${profile.twitter_username}`));
  }
  return out;
}

const VCARD_LINE = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/;

function vcardParam(params: string, name: string): string[] {
  return params
    .split(";")
    .filter((part) => part.toUpperCase().startsWith(`${name.toUpperCase()}=`) || (name === "TYPE" && /^(work|home|cell|voice|pref)$/i.test(part)))
    .flatMap((part) => (part.includes("=") ? (part.split("=")[1] ?? "") : part).split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * A vCard the user exported from their address book: the one file that already holds their address, and
 * the reason a shipping form can be filled at all.
 */
export function factsFromVCard(text: string, name = "contact.vcf"): FactProposal[] {
  const source: FactSource = { kind: "file", name };
  const out: FactProposal[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(VCARD_LINE);
    if (!m) continue;
    const field = (m[1] ?? "").toUpperCase();
    const params = m[2] ?? "";
    const value = (m[3] ?? "").trim();
    if (value === "") continue;
    const types = vcardParam(params, "TYPE");
    const evidence = evidenceOf(raw);
    if (field === "FN") push(out, propose("fullName", value, source, 0.9, evidence));
    if (field === "N") {
      const [last, first] = value.split(";");
      if (first) push(out, propose("firstName", first, source, 0.9, evidence));
      if (last) push(out, propose("lastName", last, source, 0.9, evidence));
    }
    if (field === "EMAIL") push(out, propose(types.includes("work") ? "contact.email.work" : "email", value, source, 0.9, evidence));
    if (field === "TEL") {
      const phone = findPhone(value);
      if (phone) push(out, propose("phone", phone, source, 0.9, evidence));
    }
    if (field === "ORG") push(out, propose("work.employer.current", (value.split(";")[0] ?? value).trim(), source, 0.85, evidence));
    if (field === "TITLE") push(out, propose("work.title", value, source, 0.85, evidence));
    if (field === "URL") {
      const kind = classifyLink(value);
      if (kind) push(out, propose(kind, normalizeUrl(value), source, 0.8, evidence));
    }
    if (field === "ADR") {
      // ADR is positional: po box; extended (unit); street; locality; region; postal code; country.
      const [, unit, street, city, region, postal, country] = value.split(";").map((part) => part.trim());
      if (street) push(out, propose("address.home.street", street, source, 0.9, evidence));
      if (unit) push(out, propose("address.home.unit", unit, source, 0.8, evidence));
      if (city) push(out, propose("city", city, source, 0.9, evidence));
      if (region) push(out, propose("province", region, source, 0.9, evidence));
      if (postal) push(out, propose("address.home.postalCode", postal, source, 0.9, evidence));
      if (country) push(out, propose("country", country, source, 0.9, evidence));
    }
  }
  return out;
}

export interface TextExtractOptions {
  /** The user's own name, when it is known: lets a signature line be read as "title at employer". */
  fullName?: string;
  /** Emails at other domains are still the user's, but score lower. */
  preferDomain?: string;
}

/**
 * Free text the user pointed Ghost at: a mail signature block, an "about" page, a bio. Only the things
 * code can read without guessing — addresses and prose are left to the LLM pass, which proposes into the
 * same review list. Confidence stays modest because a signature can hold someone else's details.
 */
export function factsFromText(text: string, source: FactSource, opts: TextExtractOptions = {}): FactProposal[] {
  const out: FactProposal[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const email of findEmails(text)) {
    const matchesDomain = opts.preferDomain ? email.toLowerCase().endsWith(`@${opts.preferDomain.toLowerCase()}`) : false;
    push(out, propose(matchesDomain ? "contact.email.work" : "email", email, source, matchesDomain ? 0.75 : 0.65, `found in the text: ${email}`));
  }

  for (const url of text.match(URL) ?? []) {
    const kind = classifyLink(url);
    if (kind) push(out, propose(kind, normalizeUrl(url), source, kind === "website" ? 0.6 : 0.75, `link: ${url}`));
  }

  const phoneLine = lines.find((line) => /\b(tel|phone|mobile|cell|m|t)\b[.:]?/i.test(line) && findPhone(line)) ?? lines.find((line) => findPhone(line));
  const phone = phoneLine ? findPhone(phoneLine) : null;
  if (phone) push(out, propose("phone", phone, source, 0.6, phoneLine ?? phone));

  const name = normalizeText(opts.fullName);
  for (const line of lines) {
    if (name !== "" && normalizeText(line) === name) {
      push(out, propose("fullName", line, source, 0.7, line));
      continue;
    }
    const m = line.match(TITLE_AND_EMPLOYER);
    if (!m || !m[1] || !m[2]) continue;
    push(out, propose("work.title", m[1].trim(), source, 0.6, line));
    push(out, propose("work.employer.current", m[2].trim(), source, 0.6, line));
  }
  return out;
}
