// The counter store and the three levels of prior (docs/knowledge.md sections 1, 2 and 4, docs/storage.md).
import { describe, expect, it } from "vitest";
import {
  HABIT_LIMITS,
  HABIT_PRUNE,
  HabitStore,
  OUTCOMES,
  SHAPE_PRIOR_MAX,
  SHAPE_PRIOR_MIN,
  addCounts,
  daysSince,
  hourBit,
  shapePriorWeight,
  shapePriors,
  takenInHour,
  totalOf,
} from "../src";
import type { ActionRole, HabitEntry, ScreenKind } from "../src";

const TODAY = "2026-09-19T12:00:00.000Z";
const LAST_YEAR = "2025-09-19T12:00:00.000Z";

function key(surface: string, screenKind: ScreenKind, previousAction: string, action: ActionRole) {
  return { surface, screenKind, previousAction, action };
}

describe("counters", () => {
  it("starts empty", () => {
    const habits = new HabitStore();
    expect(habits.size).toBe(0);
    expect(totalOf(habits.stat(key("s1", "feed", "none", "search")))).toBe(0);
  });

  it.each(OUTCOMES)("counts a %s outcome", (outcome) => {
    const habits = new HabitStore();
    habits.record(key("s1", "feed", "none", "search"), outcome, { at: TODAY });
    expect(habits.stat(key("s1", "feed", "none", "search"))[outcome]).toBe(1);
  });

  it("accumulates repeats on the same key", () => {
    const habits = new HabitStore();
    for (let i = 0; i < 5; i += 1) habits.record(key("s1", "media", "play", "fullscreen"), "taken", { at: TODAY });
    expect(habits.stat(key("s1", "media", "play", "fullscreen")).taken).toBe(5);
    expect(habits.size).toBe(1);
  });

  it("takes a count in one call, which is how a scan hands over aggregates", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "list", "none", "compose"), "taken", { at: TODAY, count: 12 });
    expect(habits.stat(key("s1", "list", "none", "compose")).taken).toBe(12);
  });

  it("keeps a day, never a timestamp", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "feed", "none", "search"), "taken", { at: TODAY });
    expect(habits.stat(key("s1", "feed", "none", "search")).lastSeen).toBe("2026-09-19");
    expect(JSON.stringify(habits.toJSON())).not.toContain("12:00");
  });

  it("records the hour bucket of a taken action and of nothing else", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "feed", "none", "search"), "taken", { at: TODAY, hourBucket: 2 });
    habits.record(key("s1", "feed", "none", "share"), "ignored", { at: TODAY, hourBucket: 2 });
    expect(takenInHour(habits.stat(key("s1", "feed", "none", "search")), 2)).toBe(true);
    expect(takenInHour(habits.stat(key("s1", "feed", "none", "search")), 5)).toBe(false);
    expect(habits.stat(key("s1", "feed", "none", "share")).hours).toBe(0);
  });

  it("treats a missing previous action as the 'none' key", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "feed", "", "search"), "taken", { at: TODAY });
    expect(habits.stat(key("s1", "feed", "none", "search")).taken).toBe(1);
  });

  it("ignores an empty surface id", () => {
    const habits = new HabitStore();
    habits.record(key("  ", "feed", "none", "search"), "taken", { at: TODAY });
    expect(habits.size).toBe(0);
  });

  it("keeps the key parts apart", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "feed", "none", "search"), "taken", { at: TODAY });
    expect(habits.stat(key("s2", "feed", "none", "search")).taken).toBe(0);
    expect(habits.stat(key("s1", "list", "none", "search")).taken).toBe(0);
    expect(habits.stat(key("s1", "feed", "play", "search")).taken).toBe(0);
    expect(habits.stat(key("s1", "feed", "none", "share")).taken).toBe(0);
  });
});

