// Graph operations: provenance, conflicts, rejection memory, forgetting a source, JSON round trip, caps.
//
// Three rules decide every conflict (docs/profile-sources.md section 2):
//   1. The user wins. A fact they typed or accepted is never overwritten by a scan.
//   2. A more trusted source wins over a less trusted one.
//   3. Within the same trust, newer wins.
// A proposal the user turned down is remembered as a hash so the next scan does not offer it again.
//
// Size is a feature, not an afterthought (docs/storage.md): the graph is one small file the user can read, delete
// and carry in a backup. Everything here is bounded — facts, aliases, evidence, rejection hashes, the source list
// and the skipped tally — and `knowledgeSizeBytes`/`pruneKnowledge` in shared/src/knowledge enforce the byte
// budget of the whole file on top of these counts.
import { factDefFor, kindsForFact, labelFromKey } from "./defs";
import { classifyFactSensitivity, countSkipped, type SensitiveReason, type SkippedCounts } from "./sensitivity";
import { normalizeText } from "./text";
import {
  FACT_CATEGORIES,
  type ApplyResult,
  type Fact,
  type FactCategory,
  type FactGraph,
  type FactProposal,
  type FactSource,
  type FactSourceKind,
  type GraphMeta,
  type GraphSourceMeta,
  type UpsertResult,
  type UpsertStatus,
} from "./types";

/** Bumped when the stored shape changes. Version 1 files (no meta, undated rejections) load and are migrated. */
export const FACT_SCHEMA_VERSION = 2;

export const FACT_LIMITS = {
  facts: 500,
  keyChars: 64,
  valueChars: 512,
  labelChars: 64,
  aliases: 16,
  aliasChars: 64,
  evidenceChars: 200,
  rejected: 500,
  /** Distinct sources remembered in `meta`, most recently scanned first. */
  sources: 32,
} as const;

/** A rejection hash is forgotten after this long: the user may well have changed their mind (docs/storage.md §2). */
export const REJECTED_TTL_DAYS = 90;

/** The same shape the server accepts for a fact key (`server/src/providers/validation.ts`). */
export const FACT_KEY_PATTERN = /^[A-Za-z][\w.-]{0,63}$/;

/** How far a source is trusted, in the order of docs/profile-sources.md section 2. */
const SOURCE_TRUST: Record<FactSourceKind, number> = {
  user: 100,
  file: 70,
  github: 65,
  website: 60,
  mail: 55,
  calendar: 50,
  drive: 45,
  observed: 40,
};

/** "github:alexchen-dev": what "forget this source" matches on. */
export function sourceId(source: FactSource): string {
  switch (source.kind) {
    case "user":
      return "user";
    case "file":
      return `file:${source.name}`;
    case "github":
      return `github:${source.login}`;
    case "website":
      return `website:${source.origin}`;
    case "mail":
      return `mail:${source.connector}`;
    case "calendar":
      return `calendar:${source.connector}`;
    case "drive":
      return `drive:${source.connector}`;
    case "observed":
      return `observed:${source.origin}`;
  }
}

/** Day resolution is all any stored timestamp needs, and all the file is allowed to keep (docs/storage.md §2). */
export function dayOf(timestamp: string): string {
  const day = timestamp.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "1970-01-01";
}

const MS_PER_DAY = 86_400_000;

/** Whole days from `from` to `to`, both day strings. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${dayOf(from)}T00:00:00.000Z`);
  const b = Date.parse(`${dayOf(to)}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / MS_PER_DAY);
}

export function emptyMeta(): GraphMeta {
  return { schema: FACT_SCHEMA_VERSION, skipped: {}, sources: [] };
}

export function emptyGraph(now = new Date().toISOString()): FactGraph {
  return { version: FACT_SCHEMA_VERSION, facts: {}, rejected: [], meta: emptyMeta(), updatedAt: now };
}

/** The meta section, defaulted: a graph loaded from a version 1 file has none. */
export function graphMeta(graph: FactGraph): GraphMeta {
  return graph.meta ?? emptyMeta();
}

export function listFacts(graph: FactGraph): Fact[] {
  return Object.values(graph.facts).sort((a, b) => a.key.localeCompare(b.key));
}

