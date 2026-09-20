// Cold start, the SURFACE half (docs/knowledge.md sections 1 and 3). The résumé half of cold start answers "who is
// this person"; this answers "what does this person use", which is the half that makes Shabang useful on a screen it
// has never seen — a feed, a player, a settings pane, a board, a native window, anything.
//
// The rule that matters most here: a surface is an OPAQUE ID. Nothing in this file parses one, matches one against
// a list, or behaves differently because of what one says. There is no hostname test and no bundle-id list; the
// only thing the code knows about an id is whether it is well FORMED, and everything else is learned from counts.
//
// What comes in is an observation the native side gathered from something the machine already keeps (the Dock, the
// login items, how recently an application was used, what is installed, a browser history aggregate). What comes
// out is counters: visits, four-hour buckets, a kind of screen, and the actions a kind of screen implies. No path,
// no document name, no title, no URL beyond a bare host, and no timestamp finer than a day.
import type { PageKind } from "../affordance/pageKind";
import { priorsFor } from "../affordance/priors";
import { LOCKED_ROLES } from "../affordance/roles";
import type { AffordanceRole } from "../affordance/roles";
import { bucketForHour, hostOfOrigin, TIME_BUCKETS } from "./habits";
import type { HistoryAction, TimeBucket, TimeOfDayCounts } from "./habits";
import type { ColdStartSourceKind } from "./plan";

/** What one no-permission source noticed about one place. Counts and shapes; never a path or a document. */
export interface SurfaceObservation {
  /** A bare host, an origin, a URL, or `app:<identifier>`. Reduced to an opaque id and never parsed again. */
  surface: string;
  source: ColdStartSourceKind;
  /** The kind of screen this place usually is, when the source can tell. Unknown is the honest default. */
  kind?: PageKind;
  /** How many times the machine says it was used. Absent means "once, that we know of". */
  visits?: number;
  /** Local hours (0..23) it was used at. Only the four-hour bucket survives. */
  hours?: readonly number[];
  /** How long ago it was last used, in days. Rounded, capped, and stored as a day count — never an instant. */
  lastUsedDaysAgo?: number;
  /** Actions the source can say the person takes here. Counts only. */
  actions?: readonly HistoryAction[];
  /**
   * The source knows this place EXISTS but not that it is used (an installed application). It becomes a surface
   * Shabang can recognise, and never a habit: a thing you own is not a thing you do.
   */
  installedOnly?: boolean;
}

/** One place, after folding. `surface` is the opaque id; everything else is a counter. */
export interface SurfaceRecord {
  surface: string;
  kind: PageKind;
  visits: number;
  /** Which four-hour buckets it was used in, as bucket indexes 0..5, ascending. */
  hourBuckets: number[];
  timeOfDay: TimeOfDayCounts;
  /** Days since it was last used, when any source knew. Day resolution is the finest this file ever keeps. */
  lastUsedDaysAgo?: number;
  /** Which cold-start sources contributed, so one click can remove exactly what one of them produced. */
  sources: ColdStartSourceKind[];
  /**
   * The subset that saw this place being USED rather than merely owned. Habits are credited only to these, so an
   * inventory of what is installed never takes credit for what another source watched the person do.
   */
  usedSources: ColdStartSourceKind[];
  actions: Partial<Record<AffordanceRole, number>>;
  /** True while every source that mentioned it only knew that it exists. */
  installedOnly: boolean;
}

export interface SurfaceTransitionObservation {
  from: string;
  to: string;
  count?: number;
}

export interface SurfaceTransitionRecord {
  from: string;
  to: string;
  count: number;
}

export interface SourceContribution {
  observations: number;
  surfaces: number;
  visits: number;
}

export interface SurfaceAggregate {
  surfaces: SurfaceRecord[];
  transitions: SurfaceTransitionRecord[];
  /** Per kind of screen, how much of this person's time it accounts for. No id attached. */
  kinds: Array<{ kind: PageKind; surfaces: number; visits: number }>;
  bySource: Record<string, SourceContribution>;
  /** Observations thrown away for an id that does not reduce to a well-formed opaque token. */
  dropped: number;
  /** Surfaces beyond the cap, dropped weakest first. */
  capped: number;
  totalVisits: number;
  /** Plain language for the review panel. Kinds, counts and times only: it cannot name a place. */
  summary: string[];
}

