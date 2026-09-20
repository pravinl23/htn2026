import {
  ANSWER_COUNTER_NAMES, DEFAULT_SETTINGS, DEMO_PROFILE, FACT_KEY_PATTERN, KeyMemory, LearnedAnswerStore, graphFromJSON,
  graphToProfileFacts, listFacts, profileToGraph, removeFact, setUserFact,
} from "@ghost/shared";
import type {
  FactGraph, GhostSettings, KeyMemorySnapshot, LearnedAnswersSnapshot, PastAnswer, Profile, TabProbe, UserPress,
} from "@ghost/shared";
import { DEFAULT_KEY_PREFS, isAcceptKeySetting, isGhostKeyId } from "../content/acceptKey";
import type { KeyPrefs } from "../content/acceptKey";
import { cleanCounters, cleanPair, COUNTER_NAMES } from "./messages";
import type { MetricsBatch, MetricsCounters, MetricsPair } from "./messages";

export const PROFILE_KEY = "ghost.profile";
export const SETTINGS_KEY = "ghost.settings";
export const METRICS_KEY = "ghost.metrics";
/** Answers the user themselves gave, keyed by question signature. Local only: never sent anywhere. */
export const ANSWERS_KEY = "ghost.answers";
/**
 * The fact graph (docs/profile-sources.md): who the user is, with labels, provenance and confidence.
 * It is the richer store; `ghost.profile` stays its flat mirror so every existing reader keeps working.
 * Local only: only fact KEYS ever go on the wire.
 */
export const FACTS_KEY = "ghost.facts";
/**
 * Which key accepts a ghost, and what Tab has been observed to do per origin (docs/accept-key.md). Counters
 * about keys only: an origin and one of three words, never a URL, never a page, never a value.
 */
export const KEYS_KEY = "ghost.keys";
/** The reliability chart reads the newest pairs; older ones fall off. */
export const MAX_CALIBRATION_PAIRS = 1000;

export interface StorageChanges {
  profile?: Profile;
  settings?: GhostSettings;
  /** Learned answers, rebuilt from the stored snapshot. Never leaves the machine. */
  answers?: LearnedAnswerStore;
  /** The fact graph, rebuilt from what is stored. */
  facts?: FactGraph;
  /** The accept-key preferences and what is known about Tab per origin. */
  keys?: StoredKeys;
}

type RawChanges = Record<string, { newValue?: unknown }>;
type RawListener = (changes: RawChanges) => void;

interface Backend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  subscribe(listener: RawListener): () => void;
}

const memory = new Map<string, unknown>();
const memoryListeners = new Set<RawListener>();

const memoryBackend: Backend = {
  get: async (key) => structuredCloneSafe(memory.get(key)),
  set: async (key, value) => {
    memory.set(key, structuredCloneSafe(value));
    for (const listener of [...memoryListeners]) listener({ [key]: { newValue: structuredCloneSafe(value) } });
  },
  subscribe: (listener) => {
    memoryListeners.add(listener);
    return () => memoryListeners.delete(listener);
  },
};

const chromeBackend: Backend = {
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  subscribe: (listener) => {
    const wrapped = (changes: RawChanges, area: string): void => {
      if (area === "local") listener(changes);
    };
    chrome.storage.onChanged.addListener(wrapped);
    return () => chrome.storage.onChanged.removeListener(wrapped);
  },
};

function structuredCloneSafe<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

// Resolved on every call so tests can install or remove a chrome mock at any time.
function backend(): Backend {
  const hasChrome = typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
  return hasChrome ? chromeBackend : memoryBackend;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPastAnswer(value: unknown): value is PastAnswer {
  return isRecord(value) && typeof value.question === "string" && typeof value.answer === "string";
}

/** Coerces anything found in storage into a well-formed Profile, or null when unusable. */
export function normalizeProfile(raw: unknown): Profile | null {
  if (!isRecord(raw) || !isRecord(raw.facts)) return null;
  const facts: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.facts)) {
    if (typeof value === "string") facts[key] = value;
  }
  const pastAnswers = Array.isArray(raw.pastAnswers) ? raw.pastAnswers.filter(isPastAnswer) : [];
  return { facts, pastAnswers };
}

