import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

describe("GET /v1/health", () => {
  it("reports ok and the active provider", async () => {
    const res = await createApp().request("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, provider: "heuristic" });
  });

  it("only allows the extension and localhost origins", async () => {
    const app = createApp();
    const ok = await app.request("/v1/health", { headers: { Origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const bad = await app.request("/v1/health", { headers: { Origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});