export interface SurfaceOptions {
  /** docs/storage.md section 1: 300 places, and never more. */
  maxSurfaces?: number;
  maxTransitions?: number;
  /** Ceiling on the visits one observation may claim, so a broken counter cannot swamp everything else. */
  maxVisitsPerObservation?: number;
  /** Ceiling on how far back a last-used day is kept. Beyond it the answer is simply "a long time ago". */
  maxDaysAgo?: number;
}

export const DEFAULT_MAX_SURFACES = 300;
const DEFAULT_MAX_TRANSITIONS = 20;
const DEFAULT_MAX_VISITS = 10_000;
const DEFAULT_MAX_DAYS_AGO = 400;
const MAX_ACTIONS_PER_SURFACE = 12;

/** An application id: dotted, lowercase-ish, no slash, no space. Shape only — this never asks WHICH application. */
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{1,127}$/;
export const APP_PREFIX = "app:";

/**
 * Reduce anything the native side hands in to an opaque id, or to "" when it does not reduce to one.
 *
 * Two shapes exist and the code cannot tell them apart afterwards, which is the point: a bare host for a place in a
 * browser, and `app:<identifier>` for a native window. Everything else — a path, a title, a query, a port, a user
 * name in an authority — is gone before anything is counted.
 */
export function normalizeSurfaceId(raw: string): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (trimmed.toLowerCase().startsWith(APP_PREFIX)) {
    const id = trimmed.slice(APP_PREFIX.length).trim().toLowerCase();
    return APP_ID.test(id) ? APP_PREFIX + id : "";
  }
  return hostOfOrigin(trimmed);
}

export function isAppSurface(surface: string): boolean {
  return surface.startsWith(APP_PREFIX);
}

function emptyTimeOfDay(): TimeOfDayCounts {
  return { night: 0, morning: 0, midday: 0, afternoon: 0, evening: 0 };
}

/** Bucket indexes are what the context key uses (docs/knowledge.md section 2): four-hour buckets, 0..5. */
export function hourBucketIndex(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  const clamped = ((Math.floor(hour) % 24) + 24) % 24;
  return Math.floor(clamped / 4);
}

function positiveInt(value: number | undefined, fallback: number, ceiling: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(ceiling, Math.floor(value));
}

/**
 * The action a place of this KIND implies, when the source knows nothing more specific than the kind. It comes
 * straight out of the shape priors, so there is exactly one table of "what people want on a screen like this" in
 * the repo, and a locked role is never seeded: proposing is not doing, and a seeded habit must never put weight
 * behind Send, Buy, Checkout or Submit (docs/always-propose.md, CLAUDE.md rule 2).
 */
export function impliedActionForKind(kind: PageKind): AffordanceRole | undefined {
  const locked = new Set<AffordanceRole>(LOCKED_ROLES);
  for (const prior of priorsFor(kind)) {
    if (!locked.has(prior.role) && prior.role !== "unknown") return prior.role;
  }
  return undefined;
}

interface Draft {
  surface: string;
  kinds: Map<PageKind, number>;
  visits: number;
  timeOfDay: TimeOfDayCounts;
  buckets: Set<number>;
  lastUsedDaysAgo?: number;
  sources: Set<ColdStartSourceKind>;
  usedSources: Set<ColdStartSourceKind>;
  actions: Map<AffordanceRole, number>;
  installedOnly: boolean;
}

function newDraft(surface: string): Draft {
  return {
    surface,
    kinds: new Map(),
    visits: 0,
    timeOfDay: emptyTimeOfDay(),
    buckets: new Set(),
    sources: new Set(),
    usedSources: new Set(),
    actions: new Map(),
    installedOnly: true,
  };
}

