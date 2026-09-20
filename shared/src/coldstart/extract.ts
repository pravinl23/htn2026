// Cold start, the extractors (docs/cold-start.md sections 2 and 3, docs/profile-sources.md section 3). Pure: every
// function here takes text plus metadata the caller has ALREADY read, and returns proposals for the fact graph in
// shared/src/facts. No file system, no network, no model call — the LLM path (server/src/llm/profileExtract.ts) is
// for documents these rules cannot read, and is never duplicated here.
//
// Two invariants hold for every extractor:
//   1. Nothing is proposed that has not passed sensitiveScan.classifyCandidate; what is dropped is COUNTED.
//   2. A document that reads like instructions rather than like a person is dropped whole (prompt injection): these
//      extractors only run regexes, so an instruction cannot execute, but a planted "fact" must not be proposed.
import { factDefFor, kindsForFact, labelFromKey } from "../facts/defs";
import type { FactCategory, FactProposal, FactSource } from "../facts/types";
import type { FieldKind } from "../types";
import type { ColdStartSourceKind } from "./plan";
import { looksLikeDirective, type SensitiveReason, type SkippedCounts } from "../facts/sensitivity";
import { classifyCandidate, sensitiveDocumentText } from "./sensitiveScan";
import type { PathKind } from "./sensitiveScan";

/**
 * What an extractor produces: the graph's own proposal shape, with the parts cold start always knows filled in, plus
 * where it came from and how many documents agreed. It is accepted anywhere a `FactProposal` is.
 */
export interface ColdStartProposal extends FactProposal {
  category: FactCategory;
  label: string;
  aliases: string[];
  confidence: number;
  kinds: readonly FieldKind[];
  /** Which cold-start source produced it, so "forget this source" can remove exactly its facts. */
  sourceKind: ColdStartSourceKind;
  /** How many independent documents proposed the same key and value. */
  support: number;
}

export interface ProposalOrigin {
  source: FactSource;
  sourceKind: ColdStartSourceKind;
}

export interface ExtractionResult {
  proposals: ColdStartProposal[];
  /** How many candidates were dropped before becoming proposals. */
  skipped: number;
  skippedCounts: SkippedCounts;
  /** Set when the whole document was refused, with the reason code. */
  refused?: SensitiveReason;
}

const EMPTY: ExtractionResult = { proposals: [], skipped: 0, skippedCounts: {} };

function refuse(reason: SensitiveReason): ExtractionResult {
  return { proposals: [], skipped: 1, skippedCounts: { [reason]: 1 }, refused: reason };
}

// ---------------------------------------------------------------------------------------------------------------
// Keys: shared/src/facts/defs.ts is the vocabulary. These fill the gaps it does not define — the slots a contact
// card has and a job form does not (a work address, a home phone, a GitHub login).
// ---------------------------------------------------------------------------------------------------------------

const SLOT = "<slot>";

interface KeyMeta {
  category: FactCategory;
  label: string;
  aliases: string[];
}

const EXTRA_META: Record<string, KeyMeta> = {
  "identity.middleName": { category: "identity", label: "middle name", aliases: ["middle initial"] },
  "identity.nickname": { category: "identity", label: "preferred name", aliases: ["nickname", "goes by", "preferred first name"] },
  "contact.phone.work": { category: "contact", label: "work phone", aliases: ["office phone", "business phone", "phone number"] },
  "contact.phone.home": { category: "contact", label: "home phone", aliases: ["phone number", "landline", "home number"] },
  "contact.phone.main": { category: "contact", label: "main phone", aliases: ["phone number"] },
  [`address.${SLOT}.street`]: { category: "address", label: "street address", aliases: ["address", "address line 1", "street"] },
  [`address.${SLOT}.unit`]: { category: "address", label: "apartment or suite", aliases: ["address line 2", "unit", "suite", "apt"] },
  [`address.${SLOT}.city`]: { category: "address", label: "city", aliases: ["town", "locality"] },
  [`address.${SLOT}.province`]: { category: "address", label: "province", aliases: ["state", "region", "county"] },
  [`address.${SLOT}.postalCode`]: { category: "address", label: "postal code", aliases: ["zip", "zip code", "postcode"] },
  [`address.${SLOT}.country`]: { category: "address", label: "country", aliases: ["country of residence"] },
  "work.department": { category: "work", label: "department", aliases: ["team", "division"] },
  "work.skills": { category: "work", label: "skills", aliases: ["technical skills", "technologies", "key skills"] },
  "links.github.login": { category: "links", label: "github username", aliases: ["github handle", "github login", "github id"] },
  "links.gitlab": { category: "links", label: "gitlab", aliases: ["gitlab profile", "gitlab url"] },
  "links.bitbucket": { category: "links", label: "bitbucket", aliases: ["bitbucket profile", "bitbucket url"] },
  "org.github": { category: "org", label: "github organisation", aliases: ["github org", "organisation", "organization"] },
};

