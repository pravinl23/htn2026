// Sourcing the fact graph from what the user already has (docs/profile-sources.md sections 2 and 3).
//
// Everything here is pure or takes an injected fetch, and NOTHING here writes to storage. A scan turns a
// source the user pointed Ghost at into PROPOSALS; the user reviews them and only then do they enter the
// graph. Three promises kept on this side of the wire:
//   - the fetched text is never stored: only the extracted value and a short evidence snippet,
//   - nothing classified sensitive is ever proposed, shown or saved (the extractors refuse it, and
//     `buildProposalReview` drops it again in case a source labelled a card number "member number"),
//   - every proposal says where it came from, and one click forgets a whole source.
import {
  applyProposals, factDefFor, factsFromGitHubProfile, factsFromText, factsFromVCard, isRejected, isSensitiveFact,
  labelFromKey, listFacts, rejectProposal, removeBySource, removeFact, setUserFact, sourceId, upsertFact,
} from "@ghost/shared";
import type { Fact, FactGraph, FactProposal, FactSource } from "@ghost/shared";
import { buildReviewRows } from "./resume-merge";
import { extractProfile } from "./server";
import type { ServerDeps } from "./server";

/** What a scan reads at most. A source longer than this is read from the top and the rest ignored. */
export const SCAN_MAX_CHARS = 40_000;
/** GitHub's own rule for a login: letters, digits and single hyphens, up to 39 characters. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const FETCH_TIMEOUT_MS = 8000;

/** Anything the user should read as "that scan did not work", with a sentence that says what to do next. */
export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanError";
  }
}

