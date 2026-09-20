import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createDecisionProvider } from "../src/providers/index";
import { registerPredictRoutes } from "../src/routes/predict";

const FAKE_KEY = "test-key-not-real";
const app = () => createApp(loadConfig({}));

async function healthFor(env: Record<string, string>): Promise<Record<string, unknown>> {
  const config = loadConfig(env);
  const noNetwork = async () => Promise.reject(new Error("network is not allowed in unit tests"));
  const hono = new Hono();
  registerPredictRoutes(hono, config, { provider: createDecisionProvider(config, { fetch: noNetwork as unknown as typeof fetch, evaluate: noNetwork }) });
  const res = await hono.request("/v1/health");
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /v1/health", () => {
  it("reports ok and the active provider", async () => {
    const res = await app().request("/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, provider: "heuristic", calibrated: false, textProvider: "template", version: expect.any(String) });
    expect(body.model).toBeUndefined();
  });

  it("reports the model and calibration of each provider, and never a key", async () => {
    const typesafe = await healthFor({ TYPESAFE_API_KEY: FAKE_KEY });
    expect(typesafe).toMatchObject({ provider: "typesafe", calibrated: true, model: "jev-latest" });
    expect(await healthFor({ AI_GATEWAY_API_KEY: FAKE_KEY })).toMatchObject({ provider: "jev-gateway", calibrated: true, model: "typesafe-ai/jev" });
    expect(await healthFor({ XAI_API_KEY: FAKE_KEY })).toMatchObject({ provider: "llm", calibrated: false, textProvider: "xai", model: "grok-4.20-non-reasoning" });
    expect(JSON.stringify(typesafe)).not.toContain(FAKE_KEY);
  });

  it("honors the test overrides even when keys are present", async () => {
    const body = await healthFor({ TYPESAFE_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY, SHABANG_DECISION_PROVIDER: "heuristic", SHABANG_TEXT_PROVIDER: "template" });
    expect(body).toMatchObject({ provider: "heuristic", textProvider: "template" });
  });

  it("SHABANG_PROVIDER=heuristic (the e2e web server) stays fully offline whatever keys the .env holds", async () => {
    const config = loadConfig({ XAI_API_KEY: FAKE_KEY, AI_GATEWAY_API_KEY: FAKE_KEY, SHABANG_PROVIDER: "heuristic" });
    expect(config).toMatchObject({ decisionProvider: "heuristic", textProvider: "template", llm: undefined });
  });

  it("only allows the extension and localhost origins", async () => {
    const ok = await app().request("/v1/health", { headers: { Origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const ext = await app().request("/v1/health", { headers: { Origin: "chrome-extension://abcdefghijklmnop" } });
    expect(ext.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnop");
    const bad = await app().request("/v1/health", { headers: { Origin: "https://evil.example" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});
