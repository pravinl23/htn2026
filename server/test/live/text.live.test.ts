import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEMO_PROFILE } from "@ghost/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { registerTextRoutes } from "../../src/routes/text";

// Live only (pnpm test:live). Exactly two real calls per run: one streamed draft (<= 120 tokens) and one extraction.
const hasKey = Boolean(process.env.XAI_API_KEY || process.env.OPENAI_API_KEY);
const RESUME = readFileSync(fileURLToPath(new URL("../../../demo/fixtures/resume-alex-chen.txt", import.meta.url)), "utf8");

function liveApp(): { app: Hono; provider: string } {
  const config = loadConfig({ ...process.env, GHOST_TEXT_PROVIDER: undefined });
  const app = new Hono();
  registerTextRoutes(app, config);
  return { app, provider: config.textProvider };
}

function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

describe.skipIf(!hasKey)("live text provider", () => {
  it("streams one ghost-text draft and reports first-token and total latency", async () => {
    const { app, provider } = liveApp();
    const { school, major, graduationDate, github } = DEMO_PROFILE.facts;
    const res = await post(app, "/v1/ghost-text", {
      fieldLabel: "Why Northwind?",
      fieldSignature: "live|why",
      maxChars: 360, // keeps the request at 120 output tokens
      pageContext: { company: "Northwind Robotics", role: "Software Engineering Intern", description: "Build the software that coordinates fleets of warehouse robots." },
      facts: { school, major, graduationDate, github },
      pastAnswers: [],
    });
    const events = (await res.text()).split("\n\n").filter(Boolean).map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
    const done = events[events.length - 1] ?? {};
    console.log(`[live] ghost-text provider=${String(done.provider)} firstTokenMs=${String(done.firstTokenMs)} latencyMs=${String(done.latencyMs)} deltas=${events.length - 1} chars=${String(done.text).length}${done.fallbackFrom ? ` fallbackFrom=${String(done.fallbackFrom)}` : ""}`);
    expect(done.done).toBe(true);
    expect(done.provider).toBe(provider);
    expect(String(done.text).length).toBeGreaterThan(40);
    expect(String(done.text).length).toBeLessThanOrEqual(360);
    expect(events.length).toBeGreaterThan(2);
  });

  it("extracts the fixture resume through the LLM and keeps the code-parsed graduation date", async () => {
    const { app, provider } = liveApp();
    const res = await post(app, "/v1/profile/extract", { resumeText: RESUME });
    const json = (await res.json()) as { facts: Record<string, string>; provider: string; latencyMs: number; fallbackFrom?: string };
    console.log(`[live] profile/extract provider=${json.provider} latencyMs=${json.latencyMs} facts=${Object.keys(json.facts).length}${json.fallbackFrom ? ` fallbackFrom=${json.fallbackFrom}` : ""}`);
    expect(json.provider).toBe(provider);
    expect(json.facts).toMatchObject({ email: DEMO_PROFILE.facts.email, school: DEMO_PROFILE.facts.school, graduationDate: "2028-04" });
    expect(json.facts.firstName).toBe("Alex");
  });
});