describe("the two generalizations", () => {
  it("sums the same screen kind across other surfaces and leaves this one out", () => {
    const habits = new HabitStore();
    for (const surface of ["s1", "s2", "s3"]) habits.record(key(surface, "media", "play", "fullscreen"), "taken", { at: TODAY });
    expect(habits.kindStat("media", "play", "fullscreen").taken).toBe(3);
    expect(habits.kindStat("media", "play", "fullscreen", "s1").taken).toBe(2);
  });

  it("does not leak across screen kinds", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "media", "play", "fullscreen"), "taken", { at: TODAY });
    expect(habits.kindStat("feed", "play", "fullscreen").taken).toBe(0);
  });

  it("backs off to the same surface and kind whatever came before", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "list", "primary-item", "reply"), "taken", { at: TODAY });
    habits.record(key("s1", "list", "compose", "reply"), "taken", { at: TODAY });
    expect(habits.stat(key("s1", "list", "none", "reply")).taken).toBe(0);
    expect(habits.surfaceStat("s1", "list", "reply").taken).toBe(2);
  });

  it("backs off to the same kind anywhere whatever came before", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "settings", "primary-item", "toggle"), "taken", { at: TODAY });
    habits.record(key("s2", "settings", "search", "toggle"), "taken", { at: TODAY });
    expect(habits.kindAnyStat("settings", "toggle").taken).toBe(2);
    expect(habits.kindAnyStat("settings", "toggle", "s1").taken).toBe(1);
  });

  it("merges the hour masks and keeps the latest day when it sums", () => {
    const merged = addCounts(
      { taken: 1, ignored: 0, replaced: 0, hours: hourBit(1), lastSeen: "2026-01-01" },
      { taken: 2, ignored: 1, replaced: 1, hours: hourBit(4), lastSeen: "2026-06-01" },
    );
    expect(merged).toEqual({ taken: 3, ignored: 1, replaced: 1, hours: hourBit(1) | hourBit(4), lastSeen: "2026-06-01" });
  });
});

describe("surfaces", () => {
  it("counts visits, hour buckets and the kinds a surface has shown", () => {
    const habits = new HabitStore();
    habits.noteVisit("s1", "feed", 2, TODAY);
    habits.noteVisit("s1", "feed", 2, TODAY);
    habits.noteVisit("s1", "media", 5, TODAY);
    const stat = habits.surface("s1");
    expect(stat?.visits).toBe(3);
    expect(stat?.kinds).toEqual({ feed: 2, media: 1 });
    expect((stat?.hours ?? 0) & hourBit(5)).toBeGreaterThan(0);
  });

  it("lists surfaces most used first", () => {
    const habits = new HabitStore();
    habits.noteVisit("s1", "feed", 0, TODAY);
    for (let i = 0; i < 3; i += 1) habits.noteVisit("s2", "list", 0, TODAY);
    expect(habits.surfaces().map((s) => s.surface)).toEqual(["s2", "s1"]);
  });

  it("forgets one surface completely and leaves the others alone", () => {
    const habits = new HabitStore();
    habits.noteVisit("s1", "feed", 0, TODAY);
    habits.record(key("s1", "feed", "none", "search"), "taken", { at: TODAY });
    habits.record(key("s2", "feed", "none", "search"), "taken", { at: TODAY });
    expect(habits.forgetSurface("s1")).toBe(2);
    expect(habits.surface("s1")).toBeNull();
    expect(habits.stat(key("s1", "feed", "none", "search")).taken).toBe(0);
    expect(habits.stat(key("s2", "feed", "none", "search")).taken).toBe(1);
    expect(habits.kindAnyStat("feed", "search").taken).toBe(1);
  });

  it("stays inside the surface cap", () => {
    const habits = new HabitStore();
    for (let i = 0; i < HABIT_LIMITS.surfaces + 50; i += 1) habits.noteVisit(`s${i}`, "feed", 0, TODAY);
    expect(habits.surfaceCount).toBe(HABIT_LIMITS.surfaces);
  });
});