const ADDRESS_SLOT = /^address\.([^.]+)\./;
/** Slots the graph already defines ("address.home.*"): their definitions win, so the labels stay identical. */
const DEFINED_SLOTS = new Set(["home"]);

/** How a key is phrased. The graph's own definition first; then cold start's extras; then the key itself. */
export function describeKey(key: string): KeyMeta {
  const defined = factDefFor(key);
  if (defined) return { category: defined.category, label: defined.label, aliases: [...defined.aliases] };
  const slotMatch = ADDRESS_SLOT.exec(key);
  const slot = slotMatch?.[1];
  const lookup = slot ? key.replace(ADDRESS_SLOT, `address.${SLOT}.`) : key;
  const extra = EXTRA_META[lookup] ?? EXTRA_META[stripIndex(lookup)];
  if (!extra) return { category: categoryOf(key), label: labelFromKey(stripIndex(key)), aliases: [] };
  if (!slot || slot === "other" || DEFINED_SLOTS.has(slot)) return { ...extra, aliases: [...extra.aliases] };
  return { category: extra.category, label: `${slot} ${extra.label}`, aliases: [extra.label, ...extra.aliases] };
}

/** "contact.email.2" is the second untyped email, and shares the first one's phrasing. */
function stripIndex(key: string): string {
  return key.replace(/\.\d+$/, "");
}

const CATEGORY_BY_PREFIX: Record<string, FactCategory> = {
  identity: "identity",
  contact: "contact",
  address: "address",
  work: "work",
  education: "education",
  links: "links",
  org: "org",
  preferences: "preferences",
  travel: "travel",
};

function categoryOf(key: string): FactCategory {
  return CATEGORY_BY_PREFIX[key.split(".")[0] ?? ""] ?? "other";
}

// ---------------------------------------------------------------------------------------------------------------
// Proposal building: the one place the sensitivity gate is applied, so no extractor can bypass it.
// ---------------------------------------------------------------------------------------------------------------

const MAX_VALUE = 200;
const MAX_EVIDENCE = 90;

export function cleanValue(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE);
}

export function snippet(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length <= MAX_EVIDENCE ? text : `${text.slice(0, MAX_EVIDENCE - 1)}…`;
}

interface DraftFact {
  key: string;
  value: string;
  confidence: number;
  evidence?: string;
  /** Overrides the derived label, for a candidate whose phrasing the extractor knows better. */
  label?: string;
}

const PATH_KIND_OF: Record<ColdStartSourceKind, PathKind> = {
  spotlight: "unknown",
  // The machine sources read a preference file or a name, never a document, so nothing they touch is a candidate
  // for the document gate: they propose no fact at all and are listed here only to keep the map total.
  dock: "config",
  "login-items": "config",
  "recent-apps": "unknown",
  "recent-docs": "unknown",
  "app-inventory": "config",
  contacts: "contact-card",
  resume: "document",
  "browser-history": "database",
  calendar: "unknown",
  mail: "message",
  projects: "config",
};

interface BuildOptions {
  /** Mail signatures are the ONLY part of a message that may be read (docs section 2, tier 5). */
  signatureBlock?: boolean;
  fileName?: string;
}

