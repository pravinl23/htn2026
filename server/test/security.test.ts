import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { startServer } from "../src/listen";
import type { MetricsSnapshot } from "../src/lib/metrics";
import { sampleFormRequest } from "../src/providers/sampleForm";

const JSON_HEADERS = { "Content-Type": "application/json" };
const app = () => createApp(loadConfig({}));
const EVENT = JSON.stringify({ counters: { ghostsShown: 1_000_000 } });

describe("listen address", () => {
  it("binds loopback by default, never the wildcard address", async () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({ SHABANG_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    const server = startServer(loadConfig({ PORT: "0" }));
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    expect(address.address).toBe("127.0.0.1");
  });
});

describe("cross-site and rebinding protection", () => {
  it("refuses a foreign Origin outright instead of only withholding CORS headers", async () => {
    const hono = app();
    for (const origin of ["https://evil.com", "http://localhost.evil.com", "http://localhost:5173.evil.com", "chrome-extension://abc.evil.com", "null"]) {
      const res = await hono.request("/v1/metrics/event", { method: "POST", headers: { ...JSON_HEADERS, Origin: origin }, body: EVENT });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    const snap = (await (await hono.request("/v1/metrics")).json()) as MetricsSnapshot;
    expect(snap.counters.ghostsShown).toBe(0);
  });

  it("requires application/json on POST, so a cross-site 'simple' request can never reach a handler", async () => {
    const hono = app();
    const bodies: [string, string][] = [["/v1/predict/form", JSON.stringify(sampleFormRequest())], ["/v1/metrics/event", EVENT], ["/v1/shabang-text?stream=0", JSON.stringify({ fieldLabel: "Why us?" })]];
    for (const [path, body] of bodies) {
      const wrong: Record<string, string>[] = [{}, { "Content-Type": "text/plain" }, { "Content-Type": "application/x-www-form-urlencoded" }];
      for (const headers of wrong) {
        expect((await hono.request(path, { method: "POST", headers, body })).status).toBe(415);
      }
      expect((await hono.request(path, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body })).status).toBe(200);
    }
  });

  it("refuses a Host that is not this machine (DNS rebinding)", async () => {
    const hono = app();
    expect((await hono.request("http://attacker.example:8787/v1/health")).status).toBe(403);
    expect((await hono.request("/v1/health", { headers: { Host: "attacker.example:8787" } })).status).toBe(403);
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787", "LOCALHOST"]) {
      expect((await hono.request("/v1/health", { headers: { Host: host } })).status).toBe(200);
    }
  });

  it("still serves the extension and the local demo, preflight included", async () => {
    const hono = app();
    const preflight = await hono.request("/v1/predict/form", {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://abcdefghijklmnop", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnop");
    const res = await hono.request("/v1/predict/form", { method: "POST", headers: { ...JSON_HEADERS, Origin: "http://localhost:5173" }, body: JSON.stringify(sampleFormRequest()) });
    expect(res.status).toBe(200);
  });

  it("stops reading a chunked metrics event at the limit", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(16_000));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const res = await app().request(new Request("http://localhost/v1/metrics/event", { method: "POST", headers: JSON_HEADERS, body: endless, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });
});
