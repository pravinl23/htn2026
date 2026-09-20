// Cold start, the last step: what a scan found becomes the one small file (docs/storage.md), and stays removable.
//
// The knowledge layer owns the brain (shared/src/knowledge); this module owns the two things a SCAN needs on top
// of it and nothing else does:
//
//   1. seeding — surface records and habit counters from what the machine already keeps, so the first Tab on a
//      screen Ghost has never seen is still a real guess (docs/knowledge.md section 3);
//   2. provenance — which source produced which surface and which fact, so "Forget this source" can remove
//      exactly what it produced and nothing else (docs/storage.md section 4).
//
// Provenance lives in the file's `meta` section, which is the section docs/storage.md reserves for exactly this.
// The knowledge layer neither reads nor writes it, so nothing here changes how a prediction is made.
//
// No id in this file is ever parsed. A surface is an opaque token: the code can count it, store it and delete it,
// and that is the whole vocabulary.
import { applyProposals, listFacts, removeFact } from "../facts/graph";
import type { FactProposal } from "../facts/types";
import {
  KNOWLEDGE_MAX_BYTES,
  KNOWLEDGE_TARGET_BYTES,
  SCAN_SURFACE,
  emptyKnowledge,
  forgetSurface,
  knowledgeFromJSON,
  knowledgeToJSON,
  pruneKnowledge,
  screenKindFromPageKind,
  seedFromColdStart,
} from "../knowledge";
import type { ActionRole, HourBucket, KnowledgeGraph, ScreenKind } from "../knowledge";
import { PREVIOUS_NONE } from "../knowledge";
import { OTHER_ORIGIN, TIME_BUCKETS } from "./habits";
import type { HabitAggregate, TimeBucket } from "./habits";
import type { ColdStartSourceKind } from "./plan";
import { impliedActionForKind } from "./surfaces";
import type { SurfaceAggregate, SurfaceRecord } from "./surfaces";
import type { PageKind } from "../affordance/pageKind";

export const COLD_START_META_VERSION = 1;

/** What one source put into the file. Ids and counts; the ids are local-only and never printed or sent. */
export interface ColdStartSourceMeta {
  /** Day resolution, which is the finest time docs/storage.md allows anything stored to be. */
  lastScanDay: string;
  surfaces: string[];
  factKeys: string[];
  habits: number;
  visits: number;
  skipped: Record<string, number>;
}

export interface ColdStartMeta {
  version: number;
  sources: Record<string, ColdStartSourceMeta>;
}

export function emptyColdStartMeta(): ColdStartMeta {
  return { version: COLD_START_META_VERSION, sources: {} };
}

function newSourceMeta(day: string): ColdStartSourceMeta {
  return { lastScanDay: day, surfaces: [], factKeys: [], habits: 0, visits: 0, skipped: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

function countsOf(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(value)) return out;
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) out[key] = Math.floor(count);
  }
  return out;
}

/** Never throws. A file written by an older Ghost, or half-written, yields empty provenance rather than an error. */
export function readColdStartMeta(text: string | null | undefined): ColdStartMeta {
  if (typeof text !== "string" || text.trim() === "") return emptyColdStartMeta();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyColdStartMeta();
  }
  if (!isObject(raw) || !isObject(raw.meta)) return emptyColdStartMeta();
  const sources: Record<string, ColdStartSourceMeta> = {};
  const rawSources = isObject(raw.meta.sources) ? raw.meta.sources : {};
  for (const [kind, value] of Object.entries(rawSources)) {
    if (!isObject(value)) continue;
    sources[kind] = {
      lastScanDay: typeof value.lastScanDay === "string" ? value.lastScanDay : "",
      surfaces: stringsOf(value.surfaces),
      factKeys: stringsOf(value.factKeys),
      habits: typeof value.habits === "number" && value.habits > 0 ? Math.floor(value.habits) : 0,
      visits: typeof value.visits === "number" && value.visits > 0 ? Math.floor(value.visits) : 0,
      skipped: countsOf(value.skipped),
    };
  }
  return { version: COLD_START_META_VERSION, sources };
}