/** Turn drafts into proposals, dropping and counting anything the sensitivity gate refuses. */
function build(drafts: readonly DraftFact[], origin: ProposalOrigin, options: BuildOptions = {}): ExtractionResult {
  const proposals: ColdStartProposal[] = [];
  const counts: SkippedCounts = {};
  let skipped = 0;
  for (const draft of drafts) {
    const value = cleanValue(draft.value);
    if (value === "") continue;
    const described = describeKey(draft.key);
    const label = draft.label ?? described.label;
    const verdict = classifyCandidate({
      pathKind: PATH_KIND_OF[origin.sourceKind],
      // The key is screened alongside the label: "other.publicKey" and "admin.password" read as what they are.
      label: `${label} ${draft.key.replace(/\./g, " ")}`,
      value,
      ...(options.fileName === undefined ? {} : { fileName: options.fileName }),
      ...(options.signatureBlock === undefined ? {} : { signatureBlock: options.signatureBlock }),
      ...(draft.evidence === undefined ? {} : { context: draft.evidence }),
    });
    if (verdict.sensitive) {
      skipped += 1;
      const reason = verdict.reason ?? "sensitive-label";
      counts[reason] = (counts[reason] ?? 0) + 1;
      continue;
    }
    proposals.push({
      key: draft.key,
      value,
      category: described.category,
      label,
      aliases: described.aliases,
      confidence: round(draft.confidence),
      kinds: kindsForFact(value, described.category),
      source: origin.source,
      sourceKind: origin.sourceKind,
      ...(draft.evidence === undefined ? {} : { evidence: snippet(draft.evidence) }),
      support: 1,
    });
  }
  return { proposals, skipped, skippedCounts: counts };
}

function round(n: number): number {
  return Math.round(Math.min(0.99, Math.max(0, n)) * 100) / 100;
}

// ---------------------------------------------------------------------------------------------------------------
// vCard (tier 1): the highest-precision source on the machine. No model, no guessing.
// ---------------------------------------------------------------------------------------------------------------

interface VCardLine {
  name: string;
  types: string[];
  params: Map<string, string[]>;
  value: string;
}

/** RFC 6350 unfolding: a line starting with a space or tab continues the one before it. */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (/^[ \t]/.test(raw) && out.length > 0) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out.filter((line) => line.trim() !== "");
}

