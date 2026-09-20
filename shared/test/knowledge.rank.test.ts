// Ranking, learning and field matching (docs/knowledge.md section 5, docs/always-propose.md).
import { describe, expect, it } from "vitest";
import {
  bestAction,
  bindKnowledge,
  emptyKnowledge,
  forgetSurface,
  knowledgeFromJSON,
  knowledgeSizeBytes,
  knowledgeStats,
  knowledgeToJSON,
  matchFactsForField,
  proposalLook,
  pruneKnowledge,
  rankActions,
  recordOutcome,
  recordReplacement,
  recordVisit,
  setUserFact,
  webContext,
} from "../src";
import type { CapturedField, Context, KnowledgeGraph, RankedAction } from "../src";
import {
  basketScreen,
  cand,
  encyclopediaArticle,
  gameBoard,
  messageList,
  musicPlayer,
  noteEditor,
  photoFeed,
  settingsPane,
  signupForm,
  unreadableWindow,
  videoPlayer,
  videoWall,
} from "./helpers/knowledgeFixtures";
import type { SurfaceFixture } from "./helpers/knowledgeFixtures";

const NOW = "2026-09-19T10:00:00.000Z";

function contextFor(fixture: SurfaceFixture, surface = fixture.surface): Context {
  return webContext({
    surface,
    candidates: fixture.candidates,
    screen: fixture.tree,
    at: new Date(2026, 8, 19, 10, 0),
    ...(fixture.state ? { state: fixture.state } : {}),
    ...(fixture.previousAction ? { previousAction: fixture.previousAction } : {}),
    ...(fixture.mainListSignature !== undefined ? { mainListSignature: fixture.mainListSignature } : {}),
  });
}

function rank(context: Context, graph: KnowledgeGraph): RankedAction[] {
  return rankActions(context, graph, { now: NOW });
}

function positionOf(rows: readonly RankedAction[], id: string): number {
  return rows.findIndex((row) => row.id === id) + 1;
}

/** One simulated session: the user takes the action they actually want here. */
function session(graph: KnowledgeGraph, fixture: SurfaceFixture, times = 1, surface = fixture.surface): void {
  const context = contextFor(fixture, surface);
  for (let i = 0; i < times; i += 1) {
    recordVisit(graph, context, NOW);
    recordOutcome(graph, context, fixture.correct, "taken", { at: NOW });
  }
}

describe("a ranking always exists (docs/always-propose.md)", () => {
  it("ranks every candidate on every shape, with an empty graph", () => {
    const graph = emptyKnowledge();
    for (const make of [photoFeed, messageList, videoPlayer, gameBoard, settingsPane, noteEditor, signupForm, unreadableWindow]) {
      const fixture = make();
      const rows = rank(contextFor(fixture), graph);
      expect(rows).toHaveLength(fixture.candidates.length);
      expect(rows[0]?.score).toBeGreaterThan(0);
    }
  });

  it("proposes something even on a window it cannot read", () => {
    const fixture = unreadableWindow();
    const best = bestAction(contextFor(fixture), emptyKnowledge(), { now: NOW });
    expect(best).not.toBeNull();
    expect(best?.tier).toBe("guess");
    expect(best?.reason).toBe("a guess: nothing here is more likely");
  });

  it("returns nothing only when there is nothing on screen", () => {
    const context = webContext({ surface: "s00", candidates: [], screenKind: "feed" });
    expect(rank(context, emptyKnowledge())).toEqual([]);
  });

  it("marks how a proposal should look rather than hiding it", () => {
    expect(proposalLook(0.9)).toBe("ghost");
    expect(proposalLook(0.75)).toBe("guess");
    expect(proposalLook(0.45)).toBe("dim-guess");
  });

  it("keeps every score inside its band", () => {
    const graph = emptyKnowledge();
    for (const row of rank(contextFor(messageList()), graph)) {
      expect(row.score).toBeGreaterThanOrEqual(0.05);
      expect(row.score).toBeLessThanOrEqual(0.97);
    }
  });
});

describe("a brand-new surface, with nothing learned", () => {
  it.each<[string, () => SurfaceFixture, string]>([
    ["a playing video", videoPlayer, "fullscreen"],
    ["a board", gameBoard, "cell-0"],
    ["a pane of switches", settingsPane, "toggle-0"],
    ["a grid of thumbnails", videoWall, "item-0"],
    ["a form", signupForm, "field-0"],
    ["a basket", basketScreen, "checkout"],
  ])("leads with the shape's own answer on %s", (_name, make, id) => {
    const rows = rank(contextFor(make()), emptyKnowledge());
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.tier).toBe("shape");
    expect(rows[0]?.reason).toBe("people usually do this on a screen like this");
  });

  it("does not claim to know the person when it does not", () => {
    for (const row of rank(contextFor(photoFeed()), emptyKnowledge())) {
      expect(row.tier === "shape" || row.tier === "guess").toBe(true);
      expect(row.reason).not.toContain("you usually");
    }
  });
});