describe("caps and pruning (docs/storage.md section 2)", () => {
  it("drops a habit seen once and not seen for a month", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "feed", "none", "share"), "ignored", { at: LAST_YEAR });
    expect(habits.prune(TODAY)).toBe(1);
    expect(habits.size).toBe(0);
  });

  it("keeps a habit seen once but seen recently", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "feed", "none", "share"), "taken", { at: TODAY });
    expect(habits.prune(TODAY)).toBe(0);
    expect(habits.size).toBe(1);
  });

  it("never drops a habit the user takes often, however stale it is", () => {
    const habits = new HabitStore();
    for (let i = 0; i < HABIT_PRUNE.protectTaken + 2; i += 1) {
      habits.record(key("s1", "media", "play", "fullscreen"), "taken", { at: LAST_YEAR });
    }
    habits.prune(TODAY);
    expect(habits.stat(key("s1", "media", "play", "fullscreen")).taken).toBeGreaterThanOrEqual(HABIT_PRUNE.protectTaken);
  });

  it("stays inside the counter cap and keeps the frequently taken habit when it evicts", () => {
    const habits = new HabitStore();
    for (let i = 0; i < 10; i += 1) habits.record(key("s0", "media", "play", "fullscreen"), "taken", { at: TODAY });
    for (let i = 0; i < HABIT_LIMITS.counters + 200; i += 1) {
      habits.record(key(`s${i + 1}`, "feed", "none", "search"), "ignored", { at: TODAY });
    }
    expect(habits.size).toBeLessThanOrEqual(HABIT_LIMITS.counters);
    expect(habits.stat(key("s0", "media", "play", "fullscreen")).taken).toBe(10);
  });

  it("evicts the weakest row rather than the newest one", () => {
    const habits = new HabitStore();
    for (let i = 0; i < 4; i += 1) habits.record(key("keep", "list", "none", "compose"), "taken", { at: TODAY });
    for (let i = 0; i < HABIT_LIMITS.counters + 5; i += 1) habits.record(key(`f${i}`, "feed", "none", "more"), "ignored", { at: TODAY });
    expect(habits.stat(key("keep", "list", "none", "compose")).taken).toBe(4);
  });
});

describe("serialization", () => {
  it("round trips through JSON", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "board", "none", "cell"), "taken", { at: TODAY, hourBucket: 3 });
    habits.record(key("s1", "board", "cell", "more"), "replaced", { at: TODAY });
    habits.noteVisit("s1", "board", 3, TODAY);
    const revived = HabitStore.fromJSON(JSON.parse(JSON.stringify(habits.toJSON())));
    expect(revived.toJSON()).toEqual(habits.toJSON());
    expect(revived.stat(key("s1", "board", "none", "cell")).taken).toBe(1);
    expect(revived.surface("s1")?.visits).toBe(1);
  });

  it("rebuilds the generalization indexes on the way in", () => {
    const habits = new HabitStore();
    habits.record(key("s1", "settings", "none", "toggle"), "taken", { at: TODAY });
    const revived = HabitStore.fromJSON(habits.toJSON());
    expect(revived.kindStat("settings", "none", "toggle").taken).toBe(1);
  });

  it("yields an empty store for anything corrupt rather than throwing", () => {
    expect(HabitStore.fromJSON(null).size).toBe(0);
    expect(HabitStore.fromJSON(undefined).size).toBe(0);
    expect(HabitStore.fromJSON({ version: 1, entries: "nope" } as never).size).toBe(0);
  });

  it("drops malformed rows and keeps the good ones", () => {
    const entries = [
      { surface: "s1", screenKind: "feed", previousAction: "none", action: "search", counts: { taken: 2, ignored: 0, replaced: 0, hours: 0, lastSeen: "2026-09-19" } },
      { surface: 7, action: "search" },
      null,
    ] as unknown as HabitEntry[];
    const store = HabitStore.fromJSON({ version: 1, entries, surfaces: [] });
    expect(store.size).toBe(1);
  });

  it("refuses negative and non-finite counts from a hand-edited file", () => {
    const entries = [
      { surface: "s1", screenKind: "feed", previousAction: "none", action: "search", counts: { taken: -4, ignored: Number.NaN, replaced: 2.7, hours: 999, lastSeen: "2026-09-19" } },
    ] as unknown as HabitEntry[];
    const counts = HabitStore.fromJSON({ version: 1, entries, surfaces: [] }).stat(key("s1", "feed", "none", "search"));
    expect(counts.taken).toBe(0);
    expect(counts.ignored).toBe(0);
    expect(counts.replaced).toBe(2);
    expect(counts.hours).toBeLessThanOrEqual(63);
  });
});

