// The graph itself: provenance, conflicts, rejection memory, forgetting a source, caps, JSON, and the
// promise that only fact KEYS ever leave the machine.
import { describe, expect, it } from "vitest";
import {
  FACT_KEY_PATTERN,
  FACT_LIMITS,
  applyProposals,
  emptyGraph,
  factCount,
  factKeysForRequest,
  getFact,
  graphFromJSON,
  graphToJSON,
  isRejected,
  listFacts,
  matchFieldToFacts,
  matchableFacts,
  rejectProposal,
  removeBySource,
  removeFact,
  setUserFact,
  upsertFact,
  type FactGraph,
  type FactProposal,
} from "../src";
import { fieldOf } from "./helpers/factFixtures";

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-02-01T00:00:00.000Z";
const T3 = "2026-03-01T00:00:00.000Z";

function proposal(over: Partial<FactProposal> = {}): FactProposal {
  return { key: "work.employer.current", value: "Northwind Robotics", source: { kind: "github", login: "alexchen-dev" }, ...over };
}

describe("upsertFact", () => {
  it("stores a fact with its category, label, aliases and provenance", () => {
    const { graph, status } = upsertFact(emptyGraph(T1), proposal({ evidence: "Company: Northwind Robotics" }), T1);
    const fact = getFact(graph, "work.employer.current");
    expect(status).toBe("added");
    expect(fact).toMatchObject({ category: "work", label: "employer", value: "Northwind Robotics", verifiedByUser: false });
    expect(fact?.aliases).toContain("company name");
    expect(fact?.source).toEqual({ kind: "github", login: "alexchen-dev" });
    expect(fact?.evidence).toBe("Company: Northwind Robotics");
  });

  it("describes a key nobody has defined, from the key itself", () => {
    const { graph } = upsertFact(emptyGraph(T1), proposal({ key: "travel.frequentFlyer", value: "AC 1234" }), T1);
    expect(getFact(graph, "travel.frequentFlyer")).toMatchObject({ category: "travel", label: "frequent flyer" });
  });

  it("refuses a malformed key, an empty value and an oversized value", () => {
    const graph = emptyGraph(T1);
    expect(upsertFact(graph, proposal({ key: "9lives" }), T1).status).toBe("invalid");
    expect(upsertFact(graph, proposal({ value: "   " }), T1).status).toBe("invalid");
    expect(upsertFact(graph, proposal({ value: "x".repeat(FACT_LIMITS.valueChars + 1) }), T1).status).toBe("invalid");
    expect(factCount(graph)).toBe(0);
  });

  it("caps aliases and evidence rather than growing without bound", () => {
    const aliases = Array.from({ length: 40 }, (_, i) => `alias ${i}`);
    const { graph } = upsertFact(emptyGraph(T1), proposal({ aliases, evidence: "e".repeat(500) }), T1);
    const fact = getFact(graph, "work.employer.current");
    expect(fact?.aliases.length).toBeLessThanOrEqual(FACT_LIMITS.aliases);
    expect(fact?.evidence?.length).toBe(FACT_LIMITS.evidenceChars);
  });

  it("does not mutate the graph it was given", () => {
    const before = emptyGraph(T1);
    upsertFact(before, proposal(), T2);
    expect(factCount(before)).toBe(0);
  });
});

