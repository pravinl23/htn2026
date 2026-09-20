import type { CapturedField } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORM_CACHE_KEY, MAX_CACHED_FORMS, clearFormCache, factKeysId, formSignature, readCachedForm, resetFormCacheMemory, saveCachedForm, whenFormCacheIdle,
} from "../src/lib/formCache";
import type { CachedForm } from "../src/lib/formCache";
import { createChromeStorageMock } from "./chrome-mock";
import type { ChromeStorageMock } from "./chrome-mock";

const RECT = { x: 0, y: 0, width: 200, height: 32 };
const ORIGIN = "http://localhost:5173";
const KEYS = ["firstName", "lastName", "email"];
const ANSWER = {
  provider: "jev-gateway",
  assignments: [
    { signature: "input|text|firstName|first|first name|0", factKey: "firstName", confidence: 0.97, source: "jev-gateway", calibrated: true },
    { signature: "input|email|email|email|email|0", factKey: "email", confidence: 0.99, source: "heuristic", calibrated: false },
  ],
};

function field(signature: string, partial: Partial<CapturedField> = {}): CapturedField {
  return { signature, label: signature, kind: "text", rect: RECT, ...partial };
}

function stored(mock: ChromeStorageMock): Record<string, CachedForm> {
  return (mock.store.get(FORM_CACHE_KEY) ?? {}) as Record<string, CachedForm>;
}

/** Reads touch `usedAt` in the background; tests wait for that write before looking at storage. */
const settle = whenFormCacheIdle;

describe("formSignature", () => {
  it("is stable for the same ordered fields and ignores values and geometry", () => {
    const a = formSignature([field("first", { value: "" }), field("email", { kind: "email" })]);
    const b = formSignature([field("first", { value: "Sam", rect: { x: 9, y: 9, width: 1, height: 1 } }), field("email", { kind: "email", label: "other" })]);
    expect(a).toBe(b);
    expect(a).toMatch(/^form-2-[0-9a-z]+$/);
  });

  it("changes with the order, the signatures and the kinds", () => {
    const base = formSignature([field("first"), field("email", { kind: "email" })]);
    expect(formSignature([field("email", { kind: "email" }), field("first")])).not.toBe(base);
    expect(formSignature([field("first"), field("email")])).not.toBe(base);
    expect(formSignature([field("first"), field("mail", { kind: "email" })])).not.toBe(base);
    expect(formSignature([field("first")])).not.toBe(base);
  });

  it("never contains what the user typed", () => {
    expect(formSignature([field("first", { value: "hunter2-secret" })])).not.toContain("hunter2");
  });
});

describe("factKeysId", () => {
  it("depends on the set, not on the order", () => {
    expect(factKeysId(["b", "a", "a"])).toBe(factKeysId(["a", "b"]));
    expect(factKeysId(["a", "b", "c"])).not.toBe(factKeysId(["a", "b"]));
  });
});