describe("days", () => {
  it("counts whole days and treats a never-seen row as infinitely old", () => {
    expect(daysSince("2026-09-19", TODAY)).toBe(0);
    expect(daysSince("2026-09-12", TODAY)).toBe(7);
    expect(daysSince("", TODAY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the shape-only prior", () => {
  const KINDS: readonly ScreenKind[] = ["feed", "media", "list", "reader", "commerce", "settings", "editor", "board", "form", "unknown"];

  it.each(KINDS)("has an opinion about a %s screen", (kind) => {
    const priors = shapePriors(kind);
    expect(priors.length).toBeGreaterThan(0);
    expect(priors[0]?.weight).toBeGreaterThanOrEqual(SHAPE_PRIOR_MIN);
  });

  it("stays deliberately weak, so one real habit can always outrank it", () => {
    for (const kind of KINDS) {
      for (const prior of shapePriors(kind)) {
        expect(prior.weight).toBeGreaterThanOrEqual(SHAPE_PRIOR_MIN);
        expect(prior.weight).toBeLessThanOrEqual(SHAPE_PRIOR_MAX);
      }
    }
  });

  it("returns them strongest first", () => {
    for (const kind of KINDS) {
      const weights = shapePriors(kind).map((prior) => prior.weight);
      expect([...weights].sort((a, b) => b - a)).toEqual(weights);
    }
  });

  it("puts the obvious move first on each shape", () => {
    expect(shapePriors("settings")[0]?.role).toBe("toggle");
    expect(shapePriors("board")[0]?.role).toBe("cell");
    expect(shapePriors("editor")[0]?.role).toBe("field");
    expect(shapePriors("form")[0]?.role).toBe("field");
    expect(shapePriors("feed")[0]?.role).toBe("primary-item");
  });

  it("offers to start a stopped video and to enlarge a playing one", () => {
    expect(shapePriors("media")[0]?.role).toBe("play");
    expect(shapePriors("media", { mediaPlaying: true })[0]?.role).toBe("fullscreen");
  });

  it("stops nagging a video that is already playing full screen", () => {
    const priors = shapePriors("media", { mediaPlaying: true, isFullscreen: true });
    expect(priors.map((prior) => prior.role)).not.toContain("fullscreen");
    expect(priors[0]?.weight).toBeLessThan(SHAPE_PRIOR_MAX);
  });

  it("keeps an irreversible action off the top of a shape prior", () => {
    const basket = shapePriors("commerce", { cartCount: 2 });
    expect(basket[0]?.role).not.toBe("checkout");
    expect(shapePriors("form")[0]?.role).not.toBe("submit");
  });

  it("answers about a row that is open rather than a list being scanned", () => {
    expect(shapePriors("list")[0]?.role).toBe("primary-item");
    expect(shapePriors("list", { readingItem: true })[0]?.role).toBe("reply");
  });

  it("changes what it offers at the end of a long read", () => {
    expect(shapePriors("reader")[0]?.role).toBe("scroll-more");
    expect(shapePriors("reader", { atEnd: true })[0]?.role).toBe("reply");
  });

  it("gives nothing to a role the shape has no opinion about", () => {
    expect(shapePriorWeight("board", "compose")).toBe(0);
    expect(shapePriorWeight("settings", "toggle")).toBe(SHAPE_PRIOR_MAX);
  });
});
