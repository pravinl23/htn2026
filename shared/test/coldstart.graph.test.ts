// Cold start into the one small file (docs/storage.md): what a scan found becomes surfaces, habits and facts, the
// file stays under its caps, and every source stays removable on its own.
//
// Ids here are meaningless on purpose. A test that needed a real site or a real application to pass would prove
// the code was overfitted to it.
import { describe, expect, it } from "vitest";
import { aggregateHabits } from "../src/coldstart/habits";
import type { HistoryRow } from "../src/coldstart/habits";
import { aggregateSurfaces } from "../src/coldstart/surfaces";
import type { SurfaceObservation } from "../src/coldstart/surfaces";
import {
  applyColdStart,
  describeKnowledge,
  emptyKnowledgeFile,
  fileSizeBytes,
  forgetColdStartSource,
  readColdStartMeta,
  splitVisits,
} from "../src/coldstart/graph";
import { KNOWLEDGE_TARGET_BYTES, SCAN_SURFACE, knowledgeFromJSON, rankActions } from "../src/knowledge";
import type { ActionRef, Context, HourBucket, ScreenKind } from "../src/knowledge";

const NOW = "2026-09-19T10:00:00.000Z";

function observation(surface: string, extra: Partial<SurfaceObservation> = {}): SurfaceObservation {
  return { surface, source: "recent-apps", visits: 4, ...extra };
}

function surfacesOf(observations: SurfaceObservation[]) {
  return aggregateSurfaces(observations);
}

function historyOf(rows: HistoryRow[]) {
  return aggregateHabits(rows, { minVisits: 2 });
}

describe("a scan becomes the file", () => {
  it("writes surfaces, habits and provenance, and stays far inside the target", () => {
    const result = applyColdStart({
      surfaces: surfacesOf([
        observation("app:a.b.c", { source: "dock", kind: "unknown", visits: 1 }),
        observation("app:a.b.c", { source: "recent-apps", visits: 30, hours: [9, 9, 10] }),
        observation("dddd.test", { source: "browser-history", kind: "feed", visits: 12, hours: [20] }),
        observation("app:e.f.g", { source: "app-inventory", installedOnly: true }),
      ]),
      now: NOW,
    });
    expect(result.surfaces).toBe(3);
    expect(result.bytes).toBeLessThan(KNOWLEDGE_TARGET_BYTES);
    expect(result.withinTarget).toBe(true);

    const meta = readColdStartMeta(result.file);
    expect(meta.sources.dock?.surfaces).toEqual(["app:a.b.c"]);
    expect(meta.sources["app-inventory"]?.surfaces).toEqual(["app:e.f.g"]);
    expect(meta.sources["recent-apps"]?.lastScanDay).toBe("2026-09-19");
  });

  it("keeps the visit total when it splits visits across the buckets they happened in", () => {
    const aggregate = surfacesOf([observation("dddd.test", { visits: 10, hours: [9, 9, 9, 20] })]);
    const slices = splitVisits(aggregate.surfaces[0]!);
    expect(slices.reduce((sum, slice) => sum + slice.visits, 0)).toBe(10);
    expect(slices.map((slice) => slice.bucket).sort()).toEqual([2, 5]);
  });

  it("gives a surface no hour bucket at all when no source knew one", () => {
    const aggregate = surfacesOf([observation("dddd.test", { visits: 5 })]);
    expect(splitVisits(aggregate.surfaces[0]!)).toEqual([{ visits: 5 }]);
    const result = applyColdStart({ surfaces: aggregate, now: NOW });
    const graph = knowledgeFromJSON(result.file, NOW);
    expect(graph.habits.surface("dddd.test")?.hours).toBe(0);
  });

  it("carries a browser history aggregate in through the layer's own adapter", () => {
    const rows: HistoryRow[] = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push({ origin: "https://dddd.test/watch", pathPattern: "/watch", visitedAt: Date.UTC(2026, 8, 10, 20, i) });
    }
    const result = applyColdStart({ history: historyOf(rows), now: NOW });
    expect(result.surfaces).toBe(1);
    const meta = readColdStartMeta(result.file);
    expect(meta.sources["browser-history"]?.surfaces).toContain("dddd.test");
    // What history taught about a KIND with no place attached goes with it when the source is forgotten.
    expect(meta.sources["browser-history"]?.surfaces).toContain(SCAN_SURFACE);
  });

  it("lets a source that cannot name a place still teach a shape", () => {
    const result = applyColdStart({ kinds: [{ kind: "media", count: 12, source: "recent-docs" }], now: NOW });
    expect(result.habits).toBe(1);
    expect(result.observations).toBe(12);
    const graph = knowledgeFromJSON(result.file, NOW);
    // The reserved scan surface is never ranked, so what it holds lifts every screen of that shape.
    expect(graph.habits.surface(SCAN_SURFACE)).toBeNull();
    expect(graph.habits.kindAnyStat("media", "play").taken).toBe(12);
    expect(readColdStartMeta(result.file).sources["recent-docs"]?.surfaces).toEqual([SCAN_SURFACE]);
  });

  it("is additive: a second scan adds to the first rather than replacing it", () => {
    const first = applyColdStart({ surfaces: surfacesOf([observation("dddd.test", { visits: 4 })]), now: NOW });
    const second = applyColdStart({
      file: first.file,
      surfaces: surfacesOf([observation("dddd.test", { visits: 6 })]),
      now: NOW,
    });
    const graph = knowledgeFromJSON(second.file, NOW);
    expect(graph.habits.surface("dddd.test")?.visits).toBe(10);
  });

  it("starts from an empty brain when the file is corrupt rather than throwing", () => {
    for (const broken of ["", "{", "null", "[]", '{"habits":42}']) {
      const result = applyColdStart({ file: broken, surfaces: surfacesOf([observation("dddd.test")]), now: NOW });
      expect(result.surfaces).toBe(1);
      expect(readColdStartMeta(result.file).sources["recent-apps"]).toBeDefined();
    }
  });

  it("stays under the hard cap even when a scan hands it far more than fits", () => {
    const observations: SurfaceObservation[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      observations.push(observation(`app:a.b.n${i}`, { visits: 20, hours: [9, 14, 20], kind: "feed" }));
    }
    const result = applyColdStart({ surfaces: surfacesOf(observations), now: NOW });
    expect(fileSizeBytes(result.file)).toBeLessThan(KNOWLEDGE_TARGET_BYTES);
    expect(result.withinTarget).toBe(true);
  });
});