export function getFact(graph: FactGraph, key: string): Fact | null {
  return graph.facts[key] ?? null;
}

export function getFactValue(graph: FactGraph, key: string): string {
  return graph.facts[key]?.value ?? "";
}

export function factCount(graph: FactGraph): number {
  return Object.keys(graph.facts).length;
}

/** A 32-bit FNV-1a hash. Not cryptographic: it only has to remember "the user said no to this one". */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Identifies a rejected proposal without keeping the value it rejected. */
export function proposalId(key: string, value: string): string {
  return hash(`${key}::${normalizeText(value)}`);
}

/** A stored rejection is "<hash>@<day>": the hash to recognize it, the day so it can expire. */
function rejectionEntry(id: string, now: string): string {
  return `${id}@${dayOf(now)}`;
}

function rejectionId(entry: string): string {
  const at = entry.indexOf("@");
  return at < 0 ? entry : entry.slice(0, at);
}

function rejectionDay(entry: string, fallback: string): string {
  const at = entry.indexOf("@");
  return at < 0 ? dayOf(fallback) : dayOf(entry.slice(at + 1));
}

export function isRejected(graph: FactGraph, key: string, value: string): boolean {
  const id = proposalId(key, value);
  return graph.rejected.some((entry) => rejectionId(entry) === id);
}

/** The user turned this candidate down: never propose it again from a scan. */
export function rejectProposal(graph: FactGraph, key: string, value: string, now = new Date().toISOString()): FactGraph {
  const id = proposalId(key, value);
  if (graph.rejected.some((entry) => rejectionId(entry) === id)) return graph;
  const rejected = [...graph.rejected, rejectionEntry(id, now)].slice(-FACT_LIMITS.rejected);
  return { ...graph, rejected, updatedAt: now };
}

/** Step one of the pruning order: a rejection older than 90 days is forgotten, so a rescan may offer it again. */
export function pruneRejected(graph: FactGraph, now = new Date().toISOString(), ttlDays = REJECTED_TTL_DAYS): { graph: FactGraph; dropped: number } {
  const today = dayOf(now);
  const kept = graph.rejected.filter((entry) => daysBetween(rejectionDay(entry, now), today) <= ttlDays);
  const dropped = graph.rejected.length - kept.length;
  return dropped === 0 ? { graph, dropped: 0 } : { graph: { ...graph, rejected: kept }, dropped };
}

/**
 * Rule 3 of CLAUDE.md, applied on the way in: a government ID, a card, a credential or a health number is
 * never stored by a scan and never leaves the machine. The key, the label, the aliases AND the value shape
 * all get a say, because a source may label a card number "member number".
 *
 * The rules themselves live in `./sensitivity`, shared with the cold-start scan, so a value the scan refuses
 * cannot reach the graph through another door.
 */
export function isSensitiveFact(key: string, label: string, aliases: readonly string[], value: string): boolean {
  return classifyFactSensitivity(key, label, aliases, value).sensitive;
}

/** "address.home.street" belongs to `address` without anyone saying so. */
function categoryFromKey(key: string): FactCategory | null {
  const head = key.split(".")[0] ?? "";
  return (FACT_CATEGORIES as readonly string[]).includes(head) ? (head as FactCategory) : null;
}

