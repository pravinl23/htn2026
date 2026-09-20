import { vi } from "vitest";

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type ChangeListener = (changes: Changes, area: string) => void;

export interface ChromeStorageMock {
  store: Map<string, unknown>;
  listeners: Set<ChangeListener>;
  emit(changes: Changes, area: string): void;
  chrome: { storage: { local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }; onChanged: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> } } };
}

/** Minimal chrome.storage fake: promise-based get/set plus onChanged events for the "local" area. */
export function createChromeStorageMock(): ChromeStorageMock {
  const store = new Map<string, unknown>();
  const listeners = new Set<ChangeListener>();
  const emit = (changes: Changes, area: string): void => {
    for (const listener of [...listeners]) listener(changes, area);
  };
  const get = vi.fn(async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}));
  const set = vi.fn(async (items: Record<string, unknown>) => {
    const changes: Changes = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: store.get(key), newValue: value };
      store.set(key, value);
    }
    emit(changes, "local");
  });
  const onChanged = {
    addListener: vi.fn((listener: ChangeListener) => void listeners.add(listener)),
    removeListener: vi.fn((listener: ChangeListener) => void listeners.delete(listener)),
  };
  return { store, listeners, emit, chrome: { storage: { local: { get, set }, onChanged } } };
}