export interface ScanDeps extends ServerDeps {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

async function get(url: string, deps: ScanDeps, accept: string): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    // No cookies and no cache: a scan reads what anyone can read, as the user, once.
    return await doFetch(url, { headers: { Accept: accept }, signal: abort.signal, cache: "no-store", credentials: "omit" });
  } catch {
    throw new ScanError(`Could not read ${url}. Check the address and your connection, or paste the text instead.`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- the sources ----------

/** "alexchen-dev", "@alexchen-dev" and "https://github.com/alexchen-dev" all name the same user. */
export function githubLogin(input: string): string | null {
  const clean = input
    .trim()
    .replace(/^@/, "")
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/\/+$/, "");
  return GITHUB_LOGIN.test(clean) ? clean : null;
}

/** The public REST profile, no auth: exactly what docs/profile-sources.md allows for a username. */
export async function scanGitHub(input: string, deps: ScanDeps = {}): Promise<FactProposal[]> {
  const login = githubLogin(input);
  if (!login) throw new ScanError("That is not a GitHub username. Try something like alexchen-dev.");
  const response = await get(`https://api.github.com/users/${login}`, deps, "application/vnd.github+json");
  if (response.status === 404) throw new ScanError(`GitHub has no public user called ${login}.`);
  if (!response.ok) throw new ScanError(`GitHub answered ${response.status}. Try again in a minute.`);
  const raw: unknown = await response.json().catch(() => null);
  if (!isRecord(raw)) throw new ScanError("GitHub sent a reply Ghost could not read.");
  // Only the fields the extractor knows, and only when they are strings: the rest of the reply is ignored.
  return factsFromGitHubProfile({
    login,
    name: str(raw.name),
    email: str(raw.email),
    blog: str(raw.blog),
    company: str(raw.company),
    location: str(raw.location),
    twitter_username: str(raw.twitter_username),
  });
}

export function parseHttpUrl(input: string): URL | null {
  const text = input.trim();
  if (text === "") return null;
  // A scheme the user wrote is respected (and refused unless it is http(s)); a bare host gets https://.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return null;
  try {
    const url = new URL(scheme ? text : `https://${text}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Tags out, text in. Good enough for a signature block or an about page, which is all a scan reads. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)\b[^]*?<\/\1>/gi, " ")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|address)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

export async function scanWebsite(input: string, deps: ScanDeps = {}): Promise<FactProposal[]> {
  const url = parseHttpUrl(input);
  if (!url) throw new ScanError("Enter a full address, like https://alexchen.dev.");
  const response = await get(url.href, deps, "text/html,text/plain");
  if (!response.ok) throw new ScanError(`That page answered ${response.status}.`);
  const body = (await response.text().catch(() => "")).slice(0, SCAN_MAX_CHARS);
  return factsFromText(htmlToText(body), { kind: "website", origin: url.origin });
}

/**
 * LinkedIn does not let an extension read a profile page, so the URL itself is what a scan can honestly
 * take: the link becomes a fact, and the user pastes the About section into "Paste text" for the rest.
 */
export function scanLinkedIn(input: string): FactProposal[] {
  const url = parseHttpUrl(input);
  if (!url || !/(^|\.)linkedin\.com$/i.test(url.hostname)) {
    throw new ScanError("Enter your LinkedIn profile address, like https://linkedin.com/in/alexchen-dev.");
  }
  const proposals = factsFromText(url.href, { kind: "website", origin: url.origin });
  if (proposals.length === 0) throw new ScanError("That is not a profile address. It looks like linkedin.com/in/your-name.");
  return proposals;
}

export function looksLikeVCard(text: string): boolean {
  return /^\s*BEGIN:VCARD/im.test(text);
}

/** A vCard is the one file that already holds an address, which is why a shipping form can fill at all. */
export function scanVCard(text: string, name: string): FactProposal[] {
  return factsFromVCard(text.slice(0, SCAN_MAX_CHARS), name);
}

/** A mail signature block, an about page, anything the user pasted. Offline, deterministic, modest. */
export function scanText(text: string, source: FactSource, fullName?: string): FactProposal[] {
  return factsFromText(text.slice(0, SCAN_MAX_CHARS), source, fullName ? { fullName } : {});
}

function proposalFrom(key: string, value: string, source: FactSource, confidence: number, evidence?: string): FactProposal | null {
  const def = factDefFor(key);
  const label = def?.label ?? labelFromKey(key);
  if (isSensitiveFact(key, label, def?.aliases ?? [], value)) return null;
  const proposal: FactProposal = { key, value, source, label, confidence, aliases: def?.aliases ?? [] };
  if (def?.category) proposal.category = def.category;
  if (evidence) proposal.evidence = evidence;
  return proposal;
}

/** The server's `{ facts }` reply as proposals. `buildReviewRows` already drops junk and sensitive keys. */
export function proposalsFromFacts(raw: unknown, source: FactSource, confidence = 0.8): FactProposal[] {
  const out: FactProposal[] = [];
  for (const row of buildReviewRows({}, raw)) {
    const proposal = proposalFrom(row.key, row.proposed, source, confidence);
    if (proposal) out.push(proposal);
  }
  return out;
}

export interface ResumeScan {
  proposals: FactProposal[];
  /** Who read it: the server's extractor, or the offline one when the server could not be reached. */
  provider: string;
}

/**
 * A résumé or a contact card. A vCard is read here, offline; anything else goes to the LOCAL Ghost server
 * (`/v1/profile/extract`), and when that is not running the offline text extractor still proposes what code
 * can read on its own. The file's text is never stored either way.
 */
export async function scanResume(text: string, fileName: string, deps: ScanDeps = {}): Promise<ResumeScan> {
  const source: FactSource = { kind: "file", name: fileName };
  if (looksLikeVCard(text)) return { proposals: scanVCard(text, fileName), provider: "vcard" };
  try {
    const result = await extractProfile(text, deps);
    return { proposals: proposalsFromFacts(result.facts, source), provider: result.provider };
  } catch {
    // The server is the better reader, but a missing server must never mean a missing scan.
    return { proposals: scanText(text, source), provider: "offline" };
  }
}

// ---------- review: proposals the user has not accepted yet ----------

export interface ProposalRow {
  key: string;
  label: string;
  category: string;
  /** Editable: what will be saved if the row is checked. */
  value: string;
  evidence: string;
  sourceText: string;
  /** What the graph holds for this key today, or "". */
  current: string;
  checked: boolean;
  /** The graph already holds exactly this value: nothing to save. */
  unchanged: boolean;
  proposal: FactProposal;
}

export interface ScanReview {
  rows: ProposalRow[];
  /** Proposals dropped as sensitive before the user ever saw them. Counted, never shown, never stored. */
  sensitive: number;
  /** Proposals the user turned down before. */
  rejected: number;
}

export function describeSource(source: FactSource): string {
  switch (source.kind) {
    case "user":
      return "you";
    case "file":
      return `file · ${source.name}`;
    case "github":
      return `github · ${source.login}`;
    case "website":
      return `website · ${source.origin}`;
    case "mail":
      return `mail · ${source.connector}`;
    case "calendar":
      return `calendar · ${source.connector}`;
    case "drive":
      return `drive · ${source.connector}`;
    case "observed":
      return `typed on ${source.origin}`;
  }
}

/**
 * A value read off a line that NAMES a credential or a government ID is that ID, whatever key an extractor
 * gave it: a Canadian SIN written "046 454 286" is a phone-shaped number on a line that says SIN. The
 * evidence snippet is the only place that context survives, so the review reads it before showing a row.
 */
const SENSITIVE_CONTEXT =
  /\b(sin|ssn|nin|itin|tin|nric|aadhaar|cvv|cvc|pin|otp)\b|social (insurance|security)|passport|driver'?s? licen[sc]e|national (id|insurance)|tax (id|number|file)|health (card|number|insurance)|medicare|credit card|card number|security code|account number|routing|iban|swift|password|passcode|api key|secret|token/i;

/** True when this proposal, or the line it came from, is about something Ghost must never keep. */
export function proposalIsSensitive(key: string, label: string, aliases: readonly string[], value: string, evidence = ""): boolean {
  return isSensitiveFact(key, label, aliases, value) || SENSITIVE_CONTEXT.test(evidence);
}

function categoryOf(proposal: FactProposal): string {
  return proposal.category ?? factDefFor(proposal.key)?.category ?? proposal.key.split(".")[0] ?? "other";
}

/**
 * Proposals as review rows. A row is checked by default only when it tells the graph something new; a
 * sensitive proposal never becomes a row at all, and neither does one the user has already turned down.
 */
export function buildProposalReview(graph: FactGraph, proposals: readonly FactProposal[]): ScanReview {
  const rows: ProposalRow[] = [];
  const seen = new Set<string>();
  let sensitive = 0;
  let rejected = 0;
  for (const proposal of proposals) {
    const value = proposal.value.trim();
    if (value === "" || seen.has(proposal.key)) continue;
    const label = proposal.label ?? factDefFor(proposal.key)?.label ?? labelFromKey(proposal.key);
    if (proposalIsSensitive(proposal.key, label, proposal.aliases ?? [], value, proposal.evidence ?? "")) {
      sensitive++;
      continue;
    }
    if (isRejected(graph, proposal.key, value)) {
      rejected++;
      continue;
    }
    seen.add(proposal.key);
    const current = graph.facts[proposal.key]?.value ?? "";
    const unchanged = current === value;
    rows.push({
      key: proposal.key,
      label,
      category: categoryOf(proposal),
      value,
      evidence: proposal.evidence ?? "",
      sourceText: describeSource(proposal.source),
      current,
      unchanged,
      checked: !unchanged,
      proposal,
    });
  }
  return { rows, sensitive, rejected };
}

export function checkedRows(rows: readonly ProposalRow[]): ProposalRow[] {
  return rows.filter((row) => row.checked && !row.unchanged && row.value.trim() !== "");
}

export interface SaveProposalsResult {
  graph: FactGraph;
  /** Facts that entered or changed in the graph. */
  saved: number;
  /** Checked rows the graph refused: sensitive after an edit, malformed, or already answered better. */
  skipped: number;
}

/**
 * Save ONLY the checked rows. An accepted proposal keeps its provenance and gains the user's word, so a
 * later scan of the same source never overwrites it; where a verified fact already disagreed, the user
 * picking this value is the user typing it, and it is stored as theirs.
 */
export function saveProposalRows(graph: FactGraph, rows: readonly ProposalRow[], now?: string): SaveProposalsResult {
  let next = graph;
  let saved = 0;
  let skipped = 0;
  for (const row of checkedRows(rows)) {
    const value = row.value.trim();
    const step = upsertFact(next, { ...row.proposal, value, verifiedByUser: true }, now);
    if (step.status === "added" || step.status === "updated") {
      next = step.graph;
      saved++;
      continue;
    }
    // "kept" means a fact the user already verified: taking this value is their own correction.
    if (step.status === "kept" && next.facts[row.key]?.value !== value) {
      const extra = { label: row.label, aliases: row.proposal.aliases ?? [], ...(row.evidence ? { evidence: row.evidence } : {}) };
      const forced = setUserFact(next, row.key, value, extra, now);
      if (forced.status === "added" || forced.status === "updated") {
        next = forced.graph;
        saved++;
        continue;
      }
    }
    skipped++;
  }
  return { graph: next, saved, skipped };
}

/** "Never suggest this again": remembered as a hash of key+value, so the value itself is not kept. */
export function dismissProposal(graph: FactGraph, row: ProposalRow, now?: string): FactGraph {
  return rejectProposal(graph, row.key, row.value.trim(), now);
}

/** Only used by the tests and by an import path that trusts its own proposals; the UI always reviews. */
export function applyAllProposals(graph: FactGraph, proposals: readonly FactProposal[]): FactGraph {
  return applyProposals(graph, proposals).graph;
}

// ---------- the graph as the options page shows it ----------

export interface FactView {
  key: string;
  label: string;
  /** Empty for a sensitive fact: the options page never renders one, it only offers to delete it. */
  value: string;
  category: string;
  source: FactSource;
  sourceId: string;
  sourceText: string;
  evidence: string;
  verified: boolean;
  sensitive: boolean;
  confidence: number;
}

function toView(fact: Fact): FactView {
  return {
    key: fact.key,
    label: fact.label,
    value: fact.sensitive ? "" : fact.value,
    category: fact.category,
    source: fact.source,
    sourceId: sourceId(fact.source),
    sourceText: describeSource(fact.source),
    evidence: fact.evidence ?? "",
    verified: fact.verifiedByUser,
    sensitive: fact.sensitive,
    confidence: fact.confidence,
  };
}

function haystack(view: FactView): string {
  return `${view.key} ${view.label} ${view.value} ${view.category} ${view.sourceText}`.toLowerCase();
}

/** Every fact, filtered by a plain substring search over key, label, value, category and source. */
export function factViews(graph: FactGraph, query = ""): FactView[] {
  const needle = query.trim().toLowerCase();
  const views = listFacts(graph).map(toView);
  return needle === "" ? views : views.filter((view) => haystack(view).includes(needle));
}

export interface SourceGroup {
  id: string;
  text: string;
  source: FactSource;
  count: number;
}

/** One entry per distinct source, for the "forget everything from this source" buttons. */
export function sourceGroups(graph: FactGraph): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const fact of listFacts(graph)) {
    const id = sourceId(fact.source);
    const existing = groups.get(id);
    if (existing) existing.count++;
    else groups.set(id, { id, text: describeSource(fact.source), source: fact.source, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

export function forgetSource(graph: FactGraph, source: FactSource, now?: string): { graph: FactGraph; removed: number } {
  return removeBySource(graph, source, now);
}

export function deleteFact(graph: FactGraph, key: string, now?: string): FactGraph {
  return removeFact(graph, key, now);
}

/** An edit in the fact list is the user's own word: it wins over every source, now and later. */
export function editFact(graph: FactGraph, key: string, value: string, now?: string): { graph: FactGraph; ok: boolean; reason: string } {
  const existing = graph.facts[key];
  const extra = existing ? { label: existing.label, aliases: existing.aliases, category: existing.category } : {};
  const step = setUserFact(graph, key, value.trim(), extra, now);
  return { graph: step.graph, ok: step.status === "added" || step.status === "updated", reason: step.reason };
}