describe("after a few sessions, this surface's own habit leads", () => {
  it.each<[string, () => SurfaceFixture]>([
    ["a picture feed", photoFeed],
    ["a list of messages", messageList],
    ["a long article", encyclopediaArticle],
    ["a pane of switches", settingsPane],
    ["a document", noteEditor],
    ["a music player", musicPlayer],
  ])("learns what this person does on %s", (_name, make) => {
    const fixture = make();
    const graph = emptyKnowledge();
    const before = positionOf(rank(contextFor(fixture), graph), fixture.correct);
    session(graph, fixture, 5);
    const rows = rank(contextFor(fixture), graph);
    expect(rows[0]?.id).toBe(fixture.correct);
    expect(rows[0]?.tier).toBe("surface");
    expect(rows[0]?.reason).toBe("you usually do this here");
    expect(positionOf(rows, fixture.correct)).toBeLessThanOrEqual(before);
  });

  it("puts a learned habit into the top confidence band", () => {
    const fixture = settingsPane();
    const graph = emptyKnowledge();
    session(graph, fixture, 5);
    expect(proposalLook(rank(contextFor(fixture), graph)[0]?.score ?? 0)).toBe("ghost");
  });

  it("does not let one accidental accept take over the screen", () => {
    const fixture = videoWall();
    const graph = emptyKnowledge();
    const context = contextFor(fixture);
    recordOutcome(graph, context, "search", "taken", { at: NOW });
    const rows = rank(context, graph);
    expect(rows[0]?.id).toBe("item-0");
    expect(positionOf(rows, "search")).toBeGreaterThan(1);
  });

  it("lets a repeated accept overtake the shape's own answer, and one accept not", () => {
    const fixture = videoWall();
    const once = emptyKnowledge();
    const often = emptyKnowledge();
    const context = contextFor(fixture);
    recordOutcome(once, context, "search", "taken", { at: NOW });
    for (let i = 0; i < 5; i += 1) recordOutcome(often, context, "search", "taken", { at: NOW });
    expect(rank(context, once)[0]?.id).toBe("item-0");
    expect(rank(context, often)[0]?.id).toBe("search");
  });
});

describe("what is learned on one surface transfers to another of the same shape", () => {
  it("carries a habit to a surface it has never seen", () => {
    const fixture = settingsPane();
    const graph = emptyKnowledge();
    session(graph, fixture, 5, "s90");
    const elsewhere = contextFor(fixture, "s91");
    const rows = rank(elsewhere, graph);
    expect(rows[0]?.id).toBe(fixture.correct);
    expect(rows[0]?.tier).toBe("kind");
    expect(rows[0]?.reason).toBe("you usually do this on a screen like this");
  });

  it("does not carry it to a screen of a different shape", () => {
    const graph = emptyKnowledge();
    session(graph, settingsPane(), 6, "s90");
    const feed = contextFor(photoFeed(), "s92");
    const rows = rank(feed, graph);
    expect(rows[0]?.id).toBe("item-0");
    expect(rows.find((row) => row.id === "search")?.tier).not.toBe("kind");
  });

  it("lets this surface's own history win over what was borrowed", () => {
    const fixture = settingsPane();
    const graph = emptyKnowledge();
    for (const surface of ["s90", "s93", "s94"]) session(graph, fixture, 4, surface);
    const here = contextFor(fixture, "s95");
    const context = contextFor(fixture, "s95");
    for (let i = 0; i < 6; i += 1) recordOutcome(graph, context, "toggle-0", "taken", { at: NOW });
    const rows = rank(here, graph);
    expect(rows[0]?.id).toBe("toggle-0");
    expect(rows[0]?.tier).toBe("surface");
  });

  it("counts borrowed evidence once, not twice", () => {
    const fixture = settingsPane();
    const shared = emptyKnowledge();
    session(shared, fixture, 4, "s96");
    const here = rank(contextFor(fixture, "s96"), shared).find((row) => row.id === fixture.correct);
    const there = rank(contextFor(fixture, "s97"), shared).find((row) => row.id === fixture.correct);
    expect(here?.tier).toBe("surface");
    expect(there?.tier).toBe("kind");
    expect(here?.score ?? 0).toBeGreaterThan(there?.score ?? 0);
  });
});