describe("conflict rules", () => {
  it("lets the user beat every scan, whenever the scan runs", () => {
    const typed = setUserFact(emptyGraph(T1), "work.employer.current", "Northwind Robotics", {}, T1).graph;
    const later = upsertFact(typed, proposal({ value: "Contoso", updatedAt: T3 }), T3);
    expect(later.status).toBe("kept");
    expect(getFact(later.graph, "work.employer.current")?.value).toBe("Northwind Robotics");
  });

  it("lets the user overwrite anything, including their own earlier answer", () => {
    const scanned = upsertFact(emptyGraph(T1), proposal(), T1).graph;
    const typed = setUserFact(scanned, "work.employer.current", "Contoso", {}, T2);
    expect(typed.status).toBe("updated");
    expect(getFact(typed.graph, "work.employer.current")).toMatchObject({ value: "Contoso", verifiedByUser: true, source: { kind: "user" } });
  });

  it("prefers the more trusted source and ignores the less trusted one", () => {
    const fromGithub = upsertFact(emptyGraph(T1), proposal(), T1).graph;
    const fromResume = upsertFact(fromGithub, proposal({ value: "Contoso", source: { kind: "file", name: "resume.pdf" } }), T2);
    expect(fromResume.status).toBe("updated");
    expect(getFact(fromResume.graph, "work.employer.current")?.value).toBe("Contoso");

    const fromForm = upsertFact(fromResume.graph, proposal({ value: "Initech", source: { kind: "observed", origin: "https://example.com" } }), T3);
    expect(fromForm.status).toBe("kept");
    expect(getFact(fromForm.graph, "work.employer.current")?.value).toBe("Contoso");
  });

  it("takes the newer reading of the same source and drops the older one", () => {
    const first = upsertFact(emptyGraph(T1), proposal({ updatedAt: T2 }), T2).graph;
    const stale = upsertFact(first, proposal({ value: "Contoso", updatedAt: T1 }), T1);
    expect(stale.status).toBe("kept");
    const fresh = upsertFact(first, proposal({ value: "Contoso", updatedAt: T3 }), T3);
    expect(fresh.status).toBe("updated");
    expect(getFact(fresh.graph, "work.employer.current")?.value).toBe("Contoso");
  });
});

describe("rejection memory", () => {
  it("never re-proposes a candidate the user turned down, and keeps no value", () => {
    const graph = rejectProposal(emptyGraph(T1), "work.employer.current", "Contoso", T1);
    expect(isRejected(graph, "work.employer.current", "Contoso")).toBe(true);
    expect(JSON.stringify(graph.rejected)).not.toContain("Contoso");
    const again = upsertFact(graph, proposal({ value: "Contoso" }), T2);
    expect(again.status).toBe("rejected");
    expect(factCount(again.graph)).toBe(0);
  });

  it("still lets the user type the rejected value themselves", () => {
    const graph = rejectProposal(emptyGraph(T1), "work.employer.current", "Contoso", T1);
    expect(setUserFact(graph, "work.employer.current", "Contoso", {}, T2).status).toBe("added");
  });
});

describe("forgetting a source", () => {
  const scanned = applyProposals(
    emptyGraph(T1),
    [
      proposal(),
      proposal({ key: "links.twitter", value: "https://x.com/alexchen-dev" }),
      proposal({ key: "work.title", value: "Software Engineer", source: { kind: "mail", connector: "gmail" } }),
    ],
    T1,
  ).graph;

  it("removes every fact from that source and nothing else", () => {
    const typed = setUserFact(scanned, "firstName", "Alex", {}, T2).graph;
    const { graph, removed } = removeBySource(typed, { kind: "github", login: "alexchen-dev" }, T3);
    expect(removed).toBe(2);
    expect(listFacts(graph).map((f) => f.key)).toEqual(["firstName", "work.title"]);
  });

  it("leaves the graph alone when nothing came from that source", () => {
    expect(removeBySource(scanned, { kind: "github", login: "someone-else" }, T3)).toEqual({ graph: scanned, removed: 0 });
  });

  it("removes one fact by key", () => {
    expect(factCount(removeFact(scanned, "links.twitter", T3))).toBe(2);
  });
});

describe("sensitivity", () => {
  const card: FactProposal = { key: "finance.card", value: "4111 1111 1111 1111", source: { kind: "mail", connector: "gmail" } };

  it("never imports a sensitive fact, whatever the source calls it", () => {
    const byKey = upsertFact(emptyGraph(T1), card, T1);
    expect(byKey.status).toBe("sensitive");
    // Even under an innocent key and label, the value itself gives a card away.
    const disguised = upsertFact(emptyGraph(T1), { ...card, key: "other.memberNumber", label: "member number" }, T1);
    expect(disguised.status).toBe("sensitive");
    const ssn = upsertFact(emptyGraph(T1), { ...card, key: "other.reference", label: "reference", value: "123-45-6789" }, T1);
    expect(ssn.status).toBe("sensitive");
  });

  it("counts what a scan skipped without keeping it", () => {
    const applied = applyProposals(emptyGraph(T1), [card, proposal()], T1);
    expect(applied).toMatchObject({ added: 1, sensitive: 1 });
    expect(graphToJSON(applied.graph)).not.toContain("4111");
  });

  it("stores a sensitive fact the user typed, but never matches it and never names it on the wire", () => {
    const graph = setUserFact(emptyGraph(T1), "health.cardNumber", "1234 567 890 AB", { label: "health card number" }, T1).graph;
    expect(getFact(graph, "health.cardNumber")?.sensitive).toBe(true);
    expect(matchableFacts(graph)).toEqual([]);
    expect(matchFieldToFacts(fieldOf("Health card number"), graph)).toEqual([]);
    expect(factKeysForRequest(graph)).toEqual([]);
  });
});