/** The knowledge layer's own JSON plus the provenance section. Stable key order, so a diff of the file is readable. */
export function knowledgeFileText(graph: KnowledgeGraph, meta: ColdStartMeta): string {
  const body = JSON.parse(knowledgeToJSON(graph)) as Record<string, unknown>;
  return JSON.stringify({ ...body, meta });
}

export function fileSizeBytes(text: string): number {
  return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length;
}

function dayOf(now: string): string {
  const day = now.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------------------------

const BUCKET_INDEX: Record<TimeBucket, HourBucket> = { night: 0, morning: 2, midday: 3, afternoon: 4, evening: 5 };

/**
 * Split a visit count across the four-hour buckets it was seen in, so the file keeps "mostly in the morning"
 * without ever keeping a clock. Every bucket that was seen gets at least one visit, and the total is preserved.
 */
export function splitVisits(record: SurfaceRecord): Array<{ bucket?: HourBucket; visits: number }> {
  const seen = TIME_BUCKETS.filter((bucket) => record.timeOfDay[bucket] > 0);
  const visits = Math.max(1, record.visits);
  if (seen.length === 0) return [{ visits }];
  const weight = seen.reduce((sum, bucket) => sum + record.timeOfDay[bucket], 0);
  const out: Array<{ bucket?: HourBucket; visits: number }> = [];
  let left = visits;
  seen.forEach((bucket, index) => {
    const last = index === seen.length - 1;
    const share = last ? left : Math.max(1, Math.min(left - (seen.length - index - 1), Math.round((record.timeOfDay[bucket] / weight) * visits)));
    if (share <= 0) return;
    out.push({ bucket: BUCKET_INDEX[bucket], visits: share });
    left -= share;
  });
  return out.length > 0 ? out : [{ visits }];
}

export interface SeedSurfacesResult {
  surfaces: number;
  habits: number;
  observations: number;
  /** Per source, the ids it contributed, for the provenance section. Local only. */
  bySource: Record<string, { surfaces: string[]; habits: number }>;
}

/**
 * Surface records -> the knowledge graph. Visits and hour buckets become the "what does this person use" half;
 * an action a source could name becomes a weak habit; a place the person merely OWNS becomes a surface with no
 * habit at all, because a thing you own is not a thing you do.
 */
export function seedSurfaces(
  graph: KnowledgeGraph,
  aggregate: SurfaceAggregate,
  at: Date | number | string = new Date(),
): SeedSurfacesResult {
  const before = graph.habits.size;
  const result: SeedSurfacesResult = { surfaces: 0, habits: 0, observations: 0, bySource: {} };

  for (const record of aggregate.surfaces) {
    const kind: ScreenKind = screenKindFromPageKind(record.kind);
    for (const slice of splitVisits(record)) {
      graph.habits.noteVisit(record.surface, kind, slice.bucket, at, slice.visits);
    }
    result.surfaces += 1;
    let habitsHere = 0;
    if (!record.installedOnly) {
      const hourBucket = splitVisits(record)[0]?.bucket;
      for (const [role, count] of Object.entries(record.actions) as [ActionRole, number][]) {
        if (!count || count <= 0) continue;
        graph.habits.record(
          { surface: record.surface, screenKind: kind, previousAction: PREVIOUS_NONE, action: role },
          "taken",
          hourBucket === undefined ? { at, count } : { at, count, hourBucket },
        );
        result.observations += count;
        habitsHere += 1;
      }
    }
    for (const source of record.sources) {
      const entry = result.bySource[source] ?? { surfaces: [], habits: 0 };
      entry.surfaces.push(record.surface);
      // Only a source that saw the place being used is credited with what the person does there.
      if (record.usedSources.includes(source)) entry.habits += habitsHere;
      result.bySource[source] = entry;
    }
  }

  result.habits = graph.habits.size - before;
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------------------------

export interface ApplyColdStartInput {
  /** The file as it is now. Missing, empty or corrupt all mean the same thing: start from an empty brain. */
  file?: string | null;
  /** The browser-history aggregate (shared/src/coldstart/habits.ts). */
  history?: HabitAggregate | null;
  surfaces?: SurfaceAggregate | null;
  /**
   * Counts per KIND of screen, with no place attached: "this person spends time on screens shaped like this".
   * It is the level-2 prior of docs/knowledge.md section 2, and the only thing a source that cannot name a place
   * (recently used documents) is allowed to contribute.
   */
  kinds?: readonly { kind: PageKind; count: number; source?: ColdStartSourceKind }[];
  /** Proposals the user accepted. A proposal is a fact plus its provenance; nothing enters without one. */
  facts?: readonly (FactProposal & { sourceKind?: ColdStartSourceKind })[];
  /** Counts of what each source refused to read, for the "N items skipped as sensitive" line. */
  skipped?: Record<string, Record<string, number>>;
  now?: string;
}

export interface ApplyColdStartResult {
  /** The new file text. The caller writes it atomically at mode 0600 and nowhere else. */
  file: string;
  surfaces: number;
  habits: number;
  facts: number;
  factsUnchanged: number;
  factsRejected: number;
  observations: number;
  bytes: number;
  /** True while the file is inside the 200 KB target from docs/storage.md. */
  withinTarget: boolean;
  pruned: { habits: number; rejected: number };
}

/**
 * One scan into the file. Additive: nothing the user typed or confirmed is overwritten (the facts graph enforces
 * that), habits only ever gain counters, and the caps in docs/storage.md are applied before the text is returned,
 * so the file can never come back over its hard cap.
 */
export function applyColdStart(input: ApplyColdStartInput): ApplyColdStartResult {
  const now = input.now ?? new Date().toISOString();
  const day = dayOf(now);
  const graph = input.file ? knowledgeFromJSON(input.file, now) : emptyKnowledge(now);
  const meta = readColdStartMeta(input.file);

  const touch = (kind: string): ColdStartSourceMeta => {
    const existing = meta.sources[kind] ?? newSourceMeta(day);
    existing.lastScanDay = day;
    meta.sources[kind] = existing;
    return existing;
  };

  const habitsBefore = graph.habits.size;
  let surfaces = 0;
  let observations = 0;

  if (input.history) {
    const seeded = seedFromColdStart(graph, input.history, now);
    surfaces += seeded.surfaces;
    observations += seeded.observations;
    const entry = touch("browser-history");
    const ids = (input.history.origins ?? [])
      .filter((origin) => origin.origin !== OTHER_ORIGIN && origin.other !== true)
      .map((origin) => origin.origin);
    // The reserved scan surface holds what history taught about a KIND of screen with no place attached. It is
    // listed here so that forgetting the history forgets that too, and nothing of it survives the click.
    entry.surfaces = unique([...entry.surfaces, ...ids, SCAN_SURFACE]);
    entry.visits += input.history.totalVisits ?? 0;

    // A history row knows WHERE and WHEN but not what the person did there. What the kind of screen implies is
    // still a real starting guess, so a place history could place gets one weak counter for it — one, not many,
    // because the evidence is a shape and not an action.
    for (const origin of input.history.origins ?? []) {
      if (origin.origin === OTHER_ORIGIN || origin.other === true) continue;
      if (Object.keys(origin.actions ?? {}).length > 0) continue;
      const action = impliedActionForKind(origin.dominantKind);
      if (!action) continue;
      graph.habits.record(
        { surface: origin.origin, screenKind: screenKindFromPageKind(origin.dominantKind), previousAction: PREVIOUS_NONE, action },
        "taken",
        { at: now, count: 1 },
      );
      observations += 1;
      entry.habits += 1;
    }
  }

  if (input.surfaces) {
    const seeded = seedSurfaces(graph, input.surfaces, now);
    surfaces += seeded.surfaces;
    observations += seeded.observations;
    for (const [kind, contribution] of Object.entries(seeded.bySource)) {
      const entry = touch(kind);
      entry.surfaces = unique([...entry.surfaces, ...contribution.surfaces]);
      // Visits come from the OBSERVATION level, where each source is counted once for what it actually said.
      // Summing a folded record's visits per claiming source would credit the same visit to two sources.
      entry.visits += input.surfaces.bySource[kind]?.visits ?? 0;
      entry.habits += contribution.habits;
    }
  }

  for (const entry of input.kinds ?? []) {
    const count = typeof entry?.count === "number" && entry.count > 0 ? Math.floor(entry.count) : 0;
    const action = count > 0 ? impliedActionForKind(entry.kind) : undefined;
    if (!action) continue;
    const screenKind = screenKindFromPageKind(entry.kind);
    // The reserved scan surface is never ranked; what is stored there lifts every screen of that shape.
    graph.habits.record({ surface: SCAN_SURFACE, screenKind, previousAction: PREVIOUS_NONE, action }, "taken", { at: now, count });
    observations += count;
    const meta = touch(entry.source ?? "recent-docs");
    meta.surfaces = unique([...meta.surfaces, SCAN_SURFACE]);
    meta.habits += 1;
  }

  let factsApplied = 0;
  let factsUnchanged = 0;
  let factsRejected = 0;
  if (input.facts && input.facts.length > 0) {
    const applied = applyProposals(graph.facts, input.facts, now);
    graph.facts = applied.graph;
    factsApplied = applied.added + applied.updated;
    factsUnchanged = applied.kept;
    factsRejected = applied.rejected + applied.sensitive + applied.invalid;
    for (const proposal of input.facts) {
      const kind = proposal.sourceKind ?? "spotlight";
      const entry = touch(kind);
      if (!entry.factKeys.includes(proposal.key)) entry.factKeys.push(proposal.key);
    }
  }

  for (const [kind, counts] of Object.entries(input.skipped ?? {})) {
    const entry = touch(kind);
    for (const [reason, count] of Object.entries(countsOf(counts))) {
      entry.skipped[reason] = (entry.skipped[reason] ?? 0) + count;
    }
  }

  // The caps are enforced before the text exists, never after it is written: the file cannot grow past them.
  const pruned = pruneKnowledge(graph, now);
  let text = knowledgeFileText(graph, meta);
  if (fileSizeBytes(text) > KNOWLEDGE_MAX_BYTES) {
    // One more pass with the stalest rows gone. Surfaces go before facts, because a fact is what the user typed.
    graph.habits.prune(now);
    text = knowledgeFileText(graph, meta);
  }

  const bytes = fileSizeBytes(text);
  return {
    file: text,
    surfaces,
    habits: Math.max(0, graph.habits.size - habitsBefore),
    facts: factsApplied,
    factsUnchanged,
    factsRejected,
    observations,
    bytes,
    withinTarget: bytes <= KNOWLEDGE_TARGET_BYTES,
    pruned: { habits: pruned.habits, rejected: pruned.rejected },
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------------------------------------------
// What Ghost knows, and unlearning it
// ---------------------------------------------------------------------------------------------------------------

export interface KnowledgeSummarySurface {
  /** An opaque id. It is stored locally on purpose and is never printed into a report or sent anywhere. */
  surface: string;
  visits: number;
  kinds: Partial<Record<ScreenKind, number>>;
  hourBuckets: HourBucket[];
  lastSeen: string;
}

export interface KnowledgeSummary {
  bytes: number;
  withinTarget: boolean;
  facts: number;
  factsByCategory: Record<string, number>;
  answers: number;
  habits: number;
  surfaces: number;
  /** How many surfaces are of each screen kind. Kinds and counts: this is the safe half to show anywhere. */
  byScreenKind: Record<string, number>;
  bySource: Record<string, { surfaces: number; facts: number; habits: number; visits: number; lastScanDay: string; skipped: number }>;
  /** Most used first. Ids included so a UI can offer "forget this one"; a report prints the counts, not the ids. */
  topSurfaces: KnowledgeSummarySurface[];
}

function bucketsOf(mask: number): HourBucket[] {
  const out: HourBucket[] = [];
  for (let bucket = 0; bucket < 6; bucket += 1) if ((mask & (1 << bucket)) !== 0) out.push(bucket as HourBucket);
  return out;
}

/** Everything the options page and the menu bar show (docs/storage.md section 4), computed from the file alone. */
export function describeKnowledge(text: string | null | undefined, topN = 10): KnowledgeSummary {
  const now = new Date().toISOString();
  const graph = text ? knowledgeFromJSON(text, now) : emptyKnowledge(now);
  const meta = readColdStartMeta(text);
  const facts = listFacts(graph.facts);
  const factsByCategory: Record<string, number> = {};
  for (const fact of facts) factsByCategory[fact.category] = (factsByCategory[fact.category] ?? 0) + 1;

  const surfaces = graph.habits.surfaces();
  const byScreenKind: Record<string, number> = {};
  for (const surface of surfaces) {
    let dominant = "unknown";
    let best = -1;
    for (const [kind, count] of Object.entries(surface.kinds)) {
      if (typeof count === "number" && count > best) {
        best = count;
        dominant = kind;
      }
    }
    byScreenKind[dominant] = (byScreenKind[dominant] ?? 0) + 1;
  }

  const bySource: KnowledgeSummary["bySource"] = {};
  for (const [kind, entry] of Object.entries(meta.sources)) {
    bySource[kind] = {
      surfaces: entry.surfaces.length,
      facts: entry.factKeys.length,
      habits: entry.habits,
      visits: entry.visits,
      lastScanDay: entry.lastScanDay,
      skipped: Object.values(entry.skipped).reduce((sum, count) => sum + count, 0),
    };
  }

  const bytes = text ? fileSizeBytes(text) : fileSizeBytes(knowledgeFileText(graph, meta));
  return {
    bytes,
    withinTarget: bytes <= KNOWLEDGE_TARGET_BYTES,
    facts: facts.length,
    factsByCategory,
    answers: 0,
    habits: graph.habits.size,
    surfaces: surfaces.length,
    byScreenKind,
    bySource,
    topSurfaces: surfaces.slice(0, Math.max(0, topN)).map((surface) => ({
      surface: surface.surface,
      visits: surface.visits,
      kinds: surface.kinds,
      hourBuckets: bucketsOf(surface.hours),
      lastSeen: surface.lastSeen,
    })),
  };
}

export interface ForgetResult {
  file: string;
  surfaces: number;
  habits: number;
  facts: number;
  /** Facts left alone because the user typed or confirmed them: the one class docs/storage.md protects. */
  factsKept: number;
  bytes: number;
}

/**
 * "Forget this source" (docs/storage.md section 4). It removes exactly what that source produced: the surfaces
 * only it contributed, every habit learned on them, and the facts it proposed that the user never confirmed. A
 * surface another source also found keeps its counters and simply loses this source's claim on it.
 */
export function forgetColdStartSource(text: string | null | undefined, kind: string): ForgetResult {
  const now = new Date().toISOString();
  const graph = text ? knowledgeFromJSON(text, now) : emptyKnowledge(now);
  const meta = readColdStartMeta(text);
  const entry = meta.sources[kind];
  if (!entry) {
    const unchanged = knowledgeFileText(graph, meta);
    return { file: unchanged, surfaces: 0, habits: 0, facts: 0, factsKept: 0, bytes: fileSizeBytes(unchanged) };
  }

  const claimedElsewhere = new Set<string>();
  for (const [other, source] of Object.entries(meta.sources)) {
    if (other === kind) continue;
    for (const surface of source.surfaces) claimedElsewhere.add(surface);
  }

  // The store's own count is the honest one: `forgetSurface` returns rows removed, and a surface record is one of
  // those rows, so adding its return up would report a place that held no habit as if it had held one.
  const habitsBefore = graph.habits.size;
  let removedSurfaces = 0;
  for (const surface of entry.surfaces) {
    if (claimedElsewhere.has(surface)) continue;
    forgetSurface(graph, surface);
    removedSurfaces += 1;
  }
  const removedHabits = Math.max(0, habitsBefore - graph.habits.size);

  let removedFacts = 0;
  let keptFacts = 0;
  for (const key of entry.factKeys) {
    const fact = listFacts(graph.facts).find((candidate) => candidate.key === key);
    if (!fact) continue;
    if (fact.verifiedByUser) {
      keptFacts += 1;
      continue;
    }
    graph.facts = removeFact(graph.facts, key, now);
    removedFacts += 1;
  }

  delete meta.sources[kind];
  const file = knowledgeFileText(graph, meta);
  return { file, surfaces: removedSurfaces, habits: removedHabits, facts: removedFacts, factsKept: keptFacts, bytes: fileSizeBytes(file) };
}

/** "Delete everything": the file is replaced by an empty brain rather than left in an in-between state. */
export function emptyKnowledgeFile(now = new Date().toISOString()): string {
  return knowledgeFileText(emptyKnowledge(now), emptyColdStartMeta());
}
