import { describe, expect, it, vi } from "vitest";
import type { NextCandidate, TraceEvent } from "@ghost/shared";
import { FAST_LANE_MEMORY_SCHEMA, createLocalFastLaneMemory } from "../src/background/fastLaneMemory";
import { createMemoryKv } from "../src/background/kvStorage";

const SEARCH: NextCandidate = { id: "input|search|q|q|search videos|0", kind: "field", label: "Search videos", locked: false };

function input(value: string): TraceEvent {
  return {
    t: 100, tabId: 1, type: "input", origin: "https://video.example", url: "https://video.example/",
    pathPattern: "/", target: { signature: SEARCH.id, label: SEARCH.label, kind: "text", locked: false }, value,
  };
}

describe("local Fast Lane memory adapter", () => {
  it("persists the existing state-action graph and private query values behind one contract", async () => {
    const graphStorage = createMemoryKv();
    const valueStorage = createMemoryKv();
    const first = createLocalFastLaneMemory({ graphStorage, valueStorage });
    expect(await first.observe([], input("lofi coding mix"))).toBe(true);

    const restored = createLocalFastLaneMemory({ graphStorage, valueStorage });
    expect(await restored.size()).toBe(1);
    expect(await restored.suggestInput("https://video.example", SEARCH)).toBe("lofi coding mix");
  });

  it("mirrors only value-free records to the future Sentry seam", async () => {
    const records: unknown[] = [];
    const sink = { record: vi.fn(async (event: unknown) => void records.push(event)) };
    const memory = createLocalFastLaneMemory({ graphStorage: createMemoryKv(), valueStorage: createMemoryKv(), sink });
    await memory.observe([], input("private search words"));
    await memory.noteSuggestion({
      tabId: 1, origin: "https://video.example", pathPattern: "/watch/:id", state: "private state",
      candidate: SEARCH, confidence: 0.82, provider: "memory",
    });
    await Promise.resolve();

    expect(records).toEqual([
      { schema: FAST_LANE_MEMORY_SCHEMA, kind: "action.observed", action: "input", targetKind: "text", locked: false },
      { schema: FAST_LANE_MEMORY_SCHEMA, kind: "suggestion.proposed", candidateKind: "field", locked: false, confidenceBucket: 8, provider: "memory" },
    ]);
    const wire = JSON.stringify(records);
    for (const privateText of ["private search words", "video.example", "Search videos", "private state", SEARCH.id]) {
      expect(wire).not.toContain(privateText);
    }
  });
});
