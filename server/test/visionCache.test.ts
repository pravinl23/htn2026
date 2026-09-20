import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { fakeFetch, type Responder } from "../src/llm/testing";
import { registerVisionRoutes } from "../src/routes/vision";
import { VisionBudget } from "../src/vision/budget";
import { cacheLimitFrom, DEFAULT_CACHE_ENTRIES, LabelCache, visionCacheKey } from "../src/vision/cache";
import type { VisionLabel } from "../src/vision/replies";
import { demoToolbar, responsesJson } from "../src/vision/testing";

/**
 * docs/anywhere.md section 4: "cached by a hash of the box geometry plus the page's path pattern", so the second visit
 * to a page costs nothing. Opt-in: no `page.pathPattern`, no cache.
 */

const FAKE_KEY = "sk-test-not-a-real-key";
const JSON_HEADERS = { "Content-Type": "application/json" };
const TOOLBAR = demoToolbar();

type Json = Record<string, unknown> & { labels?: Array<Record<string, unknown>>; error?: string };

const MODEL_LABELS = {
  labels: [
    { id: "b1", label: "Send", role: "button", irreversible: true, confidence: 0.97 },
    { id: "b2", label: "Cancel", role: "button", irreversible: false, confidence: 0.95 },
    { id: "b3", label: "Delete", role: "button", irreversible: true, confidence: 0.81 },
  ],
};

function appWith(cache?: LabelCache, budget?: VisionBudget) {
  const fake = fakeFetch(((): Responder => () => responsesJson(MODEL_LABELS))());
  const app = new Hono();
  const lines: string[] = [];
  registerVisionRoutes(app, loadConfig({ OPENAI_API_KEY: FAKE_KEY }), {
    env: {},
    fetch: fake.fetch,
    budget: budget ?? new VisionBudget(200),
    cache,
    log: (line) => lines.push(line),
  });
  const post = async (body: unknown): Promise<{ status: number; json: Json }> => {
    const res = await app.request("/v1/vision/label", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Json };
  };
  return { app, post, calls: fake.calls, lines };
}

const body = (extra: Record<string, unknown> = {}) => ({ image: TOOLBAR.dataUrl, boxes: TOOLBAR.boxes, ...extra });
const onWatch = (extra: Record<string, unknown> = {}) => body({ page: { pathPattern: "/watch" }, ...extra });

const label = (id: string): VisionLabel => ({ id, label: "Play", role: "button", affordance: "play", irreversible: false, sensitive: false, confidence: 0.9 });

describe("visionCacheKey", () => {
  const parts = { pathPattern: "/watch", model: "m", image: { width: 480, height: 120 }, boxes: TOOLBAR.boxes };

  it("is stable, and is a hash: neither the pattern nor an id is readable in it", () => {
    expect(visionCacheKey(parts)).toBe(visionCacheKey({ ...parts, boxes: [...TOOLBAR.boxes] }));
    expect(visionCacheKey(parts)).toMatch(/^[0-9a-f]{32}$/);
    expect(visionCacheKey(parts)).not.toContain("watch");
  });

  it("changes with the page, the model, the crop size, the geometry and the order", () => {
    const keys = new Set([
      visionCacheKey(parts),
      visionCacheKey({ ...parts, pathPattern: "/results" }),
      visionCacheKey({ ...parts, model: "other" }),
      visionCacheKey({ ...parts, image: { width: 481, height: 120 } }),
      visionCacheKey({ ...parts, boxes: [{ ...TOOLBAR.boxes[0]!, x: 25 }, ...TOOLBAR.boxes.slice(1)] }),
      visionCacheKey({ ...parts, boxes: [...TOOLBAR.boxes].reverse() }),
      visionCacheKey({ ...parts, boxes: TOOLBAR.boxes.slice(0, 2) }),
    ]);
    expect(keys.size).toBe(7);
  });

  it("ignores the client's box ids: an AX signature can carry a person's name", () => {
    const renamed = TOOLBAR.boxes.map((b) => ({ ...b, id: `${b.id}-alex-chen` }));
    expect(visionCacheKey({ ...parts, boxes: renamed })).toBe(visionCacheKey(parts));
  });
});

