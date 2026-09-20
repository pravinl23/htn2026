// The rules that make the layer safe to ship, checked mechanically (CLAUDE.md rules 3 and 6, docs/storage.md).
//
// Two of them cannot be argued with:
//   1. nothing in the knowledge layer may name a website, an app or a brand — so the SOURCE itself is scanned
//      for host-shaped and bundle-shaped strings, in the code and in the fixtures alike;
//   2. nothing the layer stores may carry page text, a value, a title or a time finer than a four-hour bucket.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyKnowledge, knowledgeToJSON, rankActions, recordOutcome, recordVisit, webContext } from "../src";
import { messageList, photoFeed, settingsPane, videoPlayer } from "./helpers/knowledgeFixtures";

const SRC = join(__dirname, "..", "src", "knowledge");
const TESTS = __dirname;

/** A host-shaped string: anything a rule could latch onto instead of reading the screen. */
const HOST_SHAPED = /\b[a-z0-9][a-z0-9-]{1,}\.(com|net|org|io|co|tv|fm|gg|ai|dev|xyz|me)\b/i;
/** A bundle-shaped string, which is the native half of the same mistake. */
const BUNDLE_SHAPED = /\b(com|org|net|io)\.[a-z][a-z0-9]*\.[a-z][a-z0-9]*/i;

function sourceFiles(): { name: string; text: string }[] {
  const knowledge = readdirSync(SRC).map((file) => ({ name: `src/knowledge/${file}`, text: readFileSync(join(SRC, file), "utf8") }));
  const tests = readdirSync(TESTS)
    .filter((file) => file.startsWith("knowledge"))
    .map((file) => ({ name: `test/${file}`, text: readFileSync(join(TESTS, file), "utf8") }));
  const fixtures = { name: "test/helpers/knowledgeFixtures.ts", text: readFileSync(join(TESTS, "helpers", "knowledgeFixtures.ts"), "utf8") };
  return [...knowledge, ...tests, fixtures];
}

describe("nothing names a place", () => {
  it("finds no host-shaped string anywhere in the layer or its fixtures", () => {
    for (const file of sourceFiles()) {
      const hit = HOST_SHAPED.exec(file.text);
      expect(hit === null || hit[0] === "example.test", `${file.name}: ${hit?.[0] ?? ""}`).toBe(true);
    }
  });

  it("finds no bundle-shaped string either", () => {
    for (const file of sourceFiles()) {
      expect(BUNDLE_SHAPED.test(file.text), file.name).toBe(false);
    }
  });

  it("reads every surface id in the fixtures as an opaque token", () => {
    for (const fixture of [photoFeed(), messageList(), settingsPane(), videoPlayer()]) {
      expect(fixture.surface).toMatch(/^s\d{2}$/);
    }
  });

  it("treats two surfaces with the same shape identically when nothing has been learned", () => {
    const fixture = settingsPane();
    const graph = emptyKnowledge();
    const here = rankActions(webContext({ surface: "aaaa", candidates: fixture.candidates, screen: fixture.tree }), graph);
    const there = rankActions(webContext({ surface: "zzzz", candidates: fixture.candidates, screen: fixture.tree }), graph);
    expect(there).toEqual(here);
  });
});

describe("nothing stored can be read back as what the user saw", () => {
  function usedGraph() {
    const graph = emptyKnowledge("2026-09-19T10:00:00.000Z");
    for (const fixture of [photoFeed(), messageList(), settingsPane(), videoPlayer()]) {
      const context = webContext({
        surface: fixture.surface,
        candidates: fixture.candidates,
        screen: fixture.tree,
        at: new Date(2026, 8, 19, 10, 30),
        ...(fixture.state ? { state: fixture.state } : {}),
      });
      recordVisit(graph, context, "2026-09-19T10:30:00.000Z");
      recordOutcome(graph, context, fixture.correct, "taken", { at: "2026-09-19T10:30:00.000Z" });
      recordOutcome(graph, context, "search", "ignored", { at: "2026-09-19T10:30:00.000Z" });
    }
    return graph;
  }

  it("keeps no label, no placeholder and no candidate id", () => {
    const stored = knowledgeToJSON(usedGraph());
    for (const text of ["New message", "Add to favourites", "Full screen", "Entry 1", "Option 1", "fav-0", "toggle-0", "item-0"]) {
      expect(stored).not.toContain(text);
    }
  });

  it("keeps no time finer than a day in anything it learns", () => {
    // The habit and surface sections are what learning writes, and they hold days and four-hour buckets only.
    // (The facts section keeps the facts module's own `updatedAt`; see shared/src/facts.)
    const habits = JSON.stringify(usedGraph().habits.toJSON());
    expect(habits).not.toMatch(/T\d{2}:\d{2}/);
    expect(habits).not.toContain("10:30");
    expect(habits).toContain("2026-09-19");
  });

  it("stores nothing but ids, kinds, roles and numbers in a habit row", () => {
    const [entry] = usedGraph().habits.list();
    expect(Object.keys(entry ?? {}).sort()).toEqual(["action", "counts", "previousAction", "screenKind", "surface"]);
    expect(Object.keys(entry?.counts ?? {}).sort()).toEqual(["hours", "ignored", "lastSeen", "replaced", "taken"]);
  });

  it("says why in words that cannot carry anything from the screen", () => {
    const allowed = new Set([
      "you usually do this here",
      "you have passed on this here before",
      "you usually do this on a screen like this",
      "you usually skip this on a screen like this",
      "people usually do this on a screen like this",
      "a guess: nothing here is more likely",
    ]);
    const graph = usedGraph();
    for (const fixture of [photoFeed(), messageList(), settingsPane(), videoPlayer()]) {
      const context = webContext({ surface: fixture.surface, candidates: fixture.candidates, screen: fixture.tree });
      for (const row of rankActions(context, graph)) {
        expect(allowed.has(row.reason), row.reason).toBe(true);
        expect(row.reason).not.toContain(fixture.surface);
      }
    }
  });
});