describe("form cache in chrome.storage.local", () => {
  let mock: ChromeStorageMock;

  beforeEach(() => {
    mock = createChromeStorageMock();
    vi.stubGlobal("chrome", mock.chrome);
  });

  afterEach(async () => {
    await settle();
    vi.unstubAllGlobals();
    await resetFormCacheMemory();
  });

  it("returns what was saved for the same origin, form and fact keys", async () => {
    await saveCachedForm(ORIGIN, "form-a", KEYS, ANSWER, 1000);
    const hit = await readCachedForm(ORIGIN, "form-a", [...KEYS].reverse(), 2000);
    expect(hit?.provider).toBe("jev-gateway");
    expect(hit?.assignments).toEqual(ANSWER.assignments);
    expect(hit?.savedAt).toBe(1000);
  });

  it("misses for another origin or another form", async () => {
    await saveCachedForm(ORIGIN, "form-a", KEYS, ANSWER);
    expect(await readCachedForm("https://example.com", "form-a", KEYS)).toBeNull();
    expect(await readCachedForm(ORIGIN, "form-b", KEYS)).toBeNull();
  });

  it("stores signatures and fact KEYS only, nothing else it was handed", async () => {
    const noisy = { ...ANSWER, assignments: [{ ...ANSWER.assignments[0], value: "Alex", extra: { secret: "hunter2" } }] };
    await saveCachedForm(ORIGIN, "form-a", KEYS, noisy as never);
    const raw = JSON.stringify([...mock.store.entries()]);
    expect(raw).not.toContain("Alex");
    expect(raw).not.toContain("hunter2");
  });

  it("is invalidated when the fact key set changes, and the stale entry is dropped", async () => {
    await saveCachedForm(ORIGIN, "form-a", KEYS, ANSWER);
    expect(await readCachedForm(ORIGIN, "form-a", [...KEYS, "phone"])).toBeNull();
    await settle();
    expect(Object.keys(stored(mock))).toHaveLength(0);
    expect(await readCachedForm(ORIGIN, "form-a", KEYS)).toBeNull();
  });

  it("keeps a model's answer for weeks but retries the heuristic's after a day", async () => {
    const day = 86_400_000;
    await saveCachedForm(ORIGIN, "model", KEYS, ANSWER, 0);
    await saveCachedForm(ORIGIN, "heur", KEYS, { ...ANSWER, provider: "heuristic" }, 0);
    expect(await readCachedForm(ORIGIN, "model", KEYS, 2 * day)).not.toBeNull();
    expect(await readCachedForm(ORIGIN, "heur", KEYS, day / 2)).not.toBeNull();
    expect(await readCachedForm(ORIGIN, "heur", KEYS, 2 * day)).toBeNull();
    expect(await readCachedForm(ORIGIN, "model", KEYS, 40 * day)).toBeNull();
  });

  it("caps the cache at 200 forms and evicts the least recently used", async () => {
    for (let i = 0; i < MAX_CACHED_FORMS; i++) await saveCachedForm(ORIGIN, `form-${i}`, KEYS, ANSWER, i);
    expect(await readCachedForm(ORIGIN, "form-0", KEYS, 10_000)).not.toBeNull(); // a read makes it recent
    await settle();
    await saveCachedForm(ORIGIN, "form-new", KEYS, ANSWER, 10_001);
    const keys = Object.keys(stored(mock));
    expect(keys).toHaveLength(MAX_CACHED_FORMS);
    expect(keys).toContain(`${ORIGIN} form-0`);
    expect(keys).toContain(`${ORIGIN} form-new`);
    expect(keys).not.toContain(`${ORIGIN} form-1`);
  });

  it("ignores malformed entries left in storage", async () => {
    mock.store.set(FORM_CACHE_KEY, {
      [`${ORIGIN} form-a`]: { provider: "x", facts: factKeysId(KEYS), savedAt: Date.now(), assignments: [{ signature: 3, factKey: "email", confidence: "high" }] },
      [`${ORIGIN} form-b`]: "nonsense",
    });
    expect(await readCachedForm(ORIGIN, "form-a", KEYS)).toBeNull();
    expect(await readCachedForm(ORIGIN, "form-b", KEYS)).toBeNull();
  });

  it("does not save an empty answer, and clears on request", async () => {
    await saveCachedForm(ORIGIN, "form-empty", KEYS, { provider: "x", assignments: [] });
    expect(stored(mock)[`${ORIGIN} form-empty`]).toBeUndefined();
    await saveCachedForm(ORIGIN, "form-a", KEYS, ANSWER);
    await clearFormCache();
    expect(await readCachedForm(ORIGIN, "form-a", KEYS)).toBeNull();
  });
});

describe("form cache without chrome.* (unit tests, previews)", () => {
  afterEach(resetFormCacheMemory);

  it("falls back to memory", async () => {
    await saveCachedForm(ORIGIN, "form-a", KEYS, ANSWER);
    expect((await readCachedForm(ORIGIN, "form-a", KEYS))?.provider).toBe("jev-gateway");
  });
});
