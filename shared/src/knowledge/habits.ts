// Habits: "here, after that, what do they do next?" (docs/knowledge.md sections 1 and 4, docs/storage.md).
//
// Counters, never histories. One entry is `(surface, screenKind, previousAction, action) -> {taken, ignored,
// replaced}` plus a six-bit mask of the hour buckets it was taken in and a day-resolution last-seen. There is no
// event log, so the file does not grow with use, and nothing in an entry can be read back as a place the user went.
//
// Two generalizations sit on top of the raw counters, and they are what make a screen Ghost has never seen useful:
//   1. the same screen kind across ALL other surfaces — what this person does on screens shaped like this one;
//   2. a shape-only prior — what anyone would want on a screen of that kind, when there is no history at all.
// Nothing here reads a surface id for meaning: it is a grouping key, so the layer cannot overfit to one site.
import type { FactGraph } from "../facts/types";
import type { ActionRole, HourBucket, ScreenState } from "./context";
import { PREVIOUS_NONE } from "./context";
import type { ScreenKind } from "./screenKind";

/** What became of a proposal, or of an action the user took unprompted. */
export type Outcome =
  /** The user accepted the ghost, or did this themselves. */
  | "taken"
  /** The ghost was shown and the user moved on. Weak evidence against. */
  | "ignored"
  /** The user did something ELSE instead. The strongest signal in the layer: it corrects and teaches at once. */
  | "replaced";

export const OUTCOMES: readonly Outcome[] = ["taken", "ignored", "replaced"];

export interface HabitCounts {
  taken: number;
  ignored: number;
  replaced: number;
  /** Bit per hour bucket in which this was taken. Six bits, so the file never holds a timestamp. */
  hours: number;
  /** Day resolution, which is all docs/storage.md allows any stored time to be. */
  lastSeen: string;
}

export interface HabitKey {
  /** Opaque. Never parsed, never matched against a list. */
  surface: string;
  screenKind: ScreenKind;
  /** An action role, or "none" for the first action on a screen. */
  previousAction: string;
  action: ActionRole;
}

export interface HabitEntry extends HabitKey {
  counts: HabitCounts;
}

/** "What does this person use, and how much?" (docs/knowledge.md section 1). Counts and buckets only. */
export interface SurfaceStat {
  surface: string;
  visits: number;
  /** Bit per hour bucket seen. */
  hours: number;
  kinds: Partial<Record<ScreenKind, number>>;
  lastSeen: string;
}

export interface HabitSnapshot {
  version: number;
  /** Least recently touched first, so a truncated file loses the stalest rows. */
  entries: HabitEntry[];
  surfaces: SurfaceStat[];
}

export const HABIT_SCHEMA_VERSION = 1;

/** docs/storage.md section 1: 300 surfaces and 2,000 counters, which is 10 to 30 KB of the 200 KB budget. */
export const HABIT_LIMITS = {
  counters: 2000,
  surfaces: 300,
  surfaceChars: 128,
  kindsPerSurface: 10,
} as const;

/** Pruning, in the order docs/storage.md gives: a habit seen once and not since is the first thing to go. */
export const HABIT_PRUNE = {
  staleDays: 30,
  /** A habit taken this often is never dropped to make room, however old it is. */
  protectTaken: 3,
} as const;

export const ZERO_COUNTS: HabitCounts = { taken: 0, ignored: 0, replaced: 0, hours: 0, lastSeen: "" };

function zero(): HabitCounts {
  return { ...ZERO_COUNTS };
}

export function totalOf(counts: HabitCounts): number {
  return counts.taken + counts.ignored + counts.replaced;
}

function dayOf(at: Date | number | string = new Date()): string {
  const date = typeof at === "string" ? new Date(at) : typeof at === "number" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return "1970-01-01";
  return date.toISOString().slice(0, 10);
}

const MS_PER_DAY = 86_400_000;