describe("size caps", () => {
  it("evicts the weakest unverified fact rather than growing past the cap", () => {
    let graph: FactGraph = emptyGraph(T1);
    for (let i = 0; i < FACT_LIMITS.facts; i++) {
      graph = upsertFact(graph, proposal({ key: `other.k${i}`, value: `v${i}`, confidence: i === 7 ? 0.1 : 0.9 }), T1).graph;
    }
    expect(factCount(graph)).toBe(FACT_LIMITS.facts);
    const full = upsertFact(graph, proposal({ key: "other.newest", value: "kept" }), T2);
    expect(full.status).toBe("added");
    expect(factCount(full.graph)).toBe(FACT_LIMITS.facts);
    expect(getFact(full.graph, "other.k7")).toBeNull();
    expect(getFact(full.graph, "other.newest")?.value).toBe("kept");
  });

  it("refuses to drop a fact the user verified to make room", () => {
    let graph: FactGraph = emptyGraph(T1);
    for (let i = 0; i < FACT_LIMITS.facts; i++) graph = setUserFact(graph, `other.k${i}`, `v${i}`, {}, T1).graph;
    const full = upsertFact(graph, proposal({ key: "other.newest" }), T2);
    expect(full.status).toBe("invalid");
    expect(factCount(full.graph)).toBe(FACT_LIMITS.facts);
  });
});

describe("JSON round trip", () => {
  const graph = applyProposals(emptyGraph(T1), [proposal({ evidence: "seen in a signature" }), proposal({ key: "work.title", value: "Software Engineer" })], T1).graph;

  it("comes back the same", () => {
    const back = graphFromJSON(graphToJSON(rejectProposal(graph, "other.x", "no", T1)), T2);
    expect(listFacts(back)).toEqual(listFacts(graph));
    expect(back.rejected).toEqual([...rejectProposal(graph, "other.x", "no", T1).rejected]);
  });

  it("survives junk, a foreign file and a half-written fact", () => {
    expect(factCount(graphFromJSON("not json", T1))).toBe(0);
    expect(factCount(graphFromJSON("[1,2,3]", T1))).toBe(0);
    expect(factCount(graphFromJSON(JSON.stringify({ facts: [{ key: "a.b" }, { value: "no key" }, 7] }), T1))).toBe(0);
  });

  it("drops a sensitive fact that was not the user's own, however it got into the file", () => {
    const smuggled = JSON.stringify({
      facts: [{ key: "other.note", value: "4111 1111 1111 1111", source: { kind: "mail", connector: "gmail" }, label: "note" }],
    });
    expect(factCount(graphFromJSON(smuggled, T1))).toBe(0);
  });
});

describe("factKeysForRequest", () => {
  const graph = applyProposals(emptyGraph(T1), [proposal(), proposal({ key: "links.twitter", value: "https://x.com/alexchen-dev" })], T1).graph;

  it("sends keys, in order, and nothing else", () => {
    const keys = factKeysForRequest(graph);
    expect(keys).toEqual(["links.twitter", "work.employer.current"]);
    const wire = JSON.stringify({ origin: "https://example.com", formSignature: "f1", fields: [], factKeys: keys });
    // Everything the graph holds ABOUT a fact stays home: the value, the evidence snippet and the
    // provenance. Only the key travels, and the server matches it against FACT_KEY.
    for (const fact of listFacts(graph)) {
      expect(wire).not.toContain(fact.value);
      expect(wire).not.toContain(fact.evidence ?? "no evidence in this fixture");
      expect(wire).not.toContain(fact.source.kind);
      expect(fact.key).toMatch(FACT_KEY_PATTERN);
    }
    expect(JSON.parse(wire)).toEqual({ origin: "https://example.com", formSignature: "f1", fields: [], factKeys: keys });
  });

  it("honours the caller's limit", () => {
    expect(factKeysForRequest(graph, 1)).toEqual(["links.twitter"]);
  });
});
