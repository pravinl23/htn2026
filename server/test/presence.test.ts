import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { parseHeartbeat, PRESENCE_LIMITS, PRESENCE_TTL_MS, PresenceRegistry, registerPresenceRoutes, type PresenceEntry } from "../src/routes/presence";

const JSON_HEADERS = { "Content-Type": "application/json" };
type App = { request: Hono["request"] };

const post = (app: App, body: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  app.request("/v1/presence", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

async function clients(app: App): Promise<PresenceEntry[]> {
  const res = await app.request("/v1/presence");
  expect(res.status).toBe(200);
  return ((await res.json()) as { clients: PresenceEntry[] }).clients;
}

/** An app with a clock the test moves by hand. */
function clockedApp(start = 1_800_000_000_000) {
  const clock = { now: start };
  const app = new Hono();
  registerPresenceRoutes(app, loadConfig({}), { registry: new PresenceRegistry(() => clock.now) });
  return { app, clock };
}

describe("parseHeartbeat", () => {
  it("accepts the two clients, lowercases the browser and keeps the version", () => {
    expect(parseHeartbeat({ client: "extension", browser: " Chrome ", version: "0.1.0" })).toEqual({ client: "extension", browser: "chrome", version: "0.1.0" });
    expect(parseHeartbeat({ client: "desktop" })).toEqual({ client: "desktop" });
    expect(parseHeartbeat({ client: "desktop", browser: null, version: null })).toEqual({ client: "desktop" });
  });

  it("rejects unknown clients, wrong types, over-long and odd names without echoing them", () => {
    const secret = "hunter2<script>";
    const bad: unknown[] = [
      null,
      [],
      "extension",
      {},
      { client: "Extension" },
      { client: "daemon" },
      { client: "extension", browser: 7 },
      { client: "extension", browser: "" },
      { client: "extension", browser: "x".repeat(PRESENCE_LIMITS.browserChars + 1) },
      { client: "extension", browser: secret },
      { client: "extension", browser: "chrome", version: ["1"] },
      { client: "extension", browser: "chrome", version: "1".repeat(PRESENCE_LIMITS.versionChars + 1) },
      { client: "extension", browser: "chrome", version: secret },
    ];
    for (const body of bad) {
      let message = "";
      try {
        parseHeartbeat(body);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
    expect(parseHeartbeat({ client: "extension", browser: "x".repeat(PRESENCE_LIMITS.browserChars) }).browser).toHaveLength(PRESENCE_LIMITS.browserChars);
  });
});

describe("PresenceRegistry", () => {
  it("keeps one entry per client and browser, newest first, with the age on the server clock", () => {
    let now = 1_000_000;
    const registry = new PresenceRegistry(() => now);
    registry.beat({ client: "extension", browser: "chrome", version: "0.1.0" });
    now += 30_000;
    registry.beat({ client: "extension", browser: "firefox" });
    registry.beat({ client: "desktop", version: "0.1.0" });
    now += 30_000;
    registry.beat({ client: "extension", browser: "chrome", version: "0.2.0" });
    now += 1_000;
    expect(registry.list()).toEqual([
      { client: "extension", browser: "chrome", version: "0.2.0", lastSeenMs: 1_060_000, ageMs: 1_000 },
      { client: "desktop", browser: null, version: "0.1.0", lastSeenMs: 1_030_000, ageMs: 31_000 },
      { client: "extension", browser: "firefox", version: null, lastSeenMs: 1_030_000, ageMs: 31_000 },
    ]);
  });

  it("prunes a client five minutes after its last heartbeat", () => {
    let now = 0;
    const registry = new PresenceRegistry(() => now);
    registry.beat({ client: "extension", browser: "chrome" });
    now = 60_000;
    registry.beat({ client: "extension", browser: "firefox" });
    now = PRESENCE_TTL_MS;
    expect(registry.list().map((c) => c.browser)).toEqual(["firefox", "chrome"]);
    now = PRESENCE_TTL_MS + 1;
    expect(registry.list().map((c) => c.browser)).toEqual(["firefox"]);
    now = PRESENCE_TTL_MS + 60_001;
    expect(registry.list()).toEqual([]);
  });

  it("never reports a negative age when the clock steps back", () => {
    let now = 10_000;
    const registry = new PresenceRegistry(() => now);
    registry.beat({ client: "desktop" });
    now = 4_000;
    expect(registry.list()[0]?.ageMs).toBe(0);
  });

  it("is bounded: made-up browser names push out the oldest entries", () => {
    let now = 0;
    const registry = new PresenceRegistry(() => now);
    for (let i = 0; i < PRESENCE_LIMITS.clients + 10; i++) {
      now += 1;
      registry.beat({ client: "extension", browser: `b${i}` });
    }
    const list = registry.list();
    expect(list).toHaveLength(PRESENCE_LIMITS.clients);
    expect(list[0]?.browser).toBe(`b${PRESENCE_LIMITS.clients + 9}`);
    expect(list.some((c) => c.browser === "b0")).toBe(false);
  });
});

describe("/v1/presence routes", () => {
  it("records a heartbeat and lists it with its age, then forgets it after five minutes", async () => {
    const { app, clock } = clockedApp();
    expect(await clients(app)).toEqual([]);

    const res = await post(app, { client: "extension", browser: "chrome", version: "0.1.0" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    clock.now += 45_000;
    expect(await clients(app)).toEqual([{ client: "extension", browser: "chrome", version: "0.1.0", lastSeenMs: 1_800_000_000_000, ageMs: 45_000 }]);

    clock.now += 30_000;
    await post(app, { client: "extension", browser: "chrome", version: "0.1.0" });
    expect((await clients(app))[0]?.ageMs).toBe(0);

    clock.now += PRESENCE_TTL_MS + 1;
    expect(await clients(app)).toEqual([]);
  });

  it("answers 400 for a malformed heartbeat and stores nothing", async () => {
    const { app } = clockedApp();
    for (const body of ["{not json", "[]", { client: "browser" }, { client: "extension", browser: "x".repeat(33) }, { client: "extension", browser: 1 }]) {
      const res = await post(app, body);
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
    }
    expect(await clients(app)).toEqual([]);
  });

  it("answers 413 for an oversized body, declared or streamed", async () => {
    const { app } = clockedApp();
    const big = JSON.stringify({ client: "extension", browser: "chrome", padding: "x".repeat(PRESENCE_LIMITS.bodyBytes) });
    expect((await post(app, big)).status).toBe(413);
    expect((await post(app, big, { ...JSON_HEADERS, "Content-Length": "10" })).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const streamed = await app.request("/v1/presence", { method: "POST", headers: JSON_HEADERS, body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(await clients(app)).toEqual([]);
  });
});

describe("/v1/presence follows the server's access rules", () => {
  const app = () => createApp(loadConfig({}));
  const BEAT = { client: "extension", browser: "chrome", version: "0.1.0" };

  it("is registered on the real app and isolated between apps", async () => {
    const a = app();
    expect((await post(a, BEAT)).status).toBe(200);
    expect((await clients(a)).map((c) => c.browser)).toEqual(["chrome"]);
    expect(await clients(app())).toEqual([]);
  });

  it("requires application/json on POST", async () => {
    const hono = app();
    const wrong: Record<string, string>[] = [{}, { "Content-Type": "text/plain" }, { "Content-Type": "application/x-www-form-urlencoded" }];
    for (const headers of wrong) {
      expect((await post(hono, BEAT, headers)).status).toBe(415);
    }
    expect((await post(hono, BEAT, { "Content-Type": "application/json; charset=utf-8" })).status).toBe(200);
    expect(await clients(hono)).toHaveLength(1);
  });

  it("refuses a foreign Origin on both verbs and a Host that is not this machine", async () => {
    const hono = app();
    for (const origin of ["https://evil.com", "http://localhost.evil.com", "null"]) {
      const write = await post(hono, BEAT, { ...JSON_HEADERS, Origin: origin });
      expect(write.status).toBe(403);
      expect(write.headers.get("access-control-allow-origin")).toBeNull();
      expect((await hono.request("/v1/presence", { headers: { Origin: origin } })).status).toBe(403);
    }
    expect((await post(hono, BEAT, { ...JSON_HEADERS, Host: "attacker.example:8787" })).status).toBe(403);
    expect((await hono.request("http://attacker.example:8787/v1/presence")).status).toBe(403);
    expect(await clients(hono)).toEqual([]);
  });

  it("serves the extension origin with CORS headers and answers its preflight", async () => {
    const hono = app();
    const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const preflight = await hono.request("/v1/presence", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    const res = await post(hono, BEAT, { ...JSON_HEADERS, Origin: origin });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
  });
});