export function daysSince(lastSeen: string, today: Date | number | string = new Date()): number {
  if (lastSeen === "") return Number.POSITIVE_INFINITY;
  const from = Date.parse(`${lastSeen}T00:00:00.000Z`);
  const to = Date.parse(`${dayOf(today)}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((to - from) / MS_PER_DAY));
}

function finite(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function cleanSurface(surface: string): string {
  return surface.trim().slice(0, HABIT_LIMITS.surfaceChars);
}

export function habitKeyOf(key: HabitKey): string {
  return `${cleanSurface(key.surface)}|${key.screenKind}|${key.previousAction || PREVIOUS_NONE}|${key.action}`;
}

/** Add one set of counters into another. Used for both generalizations, which are sums over entries. */
export function addCounts(into: HabitCounts, from: HabitCounts): HabitCounts {
  return {
    taken: into.taken + from.taken,
    ignored: into.ignored + from.ignored,
    replaced: into.replaced + from.replaced,
    hours: into.hours | from.hours,
    lastSeen: from.lastSeen > into.lastSeen ? from.lastSeen : into.lastSeen,
  };
}

export function hourBit(bucket: HourBucket | undefined): number {
  return bucket === undefined ? 0 : 1 << bucket;
}

export function takenInHour(counts: HabitCounts, bucket: HourBucket | undefined): boolean {
  return bucket !== undefined && (counts.hours & hourBit(bucket)) !== 0;
}

interface RecordOptions {
  hourBucket?: HourBucket;
  at?: Date | number | string;
  /** How many times at once. A cold-start scan hands over aggregates, not one row per action. */
  count?: number;
}

/**
 * The counter store. Pure, JSON-serializable, bounded. Insertion order is recency, exactly like the other stores
 * in this repo, so the oldest rows are the ones a truncated file loses.
 */
export class HabitStore {
  private readonly entries = new Map<string, HabitEntry>();
  private readonly surfaceStats = new Map<string, SurfaceStat>();
  /** kind|previous|action -> the full keys that contribute, for generalization 1 without a scan. */
  private readonly byKindPrevious = new Map<string, Set<string>>();
  /** kind|action -> the full keys that contribute, for the same generalization with any previous action. */
  private readonly byKind = new Map<string, Set<string>>();
  /** surface|kind|action -> the full keys, for this surface with any previous action. */
  private readonly bySurfaceKind = new Map<string, Set<string>>();
  /** surface|kind -> the full keys, for "how well does Ghost know this screen at all". */
  private readonly bySurface = new Map<string, Set<string>>();

  constructor(entries: readonly HabitEntry[] = [], surfaces: readonly SurfaceStat[] = []) {
    for (const entry of entries.slice(-HABIT_LIMITS.counters)) this.put(entry);
    for (const surface of surfaces.slice(-HABIT_LIMITS.surfaces)) {
      const clean = cleanSurface(surface.surface);
      if (clean === "") continue;
      this.surfaceStats.set(clean, {
        surface: clean,
        visits: finite(surface.visits),
        hours: finite(surface.hours) & 0b111111,
        kinds: { ...surface.kinds },
        lastSeen: surface.lastSeen ?? "",
      });
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get surfaceCount(): number {
    return this.surfaceStats.size;
  }

  private put(entry: HabitEntry): void {
    const surface = cleanSurface(entry.surface);
    const previousAction = entry.previousAction || PREVIOUS_NONE;
    const clean: HabitEntry = {
      surface,
      screenKind: entry.screenKind,
      previousAction,
      action: entry.action,
      counts: {
        taken: finite(entry.counts?.taken),
        ignored: finite(entry.counts?.ignored),
        replaced: finite(entry.counts?.replaced),
        hours: finite(entry.counts?.hours) & 0b111111,
        lastSeen: typeof entry.counts?.lastSeen === "string" ? entry.counts.lastSeen.slice(0, 10) : "",
      },
    };
    const key = habitKeyOf(clean);
    this.entries.delete(key);
    this.entries.set(key, clean);
    index(this.byKindPrevious, `${clean.screenKind}|${previousAction}|${clean.action}`, key);
    index(this.byKind, `${clean.screenKind}|${clean.action}`, key);
    index(this.bySurfaceKind, `${surface}|${clean.screenKind}|${clean.action}`, key);
    index(this.bySurface, `${surface}|${clean.screenKind}`, key);
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    unindex(this.byKindPrevious, `${entry.screenKind}|${entry.previousAction}|${entry.action}`, key);
    unindex(this.byKind, `${entry.screenKind}|${entry.action}`, key);
    unindex(this.bySurfaceKind, `${entry.surface}|${entry.screenKind}|${entry.action}`, key);
    unindex(this.bySurface, `${entry.surface}|${entry.screenKind}`, key);
  }

  /** One outcome. `taken` also records the hour bucket, which is the only time signal the file keeps. */
  record(key: HabitKey, outcome: Outcome, options: RecordOptions = {}): void {
    const surface = cleanSurface(key.surface);
    if (surface === "") return;
    const by = Math.max(1, Math.min(1000, Math.floor(options.count ?? 1)));
    const full = habitKeyOf({ ...key, surface });
    const existing = this.entries.get(full);
    const counts = existing ? { ...existing.counts } : zero();
    counts[outcome] += by;
    counts.lastSeen = dayOf(options.at);
    if (outcome === "taken") counts.hours |= hourBit(options.hourBucket);
    this.put({ surface, screenKind: key.screenKind, previousAction: key.previousAction || PREVIOUS_NONE, action: key.action, counts });
    this.enforceCaps(options.at);
  }

  /**
   * The user arrived at a surface. Feeds the "what does this person use" half of the layer. `visits` is there for
   * a cold-start scan, which hands over a count rather than one call per visit.
   */
  noteVisit(surface: string, screenKind: ScreenKind, hourBucket?: HourBucket, at: Date | number | string = new Date(), visits = 1): void {
    const clean = cleanSurface(surface);
    if (clean === "") return;
    const by = Math.max(1, Math.min(100_000, Math.floor(Number.isFinite(visits) ? visits : 1)));
    const stat = this.surfaceStats.get(clean) ?? { surface: clean, visits: 0, hours: 0, kinds: {}, lastSeen: "" };
    stat.visits += by;
    stat.hours |= hourBit(hourBucket);
    stat.lastSeen = dayOf(at);
    const seen = stat.kinds[screenKind] ?? 0;
    if (seen > 0 || Object.keys(stat.kinds).length < HABIT_LIMITS.kindsPerSurface) stat.kinds[screenKind] = seen + by;
    this.surfaceStats.delete(clean);
    this.surfaceStats.set(clean, stat);
    while (this.surfaceStats.size > HABIT_LIMITS.surfaces) {
      const weakest = [...this.surfaceStats.values()].sort((a, b) => a.visits - b.visits || a.lastSeen.localeCompare(b.lastSeen))[0];
      if (!weakest) break;
      this.surfaceStats.delete(weakest.surface);
    }
  }

  surface(surface: string): SurfaceStat | null {
    const stat = this.surfaceStats.get(cleanSurface(surface));
    return stat ? { ...stat, kinds: { ...stat.kinds } } : null;
  }

  /** Every surface the store knows, most visited first. Ids and counts: nothing else is stored to leak. */
  surfaces(): SurfaceStat[] {
    return [...this.surfaceStats.values()]
      .map((stat) => ({ ...stat, kinds: { ...stat.kinds } }))
      .sort((a, b) => b.visits - a.visits || a.surface.localeCompare(b.surface));
  }

  /** Level 1: this surface, this screen kind, after this action. */
  stat(key: HabitKey): HabitCounts {
    const entry = this.entries.get(habitKeyOf(key));
    return entry ? { ...entry.counts } : zero();
  }

  /**
   * How much Ghost has watched this person on this kind of screen HERE, counting every action and every outcome.
   * It is what decides how much borrowed evidence still counts: once Ghost knows a screen, here leads.
   */
  surfaceVolume(surface: string, screenKind: ScreenKind): number {
    const keys = this.bySurface.get(`${cleanSurface(surface)}|${screenKind}`);
    if (!keys) return 0;
    let total = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) total += totalOf(entry.counts);
    }
    return total;
  }

  /**
   * How often this person ACTS here at all: the denominator of "of everything they do on this screen, how much of
   * it is this". A rate answers "when Ghost proposed this, did they take it"; a share answers "is this the thing
   * they mostly do here", and a ranking needs both (docs/knowledge.md section 6: the noisy screens).
   */
  surfaceTaken(surface: string, screenKind: ScreenKind): number {
    const keys = this.bySurface.get(`${cleanSurface(surface)}|${screenKind}`);
    if (!keys) return 0;
    let total = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) total += entry.counts.taken;
    }
    return total;
  }

  /** Level 1, backed off: this surface and this screen kind, whatever came before. */
  surfaceStat(surface: string, screenKind: ScreenKind, action: ActionRole): HabitCounts {
    return this.sum(this.bySurfaceKind.get(`${cleanSurface(surface)}|${screenKind}|${action}`));
  }

  /**
   * Level 2: the same screen kind on every OTHER surface. Excluding the surface being ranked keeps the two levels
   * independent, so "learned there, useful here" is a real transfer rather than the same evidence counted twice.
   */
  kindStat(screenKind: ScreenKind, previousAction: string, action: ActionRole, excludeSurface?: string): HabitCounts {
    return this.sum(this.byKindPrevious.get(`${screenKind}|${previousAction || PREVIOUS_NONE}|${action}`), excludeSurface);
  }

  /** Level 2, backed off: the same screen kind anywhere, whatever came before. */
  kindAnyStat(screenKind: ScreenKind, action: ActionRole, excludeSurface?: string): HabitCounts {
    return this.sum(this.byKind.get(`${screenKind}|${action}`), excludeSurface);
  }

  private sum(keys: Set<string> | undefined, excludeSurface?: string): HabitCounts {
    const total = zero();
    if (!keys) return total;
    const exclude = excludeSurface === undefined ? undefined : cleanSurface(excludeSurface);
    let out = total;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry || (exclude !== undefined && entry.surface === exclude)) continue;
      out = addCounts(out, entry.counts);
    }
    return out;
  }

  /** Every entry, least recently touched first. */
  list(): HabitEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry, counts: { ...entry.counts } }));
  }

  /** "Forget this surface": everything learned there goes, and nothing else moves. */
  forgetSurface(surface: string): number {
    const clean = cleanSurface(surface);
    let removed = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.surface !== clean) continue;
      this.drop(key);
      removed += 1;
    }
    if (this.surfaceStats.delete(clean)) removed += 1;
    return removed;
  }

  /**
   * docs/storage.md section 2, in order: a habit seen once and not seen for 30 days goes first; past the cap the
   * weakest rows go next. A habit the user has taken more than a handful of times is never dropped to make room.
   */
  prune(today: Date | number | string = new Date()): number {
    let dropped = 0;
    for (const [key, entry] of [...this.entries]) {
      if (totalOf(entry.counts) > 1) continue;
      if (entry.counts.taken >= HABIT_PRUNE.protectTaken) continue;
      if (daysSince(entry.counts.lastSeen, today) <= HABIT_PRUNE.staleDays) continue;
      this.drop(key);
      dropped += 1;
    }
    return dropped + this.enforceCaps(today);
  }

  /** Past the cap, the weakest row goes. One pass per eviction: a write must stay cheap however full the file is. */
  private enforceCaps(today: Date | number | string = new Date()): number {
    let dropped = 0;
    while (this.entries.size > HABIT_LIMITS.counters) {
      let weakestKey: string | null = null;
      let weakest = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        const score = strength(entry, today);
        if (score < weakest) {
          weakest = score;
          weakestKey = key;
        }
      }
      if (weakestKey === null) break;
      this.drop(weakestKey);
      dropped += 1;
    }
    return dropped;
  }

  toJSON(): HabitSnapshot {
    return { version: HABIT_SCHEMA_VERSION, entries: this.list(), surfaces: this.surfaces() };
  }

  /** A corrupt or foreign snapshot yields an empty store rather than a broken one: memory is never load-bearing. */
  static fromJSON(snapshot: HabitSnapshot | null | undefined): HabitStore {
    if (!snapshot || !Array.isArray(snapshot.entries)) return new HabitStore();
    const entries: HabitEntry[] = [];
    for (const raw of snapshot.entries) {
      if (!raw || typeof raw.surface !== "string" || typeof raw.action !== "string" || typeof raw.screenKind !== "string") continue;
      entries.push({
        surface: raw.surface,
        screenKind: raw.screenKind as ScreenKind,
        previousAction: typeof raw.previousAction === "string" ? raw.previousAction : PREVIOUS_NONE,
        action: raw.action as ActionRole,
        counts: {
          taken: finite(raw.counts?.taken),
          ignored: finite(raw.counts?.ignored),
          replaced: finite(raw.counts?.replaced),
          hours: finite(raw.counts?.hours) & 0b111111,
          lastSeen: typeof raw.counts?.lastSeen === "string" ? raw.counts.lastSeen.slice(0, 10) : "",
        },
      });
    }
    const surfaces = Array.isArray(snapshot.surfaces)
      ? snapshot.surfaces.filter((s): s is SurfaceStat => Boolean(s) && typeof s.surface === "string")
      : [];
    return new HabitStore(entries, surfaces);
  }
}

/** How much a row is worth keeping. Taken counts most, a recent row beats a stale one, protection wins outright. */
function strength(entry: HabitEntry, today: Date | number | string): number {
  const protectedRow = entry.counts.taken >= HABIT_PRUNE.protectTaken;
  const age = Math.min(365, daysSince(entry.counts.lastSeen, today));
  const base = entry.counts.taken * 3 + entry.counts.replaced * 2 + entry.counts.ignored;
  return (protectedRow ? 10_000 : 0) + base * 10 - age / 10;
}

function index(map: Map<string, Set<string>>, key: string, full: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(full);
  map.set(key, set);
}

function unindex(map: Map<string, Set<string>>, key: string, full: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(full);
  if (set.size === 0) map.delete(key);
}

// ---------- level 3: the shape-only prior ----------

export interface ShapePrior {
  role: ActionRole;
  weight: number;
}

/** Deliberately weak, exactly like docs/anywhere.md's priors: real history must always be able to outrank a prior. */
export const SHAPE_PRIOR_MAX = 0.7;
export const SHAPE_PRIOR_MIN = 0.55;
/** A role the shape has no opinion about. Present, rankable, never the top of an empty graph on its own. */
export const SHAPE_PRIOR_UNLISTED = 0.45;

/**
 * What anyone would most likely want on a screen of this shape. This is the floor under "always propose": on a
 * surface Ghost has never seen, with a completely empty graph, this alone produces a ranking.
 */
export function shapePriors(kind: ScreenKind, state: ScreenState = {}): ShapePrior[] {
  return build(kind, state)
    .filter((prior) => prior.weight > 0)
    .map((prior) => ({ role: prior.role, weight: Math.min(SHAPE_PRIOR_MAX, Math.max(SHAPE_PRIOR_MIN, prior.weight)) }))
    .sort((a, b) => b.weight - a.weight);
}

export function shapePriorWeight(kind: ScreenKind, role: ActionRole, state: ScreenState = {}): number {
  return shapePriors(kind, state).find((prior) => prior.role === role)?.weight ?? 0;
}

function build(kind: ScreenKind, state: ScreenState): ShapePrior[] {
  switch (kind) {
    case "media":
      return media(state);
    case "feed":
      return [
        { role: "primary-item", weight: 0.7 },
        { role: "scroll-more", weight: state.atEnd === true ? 0.66 : 0.58 },
        { role: "search", weight: state.hasQuery === true ? 0.62 : 0.57 },
        { role: "wishlist", weight: 0.55 },
      ];
    case "list":
      // A list with one row open is a detail: answering it is the next move. Otherwise the next row is.
      return state.readingItem === true
        ? [
            { role: "reply", weight: 0.68 },
            { role: "primary-item", weight: 0.62 },
            { role: "compose", weight: 0.58 },
            { role: "back", weight: 0.55 },
          ]
        : [
            { role: "primary-item", weight: 0.7 },
            { role: "search", weight: 0.6 },
            { role: "compose", weight: 0.58 },
            { role: "more", weight: 0.55 },
          ];
    case "reader":
      return state.atEnd === true
        ? [
            { role: "reply", weight: 0.7 },
            { role: "back", weight: 0.64 },
            { role: "share", weight: 0.58 },
            { role: "scroll-more", weight: 0.55 },
          ]
        : [
            { role: "scroll-more", weight: 0.68 },
            { role: "reply", weight: 0.64 },
            { role: "back", weight: 0.57 },
            { role: "share", weight: 0.55 },
          ];
    case "commerce":
      // Terminal actions stay low on purpose (rule 2): a prior must never be what puts a cursor on Pay.
      return (state.cartCount ?? 0) > 0
        ? [
            { role: "cart", weight: 0.68 },
            { role: "checkout", weight: 0.6 },
            { role: "search", weight: 0.57 },
            { role: "primary-item", weight: 0.55 },
          ]
        : [
            { role: "cart", weight: 0.66 },
            { role: "search", weight: 0.62 },
            { role: "primary-item", weight: 0.6 },
            { role: "wishlist", weight: 0.56 },
          ];
    case "settings":
      return [
        { role: "toggle", weight: 0.7 },
        { role: "search", weight: 0.6 },
        { role: "primary-item", weight: 0.58 },
        { role: "back", weight: 0.55 },
      ];
    case "editor":
      return [
        { role: "field", weight: 0.7 },
        { role: "save", weight: 0.62 },
        { role: "share", weight: 0.56 },
        { role: "more", weight: 0.55 },
      ];
    case "board":
      return [
        { role: "cell", weight: 0.7 },
        { role: "more", weight: 0.58 },
        { role: "back", weight: 0.56 },
        { role: "settings", weight: 0.55 },
      ];
    case "form":
      return [
        { role: "field", weight: 0.7 },
        { role: "toggle", weight: 0.6 },
        { role: "submit", weight: 0.56 },
      ];
    case "unknown":
      return [
        { role: "search", weight: 0.6 },
        { role: "primary-item", weight: 0.58 },
        { role: "more", weight: 0.55 },
      ];
  }
}

function media(state: ScreenState): ShapePrior[] {
  const priors: ShapePrior[] = [];
  if (state.mediaPlaying !== true) priors.push({ role: "play", weight: 0.7 });
  // Playing: going full screen is the next move. Already full screen: proposing it again is the classic wrong ghost.
  if (state.isFullscreen !== true) priors.push({ role: "fullscreen", weight: state.mediaPlaying === true ? 0.7 : 0.62 });
  priors.push({ role: "next", weight: 0.58 });
  if (state.mediaPlaying === true) priors.push({ role: "pause", weight: 0.56 });
  priors.push({ role: "captions", weight: 0.55 });
  return priors;
}

// ---------- the graph the predictors are handed ----------

/**
 * One person's model, as the predictors see it: the facts that fill fields, the habits that predict actions, and
 * the surfaces they use. It is the in-memory half of the one small file in docs/storage.md; the answers store
 * (docs/answers.md) is the third section of that same file and is owned by its own module.
 */
export interface KnowledgeGraph {
  version: number;
  facts: FactGraph;
  habits: HabitStore;
}

export const KNOWLEDGE_SCHEMA_VERSION = 1;
