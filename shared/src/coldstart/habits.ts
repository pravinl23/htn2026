// Cold start, the habit half (docs/cold-start.md sections 2 tier 3 and 3, docs/anywhere.md section 3). Browser
// history is the single richest signal on the machine and also the most dangerous thing to keep, so this module is
// a one-way door: rows go in, AGGREGATES come out, and the caller deletes its copy of the history the moment it
// returns. Nothing in the output can rebuild a browsing list:
//
//   - an origin is reduced to a bare host: no scheme, no path, no query, no fragment, no port;
//   - a host seen fewer than `minVisits` times is folded into one "other" bucket, so a single visit to a clinic,
//     a lawyer or an ex's profile cannot be read back out;
//   - a timestamp becomes a time-of-day bucket and weekday/weekend, never an instant;
//   - nothing carries a page title, and a path only ever decides a PageKind before being discarded.
//
// The role-keyed part of the output is exactly the snapshot shape of shared/src/affordance/memory.ts, so a scan can
// hand the ranker priors the user has never had to teach it.
import { RoleMemory } from "../affordance/memory";
import type { RoleMemorySnapshot, RoleOutcome } from "../affordance/memory";
import type { PageKind } from "../affordance/pageKind";
import type { AffordanceRole } from "../affordance/roles";

export type TimeBucket = "night" | "morning" | "midday" | "afternoon" | "evening";

export const TIME_BUCKETS: readonly TimeBucket[] = ["night", "morning", "midday", "afternoon", "evening"];

/** The bucket boundaries, in local hours. Anything finer starts to describe a person's day minute by minute. */
export function bucketForHour(hour: number): TimeBucket {
  if (hour < 6) return "night";
  if (hour < 11) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  return "evening";
}

export interface HistoryAction {
  role: AffordanceRole;
  /** What the user did just before, when the caller tracked it. Missing means this was the first action of the view. */
  previousRole?: AffordanceRole;
  /** Accepted by default: a history row records something the user actually did. */
  outcome?: RoleOutcome;
  count?: number;
}

export interface HistoryRow {
  /** A full URL, an origin, or a bare host. Everything but the host is dropped before anything is counted. */
  origin: string;
  /** Path shape only ("/watch", "/orders/:id"). Used to guess a PageKind and then discarded. */
  pathPattern?: string;
  /** Epoch milliseconds or an ISO string. Only its bucket survives. */
  visitedAt: number | string;
  /** The origin the user came from, for the transition counts. */
  transitionFromOrigin?: string;
  /** What the user did after arriving, when the caller has it. Counts only. */
  actionsAfterArrival?: readonly HistoryAction[];
}

export type TimeOfDayCounts = Record<TimeBucket, number>;

export interface DayTypeCounts {
  weekday: number;
  weekend: number;
}

export interface OriginHabit {
  /** A bare host, or the "other" bucket. Never a URL. */
  origin: string;
  visits: number;
  timeOfDay: TimeOfDayCounts;
  dayType: DayTypeCounts;
  kinds: Partial<Record<PageKind, number>>;
  /** The kind this host is most often, for the kind-level transitions. */
  dominantKind: PageKind;
  actions: Partial<Record<AffordanceRole, number>>;
  /** True for the bucket that stands in for every rarely-visited host. */
  other?: boolean;
}

export interface PageKindHabit {
  kind: PageKind;
  visits: number;
  timeOfDay: TimeOfDayCounts;
  dayType: DayTypeCounts;
  actions: Partial<Record<AffordanceRole, number>>;
}

export interface OriginTransition {
  from: string;
  to: string;
  count: number;
}

export interface KindTransition {
  from: PageKind;
  to: PageKind;
  count: number;
}