export function normalizeSettings(raw: unknown): GhostSettings {
  const merged: GhostSettings = { ...DEFAULT_SETTINGS };
  if (!isRecord(raw)) return merged;
  if (typeof raw.enabled === "boolean") merged.enabled = raw.enabled;
  if (typeof raw.showHud === "boolean") merged.showHud = raw.showHud;
  if (typeof raw.learningEnabled === "boolean") merged.learningEnabled = raw.learningEnabled;
  if (typeof raw.answerProtectedWithDecline === "boolean") merged.answerProtectedWithDecline = raw.answerProtectedWithDecline;
  if (typeof raw.serverUrl === "string" && raw.serverUrl.trim()) merged.serverUrl = raw.serverUrl.trim();
  if (typeof raw.confidenceThreshold === "number" && Number.isFinite(raw.confidenceThreshold)) {
    merged.confidenceThreshold = Math.min(1, Math.max(0, raw.confidenceThreshold));
  }
  return merged;
}

export async function getProfile(): Promise<Profile> {
  const stored = normalizeProfile(await backend().get(PROFILE_KEY));
  if (stored) return stored;
  const seeded = structuredCloneSafe(DEMO_PROFILE);
  await backend().set(PROFILE_KEY, seeded);
  return seeded;
}

export async function saveProfile(profile: Profile): Promise<void> {
  const clean = normalizeProfile(profile);
  if (!clean) throw new Error("Invalid profile: expected { facts, pastAnswers }");
  await backend().set(PROFILE_KEY, clean);
  // The flat profile and the graph are two views of the same facts: an edit here is the user's own word,
  // so it wins in the graph too (and a fact deleted here is deleted there).
  await syncGraphFromFacts(clean.facts);
}

let profileWrites: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write of the stored profile, one at a time (learning adds a fact while an answer is being
 * saved). `mutate` sees the LATEST profile and returns the next one, or null to leave storage alone.
 */
export function updateProfile(mutate: (current: Profile) => Profile | null): Promise<Profile | null> {
  const write = async (): Promise<Profile | null> => {
    const next = mutate(await getProfile());
    if (next) await saveProfile(next);
    return next;
  };
  const result = profileWrites.then(write, write);
  profileWrites = result.catch(() => undefined);
  return result;
}

// ---------- the fact graph (docs/profile-sources.md): the store, and the flat mirror it keeps in step ----------

/**
 * Coerces anything found in storage into a graph, or null when there is no graph there yet (which is what
 * makes the one-time migration from `ghost.profile` run). `graphFromJSON` never throws and drops anything
 * malformed or sensitive-but-not-user-typed on the way in.
 */
export function normalizeGraph(raw: unknown): FactGraph | null {
  if (!isRecord(raw)) return null;
  if (!isRecord(raw.facts) && !Array.isArray(raw.facts)) return null;
  return graphFromJSON(JSON.stringify(raw));
}

/**
 * The graph as it stands. On the first read after an update there is no graph yet, so the stored flat
 * profile is migrated into one (and `getProfile` seeds the demo profile when there is not even that):
 * the same facts, now with a category, a human label and the phrasings forms use for them.
 */
export async function getFactGraph(): Promise<FactGraph> {
  const stored = normalizeGraph(await backend().get(FACTS_KEY));
  if (stored) return stored;
  const graph = profileToGraph(await getProfile());
  await backend().set(FACTS_KEY, graph);
  return graph;
}

