import { DEFAULT_SETTINGS, DEMO_PROFILE } from "@ghost/shared";
import type { GhostSettings, PastAnswer, Profile } from "@ghost/shared";
import { cleanCounters, cleanPair, COUNTER_NAMES } from "./messages";
import type { MetricsBatch, MetricsCounters, MetricsPair } from "./messages";

export const PROFILE_KEY = "ghost.profile";
export const SETTINGS_KEY = "ghost.settings";
export const METRICS_KEY = "ghost.metrics";
/** The reliability chart reads the newest pairs; older ones fall off. */
export const MAX_CALIBRATION_PAIRS = 1000;

export interface StorageChanges {
  profile?: Profile;
  settings?: GhostSettings;
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
  return out;
}

export function onStorageChanged(cb: (changes: StorageChanges) => void): () => void {
  return backend().subscribe((raw) => {
    const changes = toStorageChanges(raw);
    if (changes.profile || changes.settings) cb(changes);
  });
}

// ---------- metrics (Stage 7): the exact shape the options page reads ----------

export interface StoredMetrics extends MetricsCounters {
  calibration: MetricsPair[];
}

const LIFETIME_MAX = Number.MAX_SAFE_INTEGER;

export function normalizeMetrics(raw: unknown): StoredMetrics {
  const record = isRecord(raw) ? raw : {};
  const list = Array.isArray(record.calibration) ? record.calibration.slice(-MAX_CALIBRATION_PAIRS) : [];
  const calibration = list.map(cleanPair).filter((p): p is MetricsPair => p !== null);
  return { ...cleanCounters(record, LIFETIME_MAX), calibration };
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

/** Test seam: wipes the in-memory fallback. Has no effect on chrome.storage. */
export function resetMemoryStorage(): void {
  memory.clear();
  memoryListeners.clear();
}
