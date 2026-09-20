// Raw chrome.storage.local access for keys this page does not own the schema of ("ghost.metrics" is
// written by the content script and background worker). Falls back to memory when chrome.* is absent.
type Listener = (value: unknown) => void;

const memory = new Map<string, unknown>();
const memoryListeners = new Map<string, Set<Listener>>();

function hasChrome(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

export async function readLocal(key: string): Promise<unknown> {
  if (!hasChrome()) return memory.get(key);
  return (await chrome.storage.local.get(key))[key];
}

export async function writeLocal(key: string, value: unknown): Promise<void> {
  if (hasChrome()) return chrome.storage.local.set({ [key]: value });
  memory.set(key, value);
  for (const listener of [...(memoryListeners.get(key) ?? [])]) listener(value);
}

export function watchLocal(key: string, listener: Listener): () => void {
  if (!hasChrome()) return watchMemory(key, listener);
  const wrapped = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    const change = changes[key];
    if (area === "local" && change) listener(change.newValue);
  };
  chrome.storage.onChanged.addListener(wrapped);
  return () => chrome.storage.onChanged.removeListener(wrapped);
}

function watchMemory(key: string, listener: Listener): () => void {
  const listeners = memoryListeners.get(key) ?? new Set<Listener>();
  memoryListeners.set(key, listeners);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: wipes the in-memory fallback. */
export function resetLocalMemory(): void {
  memory.clear();
  memoryListeners.clear();
}