function sameFacts(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * `ghost.profile` is the graph's flat projection: the content script, the background worker and the
 * per-site cache all read it, so a fact the user accepts in the options page reaches them without any of
 * them knowing about the graph. Sensitive facts are never mirrored (`graphToProfileFacts` drops them).
 */
async function mirrorGraphToProfile(graph: FactGraph): Promise<void> {
  const current = normalizeProfile(await backend().get(PROFILE_KEY));
  // A fact whose key the graph cannot hold (an old hand-written key) is kept rather than silently dropped.
  const kept = Object.entries(current?.facts ?? {}).filter(([key]) => !FACT_KEY_PATTERN.test(key));
  const facts = { ...Object.fromEntries(kept), ...graphToProfileFacts(graph) };
  if (current && sameFacts(current.facts, facts)) return;
  await backend().set(PROFILE_KEY, { facts, pastAnswers: current?.pastAnswers ?? [] });
}

export async function saveFactGraph(graph: FactGraph): Promise<void> {
  await backend().set(FACTS_KEY, graph);
  await mirrorGraphToProfile(graph);
}

let factWrites: Promise<unknown> = Promise.resolve();

/** Every graph write goes through here, so a profile save and a scan can never clobber each other. */
function queueFactWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = factWrites.then(write, write);
  factWrites = result.catch(() => undefined);
  return result;
}

/**
 * The other direction: what the profile editor (or learning) wrote becomes the user's word in the graph.
 * The graph is not mirrored back here; the profile that triggered this is already what the user asked for.
 */
function syncGraphFromFacts(facts: Record<string, string>): Promise<void> {
  return queueFactWrite(async () => {
    let graph = await getFactGraph();
    const before = graph;
    for (const fact of listFacts(graph)) {
      // A sensitive fact the user typed never appears in the flat profile, so its absence means nothing.
      if (!fact.sensitive && !Object.hasOwn(facts, fact.key)) graph = removeFact(graph, fact.key);
    }
    for (const [key, value] of Object.entries(facts)) {
      if (value === "" || graph.facts[key]?.value === value) continue;
      graph = setUserFact(graph, key, value).graph;
    }
    if (graph !== before) await backend().set(FACTS_KEY, graph);
  });
}

/**
 * Read-modify-write of the graph, one at a time. `mutate` sees the LATEST graph and returns the next one,
 * or null to leave storage alone. Every write mirrors into the flat profile.
 */
export function updateFactGraph(mutate: (graph: FactGraph) => FactGraph | null): Promise<FactGraph> {
  return queueFactWrite(async () => {
    const current = await getFactGraph();
    const next = mutate(current);
    if (!next || next === current) return current;
    await saveFactGraph(next);
    return next;
  });
}

export async function getSettings(): Promise<GhostSettings> {
  return normalizeSettings(await backend().get(SETTINGS_KEY));
}

let settingsWrites: Promise<void> = Promise.resolve();

// Patches are read-modify-write, so they run one at a time; otherwise two quick changes lose one.
export function saveSettings(patch: Partial<GhostSettings>): Promise<void> {
  const write = async (): Promise<void> => {
    const current = await getSettings();
    await backend().set(SETTINGS_KEY, normalizeSettings({ ...current, ...patch }));
  };
  settingsWrites = settingsWrites.then(write, write);
  return settingsWrites;
}

function toStorageChanges(raw: RawChanges): StorageChanges {
  const out: StorageChanges = {};
  const profileChange = raw[PROFILE_KEY];
  if (profileChange) out.profile = normalizeProfile(profileChange.newValue) ?? structuredCloneSafe(DEMO_PROFILE);
  const settingsChange = raw[SETTINGS_KEY];
  if (settingsChange) out.settings = normalizeSettings(settingsChange.newValue);
  const answersChange = raw[ANSWERS_KEY];
  if (answersChange) out.answers = LearnedAnswerStore.fromJSON(answersChange.newValue as LearnedAnswersSnapshot | null);
  const factsChange = raw[FACTS_KEY];
  const graph = factsChange ? normalizeGraph(factsChange.newValue) : null;
  if (graph) out.facts = graph;
  const keysChange = raw[KEYS_KEY];
  if (keysChange) out.keys = normalizeKeys(keysChange.newValue);
  return out;
}

