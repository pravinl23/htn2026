// The before-and-after benchmark (docs/knowledge.md section 6). This table is the deliverable: proof that the
// knowledge layer changes what Shabang proposes on any screen, and that it does it by learning ONE PERSON rather
// than by knowing any place.
//
// The harness (./knowledgeBenchmark.ts) holds the sixteen screens, the scripted sessions and the three
// conditions; this file asserts on the numbers and fails if any column stops improving. `scripts/bench-knowledge.mjs`
// prints the same table from the same code.
import { describe, expect, it } from "vitest";
import { KINDS_HISTORY_CANNOT_EXPRESS, formatDetail, formatTable, runBenchmark } from "./knowledgeBenchmark";
import type { BenchmarkRow } from "./knowledgeBenchmark";

const result = runBenchmark();
const { rows, totals } = result;
const SCREENS = 16;

function persona(name: BenchmarkRow["persona"]): BenchmarkRow[] {
  return rows.filter((row) => row.persona === name);
}

describe("the before-and-after benchmark", () => {
  it("prints the table (docs/knowledge.md section 6)", () => {
    console.log(`\n${formatTable(result)}\n\n${formatDetail(result)}\n`);
    expect(rows).toHaveLength(SCREENS);
  });

  it("covers every shape docs/knowledge.md names, and every screen kind", () => {
    expect(new Set(rows.map((row) => row.kind)).size).toBe(10);
    expect(persona("consistent").length).toBeGreaterThan(0);
    expect(persona("noisy").length).toBeGreaterThan(0);
    expect(persona("unusual").length).toBeGreaterThan(0);
  });

  it("ranks the action the person wants somewhere, on every screen, in every condition", () => {
    for (const row of rows) {
      expect(row.empty.rank, row.shape).toBeGreaterThan(0);
      expect(row.cold.rank, row.shape).toBeGreaterThan(0);
      expect(row.learned.rank, row.shape).toBeGreaterThan(0);
    }
  });

  // ---------- condition 1: knowing nothing ----------

  it("is right about the top proposal on more than half the screens knowing nothing at all", () => {
    expect(totals.empty.topOne).toBeGreaterThan(SCREENS / 2);
  });

  it("never claims to know the person before it does", () => {
    expect(totals.empty.learnedTop).toBe(0);
    expect(totals.empty.priorTop).toBe(SCREENS);
  });

  // ---------- condition 2: the cold-start scan ----------

  it("builds the middle column out of the real scan pipeline", () => {
    expect(result.coldStart.rows).toBeGreaterThan(0);
    expect(result.coldStart.origins).toBeGreaterThanOrEqual(6);
    expect(result.coldStart.seededSurfaces).toBeGreaterThanOrEqual(6);
    expect(result.coldStart.observations).toBeGreaterThan(0);
    // Honest about the one thing history cannot do: a URL path has no word for a settings pane, an editor or a
    // board, so those three kinds are seeded the way a window scan would seed them.
    expect(result.coldStart.seededByHand).toEqual(KINDS_HISTORY_CANNOT_EXPRESS);
  });

  it("gets better on day one, before the user has taught it anything", () => {
    expect(totals.cold.topOne).toBeGreaterThan(totals.empty.topOne);
    expect(totals.cold.meanRank).toBeLessThan(totals.empty.meanRank);
    expect(totals.cold.learnedTop).toBeGreaterThan(totals.empty.learnedTop);
  });

  it("lifts a screen it has never seen because it recognizes the SHAPE", () => {
    // Nothing in the cold-start graph is keyed to any of these screens: the scan only ever saw other places.
    const lifted = rows.filter((row) => row.cold.rank < row.empty.rank);
    expect(lifted.length).toBeGreaterThanOrEqual(3);
    for (const row of lifted) expect(row.cold.topTier === "kind" || row.cold.topTier === "surface", row.shape).toBe(true);
  });

  it("cannot cold-start a screen where this person is unusual, and does not pretend to", () => {
    for (const row of persona("unusual")) {
      expect(row.cold.rank, row.shape).toBe(row.empty.rank);
      expect(row.cold.rank, row.shape).toBeGreaterThan(1);
    }
  });

  // ---------- condition 3: five sessions ----------

  it("is right about every screen once it has watched five sessions", () => {
    expect(totals.learned.topOne).toBe(SCREENS);
    expect(totals.learned.meanRank).toBe(1);
  });

  it("leans on what it learned rather than on the shape, once it has watched", () => {
    expect(totals.learned.learnedTop).toBe(SCREENS);
    expect(totals.learned.priorTop).toBe(0);
  });

  it("learns the person, not the shape: the unusual screens are the proof", () => {
    for (const row of persona("unusual")) {
      expect(row.empty.rank, row.shape).toBeGreaterThan(1);
      expect(row.learned.rank, row.shape).toBe(1);
      expect(row.learned.topTier, row.shape).toBe("surface");
    }
  });

  it("gets a noisy person right even though they contradict themselves", () => {
    for (const row of persona("noisy")) {
      expect(row.log.otherControl, row.shape).toBeGreaterThan(0);
      expect(row.learned.rank, row.shape).toBe(1);
    }
  });

  it("never gets worse on any single screen as it learns", () => {
    for (const row of rows) {
      expect(row.learned.rank, row.shape).toBeLessThanOrEqual(row.empty.rank);
      expect(row.learned.rank, row.shape).toBeLessThanOrEqual(row.cold.rank);
    }
  });

  it("learns from being turned down as well as from being taken", () => {
    const replaced = rows.reduce((sum, row) => sum + row.log.otherRole, 0);
    expect(replaced).toBeGreaterThan(10);
  });

  it("stays right as the sessions pile up", () => {
    // Fifteen sessions of the same person, three times the evidence, same answer everywhere. (Ten sessions is the
    // one place this dips: see docs/knowledge.md section 6 on what a proposal that is never made cannot learn.)
    const longer = runBenchmark({ cycles: 3 });
    expect(longer.sessions).toBe(15);
    expect(longer.totals.learned.topOne).toBe(SCREENS);
  });

  it("keeps the whole brain far under the size budget", () => {
    expect(result.sizeBytes).toBeLessThan(200_000);
  });
});