export interface HabitAggregate {
  /** Rows that counted. */
  rows: number;
  /** Rows thrown away for a malformed origin or timestamp. */
  droppedRows: number;
  totalVisits: number;
  /** Distinct hosts after folding, including the "other" bucket. */
  distinctOrigins: number;
  /** How many distinct hosts disappeared into "other", and how many visits they took with them. */
  rareOrigins: number;
  rareVisits: number;
  minVisits: number;
  origins: OriginHabit[];
  pageKinds: PageKindHabit[];
  transitions: OriginTransition[];
  kindTransitions: KindTransition[];
  /** The priors, in the shape shared/src/affordance/memory.ts stores. */
  roleMemory: RoleMemorySnapshot;
  /** Plain-language lines for the review panel. Kinds and times only: never a host. */
  summary: string[];
}

export interface HabitOptions {
  /** A host seen fewer times than this is folded into "other". Never lower than 2. */
  minVisits?: number;
  maxOrigins?: number;
  maxTransitions?: number;
  /** Minutes to add to UTC to get the user's local time. Passed in so this stays pure and testable. */
  timeZoneOffsetMinutes?: number;
}

export const OTHER_ORIGIN = "other";
export const DEFAULT_MIN_VISITS = 3;
const DEFAULT_MAX_ORIGINS = 50;
const DEFAULT_MAX_TRANSITIONS = 10;
const MAX_ACTION_COUNT = 50;

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Everything but the host, gone. Accepts a full URL, an origin or a bare host; returns "" for anything that does not
 * reduce to a plain dotted host, which is how a malformed row is dropped rather than half-kept.
 */
