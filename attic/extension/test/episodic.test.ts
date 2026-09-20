import { afterEach, describe, expect, it, vi } from "vitest";
import { EPISODIC_MAX_PAIRS, predictFromMemory, stateSummary } from "@ghost/shared";
import type { NextCandidate, TraceEvent } from "@ghost/shared";
import { REPLY_LABEL, TraceBuilder, invoiceSession } from "../../shared/test/helpers/traceBuilder";
import { MEMORY_KEY, createEpisodicMemory } from "../src/background/episodic";
import type { EpisodicMemory } from "../src/background/episodic";
import { createMemoryKv, kvStorage, resetMemoryKv } from "../src/background/kvStorage";

/** Feeds a whole session the way the router does: each event with the events before it. */
async function observeAll(memory: EpisodicMemory, events: TraceEvent[]): Promise<void> {
  for (const [i, event] of events.entries()) await memory.observe(events.slice(Math.max(0, i - 12), i), event);
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetMemoryKv();
});

describe("episodic memory", () => {
  it("stores (state summary, action) pairs under ghost.memory and never a typed value", async () => {
    const storage = createMemoryKv();
    const memory = createEpisodicMemory({ storage });
    const events = invoiceSession(2).events();
    await observeAll(memory, events);

    const stored = JSON.stringify(await storage.get(MEMORY_KEY));
    expect(stored).toContain(REPLY_LABEL);
    for (const typed of ["Northwind Traders", "1204.50", "2026-09-03", "Globex Corporation"]) expect(stored).not.toContain(typed);
    expect(await memory.size()).toBeGreaterThan(0);
  });

  it("predicts the next action from a state it has seen", async () => {
    const memory = createEpisodicMemory({ storage: createMemoryKv() });
    const events = invoiceSession(2).events();
    await observeAll(memory, events);

    // Third invoice, the sheet is filled and the user is back on the invoice page: what came next, twice, was the reply button.
    const third = invoiceSession(3).events().slice(0, -1);
    const { summary, memory: recalled } = await memory.recall(third, "/invoices/:id");
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled.length).toBeLessThanOrEqual(5);
    expect(recalled[0]).toMatchObject({ summary, count: 2, action: { type: "click", label: REPLY_LABEL, locked: true } });
    const candidates: NextCandidate[] = [
      { id: "button:Back to inbox", kind: "link", label: "Back to inbox", locked: false },
      { id: `button:${REPLY_LABEL}`, kind: "button", label: REPLY_LABEL, locked: true },
    ];
    expect(predictFromMemory(summary, candidates, recalled)).toEqual({ candidateId: `button:${REPLY_LABEL}`, confidence: 0.9 });
  });

  it("uses Ghost's own actions for the summary but never remembers them as the user's", async () => {
    const memory = createEpisodicMemory({ storage: createMemoryKv() });
    const events = new TraceBuilder().navigate("/mail").synthetic().click("Open calendar").click("Thursday 2:30 PM").events();
    const [nav, ghostClick, userClick] = events;
    if (!nav || !ghostClick || !userClick) throw new Error("fixture");
    expect(await memory.observe([nav], ghostClick)).toBe(false);
    expect(await memory.observe([nav, ghostClick], userClick)).toBe(true);
    expect(await memory.size()).toBe(1);
    const [pair] = await memory.retrieve(stateSummary([nav, ghostClick], "/mail"));
    expect(pair?.summary).toContain("Open calendar");
    expect(pair?.action.label).toBe("Thursday 2:30 PM");
  });

  it("skips events without a target and targets that read as sensitive", async () => {
    const memory = createEpisodicMemory({ storage: createMemoryKv() });
    const [nav, secret] = new TraceBuilder().navigate("/account").input("Security answer", "Rex").events();
    if (!nav || !secret) throw new Error("fixture");
    expect(await memory.observe([], nav)).toBe(false);
    expect(await memory.observe([nav], secret)).toBe(false);
    expect(await memory.size()).toBe(0);
  });

  it("survives a worker restart and drops what does not read back cleanly", async () => {
    const storage = createMemoryKv();
    await observeAll(createEpisodicMemory({ storage }), invoiceSession(2).events());
    const size = await createEpisodicMemory({ storage }).size();
    expect(size).toBeGreaterThan(0);

    const snapshot = (await storage.get(MEMORY_KEY)) as { max: number; pairs: unknown[] };
    const sensitive = { summary: "/x", count: 1, action: { type: "input", targetShape: "Password#text", label: "Password" } };
    await storage.set(MEMORY_KEY, { ...snapshot, pairs: [...snapshot.pairs, sensitive, { summary: 3 }, null] });
    expect(await createEpisodicMemory({ storage }).size()).toBe(size);

    await storage.set(MEMORY_KEY, "corrupt");
    expect(await createEpisodicMemory({ storage }).size()).toBe(0);
  });

  it("is capped by the store", async () => {
    const storage = createMemoryKv();
    const memory = createEpisodicMemory({ storage });
    const tb = new TraceBuilder();
    for (let i = 0; i < EPISODIC_MAX_PAIRS + 20; i++) tb.click(`Button ${i}`);
    await observeAll(memory, tb.events());
    expect(await memory.size()).toBe(EPISODIC_MAX_PAIRS);
    expect(((await storage.get(MEMORY_KEY)) as { pairs: unknown[] }).pairs).toHaveLength(EPISODIC_MAX_PAIRS);
  });

  it("clear forgets everything", async () => {
    const storage = createMemoryKv();
    const memory = createEpisodicMemory({ storage });
    await observeAll(memory, invoiceSession(1).events());
    await memory.clear();
    expect(await memory.size()).toBe(0);
    expect(await storage.get(MEMORY_KEY)).toBeUndefined();
  });

  it("lives in chrome.storage.local, or in memory without chrome", async () => {
    const local = new Map<string, unknown>();
    vi.stubGlobal("chrome", { storage: { local: {
      get: async (key: string) => (local.has(key) ? { [key]: local.get(key) } : {}),
      set: async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => local.set(k, v)),
      remove: async (key: string) => void local.delete(key),
    } } });
    await observeAll(createEpisodicMemory(), invoiceSession(1).events());
    expect(local.has(MEMORY_KEY)).toBe(true);

    vi.unstubAllGlobals();
    expect(await createEpisodicMemory().size()).toBe(0);
    await observeAll(createEpisodicMemory(), invoiceSession(1).events());
    expect(await kvStorage("local").get(MEMORY_KEY)).toBeDefined();
  });
});