describe("the seeded file changes an answer", () => {
  const candidates: ActionRef[] = [
    { id: "c1", role: "search", confidence: 0.6 },
    { id: "c2", role: "primary-item", confidence: 0.6 },
    { id: "c3", role: "settings", confidence: 0.6 },
  ];

  /** The context key straight from docs/knowledge.md section 2: an opaque surface, a shape, an hour bucket. */
  function context(surface: string, screenKind: ScreenKind = "feed", hourBucket: HourBucket = 2): Context {
    return { surface, screenKind, hourBucket, candidates };
  }

  it("lifts the action a scan implies on the surface the scan saw", () => {
    const seeded = applyColdStart({
      surfaces: surfacesOf([observation("dddd.test", { kind: "feed", visits: 40, hours: [9], actions: [{ role: "settings", count: 30 }] })]),
      now: NOW,
    });
    const empty = rankActions(context("dddd.test"), knowledgeFromJSON("", NOW));
    const warm = rankActions(context("dddd.test"), knowledgeFromJSON(seeded.file, NOW));
    // On an empty brain the shape prior leads; after the scan, what this person actually does here leads.
    expect(empty[0]!.id).not.toBe("c3");
    expect(warm[0]!.id).toBe("c3");
  });

  it("still proposes something on a surface the scan never saw", () => {
    const seeded = applyColdStart({ surfaces: surfacesOf([observation("dddd.test", { kind: "feed", visits: 9 })]), now: NOW });
    const ranked = rankActions(context("zzzz.test"), knowledgeFromJSON(seeded.file, NOW));
    expect(ranked.length).toBe(candidates.length);
  });
});