function splitUnescaped(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      current += `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current + (escaped ? "\\" : ""));
  return parts;
}

function unescapeValue(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_m, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

function parseVCardLine(raw: string): VCardLine | undefined {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return undefined;
  const head = raw.slice(0, colon);
  const value = raw.slice(colon + 1);
  const segments = head.split(";");
  const nameSegment = segments[0] ?? "";
  // "item1.EMAIL" — the group prefix is bookkeeping, not part of the property name.
  const name = (nameSegment.includes(".") ? nameSegment.slice(nameSegment.lastIndexOf(".") + 1) : nameSegment).trim().toUpperCase();
  if (name === "") return undefined;
  const params = new Map<string, string[]>();
  const types: string[] = [];
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=");
    if (eq < 0) {
      // vCard 2.1 style bare parameter: "TEL;WORK;VOICE:".
      types.push(segment.trim().toLowerCase().replace(/^"|"$/g, ""));
      continue;
    }
    const key = segment.slice(0, eq).trim().toUpperCase();
    const values = segment
      .slice(eq + 1)
      .split(",")
      .map((v) => v.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    params.set(key, values);
    if (key === "TYPE") types.push(...values.map((v) => v.toLowerCase()));
  }
  return { name, types, params, value };
}

function slotFor(types: readonly string[], map: Record<string, string>): string {
  for (const type of types) {
    const slot = map[type];
    if (slot !== undefined) return slot;
  }
  return "";
}

/** An untyped email is the résumé key `email`, so a contact card and a résumé agree instead of duplicating. */
const EMAIL_SLOTS: Record<string, string> = { work: "contact.email.work", home: "contact.email.personal" };
const PHONE_SLOTS: Record<string, string> = {
  cell: "contact.phone.mobile",
  mobile: "contact.phone.mobile",
  iphone: "contact.phone.mobile",
  work: "contact.phone.work",
  home: "contact.phone.home",
  main: "contact.phone.main",
};
const ADDRESS_SLOTS: Record<string, string> = { home: "home", work: "work" };

/** vCard properties carrying something that must never be stored; routed through the gate so they are COUNTED. */
const VCARD_SENSITIVE: Record<string, { key: string; label: string }> = {
  BDAY: { key: "other.birthday", label: "date of birth" },
  ANNIVERSARY: { key: "other.anniversary", label: "anniversary date" },
  KEY: { key: "other.key", label: "private key" },
};

export interface VCardOptions {
  /** Stop after the first card: the "me" card is the one the caller exported first. */
  firstCardOnly?: boolean;
}

/**
 * Parse one vCard into proposals. Handles folded lines, group prefixes, vCard 2.1 bare parameters, escaped
 * separators, several emails/phones/addresses, and a work/home split.
 */
export function extractFromVCard(text: string, origin: ProposalOrigin, options: VCardOptions = {}): ExtractionResult {
  // A card is structured, so each property is screened on its own below (a KEY is dropped, the name beside it is
  // kept). Only a card that is trying to instruct its reader is refused whole: that is not a contact card at all.
  if (looksLikeDirective(text)) return refuse("directive");

  const drafts: DraftFact[] = [];
  const sensitiveDrafts: DraftFact[] = [];
  const used = new Set<string>();
  let cards = 0;

  const add = (key: string, value: string, confidence: number, evidence: string): void => {
    const clean = value.trim();
    if (clean === "") return;
    drafts.push({ key: uniqueKey(used, key), value: clean, confidence, evidence });
  };

  for (const raw of unfold(text)) {
    const line = parseVCardLine(raw);
    if (!line) continue;
    if (line.name === "BEGIN") {
      cards += 1;
      continue;
    }
    if (options.firstCardOnly === true && cards > 1) break;
    // An encoded body (a photo, a quoted-printable blob) is never decoded here.
    const encoding = (line.params.get("ENCODING") ?? []).join(",").toLowerCase();
    if (encoding !== "" && /\b(b|base64|quoted-printable)\b/.test(encoding)) continue;

    const sensitiveProp = VCARD_SENSITIVE[line.name];
    if (sensitiveProp) {
      sensitiveDrafts.push({ key: sensitiveProp.key, value: unescapeValue(line.value), confidence: 0, label: sensitiveProp.label });
      continue;
    }

    const value = unescapeValue(line.value).trim();
    if (value === "") continue;
    const evidence = `${line.name}: ${value}`;

    switch (line.name) {
      case "FN":
        add("fullName", value, 0.95, evidence);
        break;
      case "N": {
        const [family = "", given = "", middle = ""] = splitUnescaped(line.value, ";").map((p) => unescapeValue(p).trim());
        if (given) add("firstName", given, 0.95, `N: ${given}`);
        if (family) add("lastName", family, 0.95, `N: ${family}`);
        if (middle) add("identity.middleName", middle, 0.9, `N: ${middle}`);
        break;
      }
      case "NICKNAME":
        add("identity.nickname", splitUnescaped(line.value, ",")[0] ?? value, 0.85, evidence);
        break;
      case "EMAIL":
        add(slotFor(line.types, EMAIL_SLOTS) || "email", value, 0.95, evidence);
        break;
      case "TEL": {
        if (line.types.includes("fax") || line.types.includes("pager")) break;
        add(slotFor(line.types, PHONE_SLOTS) || "phone", value, 0.95, evidence);
        break;
      }
      case "ADR": {
        const slot = slotFor(line.types, ADDRESS_SLOTS) || "other";
        const parts = splitUnescaped(line.value, ";").map((p) => unescapeValue(p).replace(/\s+/g, " ").trim());
        const [, extended = "", street = "", locality = "", region = "", postal = "", country = ""] = parts;
        const prefix = `address.${slot}`;
        if (street) add(`${prefix}.street`, street, 0.95, `ADR: ${street}`);
        if (extended) add(`${prefix}.unit`, extended, 0.9, `ADR: ${extended}`);
        if (locality) add(`${prefix}.city`, locality, 0.95, `ADR: ${locality}`);
        if (region) add(`${prefix}.province`, region, 0.95, `ADR: ${region}`);
        if (postal) add(`${prefix}.postalCode`, postal, 0.95, `ADR: ${postal}`);
        if (country) add(`${prefix}.country`, country, 0.95, `ADR: ${country}`);
        break;
      }
      case "ORG": {
        const [company = "", unit = ""] = splitUnescaped(line.value, ";").map((p) => unescapeValue(p).trim());
        if (company) add("work.employer.current", company, 0.9, `ORG: ${company}`);
        if (unit) add("work.department", unit, 0.85, `ORG: ${unit}`);
        break;
      }
      case "TITLE":
        add("work.title", value, 0.9, evidence);
        break;
      case "ROLE":
        if (!used.has("work.title")) add("work.title", value, 0.7, evidence);
        break;
      case "URL":
      case "X-SOCIALPROFILE": {
        const key = linkKeyFor(value, line.params);
        add(key, normalizeUrl(value), key === "website" ? 0.85 : 0.9, evidence);
        break;
      }
      default:
        break;
    }
  }

  const main = build(drafts, origin, { signatureBlock: true });
  const refused = build(sensitiveDrafts, origin, { signatureBlock: true });
  return {
    proposals: main.proposals,
    skipped: main.skipped + refused.skipped,
    skippedCounts: mergeCounts(main.skippedCounts, refused.skippedCounts),
  };
}

function uniqueKey(used: Set<string>, key: string): string {
  if (!used.has(key)) {
    used.add(key);
    return key;
  }
  for (let i = 2; i < 20; i += 1) {
    const candidate = `${key}.${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return `${key}.20`;
}

/** Résumé keys for the three links a form asks for; dotted keys for the rest. */
const LINK_HOSTS: readonly { re: RegExp; key: string; service: string }[] = [
  { re: /(^|\.)github\.com$/i, key: "github", service: "github" },
  { re: /(^|\.)gitlab\.com$/i, key: "links.gitlab", service: "gitlab" },
  { re: /(^|\.)bitbucket\.org$/i, key: "links.bitbucket", service: "bitbucket" },
  { re: /(^|\.)linkedin\.com$/i, key: "linkedin", service: "linkedin" },
  { re: /(^|\.)(twitter\.com|x\.com)$/i, key: "links.twitter", service: "twitter" },
];

function hostOf(url: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(withScheme);
  const authority = match?.[1] ?? "";
  const hostPort = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  return hostPort.replace(/:\d+$/, "").toLowerCase();
}

function linkKeyFor(value: string, params: Map<string, string[]>): string {
  const declared = (params.get("X-SERVICE") ?? params.get("SERVICE") ?? params.get("X-SERVICE-TYPE") ?? []).join(" ").toLowerCase();
  const host = hostOf(value);
  for (const link of LINK_HOSTS) if (link.re.test(host) || (declared !== "" && declared.includes(link.service))) return link.key;
  return "website";
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/[.,;]+$/, "");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Résumé (tier 2): the server's pure regex rules (server/src/lib/resumeRegex.ts) already return canonical fact keys.
// The extractor is INJECTED rather than imported so `shared` keeps no dependency on `server`, and so this module
// never becomes a second copy of those rules.
// ---------------------------------------------------------------------------------------------------------------

export type ResumeFactExtractor = (text: string) => Record<string, string>;

/** What a regex match on a résumé is worth. Keys not listed are proposed at RESUME_DEFAULT_CONFIDENCE. */
const RESUME_CONFIDENCE: Record<string, number> = {
  fullName: 0.8,
  firstName: 0.8,
  lastName: 0.8,
  email: 0.85,
  phone: 0.8,
  location: 0.7,
  city: 0.7,
  province: 0.7,
  country: 0.7,
  school: 0.75,
  degree: 0.75,
  major: 0.7,
  graduationDate: 0.7,
  github: 0.8,
  linkedin: 0.8,
  website: 0.75,
  "work.skills": 0.6,
};

const RESUME_DEFAULT_CONFIDENCE = 0.5;
/** `extra.skills` is the only `extra.*` key the regex rules emit today; it belongs to the work category. */
const RESUME_RENAME: Record<string, string> = { "extra.skills": "work.skills" };

/** Map already-extracted canonical résumé facts onto graph proposals. */
export function extractFromResumeFacts(facts: Record<string, string>, origin: ProposalOrigin, fileName?: string): ExtractionResult {
  const drafts: DraftFact[] = [];
  for (const [rawKey, rawValue] of Object.entries(facts)) {
    if (typeof rawValue !== "string" || rawValue.trim() === "") continue;
    if (looksLikeDirective(rawValue)) continue;
    const key = RESUME_RENAME[rawKey] ?? rawKey;
    drafts.push({
      key,
      value: rawValue,
      confidence: RESUME_CONFIDENCE[key] ?? RESUME_DEFAULT_CONFIDENCE,
      evidence: `${rawKey}: ${rawValue}`,
    });
  }
  return build(drafts, origin, fileName === undefined ? {} : { fileName });
}

export interface ResumeOptions {
  extractFacts: ResumeFactExtractor;
  fileName?: string;
}

/**
 * Résumé text -> proposals. A free-text document is refused WHOLE when any part of it reads like instructions, or
 * like a financial or health record: unlike a vCard there is no structure to tell the planted line from the real
 * one, so the honest answer is to skip the file and count it. The cost is a skipped document the user can see; the
 * alternative is proposing an attacker's email under the user's own name.
 */
export function extractFromResumeText(text: string, origin: ProposalOrigin, options: ResumeOptions): ExtractionResult {
  const refusal = sensitiveDocumentText(text);
  if (refusal?.sensitive) return refuse(refusal.reason ?? "directive");
  if (text.trim() === "") return { ...EMPTY };
  return extractFromResumeFacts(options.extractFacts(text), origin, options.fileName);
}

// ---------------------------------------------------------------------------------------------------------------
// Local project folders (tier 6): git remotes and package.json author fields.
// ---------------------------------------------------------------------------------------------------------------

export interface GitRemoteOptions {
  /** What the caller knows about the owner segment. Unknown keeps confidence low: it may well be an org. */
  ownerKind?: "user" | "org" | "unknown";
}

const REMOTE_PROFILE: Record<string, { link: string; login?: string; org?: string }> = {
  "github.com": { link: "github", login: "links.github.login", org: "org.github" },
  "gitlab.com": { link: "links.gitlab" },
  "bitbucket.org": { link: "links.bitbucket" },
};

/** scp-style ("git@host:owner/repo.git") and URL-style remotes, with credential-carrying remotes refused outright. */
export function extractFromGitRemote(remote: string, origin: ProposalOrigin, options: GitRemoteOptions = {}): ExtractionResult {
  const raw = remote.trim();
  if (raw === "") return { ...EMPTY };
  // "https://user:ghp_xxx@github.com/..." — a remote carrying a token is key material, never a fact.
  if (/:\/\/[^/@]*:[^/@]+@/.test(raw)) return refuse("key-material");

  const scp = /^(?:([^@\s]+)@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw);
  const host = scp ? (scp[2] ?? "").toLowerCase() : hostOf(raw);
  const pathPart = scp ? (scp[3] ?? "") : pathOf(raw);
  const owner = pathPart.replace(/^\/+/, "").split("/")[0] ?? "";
  if (host === "" || owner === "" || /[^A-Za-z0-9._-]/.test(owner)) return { ...EMPTY };

  const profile = REMOTE_PROFILE[host];
  if (!profile) return { ...EMPTY };
  const evidence = `remote: ${host}/${owner}`;
  const ownerKind = options.ownerKind ?? "unknown";
  if (ownerKind === "org") {
    return profile.org ? build([{ key: profile.org, value: owner, confidence: 0.5, evidence }], origin) : { ...EMPTY };
  }
  const confidence = ownerKind === "user" ? 0.75 : 0.55;
  const drafts: DraftFact[] = [{ key: profile.link, value: `https://${host}/${owner}`, confidence, evidence }];
  if (profile.login) drafts.push({ key: profile.login, value: owner, confidence, evidence });
  return build(drafts, origin);
}

function pathOf(url: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i.exec(withScheme);
  return match?.[1] ?? "";
}

export type PackageAuthor = string | { name?: string; email?: string; url?: string } | undefined | null;

const AUTHOR_STRING = /^\s*([^<(]+?)?\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?\s*$/;
const AUTHOR_NAME = /^[\p{L}][\p{L}.'-]*(?: [\p{L}][\p{L}.'-]*){1,3}$/u;
const AUTHOR_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * package.json `author`. Worth little on its own — the author of a vendored package is not the user — so everything
 * here is proposed at low confidence and only rises through `mergeProposals` when several projects agree.
 */
export function extractFromPackageAuthor(author: PackageAuthor, origin: ProposalOrigin): ExtractionResult {
  const fields = typeof author === "string" ? parseAuthorString(author) : author ?? {};
  const drafts: DraftFact[] = [];
  const name = (fields.name ?? "").trim();
  const email = (fields.email ?? "").trim();
  const url = (fields.url ?? "").trim();
  if (name && AUTHOR_NAME.test(name)) drafts.push({ key: "fullName", value: name, confidence: 0.5, evidence: `author: ${name}` });
  if (email && AUTHOR_EMAIL.test(email)) drafts.push({ key: "email", value: email, confidence: 0.5, evidence: `author email: ${email}` });
  if (url) {
    const host = hostOf(url);
    const known = LINK_HOSTS.find((h) => h.re.test(host));
    drafts.push({ key: known?.key ?? "website", value: normalizeUrl(url), confidence: 0.5, evidence: `author url: ${url}` });
  }
  return build(drafts, origin);
}

function parseAuthorString(author: string): { name?: string; email?: string; url?: string } {
  const m = AUTHOR_STRING.exec(author);
  if (!m) return {};
  return {
    ...(m[1]?.trim() ? { name: m[1].trim() } : {}),
    ...(m[2]?.trim() ? { email: m[2].trim() } : {}),
    ...(m[3]?.trim() ? { url: m[3].trim() } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------------------------------------------

function mergeCounts(a: SkippedCounts, b: SkippedCounts): SkippedCounts {
  const out: SkippedCounts = { ...a };
  for (const [reason, count] of Object.entries(b) as [SensitiveReason, number][]) out[reason] = (out[reason] ?? 0) + count;
  return out;
}

export function mergeResults(results: readonly ExtractionResult[]): ExtractionResult {
  const proposals: ColdStartProposal[] = [];
  let counts: SkippedCounts = {};
  let skipped = 0;
  for (const result of results) {
    proposals.push(...result.proposals);
    skipped += result.skipped;
    counts = mergeCounts(counts, result.skippedCounts);
  }
  return { proposals: mergeProposals(proposals), skipped, skippedCounts: counts };
}

const AGREEMENT_STEP = 0.05;
const MAX_MERGED_CONFIDENCE = 0.97;

/**
 * The same key and the same value from two documents is real corroboration, so support counts up and confidence
 * rises a little. The same key with a different value keeps both: a conflict is settled in the review list, not here.
 */
export function mergeProposals(proposals: readonly ColdStartProposal[]): ColdStartProposal[] {
  const byKeyValue = new Map<string, ColdStartProposal>();
  for (const proposal of proposals) {
    const id = `${proposal.key} ${proposal.value.toLowerCase()}`;
    const existing = byKeyValue.get(id);
    if (!existing) {
      byKeyValue.set(id, { ...proposal, aliases: [...proposal.aliases] });
      continue;
    }
    existing.support += proposal.support;
    existing.confidence = round(Math.min(MAX_MERGED_CONFIDENCE, Math.max(existing.confidence, proposal.confidence) + AGREEMENT_STEP * proposal.support));
    for (const alias of proposal.aliases) if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
    if (!existing.evidence && proposal.evidence) existing.evidence = proposal.evidence;
  }
  return [...byKeyValue.values()].sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));
}
