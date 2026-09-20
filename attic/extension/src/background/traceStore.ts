// The action trace (docs/loops.md section 1): a ring buffer of the user's recent actions plus the latest page
// facts per url. Owned by the background worker and kept in chrome.storage.session, so it survives the worker
// going to sleep and is gone when the browser restarts. Nothing in here ever comes from a sensitive field:
// the sanitizers drop such events whole, and a masked value stays masked.
import { MASKED_VALUE, normalizeUrl } from "@ghost/shared";
import type { FactsByUrl, PageFact, TraceEvent } from "@ghost/shared";
import { LIST_HANDLED_LABEL, LIST_LENGTH_LABEL, sanitizePageFacts, sanitizeTraceEvent } from "../lib/loopMessages";
import { kvStorage } from "./kvStorage";
import type { KvStorage } from "./kvStorage";

export const TRACE_EVENTS_KEY = "ghost.trace.events";
export const TRACE_FACTS_KEY = "ghost.trace.facts";
export const TRACE_MAX_EVENTS = 400;
export const TRACE_MAX_URLS = 60;

/**
 * How a content script reports the length of a repeated list: inside its "ghost:page-facts" report, as one fact
 * `{ locator: { by: "css", value: <listSignature> }, label: LIST_LENGTH_LABEL, text: "<item count>" }`, optionally
 * with a LIST_HANDLED_LABEL fact ("0,1,7": items that already show a handled marker). Both labels live in
 * lib/loopMessages.ts. The list page is always visited before its items are, so the total is known by the time a
 * loop is detected (a round trip to the tab would fail then: that tab usually shows an item page). These facts are
 * kept apart from the ordinary ones and never reach the generalizer or the server.
 */
export { LIST_HANDLED_LABEL, LIST_LENGTH_LABEL };
const MAX_LIST_ITEMS = 100_000;

export interface ListInfo {
  total: number;
  handled: number[];
}

export interface FactsEntry {
  url: string;
  pathPattern: string;
  tabId: number;
  t: number;
  facts: PageFact[];
  /** By listSignature. */
  lists: Record<string, ListInfo>;
}

/** What chrome.runtime.MessageSender says about the frame that reported. `origin`, when known, must match the report. */
export interface TraceSource {
  tabId: number | undefined;
  origin?: string;
}

export interface TraceStoreDeps {
  storage?: KvStorage;
  now?: () => number;
}

export interface TraceStore {
  /** Sanitizes, stamps the tab id, appends and persists. Null when the event was refused. */
  append(rawEvent: unknown, from: TraceSource): Promise<TraceEvent | null>;
  /** Latest facts of one url. Null when the report was refused. */
  setFacts(report: { url?: unknown; pathPattern?: unknown; facts?: unknown }, from: TraceSource): Promise<FactsEntry | null>;
  events(): Promise<TraceEvent[]>;
  /** The newest `count` events, oldest first (what /v1/predict/next gets). */
  recent(count?: number): Promise<TraceEvent[]>;
  factsByUrl(): Promise<FactsByUrl>;
  /** Newest report that mentions this list on this page pattern. */
  listInfo(origin: string, pathPattern: string, listSignature: string): Promise<ListInfo | null>;
  /** On "ghost:loop-dismiss" and when Ghost is disabled. */
  clear(): Promise<void>;
}

interface State {
  events: TraceEvent[];
  facts: FactsEntry[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Re-derived from the url: a content script's own idea of the origin and the pattern is not trusted. */
function placeOf(url: unknown, from: TraceSource): { origin: string; pathPattern: string; url: string } | null {
  const place = typeof url === "string" ? normalizeUrl(url) : null;
  if (!place || (from.origin !== undefined && from.origin.toLowerCase() !== place.origin)) return null;
  return { origin: place.origin, pathPattern: place.pathPattern, url: place.url };
}

/** A typed value that passes the card checksum is masked whatever its field was called: when in doubt, it is sensitive. */
export function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[digits.length - 1 - i]);
    sum += i % 2 === 0 ? d : d * 2 > 9 ? d * 2 - 9 : d * 2;
  }
  return sum % 10 === 0;
}

function cleanEvent(raw: unknown, from: TraceSource, now: number): TraceEvent | null {
  const event = sanitizeTraceEvent(raw);
  const place = event ? placeOf(event.url, from) : null;
  if (!event || !place || typeof from.tabId !== "number" || !Number.isInteger(from.tabId)) return null;
  const clean: TraceEvent = { ...event, ...place, t: Math.min(event.t, now), tabId: from.tabId };
  if (clean.value !== undefined && looksLikeCardNumber(clean.value)) clean.value = MASKED_VALUE;
  return clean;
}

