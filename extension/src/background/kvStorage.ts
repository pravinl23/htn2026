// A key/value seam over chrome.storage.session and chrome.storage.local for the background worker's own state
// (trace, loop run, episodic memory). Falls back to memory when chrome.* is absent, and tests inject their own.

export interface KvStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export type KvArea = "session" | "local";

interface ChromeArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

const fallback: Record<KvArea, Map<string, unknown>> = { session: new Map(), local: new Map() };

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function chromeArea(area: KvArea): ChromeArea | null {
  if (typeof chrome === "undefined" || !chrome.storage) return null;
  return (chrome.storage[area] as ChromeArea | undefined) ?? null;
}

/** A Map-backed store that copies on the way in and out, like chrome.storage does. */
export function createMemoryKv(map: Map<string, unknown> = new Map()): KvStorage {
  return {
    get: async (key) => clone(map.get(key)),
    set: async (key, value) => void map.set(key, clone(value)),
    remove: async (key) => void map.delete(key),
  };
}

/** The chrome area is resolved on every call, so a test can install or remove a chrome mock at any time. */
export function kvStorage(area: KvArea): KvStorage {
  const memory = createMemoryKv(fallback[area]);
  return {
    get: async (key) => {
      const real = chromeArea(area);
      return real ? (await real.get(key))[key] : memory.get(key);
    },
    set: (key, value) => chromeArea(area)?.set({ [key]: value }) ?? memory.set(key, value),
    remove: (key) => chromeArea(area)?.remove(key) ?? memory.remove(key),
  };
}

/** Test seam: wipes the in-memory fallback. Has no effect on chrome.storage. */
export function resetMemoryKv(): void {
  fallback.session.clear();
  fallback.local.clear();
}
