import type { DecisionProvider } from "@ghost/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { buildFormDecision } from "../../src/providers/formQuestions";
import { createJevGatewayProvider } from "../../src/providers/jevGateway";
import { createLlmProvider } from "../../src/providers/llm";
import { SAMPLE_FACT_KEYS, sampleFormFields } from "../../src/providers/sampleForm";
import { createTypesafeProvider } from "../../src/providers/typesafe";

// Live only (pnpm test:live). At most THREE real calls per run: one 12-field form per provider that has a key.
// The generous timeout is for measuring: the server itself gives a provider 2.5 s before it falls back.
const LIVE_TIMEOUT_MS = 20_000;
const config = loadConfig({ ...process.env, GHOST_DECISION_PROVIDER: undefined, GHOST_TEXT_PROVIDER: undefined });

/** Rethrows with name, message and status only, so a failing run can never print request details. */
async function decideOnce(provider: DecisionProvider) {
  const { state, questions } = buildFormDecision("http://localhost:5173", sampleFormFields(), SAMPLE_FACT_KEYS);
  try {
    return await provider.decide(state, questions);
  } catch (err) {
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
    throw new Error(`${provider.name} live call failed: ${(err as Error).name}${status ? ` (HTTP ${status})` : ""}`);
  }
}

async function expectSaneMapping(provider: DecisionProvider): Promise<void> {
  const result = await decideOnce(provider);
  const picked = sampleFormFields().map((_, i) => {
    const answer = result.answers[`f${i}`];
    return answer?.type === "choice" ? answer : undefined;
  });
  const usage = result.usage ? ` inputTokens=${result.usage.inputTokens} outputTokens=${result.usage.outputTokens}` : "";
  console.log(`[live] decision provider=${result.provider} model=${result.model ?? "?"} latencyMs=${result.latencyMs} questions=12 calibrated=${result.calibrated}${usage}`);
  console.log(`[live] decision choices=${picked.map((a) => `${a?.choice}@${a?.confidence.toFixed(2)}`).join(" ")}`);

  expect(Object.keys(result.answers)).toHaveLength(12);
  expect(picked[0]?.choice).toBe("firstName");
  expect(picked[2]?.choice).toBe("email");
  expect(picked[4]?.choice).toBe("linkedin");
  expect(picked[11]?.choice).toBe("needs_text");
  for (const answer of picked) {
    expect(answer?.confidence).toBeGreaterThanOrEqual(0);
    expect(answer?.confidence).toBeLessThanOrEqual(1);
  }
  expect(result.latencyMs).toBeGreaterThan(0);
}

describe.skipIf(!config.typesafeApiKey)("live: TypeSafe direct", () => {
  it("maps a 12-field form in one call", async () => {
    await expectSaneMapping(createTypesafeProvider({ apiKey: config.typesafeApiKey ?? "", timeoutMs: LIVE_TIMEOUT_MS }));
  });
});

describe.skipIf(!config.aiGatewayApiKey)("live: Jev through Vercel AI Gateway", () => {
  it("maps a 12-field form in one call", async () => {
    await expectSaneMapping(createJevGatewayProvider({ apiKey: config.aiGatewayApiKey, timeoutMs: LIVE_TIMEOUT_MS }));
  });
});

describe.skipIf(!config.llm)("live: OpenAI-compatible LLM adapter", () => {
  it("maps a 12-field form in one call", async () => {
    if (!config.llm) return;
    await expectSaneMapping(createLlmProvider({ llm: config.llm, timeoutMs: LIVE_TIMEOUT_MS }));
  });
});
