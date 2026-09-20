// The flat 19-key profile becomes a graph without anyone noticing: same keys, same values, plus the
// category, label and phrasings the flat profile never had.
import { describe, expect, it } from "vitest";
import {
  DEMO_FACT_GRAPH,
  DEMO_PROFILE,
  factKeysForRequest,
  getFact,
  graphToProfileFacts,
  listFacts,
  mapFieldToFact,
  profileFromGraph,
  profileToGraph,
  type Profile,
} from "../src";
import { fieldOf } from "./helpers/factFixtures";

const T1 = "2026-01-01T00:00:00.000Z";

describe("profileToGraph", () => {
  const graph = profileToGraph(DEMO_PROFILE, { kind: "user" }, T1);

  it("keeps every fact, under the same key", () => {
    expect(listFacts(graph).map((f) => f.key).sort()).toEqual(Object.keys(DEMO_PROFILE.facts).sort());
    expect(graphToProfileFacts(graph)).toEqual(DEMO_PROFILE.facts);
  });

  it("gives each résumé fact a category, a human label and the phrasings a form uses", () => {
    expect(getFact(graph, "firstName")).toMatchObject({ category: "identity", label: "first name", verifiedByUser: true, sensitive: false });
    expect(getFact(graph, "firstName")?.aliases).toEqual(expect.arrayContaining(["given name", "forename"]));
    expect(getFact(graph, "linkedin")?.category).toBe("links");
    expect(getFact(graph, "graduationDate")?.category).toBe("education");
    expect(getFact(graph, "referralSource")?.label).toBe("how you heard about us");
  });

  it("reads a country-qualified declaration as the same fact asked about one country", () => {
    const fact = getFact(graph, "workAuthorization.CA");
    expect(fact?.label).toBe("work authorization in canada");
    expect(fact?.aliases).toEqual(expect.arrayContaining(["authorized to work"]));
    expect(fact?.category).toBe("work");
  });

  it("describes a key it has never seen from the key itself", () => {
    const odd: Profile = { facts: { nickname: "Ace", "travel.homeAirport": "YYZ" }, pastAnswers: [] };
    const graphed = profileToGraph(odd, { kind: "user" }, T1);
    expect(getFact(graphed, "nickname")).toMatchObject({ label: "nickname", category: "other" });
    expect(getFact(graphed, "travel.homeAirport")).toMatchObject({ label: "home airport", category: "travel" });
  });

  it("marks an imported profile as unverified, so the user's own answer still wins", () => {
    const imported = profileToGraph(DEMO_PROFILE, { kind: "file", name: "resume.pdf" }, T1);
    expect(getFact(imported, "firstName")).toMatchObject({ verifiedByUser: false, source: { kind: "file", name: "resume.pdf" } });
    expect(getFact(imported, "firstName")?.confidence).toBeLessThan(1);
  });

  it("skips an empty value rather than storing a blank fact", () => {
    const sparse: Profile = { facts: { firstName: "Alex", lastName: "   ", website: "" }, pastAnswers: [] };
    expect(listFacts(profileToGraph(sparse, { kind: "user" }, T1)).map((f) => f.key)).toEqual(["firstName"]);
  });

  it("carries a sensitive value the user typed, but never back into the profile that goes on the wire", () => {
    const withId: Profile = { facts: { firstName: "Alex", passportNumber: "X1234567" }, pastAnswers: [] };
    const graphed = profileToGraph(withId, { kind: "user" }, T1);
    expect(getFact(graphed, "passportNumber")?.sensitive).toBe(true);
    expect(graphToProfileFacts(graphed)).toEqual({ firstName: "Alex" });
    expect(factKeysForRequest(graphed)).toEqual(["firstName"]);
  });
});

describe("profileFromGraph", () => {
  it("round trips, keeping what the user has answered before", () => {
    const answers = [{ question: "How did you hear about us?", answer: "Hack the North" }];
    expect(profileFromGraph(DEMO_FACT_GRAPH, answers)).toEqual({ facts: DEMO_PROFILE.facts, pastAnswers: answers });
  });
});

describe("DEMO_FACT_GRAPH", () => {
  it("is the demo profile, and still fills the demo application form", () => {
    expect(graphToProfileFacts(DEMO_FACT_GRAPH)).toEqual(DEMO_PROFILE.facts);
    for (const [label, key] of [
      ["First name", "firstName"],
      ["Email", "email"],
      ["School", "school"],
      ["LinkedIn profile", "linkedin"],
      ["How did you hear about us?", "referralSource"],
    ] as const) {
      // No factKeys at all: everything the mapper offers comes from the graph.
      expect(mapFieldToFact(fieldOf(label, label.startsWith("How") ? "select" : "text"), [], DEMO_FACT_GRAPH).factKey, label).toBe(key);
    }
  });
});
