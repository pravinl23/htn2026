/**
 * Tiny typed localStorage helpers for the invoices/sheet demo pages.
 * Every key starts with "ghostdemo." and every write is announced twice: the browser's own "storage" event
 * reaches other tabs and iframes, and CHANGE_EVENT reaches listeners in the same document (which "storage" skips).
 */
export const DEMO_PREFIX = "ghostdemo.";
export const CHANGE_EVENT = "ghostdemo:change";

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory Storage stand-in for unit tests (no DOM needed). */
export class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Where to read/write and where to announce changes. Injected in tests, the browser's own otherwise. */
export interface StorageEnv {
  storage: StorageLike | null;
  events: EventTarget | null;
}

export function browserEnv(): StorageEnv {
  if (typeof window === "undefined") return { storage: null, events: null };
  try {
    return { storage: window.localStorage, events: window };
  } catch {
    return { storage: null, events: window }; // storage blocked (sandboxed iframe, strict privacy mode)
  }
}

export function readRaw(key: string, env: StorageEnv = browserEnv()): string | null {
  try {
    return env.storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Parses the stored JSON. Missing, malformed, or wrongly shaped values all come back as `fallback`. */
export function parseJson<T>(raw: string | null, fallback: T, guard?: (value: unknown) => value is T): T {
  if (raw === null) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (guard) return guard(value) ? value : fallback;
    return value as T;
  } catch {
    return fallback;
  }
}

export function readJson<T>(key: string, fallback: T, guard?: (value: unknown) => value is T, env: StorageEnv = browserEnv()): T {
  return parseJson(readRaw(key, env), fallback, guard);
}

function announce(key: string | null, env: StorageEnv): void {
  env.events?.dispatchEvent(new CustomEvent<{ key: string | null }>(CHANGE_EVENT, { detail: { key } }));
}

/** Returns false when the value could not be stored (quota, blocked storage). */
export function writeJson(key: string, value: unknown, env: StorageEnv = browserEnv()): boolean {
  try {
    if (!env.storage) return false;
    env.storage.setItem(key, JSON.stringify(value));
  } catch {
    return false;
  }
  announce(key, env);
  return true;
}

export function removeKey(key: string, env: StorageEnv = browserEnv()): void {
  try {
    env.storage?.removeItem(key);
  } catch {
    return;
  }
  announce(key, env);
}

export function keysWithPrefix(prefix: string = DEMO_PREFIX, env: StorageEnv = browserEnv()): string[] {
  const found: string[] = [];
  try {
    const storage = env.storage;
    if (!storage) return found;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(prefix)) found.push(key);
    }
  } catch {
    return found;
  }
  return found.sort();
}

/** Removes every key with the prefix and returns the removed key names. */
export function clearPrefix(prefix: string = DEMO_PREFIX, env: StorageEnv = browserEnv()): string[] {
  const keys = keysWithPrefix(prefix, env);
  for (const key of keys) removeKey(key, env);
  return keys;
}

function changedKey(event: Event): string | null {
  if (event.type === CHANGE_EVENT) return (event as CustomEvent<{ key: string | null }>).detail?.key ?? null;
  return (event as StorageEvent).key ?? null; // null means storage.clear()
}

/**
 * Calls `onChange` when one of `keys` changes in this document, another tab, or an iframe.
 * Pass null to hear about every key. A whole-storage clear (key null) always notifies.
 */
export function subscribe(
  keys: string | readonly string[] | null,
  onChange: (key: string | null) => void,
  env: StorageEnv = browserEnv(),
): () => void {
  const target = env.events;
  if (!target) return () => {};
  const wanted = keys === null ? null : new Set(typeof keys === "string" ? [keys] : keys);
  const listener = (event: Event) => {
    const key = changedKey(event);
    if (key === null || wanted === null || wanted.has(key)) onChange(key);
  };
  target.addEventListener("storage", listener);
  target.addEventListener(CHANGE_EVENT, listener);
  return () => {
    target.removeEventListener("storage", listener);
    target.removeEventListener(CHANGE_EVENT, listener);
  };
}
