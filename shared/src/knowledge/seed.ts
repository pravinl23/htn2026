// Cold start into the knowledge layer (docs/knowledge.md section 3).
//
// `shared/src/coldstart/habits.ts` turns a browser history into AGGREGATES: per bare host, visit counts, time
// buckets, the kinds of page seen and the actions taken, plus role-keyed counters with no host attached at all.
// This is the one-way door on the other side: aggregates in, habit counters out, and nothing else crosses.
//
// It is how a first-run Shabang is useful before the user has taught it anything, and it is the only thing that
// makes the middle column of the benchmark (docs/knowledge.md section 6) real rather than imagined.
import type { HabitAggregate, OriginHabit, TimeBucket } from "../coldstart/habits";
import { OTHER_ORIGIN } from "../coldstart/habits";
import type { PageKind } from "../affordance/pageKind";
import type { ActionRole, HourBucket } from "./context";
import { PREVIOUS_NONE } from "./context";
import type { KnowledgeGraph } from "./habits";
import type { ScreenKind } from "./screenKind";

/**
 * A reserved surface id for what a scan learned about a KIND of screen without knowing where. It is not a place,
 * it is never ranked, and because `kindStat` only ever excludes the surface being ranked, what is stored here
 * lifts every screen of that shape — which is exactly what "on video screens this person goes full screen" means.
 */
export const SCAN_SURFACE = "~scan";

/**
 * The scan's page kinds are the older, coarser vocabulary (`shared/src/affordance/pageKind.ts`). A mailbox is a
 * list of rows with one open, and a window nothing could place is simply unknown.
 */
const KIND_FROM_PAGE: Record<PageKind, ScreenKind> = {
  feed: "feed",
  media: "media",
  commerce: "commerce",
  reader: "reader",
  mail: "list",
  form: "form",
  app: "unknown",
  unknown: "unknown",
};

export function screenKindFromPageKind(kind: PageKind): ScreenKind {
  return KIND_FROM_PAGE[kind] ?? "unknown";
}

/** A time-of-day bucket, expressed in the four-hour buckets the context key uses. */
const BUCKET_FROM_TIME: Record<TimeBucket, HourBucket> = {
  night: 0,
  morning: 2,
  midday: 3,
  afternoon: 4,
  evening: 5,
};

export function hourBucketFromTimeBucket(bucket: TimeBucket): HourBucket {
  return BUCKET_FROM_TIME[bucket] ?? 0;
}

export interface SeedResult {
  surfaces: number;
  habits: number;
  observations: number;
  /** Hosts folded into the scan's "other" bucket, which is a tally and not a place, so it seeds no surface. */
  skippedRare: number;
}

function topTimeBucket(origin: OriginHabit): HourBucket {
  let best: TimeBucket = "morning";
  let bestCount = -1;
  for (const [bucket, count] of Object.entries(origin.timeOfDay) as [TimeBucket, number][]) {
    if (count > bestCount) {
      best = bucket;
      bestCount = count;
    }
  }
  return hourBucketFromTimeBucket(best);
}

/**
 * Apply a scan's aggregates to a graph. Pure in everything that matters: it only ever adds counters, it obeys the
 * store's caps, and it cannot introduce anything the aggregate did not already reduce to a count.
 */
export function seedFromColdStart(graph: KnowledgeGraph, aggregate: HabitAggregate, at: Date | number | string = new Date()): SeedResult {
  const result: SeedResult = { surfaces: 0, habits: 0, observations: 0, skippedRare: 0 };
  const before = graph.habits.size;

  for (const origin of aggregate.origins ?? []) {
    if (origin.origin === OTHER_ORIGIN || origin.other === true) {
      result.skippedRare += 1;
      continue;
    }
    const kind = screenKindFromPageKind(origin.dominantKind);
    const hour = topTimeBucket(origin);
    graph.habits.noteVisit(origin.origin, kind, hour, at, origin.visits);
    result.surfaces += 1;
    for (const [role, count] of Object.entries(origin.actions) as [ActionRole, number][]) {
      if (!count || count <= 0) continue;
      graph.habits.record({ surface: origin.origin, screenKind: kind, previousAction: PREVIOUS_NONE, action: role }, "taken", {
        at,
        hourBucket: hour,
        count,
      });
      result.observations += count;
    }
  }

  // What the scan learned about a KIND of screen, with no host attached: the level-2 prior, straight from history.
  for (const entry of aggregate.roleMemory?.entries ?? []) {
    const kind = screenKindFromPageKind(entry.pageKind);
    const previousAction = entry.previousRole === "none" ? PREVIOUS_NONE : entry.previousRole;
    for (const [outcome, count] of [
      ["taken", entry.stat.accepted],
      ["ignored", entry.stat.dismissed],
      ["replaced", entry.stat.replaced],
    ] as const) {
      if (count <= 0) continue;
      graph.habits.record({ surface: SCAN_SURFACE, screenKind: kind, previousAction, action: entry.role }, outcome, { at, count });
      result.observations += count;
    }
  }

  result.habits = graph.habits.size - before;
  return result;
}
