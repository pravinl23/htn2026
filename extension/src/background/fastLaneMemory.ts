// The Fast Lane memory boundary. Runtime prediction depends on this contract, not on chrome.storage or Sentry.
// The local adapter composes Ghost's existing behavioral graph (state -> action edges) with private query values.
// A later Sentry-backed adapter can mirror the value-free records and hydrate the same contract without changing
// nextAction, nextClient, or the trace router. Raw input values are deliberately absent from MemoryRecord.
import type { EpisodicPair, NextCandidate, TraceEvent } from "@ghost/shared";
import { createEpisodicMemory } from "./episodic";
import type { EpisodicMemory } from "./episodic";
import type { KvStorage } from "./kvStorage";
import { createQueryMemory } from "./queryMemory";
import type { QueryMemory } from "./queryMemory";

export const FAST_LANE_MEMORY_SCHEMA = "ghost.fast-lane-memory.v1";

export interface FastLaneSuggestion {
  tabId: number;
  origin: string;
  pathPattern: string;
  state: string;
  candidate: NextCandidate;
  confidence: number;
  provider: string;
}

/** Safe to mirror to Sentry: no origin, URL, label, signature, context, or typed value. */
export type FastLaneMemoryRecord =
  | { schema: typeof FAST_LANE_MEMORY_SCHEMA; kind: "action.observed"; action: TraceEvent["type"]; targetKind?: string; locked: boolean }
  | { schema: typeof FAST_LANE_MEMORY_SCHEMA; kind: "suggestion.proposed"; candidateKind: NextCandidate["kind"]; locked: boolean; confidenceBucket: number; provider: string };

export interface FastLaneMemorySink {
  record(event: FastLaneMemoryRecord): Promise<void> | void;
}

/**
 * One contract for the complete latency-sensitive memory path. The first five methods expose the persisted
 * state->action graph; suggestInput is the private local value layer; noteSuggestion is the value-free telemetry
 * seam a Sentry adapter can implement later. Reads must be local/fast: remote telemetry never sits on the Tab path.
 */
export interface FastLaneMemory {
  observe(before: readonly TraceEvent[], event: TraceEvent): Promise<boolean>;
  recall(events: readonly TraceEvent[], pathPattern: string, k?: number): Promise<{ summary: string; memory: EpisodicPair[] }>;
  retrieve(summary: string, k?: number): Promise<EpisodicPair[]>;
  recent(k?: number): Promise<EpisodicPair[]>;
  size(): Promise<number>;
  suggestInput(origin: string, candidate: NextCandidate): Promise<string | null>;
  noteSuggestion(suggestion: FastLaneSuggestion): Promise<void>;
  clear(): Promise<void>;
}

export interface LocalFastLaneMemoryDeps {
  /** Persistent storage for state->action edges. */
  graphStorage?: KvStorage;
  /** Persistent, local-only storage for input values. */
  valueStorage?: KvStorage;
  /** Optional value-free mirror; a Sentry implementation belongs here. */
  sink?: FastLaneMemorySink;
  actions?: EpisodicMemory;
  queries?: QueryMemory;
}

function confidenceBucket(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(10, Math.floor(confidence * 10)));
}

function emit(sink: FastLaneMemorySink | undefined, event: FastLaneMemoryRecord): void {
  if (!sink) return;
  Promise.resolve(sink.record(event)).catch(() => undefined); // telemetry can never delay or break a ghost
}

export function createLocalFastLaneMemory(deps: LocalFastLaneMemoryDeps = {}): FastLaneMemory {
  const actions = deps.actions ?? createEpisodicMemory({ ...(deps.graphStorage ? { storage: deps.graphStorage } : {}) });
  const queries = deps.queries ?? createQueryMemory({ ...(deps.valueStorage ? { storage: deps.valueStorage } : {}) });

  return {
    async observe(before, event) {
      const [remembered] = await Promise.all([actions.observe(before, event), queries.observe(event)]);
      if (!event.synthetic) {
        emit(deps.sink, {
          schema: FAST_LANE_MEMORY_SCHEMA,
          kind: "action.observed",
          action: event.type,
          ...(event.target ? { targetKind: event.target.kind } : {}),
          locked: event.target?.locked === true,
        });
      }
      return remembered;
    },
    recall: (events, pathPattern, k) => actions.recall(events, pathPattern, k),
    retrieve: (summary, k) => actions.retrieve(summary, k),
    recent: (k) => actions.recent(k),
    size: () => actions.size(),
    suggestInput: (origin, candidate) => queries.suggest(origin, candidate),
    async noteSuggestion(suggestion) {
      emit(deps.sink, {
        schema: FAST_LANE_MEMORY_SCHEMA,
        kind: "suggestion.proposed",
        candidateKind: suggestion.candidate.kind,
        locked: suggestion.candidate.locked,
        confidenceBucket: confidenceBucket(suggestion.confidence),
        provider: suggestion.provider.slice(0, 40),
      });
    },
    async clear() {
      await Promise.all([actions.clear(), queries.clear()]);
    },
  };
}
