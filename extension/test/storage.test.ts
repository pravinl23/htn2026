import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEMO_PROFILE } from "@ghost/shared";
import type { Profile } from "@ghost/shared";
import {
  PROFILE_KEY,
  SETTINGS_KEY,
  getProfile,
  getSettings,
  normalizeProfile,
  normalizeSettings,
  onStorageChanged,
  resetMemoryStorage,
  saveProfile,
  saveSettings,
} from "../src/lib/storage";
import { createChromeStorageMock } from "./chrome-mock";

const EDITED: Profile = { facts: { firstName: "Alex", nickname: "Al" }, pastAnswers: [{ question: "Why?", answer: "Robots." }] };

afterEach(() => {
  vi.unstubAllGlobals();
  resetMemoryStorage();
});

describe("storage with the in-memory fallback (no chrome global)", () => {
  it("seeds the demo profile on first read and returns a private copy", async () => {
    const first = await getProfile();
    expect(first).toEqual(DEMO_PROFILE);
    first.facts.firstName = "Mutated";
    expect(DEMO_PROFILE.facts.firstName).toBe("Alex");
    expect((await getProfile()).facts.firstName).toBe("Alex");
  });

  it("round-trips a saved profile", async () => {
    await saveProfile(EDITED);
    expect(await getProfile()).toEqual(EDITED);
  });

  it("rejects a malformed profile instead of storing it", async () => {
    await expect(saveProfile({ facts: null } as unknown as Profile)).rejects.toThrow(/Invalid profile/);
    expect(await getProfile()).toEqual(DEMO_PROFILE);
  });

  it("returns default settings, then merges patches on top of them", async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    await saveSettings({ enabled: false });
    await saveSettings({ confidenceThreshold: 0.85 });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, enabled: false, confidenceThreshold: 0.85 });
  });

  it("keeps every patch when saves overlap", async () => {
    await Promise.all([saveSettings({ enabled: false }), saveSettings({ showHud: false }), saveSettings({ learningEnabled: true })]);
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, enabled: false, showHud: false, learningEnabled: true });
  });

  it("notifies subscribers with typed changes until they unsubscribe", async () => {
    const cb = vi.fn();
    const off = onStorageChanged(cb);
    await saveSettings({ showHud: false });
    await saveProfile(EDITED);
    expect(cb).toHaveBeenNthCalledWith(1, { settings: { ...DEFAULT_SETTINGS, showHud: false } });
    expect(cb).toHaveBeenNthCalledWith(2, { profile: EDITED });
    off();
    await saveSettings({ showHud: true });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe("storage with chrome.storage.local", () => {
  let mock: ReturnType<typeof createChromeStorageMock>;

  beforeEach(() => {
    mock = createChromeStorageMock();
    vi.stubGlobal("chrome", mock.chrome);
  });

  it("seeds the demo profile into chrome.storage.local on first read", async () => {
    expect(await getProfile()).toEqual(DEMO_PROFILE);
    expect(mock.store.get(PROFILE_KEY)).toEqual(DEMO_PROFILE);
    expect(mock.chrome.storage.local.set).toHaveBeenCalledTimes(1);
    await getProfile();
    expect(mock.chrome.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it("reads and writes the profile under ghost.profile", async () => {
    await saveProfile(EDITED);
    expect(mock.store.get(PROFILE_KEY)).toEqual(EDITED);
    expect(await getProfile()).toEqual(EDITED);
  });

  it("merges DEFAULT_SETTINGS over a partial stored value", async () => {
    mock.store.set(SETTINGS_KEY, { enabled: false });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, enabled: false });
  });

  it("saves a full merged settings object under ghost.settings", async () => {
    await saveSettings({ serverUrl: "http://localhost:9999" });
    expect(mock.store.get(SETTINGS_KEY)).toEqual({ ...DEFAULT_SETTINGS, serverUrl: "http://localhost:9999" });
  });

  it("forwards only local-area changes for Ghost keys and removes its listener", async () => {
    const cb = vi.fn();
    const off = onStorageChanged(cb);
    mock.emit({ [SETTINGS_KEY]: { newValue: { enabled: false } } }, "sync");
    mock.emit({ "other.key": { newValue: 1 } }, "local");
    expect(cb).not.toHaveBeenCalled();
    await saveSettings({ enabled: false });
    expect(cb).toHaveBeenCalledWith({ settings: { ...DEFAULT_SETTINGS, enabled: false } });
    off();
    expect(mock.chrome.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
    expect(mock.listeners.size).toBe(0);
  });

  it("does not leak into the in-memory fallback", async () => {
    await saveSettings({ enabled: false });
    vi.unstubAllGlobals();
    expect((await getSettings()).enabled).toBe(true);
  });
});

describe("normalizers", () => {
  it("drops non-string facts and malformed past answers", () => {
    const raw = { facts: { a: "1", b: 2 }, pastAnswers: [{ question: "q", answer: "a" }, { question: 1 }, "x"] };
    expect(normalizeProfile(raw)).toEqual({ facts: { a: "1" }, pastAnswers: [{ question: "q", answer: "a" }] });
    expect(normalizeProfile("nope")).toBeNull();
    expect(normalizeProfile({ facts: [] })).toBeNull();
  });

  it("ignores wrongly typed settings and clamps the threshold", () => {
    const settings = normalizeSettings({ enabled: "yes", confidenceThreshold: 7, serverUrl: "  ", showHud: false });
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, confidenceThreshold: 1, showHud: false });
    expect(normalizeSettings({ confidenceThreshold: Number.NaN }).confidenceThreshold).toBe(DEFAULT_SETTINGS.confidenceThreshold);
  });
});