function parseIndexes(text: string, total: number): number[] {
  const indexes = (text.match(/\d+/g) ?? []).map(Number).filter((i) => i < total);
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function isListFact(fact: PageFact): boolean {
  return fact.label === LIST_LENGTH_LABEL || fact.label === LIST_HANDLED_LABEL;
}

function listsOf(facts: readonly PageFact[]): Record<string, ListInfo> {
  const lists = Object.create(null) as Record<string, ListInfo>; // keys come from pages: "__proto__" must stay a key
  for (const fact of facts) {
    const total = fact.label === LIST_LENGTH_LABEL && /^\d{1,6}$/.test(fact.text) ? Number(fact.text) : -1;
    if (total >= 0 && total <= MAX_LIST_ITEMS) lists[fact.locator.value] = { total, handled: [] };
  }
  for (const fact of facts) {
    const list = fact.label === LIST_HANDLED_LABEL ? lists[fact.locator.value] : undefined;
    if (list) list.handled = parseIndexes(fact.text, list.total);
  }
  return lists;
}

function cleanEntry(report: { url?: unknown; facts?: unknown }, from: TraceSource, t: number): FactsEntry | null {
  const place = placeOf(report.url, from);
  if (!place || typeof from.tabId !== "number") return null;
  const all = sanitizePageFacts(report.facts);
  return { url: place.url, pathPattern: place.pathPattern, tabId: from.tabId, t, facts: all.filter((f) => !isListFact(f)), lists: listsOf(all) };
}

/** Everything read back from storage is rebuilt the same way a fresh report is. */
function reviveEvents(raw: unknown): TraceEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: TraceEvent[] = [];
  for (const item of raw.slice(-TRACE_MAX_EVENTS)) {
    const tabId: unknown = isObject(item) ? item.tabId : undefined;
    const event = cleanEvent(item, { tabId: typeof tabId === "number" ? tabId : undefined }, Number.POSITIVE_INFINITY);
    if (event) out.push(event);
  }
  return out;
}

function reviveFacts(raw: unknown): FactsEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FactsEntry[] = [];
  for (const item of raw.slice(-TRACE_MAX_URLS)) {
    if (!isObject(item) || typeof item.tabId !== "number" || typeof item.t !== "number") continue;
    const entry = cleanEntry({ url: item.url, facts: item.facts }, { tabId: item.tabId }, item.t);
    if (entry) out.push({ ...entry, lists: reviveLists(item.lists) });
  }
  return out;
}

function reviveLists(raw: unknown): Record<string, ListInfo> {
  const lists = Object.create(null) as Record<string, ListInfo>;
  if (!isObject(raw)) return lists;
  for (const [signature, info] of Object.entries(raw)) {
    if (!isObject(info) || typeof info.total !== "number" || !Number.isInteger(info.total) || info.total < 0) continue;
    const handled = Array.isArray(info.handled) ? info.handled.filter((i): i is number => Number.isInteger(i)) : [];
    lists[signature] = { total: info.total, handled };
  }
  return lists;
}

export function createTraceStore(deps: TraceStoreDeps = {}): TraceStore {
  const storage = deps.storage ?? kvStorage("session");
  const now = deps.now ?? Date.now;
  let loading: Promise<State> | null = null;
  let writes: Promise<void> = Promise.resolve();
  const dirty = new Set<string>();

  async function read(): Promise<State> {
    const [events, facts] = await Promise.all([storage.get(TRACE_EVENTS_KEY), storage.get(TRACE_FACTS_KEY)]).catch(() => [undefined, undefined]);
    return { events: reviveEvents(events), facts: reviveFacts(facts) };
  }

  function load(): Promise<State> {
    loading ??= read();
    return loading;
  }

  /** One write at a time, and a write that is still queued carries every change made before it runs. */
  function persist(key: string, snapshot: (state: State) => unknown): Promise<void> {
    dirty.add(key);
    const run = async (): Promise<void> => {
      if (!dirty.delete(key)) return;
      await storage.set(key, snapshot(await load())).catch((error: unknown) => console.warn("[ghost] trace write failed", error));
    };
    writes = writes.then(run, run);
    return writes;
  }

  return {
    async append(rawEvent, from) {
      const event = cleanEvent(rawEvent, from, now());
      if (!event) return null;
      const state = await load();
      state.events.push(event);
      if (state.events.length > TRACE_MAX_EVENTS) state.events.splice(0, state.events.length - TRACE_MAX_EVENTS);
      await persist(TRACE_EVENTS_KEY, (s) => s.events);
      return { ...event };
    },

    async setFacts(report, from) {
      const entry = cleanEntry(report, from, now());
      if (!entry) return null;
      const state = await load();
      state.facts = [...state.facts.filter((f) => f.url !== entry.url), entry].slice(-TRACE_MAX_URLS);
      await persist(TRACE_FACTS_KEY, (s) => s.facts);
      return entry;
    },

    events: async () => (await load()).events.map((e) => ({ ...e })),

    recent: async (count = 20) => (await load()).events.slice(-Math.max(0, count)).map((e) => ({ ...e })),

    async factsByUrl() {
      const out: FactsByUrl = {};
      for (const entry of (await load()).facts) out[entry.url] = entry.facts.map((f) => ({ ...f }));
      return out;
    },

    async listInfo(origin, pathPattern, listSignature) {
      const entries = (await load()).facts;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const info = entry?.pathPattern === pathPattern && entry.url.startsWith(`${origin}/`) ? entry.lists[listSignature] : undefined;
        if (info) return { total: info.total, handled: [...info.handled] };
      }
      return null;
    },

    async clear() {
      const state = await load();
      state.events = [];
      state.facts = [];
      dirty.clear();
      const wipe = (): Promise<void> => Promise.all([storage.remove(TRACE_EVENTS_KEY), storage.remove(TRACE_FACTS_KEY)]).then(() => undefined, () => undefined);
      writes = writes.then(wipe, wipe);
      await writes;
    },
  };
}