export function onStorageChanged(cb: (changes: StorageChanges) => void): () => void {
  return backend().subscribe((raw) => {
    const changes = toStorageChanges(raw);
    if (changes.profile || changes.settings || changes.answers || changes.facts || changes.keys) cb(changes);
  });
}

// ---------- learned answers (docs/answers.md section 4): local only, never sent to any server ----------

export async function getLearnedAnswers(): Promise<LearnedAnswerStore> {
  return LearnedAnswerStore.fromJSON((await backend().get(ANSWERS_KEY)) as LearnedAnswersSnapshot | null);
}

let answerWrites: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write of the answer store, one at a time. `mutate` sees the LATEST store and returns true when
 * it changed something worth persisting; another tab's correction is never lost under this one.
 */
export function updateLearnedAnswers(mutate: (store: LearnedAnswerStore) => boolean): Promise<LearnedAnswerStore> {
  const write = async (): Promise<LearnedAnswerStore> => {
    const store = await getLearnedAnswers();
    if (mutate(store)) await backend().set(ANSWERS_KEY, store.toJSON());
    return store;
  };
  const result = answerWrites.then(write, write);
  answerWrites = result.catch(() => undefined);
  return result;
}

// ---------- metrics (Stage 7): the exact shape the options page reads ----------

export interface StoredMetrics extends MetricsCounters {
  calibration: MetricsPair[];
  /**
   * Value-free answer counters (docs/answers.md section 6), keyed by the names in `ANSWER_COUNTER_NAMES`.
   * No label, no value, no origin: only how often each class and source was proposed, accepted or corrected.
   */
  answers: Record<string, number>;
}

const LIFETIME_MAX = Number.MAX_SAFE_INTEGER;

/** Only names the answer engine can produce, and only finite non-negative numbers. Anything else is dropped. */
export function cleanAnswerCounters(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(raw)) return out;
  for (const name of ANSWER_COUNTER_NAMES) {
    const value = raw[name];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[name] = Math.min(LIFETIME_MAX, Math.floor(value));
  }
  return out;
}

export function normalizeMetrics(raw: unknown): StoredMetrics {
  const record = isRecord(raw) ? raw : {};
  const list = Array.isArray(record.calibration) ? record.calibration.slice(-MAX_CALIBRATION_PAIRS) : [];
  const calibration = list.map(cleanPair).filter((p): p is MetricsPair => p !== null);
  return { ...cleanCounters(record, LIFETIME_MAX), calibration, answers: cleanAnswerCounters(record.answers) };
}

export async function getMetrics(): Promise<StoredMetrics> {
  return normalizeMetrics(await backend().get(METRICS_KEY));
}

let metricsWrites: Promise<unknown> = Promise.resolve();

/** Adds one batch of deltas. Runs one at a time, so batches from several tabs never lose each other. */
export function addMetrics(batch: MetricsBatch): Promise<StoredMetrics> {
  const write = async (): Promise<StoredMetrics> => {
    const next = await getMetrics();
    for (const name of COUNTER_NAMES) next[name] = Math.min(LIFETIME_MAX, next[name] + batch.counters[name]);
    next.calibration = [...next.calibration, ...batch.pairs].slice(-MAX_CALIBRATION_PAIRS);
    await backend().set(METRICS_KEY, next);
    return next;
  };
  const result = metricsWrites.then(write, write);
  metricsWrites = result.catch(() => undefined);
  return result;
}

/**
 * Adds value-free answer counters to `ghost.metrics`. Shares the metrics write queue so a batch of ghost
 * counters and a correction landing together never overwrite each other.
 */
