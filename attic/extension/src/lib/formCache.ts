// Per-site form mappings: once a form has been answered, a repeat visit makes zero server calls.
// Stores field signatures and fact KEYS only. Never a profile value, never anything the user typed.
import type { CapturedField } from "@ghost/shared";
import { cleanAssignments } from "./messages";
import type { ServedAssignment } from "./messages";

export const FORM_CACHE_KEY = "ghost.formCache";
export const MAX_CACHED_FORMS = 200;
const DAY_MS = 86_400_000;
/** A model's answer keeps; the heuristic's is retried daily so adding a key later still upgrades the site. */
const TTL_MS = { model: 30 * DAY_MS, heuristic: DAY_MS } as const;

export interface CachedForm {
  assignments: ServedAssignment[];
  provider: string;
  savedAt: number;
  /** Last read or write: what the LRU evicts by. */
  usedAt: number;
  /** Id of the fact key set the answer was computed for. Another set is another question. */
  facts: string;
}

type Store = Record<string, CachedForm>;

/** cyrb53: small, fast, stable across reloads. A collision only costs a cache miss or a redundant answer. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Identifies a form by its ordered field signatures and kinds. Values and geometry never reach it. */
export function formSignature(fields: CapturedField[]): string {
  return `form-${fields.length}-${hash(fields.map((f) => `${f.signature}#${f.kind}`).join("\n"))}`;
}

/** Order does not matter, the set does: a new or removed fact may change every answer. */
export function factKeysId(factKeys: string[]): string {
  return hash([...new Set(factKeys)].sort().join("\n"));
}

function entryKey(origin: string, signature: string): string {
  return `${origin} ${signature}`;
}

const memory = new Map<string, unknown>();

function hasChromeStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

async function load(): Promise<Store> {
  const raw: unknown = hasChromeStorage() ? (await chrome.storage.local.get(FORM_CACHE_KEY))[FORM_CACHE_KEY] : memory.get(FORM_CACHE_KEY);
  const store: Store = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return store;
  for (const [key, value] of Object.entries(raw)) {
    const entry = cleanEntry(value);
    if (entry) store[key] = entry;
  }
  return store;
}

async function save(store: Store): Promise<void> {
  if (hasChromeStorage()) await chrome.storage.local.set({ [FORM_CACHE_KEY]: store });
  else memory.set(FORM_CACHE_KEY, JSON.parse(JSON.stringify(store)));
}

/** Storage is shared with every version of the extension that ever wrote to it: trust nothing in it. */
function cleanEntry(raw: unknown): CachedForm | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const { provider, savedAt, usedAt, facts } = entry;
  if (typeof provider !== "string" || typeof facts !== "string" || typeof savedAt !== "number") return null;
  const assignments = cleanAssignments(entry.assignments);
  if (assignments.length === 0) return null;
  return { assignments, provider, facts, savedAt, usedAt: typeof usedAt === "number" ? usedAt : savedAt };
}

function isFresh(entry: CachedForm, now: number): boolean {
  const ttl = entry.provider === "heuristic" ? TTL_MS.heuristic : TTL_MS.model;
  return now - entry.savedAt < ttl;
}

function evict(store: Store): void {
  const keys = Object.keys(store);
  if (keys.length <= MAX_CACHED_FORMS) return;
  keys.sort((a, b) => (store[a]?.usedAt ?? 0) - (store[b]?.usedAt ?? 0));
  for (const key of keys.slice(0, keys.length - MAX_CACHED_FORMS)) delete store[key];
}

let writes: Promise<void> = Promise.resolve();

/** Read-modify-write on one key, so changes run one at a time (frames of other tabs can still race: that costs a miss). */
function update(change: (store: Store) => void): Promise<void> {
  const run = async (): Promise<void> => {
    const store = await load();
    change(store);
    evict(store);
    await save(store);
  };
  writes = writes.then(run, run);
  return writes;
}

/** The remembered answer for this form, or null. A hit for another fact key set, or a stale one, is dropped. */
export async function readCachedForm(origin: string, signature: string, factKeys: string[], now = Date.now()): Promise<CachedForm | null> {
  const key = entryKey(origin, signature);
  const entry = (await load())[key];
  if (!entry) return null;
  const usable = entry.facts === factKeysId(factKeys) && isFresh(entry, now);
  void update((store) => {
    const live = store[key];
    if (live && usable) live.usedAt = now;
    else delete store[key];
  }).catch(() => undefined);
  return usable ? entry : null;
}

export function saveCachedForm(
  origin: string,
  signature: string,
  factKeys: string[],
  answer: { assignments: ServedAssignment[]; provider: string },
  now = Date.now(),
): Promise<void> {
  const assignments = cleanAssignments(answer.assignments);
  if (assignments.length === 0) return Promise.resolve();
  const entry: CachedForm = { assignments, provider: answer.provider, savedAt: now, usedAt: now, facts: factKeysId(factKeys) };
  return update((store) => void (store[entryKey(origin, signature)] = entry));
}

export function clearFormCache(): Promise<void> {
  return update((store) => {
    for (const key of Object.keys(store)) delete store[key];
  });
}

/** Resolves once every queued write (a read's LRU touch included) has landed. */
export function whenFormCacheIdle(): Promise<void> {
  return writes.catch(() => undefined);
}

/** Test seam: wipes the in-memory fallback. Has no effect on chrome.storage. */
export async function resetFormCacheMemory(): Promise<void> {
  await whenFormCacheIdle();
  memory.clear();
}
