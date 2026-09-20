import { describe, expect, it } from "vitest";
import type { NextCandidate, TraceEvent, TraceTarget } from "@ghost/shared";
import { createMemoryKv } from "../src/background/kvStorage";
import { createQueryMemory } from "../src/background/queryMemory";

const ORIGIN = "https://www.youtube.com";
const search: TraceTarget = { signature: "input|search|search_query", label: "Search", kind: "text", locked: false };
const candidate: NextCandidate = { id: search.signature, label: "Search videos", kind: "field", locked: false };

function event(value: string, over: Partial<TraceEvent> = {}): TraceEvent {
  return { t: 100, tabId: 1, type: "input", origin: ORIGIN, pathPattern: "/", url: `${ORIGIN}/`, target: search, value, ...over };
}

describe("same-origin search memory", () => {
  it("remembers the user's latest search across instances and keeps it origin-scoped", async () => {
    const storage = createMemoryKv();
    const first = createQueryMemory({ storage });
    expect(await first.observe(event("lofi coding mix"))).toBe(true);
    expect(await first.observe(event("javascript conference talks", { t: 200 }))).toBe(true);
    const restored = createQueryMemory({ storage });
    expect(await restored.suggest(ORIGIN, candidate)).toBe("javascript conference talks");
    expect(await restored.suggest("https://www.amazon.ca", { ...candidate, label: "Search products" })).toBeNull();
  });

  it("ignores synthetic, non-search, masked and secret-shaped input values", async () => {
    const memory = createQueryMemory({ storage: createMemoryKv() });
    expect(await memory.observe(event("ghost wrote this", { synthetic: true }))).toBe(false);
    expect(await memory.observe(event("•••"))).toBe(false);
    expect(await memory.observe(event("4111 1111 1111 1111"))).toBe(false);
    expect(await memory.observe(event("hello", { target: { ...search, label: "Reply", signature: "textarea|reply" } }))).toBe(false);
    expect(await memory.entries()).toEqual([]);
  });
});
