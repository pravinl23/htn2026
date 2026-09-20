// Episodic memory (docs/loops.md section 2): (state summary, action) pairs in chrome.storage.local under
// "ghost.memory". A pair holds shape keys, a label and a signature. It never holds a typed value: the
// value of the observed event is not even read here.
import { EPISODIC_TOP_K, EpisodicStore, actionFromEvent, isSensitive, stateSummary } from "@ghost/shared";
import type { EpisodicPair, EpisodicSnapshot, TraceEvent } from "@ghost/shared";
import { kvStorage } from "./kvStorage";
import type { KvStorage } from "./kvStorage";

export const MEMORY_KEY = "ghost.memory";

export interface EpisodicMemory {
  /**
   * Remembers what the user did in the state described by the events BEFORE it. Synthetic events shape the
   * summary but are never remembered as the user's action. Resolves to false when nothing was stored.
   */
  observe(before: readonly TraceEvent[], event: TraceEvent): Promise<boolean>;
  /** The summary of "now" on this page plus the most similar pairs (exact matches first). */
  recall(events: readonly TraceEvent[], pathPattern: string, k?: number): Promise<{ summary: string; memory: EpisodicPair[] }>;
  retrieve(summary: string, k?: number): Promise<EpisodicPair[]>;
  /** Newest pairs across states. The caller must filter them to the current origin before using them. */
  recent(k?: number): Promise<EpisodicPair[]>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

function isSnapshot(raw: unknown): raw is EpisodicSnapshot {
  return typeof raw === "object" && raw !== null && Array.isArray((raw as { pairs?: unknown }).pairs);
}

function isPair(raw: unknown): raw is EpisodicPair {
  if (typeof raw !== "object" || raw === null) return false;
  const pair = raw as { summary?: unknown; count?: unknown; action?: { type?: unknown; targetShape?: unknown; label?: unknown } | null };
  const action = pair.action;
  return typeof pair.summary === "string" && typeof pair.count === "number" && Number.isFinite(pair.count)
    && typeof action === "object" && action !== null
    && typeof action.type === "string" && typeof action.targetShape === "string" && typeof action.label === "string";
}

/** Malformed pairs and pairs whose label reads as sensitive are dropped on the way in. */
function revive(raw: unknown): EpisodicStore {
  if (!isSnapshot(raw)) return new EpisodicStore();
  const pairs = raw.pairs.filter(isPair).filter((pair) => !isSensitive({ label: pair.action.label }));
  return EpisodicStore.fromJSON({ max: raw.max, pairs });
}

export function createEpisodicMemory(deps: { storage?: KvStorage } = {}): EpisodicMemory {
  const storage = deps.storage ?? kvStorage("local");
  let loading: Promise<EpisodicStore> | null = null;
  let writes: Promise<void> = Promise.resolve();

  function load(): Promise<EpisodicStore> {
    loading ??= storage.get(MEMORY_KEY).then(revive, () => new EpisodicStore());
    return loading;
  }

  function persist(): Promise<void> {
    const write = async (): Promise<void> => {
      await storage.set(MEMORY_KEY, (await load()).toJSON()).catch((error: unknown) => console.warn("[ghost] memory write failed", error));
    };
    writes = writes.then(write, write);
    return writes;
  }

  return {
    async observe(before, event) {
      const action = event.synthetic ? null : actionFromEvent(event);
      if (!action || isSensitive({ label: action.label })) return false;
      (await load()).add(stateSummary(before, event.pathPattern), action);
      await persist();
      return true;
    },

    async recall(events, pathPattern, k = EPISODIC_TOP_K) {
      const summary = stateSummary(events, pathPattern);
      return { summary, memory: (await load()).retrieve(summary, k) };
    },

    retrieve: async (summary, k = EPISODIC_TOP_K) => (await load()).retrieve(summary, k),

    recent: async (k = EPISODIC_TOP_K) => (await load()).recent(k),

    size: async () => (await load()).size,

    async clear() {
      loading = Promise.resolve(new EpisodicStore());
      const wipe = (): Promise<void> => storage.remove(MEMORY_KEY).catch(() => undefined);
      writes = writes.then(wipe, wipe);
      await writes;
    },
  };
}