export function hostOfOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const authority = withoutScheme.split(/[/?#]/)[0] ?? "";
  const afterAuth = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  const host = afterAuth.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  return HOST.test(bare) ? bare : "";
}

/** Generic path words per kind. A history row has no DOM, so this is all `inferPageKind` would have had anyway. */
const PATH_KIND: readonly { kind: PageKind; re: RegExp }[] = [
  { kind: "media", re: /\b(watch|video|videos|play|player|episode|stream|listen|track|album|movie|clip|shorts)\b/ },
  { kind: "commerce", re: /\b(cart|basket|bag|checkout|product|products|item|items|shop|store|order|orders|deal|deals)\b/ },
  { kind: "mail", re: /\b(mail|inbox|messages|message|thread|threads|chat|conversation|conversations|dm)\b/ },
  { kind: "form", re: /\b(apply|application|form|signup|sign-up|register|survey|onboarding)\b/ },
  { kind: "feed", re: /\b(feed|home|results|search|browse|explore|discover|trending|timeline)\b/ },
  { kind: "reader", re: /\b(article|articles|post|posts|blog|docs|doc|wiki|story|stories|read|news|guide)\b/ },
];

/** The kind of place a path suggests. Unknown when it suggests nothing: a guess here is worse than no prior. */
export function pageKindFromPath(pathPattern: string | undefined): PageKind {
  const path = (pathPattern ?? "").toLowerCase();
  if (path === "") return "unknown";
  for (const { kind, re } of PATH_KIND) if (re.test(path)) return kind;
  return "unknown";
}

function emptyTimeOfDay(): TimeOfDayCounts {
  return { night: 0, morning: 0, midday: 0, afternoon: 0, evening: 0 };
}

interface NormalizedRow {
  host: string;
  from: string;
  kind: PageKind;
  bucket: TimeBucket;
  weekend: boolean;
  actions: readonly HistoryAction[];
}

function millisOf(visitedAt: number | string): number | undefined {
  if (typeof visitedAt === "number") return Number.isFinite(visitedAt) ? visitedAt : undefined;
  if (typeof visitedAt !== "string" || visitedAt.trim() === "") return undefined;
  const parsed = Date.parse(visitedAt);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalize(row: HistoryRow, offsetMinutes: number): NormalizedRow | undefined {
  if (!row || typeof row.origin !== "string") return undefined;
  const host = hostOfOrigin(row.origin);
  if (host === "") return undefined;
  const millis = millisOf(row.visitedAt);
  if (millis === undefined) return undefined;
  const local = new Date(millis + offsetMinutes * 60_000);
  if (Number.isNaN(local.getTime())) return undefined;
  const day = local.getUTCDay();
  return {
    host,
    from: typeof row.transitionFromOrigin === "string" ? hostOfOrigin(row.transitionFromOrigin) : "",
    kind: pageKindFromPath(row.pathPattern),
    bucket: bucketForHour(local.getUTCHours()),
    weekend: day === 0 || day === 6,
    actions: Array.isArray(row.actionsAfterArrival) ? row.actionsAfterArrival : [],
  };
}

function bump(counts: Partial<Record<string, number>>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

function newOrigin(origin: string, other = false): OriginHabit {
  return {
    origin,
    visits: 0,
    timeOfDay: emptyTimeOfDay(),
    dayType: { weekday: 0, weekend: 0 },
    kinds: {},
    dominantKind: "unknown",
    actions: {},
    ...(other ? { other: true } : {}),
  };
}

function newKind(kind: PageKind): PageKindHabit {
  return { kind, visits: 0, timeOfDay: emptyTimeOfDay(), dayType: { weekday: 0, weekend: 0 }, actions: {} };
}

function actionCount(action: HistoryAction): number {
  const raw = typeof action.count === "number" && Number.isFinite(action.count) ? Math.floor(action.count) : 1;
  return Math.max(0, Math.min(MAX_ACTION_COUNT, raw));
}

/**
 * History rows -> habit priors. Pure, and the only output is counts: see the file header for what can and cannot be
 * read back out of it.
 */
export function aggregateHabits(rows: readonly HistoryRow[], options: HabitOptions = {}): HabitAggregate {
  const minVisits = Math.max(2, Math.floor(options.minVisits ?? DEFAULT_MIN_VISITS));
  const maxOrigins = Math.max(1, Math.floor(options.maxOrigins ?? DEFAULT_MAX_ORIGINS));
  const maxTransitions = Math.max(1, Math.floor(options.maxTransitions ?? DEFAULT_MAX_TRANSITIONS));
  const offset = Number.isFinite(options.timeZoneOffsetMinutes) ? Number(options.timeZoneOffsetMinutes) : 0;

  const normalized: NormalizedRow[] = [];
  let droppedRows = 0;
  for (const row of rows) {
    const clean = normalize(row, offset);
    if (clean) normalized.push(clean);
    else droppedRows += 1;
  }

  // Pass one: how often each host was seen at all. This is the only thing the rare-host threshold may look at.
  const visitsPerHost = new Map<string, number>();
  for (const row of normalized) visitsPerHost.set(row.host, (visitsPerHost.get(row.host) ?? 0) + 1);

  const kept = new Set<string>();
  let rareOrigins = 0;
  let rareVisits = 0;
  const ranked = [...visitsPerHost.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [host, visits] of ranked) {
    if (visits >= minVisits && kept.size < maxOrigins) kept.add(host);
    else {
      rareOrigins += 1;
      rareVisits += visits;
    }
  }
  const nameOf = (host: string): string => (host !== "" && kept.has(host) ? host : OTHER_ORIGIN);

  // Pass two: the aggregates themselves.
  const origins = new Map<string, OriginHabit>();
  const kinds = new Map<PageKind, PageKindHabit>();
  const transitions = new Map<string, OriginTransition>();
  const kindTransitionCounts = new Map<string, KindTransition>();
  const memory = new RoleMemory(null);

  for (const row of normalized) {
    const name = nameOf(row.host);
    const origin = origins.get(name) ?? newOrigin(name, name === OTHER_ORIGIN);
    origin.visits += 1;
    origin.timeOfDay[row.bucket] += 1;
    origin.dayType[row.weekend ? "weekend" : "weekday"] += 1;
    bump(origin.kinds, row.kind);
    origins.set(name, origin);

    const kind = kinds.get(row.kind) ?? newKind(row.kind);
    kind.visits += 1;
    kind.timeOfDay[row.bucket] += 1;
    kind.dayType[row.weekend ? "weekend" : "weekday"] += 1;
    kinds.set(row.kind, kind);

    for (const action of row.actions) {
      if (!action || typeof action.role !== "string") continue;
      const count = actionCount(action);
      if (count === 0) continue;
      bump(origin.actions, action.role, count);
      bump(kind.actions, action.role, count);
      const outcome: RoleOutcome = action.outcome ?? "accepted";
      for (let i = 0; i < count; i += 1) {
        memory.record(
          { pageKind: row.kind, previousRole: action.previousRole ?? "none", role: action.role as AffordanceRole },
          outcome,
        );
      }
    }

    if (row.from !== "" && row.from !== row.host) {
      const from = nameOf(row.from);
      if (from !== name) {
        const key = `${from} ${name}`;
        const existing = transitions.get(key) ?? { from, to: name, count: 0 };
        existing.count += 1;
        transitions.set(key, existing);
      }
    }
  }

  for (const origin of origins.values()) origin.dominantKind = dominant(origin.kinds);

  // Kind-level transitions, derived from the origin-level ones so no extra history detail is needed.
  for (const transition of transitions.values()) {
    const from = origins.get(transition.from)?.dominantKind ?? "unknown";
    const to = origins.get(transition.to)?.dominantKind ?? "unknown";
    if (from === "unknown" && to === "unknown") continue;
    const key = `${from} ${to}`;
    const existing = kindTransitionCounts.get(key) ?? { from, to, count: 0 };
    existing.count += transition.count;
    kindTransitionCounts.set(key, existing);
  }

  const originList = [...origins.values()].sort((a, b) => b.visits - a.visits || a.origin.localeCompare(b.origin));
  const kindList = [...kinds.values()].sort((a, b) => b.visits - a.visits || a.kind.localeCompare(b.kind));
  const transitionList = [...transitions.values()]
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, maxTransitions);
  const kindTransitionList = [...kindTransitionCounts.values()]
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, maxTransitions);

  return {
    rows: normalized.length,
    droppedRows,
    totalVisits: normalized.length,
    distinctOrigins: originList.length,
    rareOrigins,
    rareVisits,
    minVisits,
    origins: originList,
    pageKinds: kindList,
    transitions: transitionList,
    kindTransitions: kindTransitionList,
    roleMemory: memory.toJSON(),
    summary: summarize(kindList, kindTransitionList),
  };
}

function dominant(counts: Partial<Record<PageKind, number>>): PageKind {
  let best: PageKind = "unknown";
  let bestCount = 0;
  for (const [kind, count] of Object.entries(counts) as [PageKind, number][]) {
    if (kind === "unknown") continue;
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

const PLACE_PHRASE: Record<PageKind, string> = {
  media: "watching something",
  feed: "in a feed",
  commerce: "shopping",
  reader: "reading",
  mail: "in a mailbox",
  form: "filling something in",
  app: "in an app",
  unknown: "somewhere Shabang cannot place",
};

const BUCKET_PHRASE: Record<TimeBucket, string> = {
  night: "late at night",
  morning: "in the morning",
  midday: "around midday",
  afternoon: "in the afternoon",
  evening: "in the evening",
};

/** Plain language for the review panel. Built from kinds, buckets and counts: it cannot name a site. */
function summarize(kinds: readonly PageKindHabit[], transitions: readonly KindTransition[]): string[] {
  const lines: string[] = [];
  for (const kind of kinds.slice(0, 2)) {
    if (kind.kind === "unknown" || kind.visits === 0) continue;
    const bucket = topBucket(kind.timeOfDay);
    const when = kind.dayType.weekday >= kind.dayType.weekend ? "on weekdays" : "at weekends";
    lines.push(`You are usually ${PLACE_PHRASE[kind.kind]} ${BUCKET_PHRASE[bucket]} ${when} (${kind.visits} visits).`);
  }
  const top = transitions.find((t) => t.from !== "unknown" && t.to !== "unknown" && t.from !== t.to);
  if (top) lines.push(`After being ${PLACE_PHRASE[top.from]} you usually end up ${PLACE_PHRASE[top.to]} (${top.count} times).`);
  return lines;
}

function topBucket(counts: TimeOfDayCounts): TimeBucket {
  let best: TimeBucket = "morning";
  let bestCount = -1;
  for (const bucket of TIME_BUCKETS) {
    if (counts[bucket] > bestCount) {
      best = bucket;
      bestCount = counts[bucket];
    }
  }
  return best;
}