describe("LabelCache", () => {
  it("returns the stored labels under the CURRENT request's ids", () => {
    const cache = new LabelCache();
    cache.set("k", [label("old-1"), label("old-2")]);
    expect(cache.get("k", [{ id: "new-1" }, { id: "new-2" }])?.map((l) => l.id)).toEqual(["new-1", "new-2"]);
    expect(cache.stats()).toMatchObject({ enabled: true, entries: 1, hits: 1, misses: 0 });
  });

  it("misses on an unknown key, a different box count, and after the TTL", () => {
    let now = 1_000;
    const cache = new LabelCache(10, 60_000, () => now);
    cache.set("k", [label("a")]);
    expect(cache.get("other", [{ id: "a" }])).toBeUndefined();
    expect(cache.get("k", [{ id: "a" }, { id: "b" }])).toBeUndefined();
    now = 1_000 + 60_001;
    cache.set("fresh", [label("a")]);
    expect(cache.get("k", [{ id: "a" }])).toBeUndefined();
    expect(cache.get("fresh", [{ id: "a" }])).toBeDefined();
    expect(cache.stats().misses).toBe(3);
  });

  it("evicts the oldest page past the limit, and a limit of 0 switches it off", () => {
    const cache = new LabelCache(2);
    for (const key of ["a", "b", "c"]) cache.set(key, [label("x")]);
    expect(cache.get("a", [{ id: "x" }])).toBeUndefined();
    expect(cache.get("c", [{ id: "x" }])).toBeDefined();
    expect(cache.stats().entries).toBe(2);

    const off = new LabelCache(0);
    off.set("a", [label("x")]);
    expect(off.get("a", [{ id: "x" }])).toBeUndefined();
    expect(off.stats()).toMatchObject({ enabled: false, entries: 0 });
  });

  it("stores copies, so a caller cannot edit what the next visit reads", () => {
    const cache = new LabelCache();
    const stored = [label("a")];
    cache.set("k", stored);
    stored[0]!.irreversible = true;
    const read = cache.get("k", [{ id: "a" }])!;
    read[0]!.label = "Tampered";
    expect(cache.get("k", [{ id: "a" }])?.[0]).toMatchObject({ label: "Play", irreversible: false });
  });

  it("reads GHOST_VISION_CACHE, and keeps the default for anything unreadable", () => {
    expect(cacheLimitFrom("50")).toBe(50);
    expect(cacheLimitFrom("0")).toBe(0);
    expect(cacheLimitFrom(undefined)).toBe(DEFAULT_CACHE_ENTRIES);
    expect(cacheLimitFrom("many")).toBe(DEFAULT_CACHE_ENTRIES);
    expect(cacheLimitFrom("-3")).toBe(DEFAULT_CACHE_ENTRIES);
    expect(cacheLimitFrom("9999999")).toBe(5_000);
  });
});

describe("POST /v1/vision/label: the per-page cache", () => {
  it("answers the second visit to the same page from memory, with no second call", async () => {
    const { post, calls, lines } = appWith();
    const first = await post(onWatch());
    const second = await post(onWatch());
    expect(first.json.cached).toBe(false);
    expect(second.status).toBe(200);
    expect(second.json.cached).toBe(true);
    expect(second.json.labels).toEqual(first.json.labels);
    expect(calls).toHaveLength(1);
    expect(lines[0]).toContain("cache=miss");
    expect(lines[1]).toContain("cache=hit");
    expect(lines[1]).toContain("attempts=0");
    // The page pattern is hashed, never written down.
    expect(lines.join(" ")).not.toContain("/watch");
  });

  it("is opt-in: without page.pathPattern every request is a call", async () => {
    const { post, calls } = appWith();
    await post(body());
    const second = await post(body());
    expect(second.json.cached).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("keys on the geometry: a control that moved costs a call, a different page costs a call", async () => {
    const { post, calls } = appWith();
    await post(onWatch());
    await post(onWatch({ boxes: [{ ...TOOLBAR.boxes[0]!, x: 25 }, ...TOOLBAR.boxes.slice(1)] }));
    await post(body({ page: { pathPattern: "/results" } }));
    expect(calls).toHaveLength(3);
  });

  it("re-attaches the current request's ids to cached labels", async () => {
    const { post, calls } = appWith();
    await post(onWatch());
    const renamed = TOOLBAR.boxes.map((b) => ({ ...b, id: `${b.id}-2` }));
    const second = await post(onWatch({ boxes: renamed }));
    expect(second.json.cached).toBe(true);
    expect(second.json.labels?.map((l) => l.id)).toEqual(["send-2", "cancel-2", "trash-2"]);
    expect(second.json.labels?.map((l) => l.label)).toEqual(["Send", "Cancel", "Delete"]);
    expect(calls).toHaveLength(1);
  });

  it("still answers a known page once the budget is spent", async () => {
    const budget = new VisionBudget(1);
    const { post, calls } = appWith(new LabelCache(), budget);
    expect((await post(onWatch())).status).toBe(200);
    expect(budget.remaining()).toBe(0);
    const cached = await post(onWatch());
    expect(cached.status).toBe(200);
    expect(cached.json.cached).toBe(true);
    // An unknown page is still refused: the budget is about money, the cache is about repeats.
    expect((await post(body({ page: { pathPattern: "/other" } }))).status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it("reports the cache on GET /v1/vision", async () => {
    const { app, post } = appWith();
    await post(onWatch());
    await post(onWatch());
    const stats = ((await (await app.request("/v1/vision")).json()) as { cache: unknown }).cache;
    expect(stats).toEqual({ enabled: true, entries: 1, hits: 1, misses: 1 });
  });

  it("refuses a pathPattern that is a URL with identifiers, a query string, or hidden characters", async () => {
    const { post, calls } = appWith();
    const cases: Array<[unknown, RegExp]> = [
      [{ pathPattern: "/watch?v=abc&token=zz" }, /query string/],
      [{ pathPattern: "/orders/10293847" }, /identifiers/],
      [{ pathPattern: "/mail/alex.chen@example.com" }, /identifiers/],
      [{ pathPattern: "/a‮b" }, /bidirectional/],
      [{ pathPattern: "/" + "x".repeat(300) }, /1 to 200 characters/],
      [{ pathPattern: 7 }, /must be a string/],
      ["/watch", /page must be an object/],
    ];
    for (const [page, message] of cases) {
      const res = await post(body({ page }));
      expect(res.status, JSON.stringify(page)).toBe(400);
      expect(String(res.json.error)).toMatch(message);
    }
    expect(calls).toHaveLength(0);
  });

  it("treats a missing or null page as no caching, not as an error", async () => {
    const { post, calls } = appWith();
    expect((await post(body({ page: null }))).status).toBe(200);
    expect((await post(body({ page: { pathPattern: null } }))).status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});