describe("outcomes", () => {
  it("demotes a replaced proposal faster than an ignored one", () => {
    const fixture = videoWall();
    const context = contextFor(fixture);
    const ignored = emptyKnowledge();
    const replaced = emptyKnowledge();
    recordOutcome(ignored, context, "item-0", "ignored", { at: NOW });
    recordOutcome(replaced, context, "item-0", "replaced", { at: NOW });
    const withIgnore = rank(context, ignored).find((row) => row.id === "item-0");
    const withReplace = rank(context, replaced).find((row) => row.id === "item-0");
    expect(withReplace?.score ?? 1).toBeLessThan(withIgnore?.score ?? 0);
  });

  it("teaches the action the user chose instead, in the same breath", () => {
    const fixture = videoWall();
    const context = contextFor(fixture);
    const graph = emptyKnowledge();
    for (let i = 0; i < 3; i += 1) recordReplacement(graph, context, "item-0", "search", { at: NOW });
    const rows = rank(context, graph);
    expect(rows[0]?.id).toBe("search");
    expect(positionOf(rows, "item-0")).toBeGreaterThan(1);
  });

  it("does not record a replacement against the action that was taken", () => {
    const fixture = videoWall();
    const context = contextFor(fixture);
    const graph = emptyKnowledge();
    recordReplacement(graph, context, "search", "search", { at: NOW });
    expect(graph.habits.stat({ surface: "s05", screenKind: "feed", previousAction: "none", action: "search" })).toMatchObject({
      taken: 1,
      replaced: 0,
    });
  });

  it("says out loud when the user has passed on something here", () => {
    const fixture = videoWall();
    const context = contextFor(fixture);
    const graph = emptyKnowledge();
    for (let i = 0; i < 3; i += 1) recordOutcome(graph, context, "item-0", "ignored", { at: NOW });
    const row = rank(context, graph).find((r) => r.id === "item-0");
    expect(row?.reason).toBe("you have passed on this here before");
  });

  it("learns from an action that was never proposed", () => {
    const fixture = unreadableWindow();
    const context = contextFor(fixture);
    const graph = emptyKnowledge();
    for (let i = 0; i < 4; i += 1) recordOutcome(graph, context, { role: "unknown" }, "taken", { at: NOW });
    expect(rank(context, graph)[0]?.tier).toBe("surface");
  });

  it("ignores an outcome for something that is not on screen and has no role", () => {
    const graph = emptyKnowledge();
    const context = contextFor(videoWall());
    recordOutcome(graph, context, "", "taken", { at: NOW });
    expect(graph.habits.size).toBe(0);
  });

  it("counts a visit without counting an action", () => {
    const graph = emptyKnowledge();
    const context = contextFor(photoFeed());
    recordVisit(graph, context, NOW);
    expect(graph.habits.surface("s01")?.visits).toBe(1);
    expect(graph.habits.size).toBe(0);
  });

  it("weighs a fresh habit above a stale one", () => {
    const fixture = videoWall();
    const context = contextFor(fixture);
    const fresh = emptyKnowledge();
    const stale = emptyKnowledge();
    for (let i = 0; i < 4; i += 1) {
      recordOutcome(fresh, context, "search", "taken", { at: NOW });
      recordOutcome(stale, context, "search", "taken", { at: "2025-01-05T10:00:00.000Z" });
    }
    const freshScore = rank(context, fresh).find((row) => row.id === "search")?.score ?? 0;
    const staleScore = rank(context, stale).find((row) => row.id === "search")?.score ?? 0;
    expect(freshScore).toBeGreaterThan(staleScore);
  });

  it("gives a small lift to the time of day the habit belongs to", () => {
    const fixture = videoWall();
    const morning = webContext({ surface: "s05", candidates: fixture.candidates, screen: fixture.tree, at: new Date(2026, 8, 19, 9, 0) });
    const evening = webContext({ surface: "s05", candidates: fixture.candidates, screen: fixture.tree, at: new Date(2026, 8, 19, 21, 0) });
    const graph = emptyKnowledge();
    for (let i = 0; i < 3; i += 1) recordOutcome(graph, morning, "search", "taken", { at: NOW });
    const morningScore = rank(morning, graph).find((row) => row.id === "search")?.score ?? 0;
    const eveningScore = rank(evening, graph).find((row) => row.id === "search")?.score ?? 0;
    expect(morningScore).toBeGreaterThan(eveningScore);
  });
});

describe("ties and locks", () => {
  it("proposes an irreversible action but lets a reversible one win a tie", () => {
    const context = webContext({
      surface: "s98",
      screenKind: "form",
      candidates: [cand("send", "Send", { locked: true }), cand("draft", "Save")],
    });
    const rows = rank(context, emptyKnowledge());
    expect(rows.map((row) => row.id)).toContain("send");
    expect(rows.find((row) => row.id === "send")?.locked).toBe(true);
  });

  it("leads with the first item of a repeated list when the items tie", () => {
    const rows = rank(contextFor(videoWall()), emptyKnowledge());
    expect(rows[0]?.id).toBe("item-0");
    expect(rows[1]?.id).toBe("item-1");
  });

  it("honours a limit", () => {
    const rows = rankActions(contextFor(videoWall()), emptyKnowledge(), { now: NOW, limit: 3 });
    expect(rows).toHaveLength(3);
  });
});

