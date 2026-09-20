// The fact graph in chrome.storage.local: migration from the old flat profile, the mirror that keeps every
// existing reader working, and the promise that nothing sensitive is ever written by anything but the user.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_PROFILE, isRejected, listFacts, proposalId, pruneRejected, removeFact, setUserFact } from "@ghost/shared";
import type { Profile } from "@ghost/shared";
import {
  FACTS_KEY, PROFILE_KEY, getFactGraph, getProfile, normalizeGraph, onStorageChanged, resetMemoryStorage, saveFactGraph,
  saveProfile, updateFactGraph,
} from "../src/lib/storage";
import { createChromeStorageMock } from "./chrome-mock";

/** A profile stored by a Ghost from before the graph existed. */
const OLD_PROFILE: Profile = {
  facts: { firstName: "Alex", lastName: "Chen", email: "alex.chen.dev@example.com", "address.home.postalCode": "N2L 3G1" },
  pastAnswers: [{ question: "Why?", answer: "Robots." }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetMemoryStorage();
});

describe("normalizeGraph", () => {
  it("returns null for anything that is not a stored graph, so migration can run", () => {
    for (const junk of [null, undefined, 3, "graph", [], {}, { version: 1 }]) expect(normalizeGraph(junk)).toBeNull();
  });

  it("revives a stored graph and drops a fact a scan should never have stored", () => {
    const graph = normalizeGraph({
      version: 1,
      facts: [
        { key: "city", value: "Waterloo", source: { kind: "user" }, label: "city", category: "address", updatedAt: "2026-01-01T00:00:00.000Z", verifiedByUser: true },
        { key: "sin", value: "046 454 286", source: { kind: "github", login: "x" }, label: "social insurance number", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      rejected: ["deadbeef"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Object.keys(graph?.facts ?? {})).toEqual(["city"]);
    // A version 1 file holds bare hashes with no day on them. Reviving stamps each one with the file's own
    // day (shared/src/facts/graph.ts) so it can expire after REJECTED_TTL_DAYS instead of living forever.
    expect(graph?.rejected).toEqual(["deadbeef@2026-01-01"]);
  });

  it("keeps a revived rejection doing its job: still blocks its proposal, and now expires", () => {
    const id = proposalId("city", "Kitchener");
    const graph = normalizeGraph({
      version: 1,
      facts: [{ key: "city", value: "Waterloo", source: { kind: "user" }, label: "city", category: "address", updatedAt: "2026-01-01T00:00:00.000Z", verifiedByUser: true }],
      rejected: [id],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    if (!graph) throw new Error("the graph should have been revived");
    expect(graph.rejected).toEqual([`${id}@2026-01-01`]);
    // The hash still recognizes the proposal the user turned down: the stamp is a day, not a new id.
    expect(isRejected(graph, "city", "Kitchener")).toBe(true);
    expect(isRejected(graph, "city", "Waterloo")).toBe(false);
    // And the day it was stamped with is what the TTL counts from.
    expect(pruneRejected(graph, "2026-03-01T00:00:00.000Z").graph.rejected).toEqual([`${id}@2026-01-01`]);
    const expired = pruneRejected(graph, "2026-06-01T00:00:00.000Z");
    expect(expired.dropped).toBe(1);
    expect(expired.graph.rejected).toEqual([]);
  });
});

describe("migration from a stored profile", () => {
  it("builds the graph from the old flat profile on first read, and keeps the keys", async () => {
    const mock = createChromeStorageMock();
    vi.stubGlobal("chrome", mock.chrome);
    mock.store.set(PROFILE_KEY, OLD_PROFILE);

    const graph = await getFactGraph();
    expect(listFacts(graph).map((f) => f.key)).toEqual(["address.home.postalCode", "email", "firstName", "lastName"]);
    // What the flat profile never had: a category, a human label and the phrasings a form uses.
    expect(graph.facts["address.home.postalCode"]).toMatchObject({ category: "address", label: "postal code", verifiedByUser: true });
    expect(graph.facts["address.home.postalCode"]?.aliases).toContain("zip code");
    expect(graph.facts.email?.category).toBe("contact");
    // It is stored, so the next read is not a migration.
    expect(normalizeGraph(mock.store.get(FACTS_KEY))?.facts.email?.value).toBe("alex.chen.dev@example.com");
    const again = await getFactGraph();
    expect(listFacts(again).map((f) => f.key)).toEqual(listFacts(graph).map((f) => f.key));
  });

  it("migrates the seeded demo profile when there is nothing stored at all", async () => {
    const graph = await getFactGraph();
    expect(listFacts(graph)).toHaveLength(Object.keys(DEMO_PROFILE.facts).length);
    expect(graph.facts.firstName?.value).toBe("Alex");
    expect(graph.facts["workAuthorization.CA"]).toMatchObject({ category: "work", value: "yes" });
  });

  it("leaves an existing graph alone", async () => {
    const mock = createChromeStorageMock();
    vi.stubGlobal("chrome", mock.chrome);
    mock.store.set(PROFILE_KEY, OLD_PROFILE);
    mock.store.set(FACTS_KEY, setUserFact(await getFactGraph(), "travel.homeAirport", "YYZ").graph);
    expect((await getFactGraph()).facts["travel.homeAirport"]?.value).toBe("YYZ");
  });
});

describe("the graph and the flat profile stay two views of the same facts", () => {
  it("mirrors a graph write into ghost.profile, so the content script sees a new fact at once", async () => {
    const graph = await getFactGraph();
    await saveFactGraph(setUserFact(graph, "address.home.street", "88 Rideau Street").graph);
    expect((await getProfile()).facts["address.home.street"]).toBe("88 Rideau Street");
    expect((await getProfile()).pastAnswers).toEqual(DEMO_PROFILE.pastAnswers);
  });

  it("never mirrors a sensitive fact the user typed", async () => {
    await updateFactGraph((graph) => setUserFact(graph, "health.cardNumber", "1234 567 890 XY").graph);
    const stored = await getFactGraph();
    expect(stored.facts["health.cardNumber"]?.sensitive).toBe(true);
    expect((await getProfile()).facts["health.cardNumber"]).toBeUndefined();
  });

  it("writes a profile edit back into the graph as the user's own word", async () => {
    await saveProfile({ facts: { ...DEMO_PROFILE.facts, city: "Toronto" }, pastAnswers: [] });
    const graph = await getFactGraph();
    expect(graph.facts.city).toMatchObject({ value: "Toronto", verifiedByUser: true });
    expect(graph.facts.city?.source).toEqual({ kind: "user" });
  });

  it("deletes a fact from the graph when the profile editor drops it", async () => {
    const { website: _dropped, ...facts } = DEMO_PROFILE.facts;
    await saveProfile({ facts, pastAnswers: [] });
    expect((await getFactGraph()).facts.website).toBeUndefined();
  });

  it("keeps a sensitive fact the user typed when the profile is saved without it", async () => {
    await updateFactGraph((graph) => setUserFact(graph, "health.cardNumber", "1234 567 890 XY").graph);
    await saveProfile(DEMO_PROFILE);
    expect((await getFactGraph()).facts["health.cardNumber"]?.value).toBe("1234 567 890 XY");
  });

  it("reports a graph change to subscribers", async () => {
    await getFactGraph();
    const cb = vi.fn();
    const off = onStorageChanged(cb);
    await updateFactGraph((graph) => removeFact(graph, "website"));
    const changes = cb.mock.calls.map(([change]) => change as { facts?: unknown; profile?: unknown });
    expect(changes.some((c) => c.facts !== undefined)).toBe(true);
    expect(changes.some((c) => c.profile !== undefined)).toBe(true);
    off();
  });
});
