import { DEMO_PROFILE } from "@ghost/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { createBasetenProvider } from "../../src/providers/baseten";
import { buildFormDecision } from "../../src/providers/formQuestions";
import { SAMPLE_FACT_KEYS, sampleFormFields } from "../../src/providers/sampleForm";
import { registerTextRoutes } from "../../src/routes/text";

// Live only (pnpm test:live), skipped without BASETEN_API_KEY. At most 5 real calls per run, well under the cap of 8:
// one decision = at most 3 samples + 1 hedge (clamped here whatever the .env says), plus one streamed draft.
// The account this was written against allows 15 requests per minute, so do not run it in a loop.
const config = loadConfig({ ...process.env, GHOST_PROVIDER: undefined, GHOST_DECISION_PROVIDER: "baseten", GHOST_TEXT_PROVIDER: "baseten", GHOST_WARMUP: "0" });
const baseten = config.baseten ? { ...config.baseten, samples: Math.min(config.baseten.samples, 3), hedge: Math.min(config.baseten.hedge, 1) } : undefined;
// Generous on purpose: this test measures. The server itself gives the vote 2.3 s.
const LIVE_TIMEOUT_MS = 20_000;
const EXPECTED = ["firstName", "lastName", "email", "phone", "linkedin", "github", "website", "school", "degree", "graduationDate", "referralSource", "needs_text"];

describe.skipIf(!baseten)("live: Baseten", () => {
  it("maps the 12-field form with ONE hedged vote, and its consensus probabilities are a distribution", async () => {
    if (!baseten) return;
    const provider = createBasetenProvider({ baseten, timeoutMs: LIVE_TIMEOUT_MS });
    const { state, questions } = buildFormDecision("http://localhost:5173", sampleFormFields(), SAMPLE_FACT_KEYS);
    const result = await provider.decide(state, questions).catch((err: unknown) => {
      // Name and status only, so a failing run can never print request details.
      throw new Error(`baseten live call failed: ${(err as Error).name} ${(err as Error).message}`);
    });
    const picked = EXPECTED.map((_, i) => {
      const answer = result.answers[`f${i}`];
      return answer?.type === "choice" ? answer : undefined;
    });
    const s = result.sampling;
    console.log(`[live] baseten decision model=${result.model} latencyMs=${result.latencyMs} arrivalsMs=${s.arrivalsMs.join("/")} launched=${s.launched} received=${s.samplesReceived} failed=${s.failed} abandoned=${s.abandoned} rateLimited=${s.rateLimited} logprobsSeen=${s.logprobsSeen} inputTokens=${result.usage?.inputTokens} outputTokens=${result.usage?.outputTokens}`);
    console.log(`[live] baseten choices=${picked.map((a) => `${a?.choice}@${a?.confidence.toFixed(2)}`).join(" ")}`);

    expect(s.launched).toBeLessThanOrEqual(4);
    expect(result).toMatchObject({ provider: "baseten", calibrated: false });
    expect(Object.keys(result.answers)).toHaveLength(12);
    expect(picked[0]?.choice).toBe("firstName");
    expect(picked[2]?.choice).toBe("email");
    expect(picked[4]?.choice).toBe("linkedin");
    expect(picked[11]?.choice).toBe("needs_text");
    for (const answer of picked) {
      expect(answer?.confidenceSource).toBe(s.logprobsSeen ? "logprobs" : "consensus");
      expect(answer?.confidence).toBeGreaterThan(0);
      expect(answer?.confidence).toBeLessThan(1);
      expect(Object.values(answer?.probabilities ?? {}).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
    expect(result.latencyMs).toBeGreaterThan(0);
  });

  it("streams one draft with thinking off, logs TTFT, and leaks no reasoning", async () => {
    const app = new Hono();
    registerTextRoutes(app, config);
    const { school, major, graduationDate } = DEMO_PROFILE.facts;
    const res = await app.request("/v1/ghost-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fieldLabel: "Why do you want to work at Northwind Robotics?",
        fieldSignature: "live|baseten|why",
        maxChars: 360, // keeps the request at 120 output tokens
        pageContext: { company: "Northwind Robotics", role: "Software Engineering Intern", description: "Build the software that coordinates fleets of warehouse robots." },
        facts: { school, major, graduationDate },
        pastAnswers: [],
      }),
    });
    const events = (await res.text()).split("\n\n").filter(Boolean).map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>);
    const done = events[events.length - 1] ?? {};
    const text = String(done.text ?? "");
    console.log(`[live] baseten ghost-text model=${config.baseten?.textModel} firstTokenMs=${String(done.firstTokenMs)} latencyMs=${String(done.latencyMs)} deltas=${events.length - 1} chars=${text.length}${done.fallbackFrom ? ` fallbackFrom=${String(done.fallbackFrom)}` : ""}`);

    expect(done).toMatchObject({ done: true, provider: "baseten" });
    expect(text.length).toBeGreaterThan(40);
    expect(text.length).toBeLessThanOrEqual(360);
    expect(events.length).toBeGreaterThan(2);
    const streamed = JSON.stringify(events);
    expect(streamed).not.toMatch(/<\/?think>/i);
    expect(streamed).not.toContain("reasoning_content");
    // A first-person draft, not a plan for one.
    expect(text).not.toMatch(/^(okay|alright|let me|let's|the user|we need|first,|hmm)/i);
  });
});