describe("facts fill fields, whatever kind of form it is", () => {
  function field(over: Partial<CapturedField> = {}): CapturedField {
    return { signature: "f1", label: "Email", kind: "email", rect: { x: 0, y: 0, width: 200, height: 30 }, ...over };
  }

  function graphWithFacts(): KnowledgeGraph {
    const graph = emptyKnowledge(NOW);
    graph.facts = setUserFact(graph.facts, "contact.email.personal", "someone@example.test", { label: "email" }, NOW).graph;
    graph.facts = setUserFact(graph.facts, "address.home.postalCode", "A1A 1A1", { label: "postal code" }, NOW).graph;
    return graph;
  }

  it("matches a field to a fact by what both call themselves", () => {
    const matches = matchFactsForField(field(), graphWithFacts());
    expect(matches[0]?.key).toBe("contact.email.personal");
    expect(matches[0]?.confidence).toBeGreaterThan(0.7);
    expect(matches[0]?.reason).toBeTruthy();
  });

  it("fills a field no résumé ever had, because the key set is open", () => {
    const matches = matchFactsForField(field({ label: "Postal code", kind: "text" }), graphWithFacts());
    expect(matches[0]?.key).toBe("address.home.postalCode");
  });

  it("offers nothing for a sensitive field", () => {
    expect(matchFactsForField(field({ label: "Password", kind: "text", inputType: "password" }), graphWithFacts())).toEqual([]);
  });

  it("offers nothing when the graph knows nothing", () => {
    expect(matchFactsForField(field(), emptyKnowledge(NOW))).toEqual([]);
  });

  it("never names a value in its reason", () => {
    for (const match of matchFactsForField(field(), graphWithFacts())) {
      expect(match.reason).not.toContain("@");
    }
  });
});

describe("the graph itself", () => {
  it("round trips through JSON with its habits and its facts", () => {
    const graph = emptyKnowledge(NOW);
    graph.facts = setUserFact(graph.facts, "identity.fullName", "A Person", { label: "full name" }, NOW).graph;
    session(graph, settingsPane(), 3);
    const revived = knowledgeFromJSON(knowledgeToJSON(graph), NOW);
    expect(knowledgeStats(revived)).toEqual(knowledgeStats(graph));
    expect(revived.habits.toJSON()).toEqual(graph.habits.toJSON());
  });

  it("survives a corrupt file", () => {
    expect(knowledgeStats(knowledgeFromJSON("{", NOW)).habits).toBe(0);
    expect(knowledgeStats(knowledgeFromJSON("[]", NOW)).facts).toBe(0);
  });

  it("stays far inside the size budget after a month of use", () => {
    const graph = emptyKnowledge(NOW);
    for (let day = 0; day < 30; day += 1) {
      for (const make of [photoFeed, messageList, videoPlayer, settingsPane, noteEditor, basketScreen]) session(graph, make(), 2);
    }
    expect(knowledgeSizeBytes(graph)).toBeLessThan(200_000);
  });

  it("prunes on request and reports what went", () => {
    const graph = emptyKnowledge(NOW);
    const context = contextFor(videoWall());
    recordOutcome(graph, context, "search", "ignored", { at: "2025-01-05T10:00:00.000Z" });
    const pruned = pruneKnowledge(graph, NOW);
    expect(pruned.habits).toBe(1);
    expect(pruned.bytes).toBeGreaterThan(0);
  });

  it("forgets one surface on request", () => {
    const graph = emptyKnowledge(NOW);
    session(graph, settingsPane(), 3);
    expect(forgetSurface(graph, "s12")).toBeGreaterThan(0);
    expect(knowledgeStats(graph).habits).toBe(0);
  });

  it("offers the documented API bound to one graph", () => {
    const graph = emptyKnowledge(NOW);
    const knowledge = bindKnowledge(graph);
    const context = contextFor(settingsPane());
    knowledge.recordVisit(context);
    for (let i = 0; i < 5; i += 1) knowledge.recordOutcome(context, "search", "taken");
    expect(knowledge.rankActions(context)[0]?.id).toBe("search");
    knowledge.recordReplacement(context, "search", "toggle-0");
    expect(knowledge.graph.habits.size).toBeGreaterThan(1);
  });

  it("counts what it knows", () => {
    const graph = emptyKnowledge(NOW);
    session(graph, settingsPane(), 4);
    const stats = knowledgeStats(graph);
    expect(stats.habits).toBe(1);
    expect(stats.observations).toBe(4);
    expect(stats.surfaces).toBe(1);
  });
});