function cleanAliases(aliases: readonly string[]): string[] {
  const out: string[] = [];
  for (const alias of aliases) {
    const text = normalizeText(alias).slice(0, FACT_LIMITS.aliasChars);
    if (text !== "" && !out.includes(text)) out.push(text);
    if (out.length >= FACT_LIMITS.aliases) break;
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function defaultConfidence(source: FactSource): number {
  return source.kind === "user" ? 1 : SOURCE_TRUST[source.kind] / 100;
}

/** The fact a proposal would become, before any conflict is considered. */
function buildFact(proposal: FactProposal, existing: Fact | null, now: string): Fact | null {
  const key = proposal.key.trim();
  if (!FACT_KEY_PATTERN.test(key) || key.length > FACT_LIMITS.keyChars) return null;
  const value = proposal.value.trim();
  if (value === "" || value.length > FACT_LIMITS.valueChars) return null;

  const def = factDefFor(key);
  const category = proposal.category ?? def?.category ?? categoryFromKey(key) ?? existing?.category ?? "other";
  const label = normalizeText(proposal.label ?? def?.label ?? existing?.label ?? labelFromKey(key)).slice(0, FACT_LIMITS.labelChars);
  const aliases = cleanAliases([...(proposal.aliases ?? []), ...(def?.aliases ?? []), ...(existing?.aliases ?? [])]);
  const kinds = proposal.kinds ?? def?.kinds ?? kindsForFact(value, category);
  const fact: Fact = {
    key,
    value,
    category,
    label: label === "" ? labelFromKey(key) : label,
    aliases,
    confidence: clamp(proposal.confidence ?? defaultConfidence(proposal.source), 0, 1),
    source: proposal.source,
    updatedAt: proposal.updatedAt ?? now,
    verifiedByUser: proposal.verifiedByUser ?? proposal.source.kind === "user",
    sensitive: false,
    kinds,
  };
  const evidence = proposal.evidence?.slice(0, FACT_LIMITS.evidenceChars);
  if (evidence) fact.evidence = evidence;
  const verdict = classifyFactSensitivity(fact.key, fact.label, fact.aliases, fact.value);
  fact.sensitive = verdict.sensitive;
  if (verdict.sensitive && verdict.reason) fact.sensitiveReason = verdict.reason;
  return fact;
}

/** The weakest fact: what a full graph drops to make room. A verified fact is never dropped. */
function weakest(graph: FactGraph): Fact | null {
  const droppable = listFacts(graph).filter((fact) => !fact.verifiedByUser);
  if (droppable.length === 0) return null;
  return droppable.sort((a, b) => a.confidence - b.confidence || a.updatedAt.localeCompare(b.updatedAt))[0] ?? null;
}

function result(graph: FactGraph, status: UpsertStatus, reason: string, sensitiveReason?: SensitiveReason): UpsertResult {
  return sensitiveReason === undefined ? { graph, status, reason } : { graph, status, reason, sensitiveReason };
}

/** Count a refusal without keeping what was refused: this is what "23 items skipped as sensitive" is made of. */
export function noteSkipped(graph: FactGraph, reason: SensitiveReason, by = 1): FactGraph {
  const meta = graphMeta(graph);
  return { ...graph, meta: { ...meta, skipped: countSkipped(meta.skipped, reason, by) } };
}

/** Remember that this source was read, so the options page can say when each one last contributed. */
function noteSource(meta: GraphMeta, source: FactSource, now: string): GraphMeta {
  const id = sourceId(source);
  const entry: GraphSourceMeta = { id, lastScan: dayOf(now) };
  const sources = [entry, ...meta.sources.filter((s) => s.id !== id)].slice(0, FACT_LIMITS.sources);
  return { ...meta, sources };
}

/**
 * Add or update one fact. Pure: the graph passed in is never mutated.
 * A sensitive fact is stored ONLY when the user typed it themselves, and even then it is never matched
 * against a field and never put on the wire.
 */
export function upsertFact(graph: FactGraph, proposal: FactProposal, now = new Date().toISOString()): UpsertResult {
  const existing = graph.facts[proposal.key.trim()] ?? null;
  const fact = buildFact(proposal, existing, now);
  if (!fact) return result(graph, "invalid", "the key or the value is not usable");
  if (fact.sensitive && fact.source.kind !== "user") {
    const reason = fact.sensitiveReason ?? "sensitive-label";
    return result(noteSkipped(graph, reason), "sensitive", "sensitive facts are never imported", reason);
  }
  if (fact.source.kind !== "user" && isRejected(graph, fact.key, fact.value)) {
    return result(graph, "rejected", "the user turned this proposal down before");
  }

  if (existing) {
    if (existing.verifiedByUser && fact.source.kind !== "user") return result(graph, "kept", "the user verified this fact");
    const incoming = SOURCE_TRUST[fact.source.kind];
    const held = SOURCE_TRUST[existing.source.kind];
    if (incoming < held) return result(graph, "kept", "a more trusted source already answered");
    if (incoming === held && fact.updatedAt < existing.updatedAt) return result(graph, "kept", "an older reading of the same source");
  }

  let facts = graph.facts;
  if (!existing && factCount(graph) >= FACT_LIMITS.facts) {
    const drop = weakest(graph);
    if (!drop) return result(graph, "invalid", "the graph is full of facts the user verified");
    facts = { ...facts };
    delete facts[drop.key];
  }
  const meta = noteSource(graphMeta(graph), fact.source, now);
  return result({ ...graph, facts: { ...facts, [fact.key]: fact }, meta, updatedAt: now }, existing ? "updated" : "added", "stored");
}

/** Apply a scan's proposals in one pass, counting what happened to each. */
export function applyProposals(graph: FactGraph, proposals: readonly FactProposal[], now = new Date().toISOString()): ApplyResult {
  const counts: ApplyResult = { graph, added: 0, updated: 0, kept: 0, rejected: 0, sensitive: 0, invalid: 0, skippedCounts: {} };
  for (const proposal of proposals) {
    const step = upsertFact(counts.graph, proposal, now);
    counts.graph = step.graph;
    counts[step.status]++;
    if (step.sensitiveReason) counts.skippedCounts = countSkipped(counts.skippedCounts, step.sensitiveReason);
  }
  return counts;
}

/** What the user typed wins, always. The one way a sensitive fact can enter the graph. */
export function setUserFact(
  graph: FactGraph,
  key: string,
  value: string,
  extra: Omit<FactProposal, "key" | "value" | "source"> = {},
  now = new Date().toISOString(),
): UpsertResult {
  return upsertFact(graph, { ...extra, key, value, source: { kind: "user" } }, now);
}

/**
 * The review list's "accept": the fact keeps its source and gains the user's word. Its evidence snippet is dropped
 * at the same moment (docs/storage.md section 2): it existed to help the user decide, and they have decided.
 */
export function acceptFact(graph: FactGraph, key: string, now = new Date().toISOString()): FactGraph {
  const fact = graph.facts[key];
  if (!fact || fact.verifiedByUser) return graph;
  const accepted: Fact = { ...fact, verifiedByUser: true, confidence: 1, updatedAt: now };
  delete accepted.evidence;
  return { ...graph, facts: { ...graph.facts, [key]: accepted }, updatedAt: now };
}

export function removeFact(graph: FactGraph, key: string, now = new Date().toISOString()): FactGraph {
  if (!graph.facts[key]) return graph;
  const facts = { ...graph.facts };
  delete facts[key];
  return { ...graph, facts, updatedAt: now };
}

/** "Forget this source": every fact whose provenance is that exact source goes, and so does its meta row. */
export function removeBySource(graph: FactGraph, source: FactSource, now = new Date().toISOString()): { graph: FactGraph; removed: number } {
  const id = sourceId(source);
  const facts: Record<string, Fact> = {};
  let removed = 0;
  for (const fact of Object.values(graph.facts)) {
    if (sourceId(fact.source) === id) removed++;
    else facts[fact.key] = fact;
  }
  const meta = graphMeta(graph);
  const sources = meta.sources.filter((s) => s.id !== id);
  if (removed === 0 && sources.length === meta.sources.length) return { graph, removed: 0 };
  return { graph: { ...graph, facts, meta: { ...meta, sources }, updatedAt: now }, removed };
}

/** Every source the graph holds facts from, with how many and when it last contributed. Counts only. */
export function sourceSummary(graph: FactGraph): Array<{ id: string; facts: number; lastScan: string }> {
  const counts = new Map<string, number>();
  for (const fact of Object.values(graph.facts)) {
    const id = sourceId(fact.source);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const meta = graphMeta(graph);
  const lastScan = new Map(meta.sources.map((s) => [s.id, s.lastScan]));
  return [...counts.entries()]
    .map(([id, facts]) => ({ id, facts, lastScan: lastScan.get(id) ?? "" }))
    .sort((a, b) => b.facts - a.facts || a.id.localeCompare(b.id));
}

/**
 * The wire shape. `/v1/predict/form` receives fact KEYS and nothing else: no value, no label, no alias,
 * no evidence, no provenance. Sensitive facts are not even named.
 */
export function factKeysForRequest(graph: FactGraph, limit = 64): string[] {
  return listFacts(graph)
    .filter((fact) => !fact.sensitive && fact.value !== "" && FACT_KEY_PATTERN.test(fact.key))
    .map((fact) => fact.key)
    .slice(0, limit);
}

/** Every fact the matcher may offer: sensitive facts are excluded here, once, for every caller. */
export function matchableFacts(graph: FactGraph): Fact[] {
  return listFacts(graph).filter((fact) => !fact.sensitive && fact.value !== "");
}

export function graphToJSON(graph: FactGraph): string {
  return JSON.stringify({
    version: FACT_SCHEMA_VERSION,
    facts: listFacts(graph),
    rejected: graph.rejected,
    meta: graphMeta(graph),
    updatedAt: graph.updatedAt,
  });
}

function isSource(raw: unknown): raw is FactSource {
  if (typeof raw !== "object" || raw === null) return false;
  const kind = (raw as { kind?: unknown }).kind;
  return typeof kind === "string" && kind in SOURCE_TRUST;
}

function reviveFact(raw: unknown, now: string): Fact | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string" || typeof r.value !== "string" || !isSource(r.source)) return null;
  const proposal: FactProposal = {
    key: r.key,
    value: r.value,
    source: r.source,
    category: typeof r.category === "string" && (FACT_CATEGORIES as readonly string[]).includes(r.category) ? (r.category as FactCategory) : undefined,
    label: typeof r.label === "string" ? r.label : undefined,
    aliases: Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === "string") : undefined,
    confidence: typeof r.confidence === "number" ? r.confidence : undefined,
    evidence: typeof r.evidence === "string" ? r.evidence : undefined,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
    verifiedByUser: r.verifiedByUser === true,
  };
  const fact = buildFact(proposal, null, now);
  // A stored graph may hold a sensitive fact the user typed; anything else sensitive is dropped on the way in.
  if (!fact || (fact.sensitive && fact.source.kind !== "user")) return null;
  return fact;
}

function reviveMeta(raw: unknown, now: string): GraphMeta {
  const meta = emptyMeta();
  if (typeof raw !== "object" || raw === null) return meta;
  const r = raw as Record<string, unknown>;
  if (typeof r.skipped === "object" && r.skipped !== null) {
    const skipped: SkippedCounts = {};
    for (const [reason, count] of Object.entries(r.skipped as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count) && count > 0) skipped[reason as SensitiveReason] = Math.floor(count);
    }
    meta.skipped = skipped;
  }
  if (Array.isArray(r.sources)) {
    meta.sources = r.sources
      .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .filter((s) => typeof s.id === "string" && s.id !== "")
      .map((s) => ({ id: String(s.id).slice(0, 128), lastScan: typeof s.lastScan === "string" ? dayOf(s.lastScan) : dayOf(now) }))
      .slice(0, FACT_LIMITS.sources);
  }
  return meta;
}

/** Never throws: a corrupt or foreign file yields an empty graph rather than breaking the client. */
export function graphFromJSON(text: string, now = new Date().toISOString()): FactGraph {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyGraph(now);
  }
  if (typeof raw !== "object" || raw === null) return emptyGraph(now);
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.facts) ? r.facts : Object.values((r.facts as Record<string, unknown>) ?? {});
  const facts: Record<string, Fact> = {};
  for (const item of list) {
    const fact = reviveFact(item, now);
    if (fact && Object.keys(facts).length < FACT_LIMITS.facts) facts[fact.key] = fact;
  }
  const updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : now;
  // A version 1 file holds bare hashes. They are stamped with the file's own day, so they expire from then on
  // rather than living forever.
  const rejected = Array.isArray(r.rejected)
    ? r.rejected
        .filter((id): id is string => typeof id === "string" && id !== "")
        .map((entry) => (entry.includes("@") ? entry : rejectionEntry(entry, updatedAt)))
        .slice(-FACT_LIMITS.rejected)
    : [];
  return { version: FACT_SCHEMA_VERSION, facts, rejected, meta: reviveMeta(r.meta, now), updatedAt };
}