function dominantKind(kinds: Map<PageKind, number>): PageKind {
  let best: PageKind = "unknown";
  let bestCount = 0;
  for (const [kind, count] of [...kinds.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (kind === "unknown") continue;
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Observations -> surface records. Pure, and the only thing it can produce is counts.
 *
 * Folding is by id alone: two sources that saw the same place add up, which is how "it is in the Dock AND it was
 * used an hour ago" becomes one stronger record rather than two weak ones.
 */
export function aggregateSurfaces(
  observations: readonly SurfaceObservation[],
  transitions: readonly SurfaceTransitionObservation[] = [],
  options: SurfaceOptions = {},
): SurfaceAggregate {
  const maxSurfaces = positiveInt(options.maxSurfaces, DEFAULT_MAX_SURFACES, DEFAULT_MAX_SURFACES);
  const maxTransitions = positiveInt(options.maxTransitions, DEFAULT_MAX_TRANSITIONS, 200);
  const maxVisits = positiveInt(options.maxVisitsPerObservation, DEFAULT_MAX_VISITS, DEFAULT_MAX_VISITS);
  const maxDaysAgo = positiveInt(options.maxDaysAgo, DEFAULT_MAX_DAYS_AGO, 10_000);

  const drafts = new Map<string, Draft>();
  const bySource: Record<string, SourceContribution> = {};
  let dropped = 0;

  for (const observation of observations) {
    if (!observation || typeof observation.surface !== "string") {
      dropped += 1;
      continue;
    }
    const surface = normalizeSurfaceId(observation.surface);
    if (surface === "") {
      dropped += 1;
      continue;
    }
    const source = observation.source;
    const visits = observation.installedOnly === true ? 0 : positiveInt(observation.visits, 1, maxVisits);
    const draft = drafts.get(surface) ?? newDraft(surface);
    draft.visits += visits;
    draft.sources.add(source);
    if (observation.installedOnly !== true) {
      draft.installedOnly = false;
      draft.usedSources.add(source);
    }

    const kind: PageKind = observation.kind ?? "unknown";
    draft.kinds.set(kind, (draft.kinds.get(kind) ?? 0) + Math.max(1, visits));

    for (const hour of observation.hours ?? []) {
      if (typeof hour !== "number" || !Number.isFinite(hour)) continue;
      const clamped = ((Math.floor(hour) % 24) + 24) % 24;
      draft.timeOfDay[bucketForHour(clamped)] += 1;
      draft.buckets.add(hourBucketIndex(clamped));
    }

    if (typeof observation.lastUsedDaysAgo === "number" && Number.isFinite(observation.lastUsedDaysAgo)) {
      const days = Math.min(maxDaysAgo, Math.max(0, Math.floor(observation.lastUsedDaysAgo)));
      draft.lastUsedDaysAgo = draft.lastUsedDaysAgo === undefined ? days : Math.min(draft.lastUsedDaysAgo, days);
    }

    for (const action of observation.actions ?? []) {
      if (!action || typeof action.role !== "string") continue;
      const count = positiveInt(action.count, 1, maxVisits);
      draft.actions.set(action.role, (draft.actions.get(action.role) ?? 0) + count);
    }

    drafts.set(surface, draft);
    const contribution = bySource[source] ?? { observations: 0, surfaces: 0, visits: 0 };
    contribution.observations += 1;
    contribution.visits += visits;
    bySource[source] = contribution;
  }

  // Strongest first, then the cap: a Mac with four hundred applications keeps the three hundred that matter.
  const ordered = [...drafts.values()].sort(
    (a, b) =>
      Number(a.installedOnly) - Number(b.installedOnly) ||
      b.visits - a.visits ||
      (a.lastUsedDaysAgo ?? Number.MAX_SAFE_INTEGER) - (b.lastUsedDaysAgo ?? Number.MAX_SAFE_INTEGER) ||
      a.surface.localeCompare(b.surface),
  );
  const keptDrafts = ordered.slice(0, maxSurfaces);
  const capped = ordered.length - keptDrafts.length;
  const kept = new Set(keptDrafts.map((draft) => draft.surface));

  const surfaces: SurfaceRecord[] = keptDrafts.map((draft) => {
    const kind = dominantKind(draft.kinds);
    const actions = new Map(draft.actions);
    // A source that only knew the KIND still says something useful: what people do on a screen shaped like that.
    if (actions.size === 0 && !draft.installedOnly) {
      const implied = impliedActionForKind(kind);
      if (implied) actions.set(implied, 1);
    }
    const top = [...actions.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_ACTIONS_PER_SURFACE);
    const record: SurfaceRecord = {
      surface: draft.surface,
      kind,
      visits: draft.visits,
      hourBuckets: [...draft.buckets].sort((a, b) => a - b),
      timeOfDay: draft.timeOfDay,
      sources: [...draft.sources].sort(),
      usedSources: [...draft.usedSources].sort(),
      actions: Object.fromEntries(top) as Partial<Record<AffordanceRole, number>>,
      installedOnly: draft.installedOnly,
    };
    if (draft.lastUsedDaysAgo !== undefined) record.lastUsedDaysAgo = draft.lastUsedDaysAgo;
    return record;
  });

  for (const record of surfaces) {
    for (const source of record.sources) {
      const contribution = bySource[source] ?? { observations: 0, surfaces: 0, visits: 0 };
      contribution.surfaces += 1;
      bySource[source] = contribution;
    }
  }

  const transitionCounts = new Map<string, SurfaceTransitionRecord>();
  for (const raw of transitions) {
    if (!raw) continue;
    const from = normalizeSurfaceId(String(raw.from ?? ""));
    const to = normalizeSurfaceId(String(raw.to ?? ""));
    // A transition to a place that did not survive the cap is not a transition anyone can act on.
    if (from === "" || to === "" || from === to || !kept.has(from) || !kept.has(to)) continue;
    const key = `${from} ${to}`;
    const existing = transitionCounts.get(key) ?? { from, to, count: 0 };
    existing.count += positiveInt(raw.count, 1, maxVisits);
    transitionCounts.set(key, existing);
  }

  const kinds = new Map<PageKind, { kind: PageKind; surfaces: number; visits: number }>();
  let totalVisits = 0;
  for (const record of surfaces) {
    const entry = kinds.get(record.kind) ?? { kind: record.kind, surfaces: 0, visits: 0 };
    entry.surfaces += 1;
    entry.visits += record.visits;
    kinds.set(record.kind, entry);
    totalVisits += record.visits;
  }

  const transitionList = [...transitionCounts.values()]
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, maxTransitions);
  const kindList = [...kinds.values()].sort((a, b) => b.visits - a.visits || a.kind.localeCompare(b.kind));

  return {
    surfaces,
    transitions: transitionList,
    kinds: kindList,
    bySource,
    dropped,
    capped,
    totalVisits,
    summary: summarizeSurfaces(surfaces, kindList),
  };
}

const KIND_PHRASE: Record<PageKind, string> = {
  media: "places you watch or listen in",
  feed: "feeds",
  commerce: "places you shop in",
  reader: "things you read",
  mail: "places you write to people in",
  form: "things you fill in",
  app: "applications",
  unknown: "places Shabang cannot place yet",
};

/**
 * The review panel's words. Built from counts and kinds alone, which is why it is safe to show, log and quote: it
 * has no way to name a place even if it wanted to.
 */
function summarizeSurfaces(
  surfaces: readonly SurfaceRecord[],
  kinds: readonly { kind: PageKind; surfaces: number; visits: number }[],
): string[] {
  const lines: string[] = [];
  const used = surfaces.filter((s) => !s.installedOnly);
  const owned = surfaces.length - used.length;
  if (used.length > 0) lines.push(`Shabang knows ${used.length} place${used.length === 1 ? "" : "s"} you actually use.`);
  if (owned > 0) lines.push(`It can also recognise ${owned} more you have but has not seen you in.`);
  for (const kind of kinds.slice(0, 2)) {
    if (kind.kind === "unknown" || kind.visits === 0) continue;
    lines.push(`Most of that is ${KIND_PHRASE[kind.kind]} (${kind.visits} visits across ${kind.surfaces}).`);
  }
  const morning = used.filter((s) => s.hourBuckets.includes(2)).length;
  if (morning >= 3) lines.push(`${morning} of them you open in the morning.`);
  return lines;
}

/** Bucket names, for a panel that wants to show the hours a place is used without showing a clock. */
export function bucketNamesOf(record: SurfaceRecord): TimeBucket[] {
  return TIME_BUCKETS.filter((bucket) => record.timeOfDay[bucket] > 0);
}
