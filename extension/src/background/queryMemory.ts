// Local-only memory for search-like text fields. Query values never leave the extension worker.
// Memory is origin-scoped: a YouTube query can help on YouTube later, but never on another site.
import { MASKED_VALUE, isSensitive, normalize } from "@ghost/shared";
import type { NextCandidate, TraceEvent, TraceTarget } from "@ghost/shared";
import { kvStorage } from "./kvStorage";
import type { KvStorage } from "./kvStorage";

export const QUERY_MEMORY_KEY = "ghost.query-memory";
export const QUERY_MEMORY_MAX = 100;
export const QUERY_VALUE_MAX = 200;

const SEARCH = /\b(search|find|look ?up|query|filter|discover)\b/i;
const SECRET_SHAPE = /\b\d{3}-\d{2}-\d{4}\b|(?:\d[ -]?){13,19}/;

export interface QueryMemoryEntry {
  origin: string;
  label: string;
  value: string;
  count: number;
  updatedAt: number;
}

export interface QueryMemory {
  observe(event: TraceEvent): Promise<boolean>;
  suggest(origin: string, candidate: NextCandidate): Promise<string | null>;
  entries(): Promise<QueryMemoryEntry[]>;
  clear(): Promise<void>;
}

function searchText(target: Pick<TraceTarget, "label" | "signature"> | NextCandidate): string {
  return `${target.label} ${"signature" in target ? target.signature : target.id} ${"context" in target ? target.context ?? "" : ""}`;
}

export function isSearchTarget(target: Pick<TraceTarget, "label" | "signature"> | NextCandidate): boolean {
  const kind: string | undefined = "kind" in target ? target.kind : undefined;
  return (kind === undefined || kind === "text" || kind === "textarea" || kind === "field") && SEARCH.test(searchText(target));
}

function safeValue(raw: string | undefined): string | null {
  const value = raw?.trim().slice(0, QUERY_VALUE_MAX) ?? "";
  if (!value || value === MASKED_VALUE || SECRET_SHAPE.test(value) || isSensitive({ label: value })) return null;
  return value;
}

function revive(raw: unknown): QueryMemoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: QueryMemoryEntry[] = [];
  for (const item of raw.slice(-QUERY_MEMORY_MAX)) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Partial<QueryMemoryEntry>;
    const value = safeValue(entry.value);
    if (!value || typeof entry.origin !== "string" || !/^https?:\/\//.test(entry.origin) || typeof entry.label !== "string") continue;
    out.push({
      origin: entry.origin.toLowerCase(), label: normalize(entry.label).slice(0, 160), value,
      count: typeof entry.count === "number" && Number.isInteger(entry.count) ? Math.max(1, entry.count) : 1,
      updatedAt: typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
    });
  }
  return out;
}

export function createQueryMemory(deps: { storage?: KvStorage } = {}): QueryMemory {
  const storage = deps.storage ?? kvStorage("local");
  let loading: Promise<QueryMemoryEntry[]> | null = null;
  let writes: Promise<void> = Promise.resolve();
  const load = (): Promise<QueryMemoryEntry[]> => (loading ??= storage.get(QUERY_MEMORY_KEY).then(revive, () => []));
  const persist = (): Promise<void> => {
    const write = async (): Promise<void> => storage.set(QUERY_MEMORY_KEY, await load()).catch(() => undefined);
    writes = writes.then(write, write);
    return writes;
  };

  return {
    async observe(event) {
      const value = safeValue(event.value);
      if (event.type !== "input" || event.synthetic || !event.target || !isSearchTarget(event.target) || !value) return false;
      const entries = await load();
      const origin = event.origin.toLowerCase();
      const label = normalize(event.target.label).slice(0, 160);
      const existing = entries.findIndex((entry) => entry.origin === origin && entry.label === label && entry.value === value);
      const previous = existing >= 0 ? entries.splice(existing, 1)[0] : undefined;
      entries.push({ origin, label, value, count: Math.min(10_000, (previous?.count ?? 0) + 1), updatedAt: event.t });
      if (entries.length > QUERY_MEMORY_MAX) entries.splice(0, entries.length - QUERY_MEMORY_MAX);
      await persist();
      return true;
    },
    async suggest(origin, candidate) {
      if (candidate.kind !== "field" || !isSearchTarget(candidate)) return null;
      const here = (await load()).filter((entry) => entry.origin === origin.toLowerCase());
      const label = normalize(candidate.label);
      return ([...here].reverse().find((entry) => entry.label === label) ?? here.at(-1))?.value ?? null;
    },
    entries: async () => [...(await load())],
    async clear() {
      loading = Promise.resolve([]);
      const wipe = (): Promise<void> => storage.remove(QUERY_MEMORY_KEY).catch(() => undefined);
      writes = writes.then(wipe, wipe);
      await writes;
    },
  };
}