describe("everything stays removable", () => {
  function twoSources() {
    return applyColdStart({
      surfaces: surfacesOf([
        observation("app:a.b.c", { source: "dock", visits: 5, kind: "unknown" }),
        observation("app:h.i.j", { source: "dock", visits: 5, kind: "unknown" }),
        observation("app:a.b.c", { source: "recent-apps", visits: 20, hours: [9] }),
        observation("dddd.test", { source: "browser-history", kind: "feed", visits: 8 }),
      ]),
      now: NOW,
    });
  }

  it("removes only what one source produced, and leaves a shared surface alone", () => {
    const before = twoSources();
    const after = forgetColdStartSource(before.file, "dock");
    // app:a.b.c was also found by recent-apps, so only the one dock found on its own goes.
    expect(after.surfaces).toBe(1);
    const graph = knowledgeFromJSON(after.file, NOW);
    expect(graph.habits.surface("app:h.i.j")).toBeNull();
    expect(graph.habits.surface("app:a.b.c")).not.toBeNull();
    expect(readColdStartMeta(after.file).sources.dock).toBeUndefined();
  });

  it("does not claim to have removed a habit from a place that never held one", () => {
    const owned = applyColdStart({
      surfaces: surfacesOf([observation("app:k.l.m", { source: "app-inventory", installedOnly: true })]),
      now: NOW,
    });
    const after = forgetColdStartSource(owned.file, "app-inventory");
    expect(after.surfaces).toBe(1);
    expect(after.habits).toBe(0);
  });

  it("does nothing at all for a source that contributed nothing", () => {
    const before = twoSources();
    const after = forgetColdStartSource(before.file, "calendar");
    expect(after.surfaces).toBe(0);
    expect(describeKnowledge(after.file).surfaces).toBe(describeKnowledge(before.file).surfaces);
  });

  it("empties the whole file in one call", () => {
    const empty = describeKnowledge(emptyKnowledgeFile(NOW));
    expect(empty.surfaces).toBe(0);
    expect(empty.habits).toBe(0);
    expect(empty.facts).toBe(0);
  });
});

describe("what Ghost knows, described", () => {
  it("reports counts per screen kind and per source, plus the file size", () => {
    const seeded = applyColdStart({
      surfaces: surfacesOf([
        observation("dddd.test", { source: "browser-history", kind: "feed", visits: 30, hours: [9] }),
        observation("eeee.test", { source: "browser-history", kind: "media", visits: 20, hours: [20] }),
        observation("app:a.b.c", { source: "dock", visits: 4 }),
      ]),
      skipped: { resume: { "financial-document": 2 } },
      now: NOW,
    });
    const summary = describeKnowledge(seeded.file, 2);
    expect(summary.surfaces).toBe(3);
    expect(summary.byScreenKind.feed).toBe(1);
    expect(summary.byScreenKind.media).toBe(1);
    expect(summary.bySource["browser-history"]?.surfaces).toBe(2);
    expect(summary.bySource.resume?.skipped).toBe(2);
    expect(summary.topSurfaces).toHaveLength(2);
    expect(summary.topSurfaces[0]!.surface).toBe("dddd.test");
    expect(summary.bytes).toBeGreaterThan(0);
    expect(summary.withinTarget).toBe(true);
  });

  it("describes an absent file as an empty brain instead of failing", () => {
    for (const nothing of [null, undefined, "", "not json"]) {
      const summary = describeKnowledge(nothing);
      expect(summary.surfaces).toBe(0);
      expect(summary.facts).toBe(0);
    }
  });

  // The habits and provenance sections are this module's to write, and neither may hold a clock. (The facts
  // section still stamps a full ISO time; that is the facts module's own gap, recorded rather than papered over.)
  it("keeps every time this module stores at day resolution or coarser", () => {
    const seeded = applyColdStart({ surfaces: surfacesOf([observation("dddd.test", { visits: 3, hours: [9] })]), now: NOW });
    const parsed = JSON.parse(seeded.file) as Record<string, unknown>;
    expect(JSON.stringify(parsed.habits)).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(JSON.stringify(parsed.meta)).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
