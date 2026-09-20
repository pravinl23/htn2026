// The cold-start scan, applied to the knowledge layer (docs/knowledge.md section 3).
//
// The history rows below use reserved, unroutable hostnames and opaque paths on purpose: the adapter must work on
// whatever a real machine holds without any rule ever reading a host for meaning.
import { describe, expect, it } from "vitest";
import {
  OTHER_ORIGIN,
  SCAN_SURFACE,
  aggregateHabits,
  emptyKnowledge,
  hourBucketFromTimeBucket,
  knowledgeSizeBytes,
  rankActions,
  screenKindFromPageKind,
  seedFromColdStart,
  webContext,
} from "../src";
import type { HistoryRow, KnowledgeGraph } from "../src";
import { settingsPane, videoPlayer } from "./helpers/knowledgeFixtures";

const DAY = 86_400_000;
const START = Date.UTC(2026, 8, 1, 9, 0);
const NOW = "2026-09-19T10:00:00.000Z";

/** A month of mornings on one surface, where the user always does the same thing after arriving. */
function history(): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (let day = 0; day < 12; day += 1) {
    rows.push({
      origin: "one.invalid",
      pathPattern: "/watch/:id",
      visitedAt: START + day * DAY,
      actionsAfterArrival: [{ role: "play" }, { role: "fullscreen", previousRole: "play" }],
    });
    rows.push({
      origin: "two.invalid",
      pathPattern: "/inbox",
      visitedAt: START + day * DAY + 3_600_000,
      transitionFromOrigin: "one.invalid",
      actionsAfterArrival: [{ role: "compose" }],
    });
  }
  // One visit to somewhere the user barely goes: the scan folds it away and it must not become a surface.
  rows.push({ origin: "rare.invalid", pathPattern: "/article", visitedAt: START });
  return rows;
}

function seeded(): { graph: KnowledgeGraph; result: ReturnType<typeof seedFromColdStart> } {
  const graph = emptyKnowledge(NOW);
  const result = seedFromColdStart(graph, aggregateHabits(history()), NOW);
  return { graph, result };
}

describe("seeding the graph from a scan", () => {
  it("turns aggregated origins into surfaces with their visit counts", () => {
    const { graph, result } = seeded();
    expect(result.surfaces).toBe(2);
    expect(graph.habits.surface("one.invalid")?.visits).toBe(12);
    expect(graph.habits.surface("two.invalid")?.visits).toBe(12);
  });

  it("does not treat the scan's rare-host bucket as a place", () => {
    const { graph, result } = seeded();
    expect(result.skippedRare).toBeGreaterThanOrEqual(1);
    expect(graph.habits.surface(OTHER_ORIGIN)).toBeNull();
  });

  it("turns the actions a scan counted into habits on that surface", () => {
    const { graph } = seeded();
    expect(graph.habits.surfaceStat("one.invalid", "media", "fullscreen").taken).toBe(12);
    expect(graph.habits.surfaceStat("two.invalid", "list", "compose").taken).toBe(12);
  });

  it("keeps what it learned about a KIND of screen on a surface that is not a place", () => {
    const { graph } = seeded();
    expect(graph.habits.kindStat("media", "play", "fullscreen").taken).toBeGreaterThan(0);
    expect(graph.habits.surface(SCAN_SURFACE)).toBeNull();
  });

  it("makes a screen Ghost has never seen useful on the first visit", () => {
    const { graph } = seeded();
    const fixture = videoPlayer();
    const context = webContext({
      surface: "brand-new",
      candidates: fixture.candidates,
      screen: fixture.tree,
      state: fixture.state ?? {},
      previousAction: "play",
    });
    const rows = rankActions(context, graph, { now: NOW });
    expect(rows[0]?.id).toBe("fullscreen");
    expect(rows[0]?.tier).toBe("kind");
  });

  it("lifts the same kind of screen without touching a different kind", () => {
    const { graph } = seeded();
    const fixture = settingsPane();
    const context = webContext({ surface: "brand-new-2", candidates: fixture.candidates, screen: fixture.tree });
    const rows = rankActions(context, graph, { now: NOW });
    expect(rows[0]?.tier).toBe("shape");
  });

  it("adds nothing when the scan found nothing", () => {
    const graph = emptyKnowledge(NOW);
    const result = seedFromColdStart(graph, aggregateHabits([]), NOW);
    expect(result).toMatchObject({ surfaces: 0, habits: 0, observations: 0 });
    expect(graph.habits.size).toBe(0);
  });

  it("stays tiny: a month of history is a few kilobytes of counters", () => {
    const { graph } = seeded();
    expect(knowledgeSizeBytes(graph)).toBeLessThan(20_000);
  });

  it("keeps no path, no title and no time of day finer than a bucket", () => {
    const { graph } = seeded();
    const stored = JSON.stringify(graph.habits.toJSON());
    expect(stored).not.toContain("/watch");
    expect(stored).not.toContain("/inbox");
    expect(stored).not.toMatch(/T\d{2}:\d{2}/);
  });
});

describe("the two vocabularies the scan speaks", () => {
  it.each([
    ["feed", "feed"],
    ["media", "media"],
    ["commerce", "commerce"],
    ["reader", "reader"],
    ["mail", "list"],
    ["form", "form"],
    ["app", "unknown"],
    ["unknown", "unknown"],
  ] as const)("maps the scan's %s page onto a %s screen", (page, screen) => {
    expect(screenKindFromPageKind(page)).toBe(screen);
  });

  it.each([
    ["night", 0],
    ["morning", 2],
    ["midday", 3],
    ["afternoon", 4],
    ["evening", 5],
  ] as const)("maps the scan's %s onto hour bucket %i", (time, bucket) => {
    expect(hourBucketFromTimeBucket(time)).toBe(bucket);
  });
});