export function addAnswerCounters(deltas: Readonly<Record<string, number>>): Promise<StoredMetrics> {
  const clean = cleanAnswerCounters(deltas);
  const write = async (): Promise<StoredMetrics> => {
    const next = await getMetrics();
    if (Object.keys(clean).length === 0) return next;
    for (const [name, delta] of Object.entries(clean)) {
      next.answers[name] = Math.min(LIFETIME_MAX, (next.answers[name] ?? 0) + delta);
    }
    await backend().set(METRICS_KEY, next);
    return next;
  };
  const result = metricsWrites.then(write, write);
  metricsWrites = result.catch(() => undefined);
  return result;
}

// ---------- the accept key (docs/accept-key.md): the user's choice, and what each origin does with Tab ----------

/**
 * `ghost.keys`. The per-origin part is the shared `KeyMemory` (shared/src/keys/observe.ts): counters and one
 * three-state flag per origin, capped at KEY_MEMORY_MAX with the least recently used evicted first. No URL
 * beyond scheme://host, no titles, no timestamps, no event log (docs/storage.md, the habits budget).
 */
export interface StoredKeys extends KeyPrefs {
  memory: KeyMemorySnapshot;
}

export const DEFAULT_KEYS: StoredKeys = { ...DEFAULT_KEY_PREFS, memory: new KeyMemory().toJSON() };

/** Anything found in storage becomes a usable value: a corrupt memory yields an empty one, never a throw. */
export function normalizeKeys(raw: unknown): StoredKeys {
  const record = isRecord(raw) ? raw : {};
  return {
    acceptKey: isAcceptKeySetting(record.acceptKey) ? record.acceptKey : DEFAULT_KEY_PREFS.acceptKey,
    ghostKey: isGhostKeyId(record.ghostKey) ? record.ghostKey : DEFAULT_KEY_PREFS.ghostKey,
    memory: KeyMemory.fromJSON(record.memory as KeyMemorySnapshot | null).toJSON(),
  };
}

export async function getKeys(): Promise<StoredKeys> {
  return normalizeKeys(await backend().get(KEYS_KEY));
}

/** The key preferences alone, which is all the content script needs to decide. */
export async function getKeyPrefs(): Promise<KeyPrefs> {
  const { acceptKey, ghostKey } = await getKeys();
  return { acceptKey, ghostKey };
}

export async function getKeyMemory(): Promise<KeyMemory> {
  return KeyMemory.fromJSON((await getKeys()).memory);
}

let keyWrites: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write of `ghost.keys`, one at a time. A probe landing in one tab never overwrites a preference
 * changed in another, and two tabs watching the same origin both count.
 */
export function updateKeys(mutate: (current: StoredKeys) => StoredKeys | null): Promise<StoredKeys> {
  const write = async (): Promise<StoredKeys> => {
    const current = await getKeys();
    const next = mutate(current);
    if (!next) return current;
    const clean = normalizeKeys(next);
    await backend().set(KEYS_KEY, clean);
    return clean;
  };
  const result = keyWrites.then(write, write);
  keyWrites = result.catch(() => undefined);
  return result;
}

export function saveKeyPrefs(patch: Partial<KeyPrefs>): Promise<StoredKeys> {
  return updateKeys((current) => ({ ...current, ...patch }));
}

/** Folds one watched Tab press into what is known about that origin (shared/src/keys/observe.ts). */
export function recordTabProbe(probe: TabProbe): Promise<StoredKeys> {
  return updateKeys((current) => {
    const memory = KeyMemory.fromJSON(current.memory);
    memory.recordTabProbe(probe);
    return { ...current, memory: memory.toJSON() };
  });
}

/** Folds one accept press by the user into that origin (three consistent presses flip it, doc section 2 step 4). */
export function recordUserPress(press: UserPress): Promise<StoredKeys> {
  return updateKeys((current) => {
    const memory = KeyMemory.fromJSON(current.memory);
    memory.recordUserPress(press);
    return { ...current, memory: memory.toJSON() };
  });
}

/** Test seam: wipes the in-memory fallback. Has no effect on chrome.storage. */
export function resetMemoryStorage(): void {
  memory.clear();
  memoryListeners.clear();
}
