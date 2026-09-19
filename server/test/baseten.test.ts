import type { Questions } from "@ghost/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { BASETEN_DEFAULT_BASE_URL, BASETEN_DEFAULT_MODEL, loadConfig, type BasetenConfig } from "../src/config";
import { fakeFetch, type FakeCall } from "../src/llm/testing";
import {
  aliasOptions,
  buildDecisionPlan,
  buildRequestBody,
  createBasetenProvider,
  maxTokensFor,
  parseAnswerJson,
  readLogprobs,
  thinkingControl,
  valueProbabilities,
} from "../src/providers/baseten";
import { buildFormDecision } from "../src/providers/formQuestions";
import { createDecisionProvider, providerModel, textModel } from "../src/providers/index";
import { SAMPLE_FACT_KEYS, sampleFormFields, sampleFormRequest } from "../src/providers/sampleForm";
import { registerPredictRoutes } from "../src/routes/predict";

const FAKE_KEY = "test-key-not-real";
const MODEL = BASETEN_DEFAULT_MODEL;

const QUESTIONS: Questions = {
  route: { type: "choice", instructions: "Route `ticket`.", criteria: { billing: "payment problems", shipping: null, none: "nothing fits" } },
  refunded: { type: "noul", instructions: "Was a refund issued?" },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
};
const GOOD = { route: "billing", refunded: "yes", urgency: "2" };

function baseten(overrides: Partial<BasetenConfig> = {}): BasetenConfig {
  const config = loadConfig({ BASETEN_API_KEY: FAKE_KEY }).baseten;
  if (!config) throw new Error("no baseten config");
  return { ...config, ...overrides };
}

function completion(answers: unknown, init: { headers?: Record<string, string>; extra?: Record<string, unknown> } = {}): Response {
  const content = typeof answers === "string" ? answers : JSON.stringify(answers);
  return Response.json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content }, ...init.extra }], usage: { prompt_tokens: 100, completion_tokens: 10 } }, { headers: init.headers });
}

/** Answers after `ms`, or rejects the moment the provider aborts the request. */
function after(ms: number, call: FakeCall, make: () => Response): Promise<Response> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(call.signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      call.signal?.removeEventListener("abort", onAbort);
      resolve(make());
    }, ms);
    call.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

describe("config: BASETEN_*", () => {
  it("a key enables Baseten for decisions and for text, with the verified defaults", () => {
    const config = loadConfig({ BASETEN_API_KEY: FAKE_KEY });
    expect(config).toMatchObject({ decisionProvider: "baseten", textProvider: "baseten" });
    expect(config.baseten).toEqual({ apiKey: FAKE_KEY, baseUrl: BASETEN_DEFAULT_BASE_URL, decisionModel: "zai-org/GLM-5.3-Flash", textModel: "zai-org/GLM-5.3-Flash", samples: 3, hedge: 1, decisionBaseUrl: undefined, logprobs: false, warmup: true });
    expect(BASETEN_DEFAULT_BASE_URL).toBe("https://inference.baseten.co/v1");
  });

  it("reads every BASETEN_* variable", () => {
    const config = loadConfig({
      BASETEN_API_KEY: FAKE_KEY,
      BASETEN_BASE_URL: "https://example.test/v1",
      BASETEN_DECISION_MODEL: "deepseek-ai/DeepSeek-V4.1-Flash",
      BASETEN_TEXT_MODEL: "zai-org/GLM-4.7",
      BASETEN_SAMPLES: "5",
      BASETEN_HEDGE: "2",
      BASETEN_DECISION_MODEL_URL: "https://model-abc.api.baseten.co/environments/production/sync/v1",
      BASETEN_LOGPROBS: "1",
      GHOST_WARMUP: "0",
    }).baseten;
    expect(config).toMatchObject({ baseUrl: "https://example.test/v1", decisionModel: "deepseek-ai/DeepSeek-V4.1-Flash", textModel: "zai-org/GLM-4.7", samples: 5, hedge: 2, logprobs: true, warmup: false });
    expect(config?.decisionBaseUrl).toContain("model-abc");
  });

  it("clamps samples and hedge, because every one of them is a billed request", () => {
    expect(loadConfig({ BASETEN_API_KEY: FAKE_KEY, BASETEN_SAMPLES: "99", BASETEN_HEDGE: "99" }).baseten).toMatchObject({ samples: 8, hedge: 4 });
    expect(loadConfig({ BASETEN_API_KEY: FAKE_KEY, BASETEN_SAMPLES: "0", BASETEN_HEDGE: "-3" }).baseten).toMatchObject({ samples: 1, hedge: 0 });
    expect(loadConfig({ BASETEN_API_KEY: FAKE_KEY, BASETEN_SAMPLES: "many", BASETEN_HEDGE: "1.5" }).baseten).toMatchObject({ samples: 3, hedge: 1 });
    expect(loadConfig({ BASETEN_API_KEY: FAKE_KEY, BASETEN_SAMPLES: "", BASETEN_HEDGE: "0" }).baseten).toMatchObject({ samples: 3, hedge: 0 });
  });

  it("decision precedence: typesafe > jev-gateway > baseten > llm > heuristic", () => {
    const all = { TYPESAFE_API_KEY: FAKE_KEY, AI_GATEWAY_API_KEY: FAKE_KEY, BASETEN_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY, XAI_API_KEY: FAKE_KEY };
    expect(loadConfig(all).decisionProvider).toBe("typesafe");
    expect(loadConfig({ ...all, TYPESAFE_API_KEY: "" }).decisionProvider).toBe("jev-gateway");
    expect(loadConfig({ ...all, TYPESAFE_API_KEY: "", AI_GATEWAY_API_KEY: "" }).decisionProvider).toBe("baseten");
    expect(loadConfig({ OPENAI_API_KEY: FAKE_KEY }).decisionProvider).toBe("llm");
    expect(loadConfig({}).decisionProvider).toBe("heuristic");
  });

  it("text precedence: baseten > openai > xai > template", () => {
    expect(loadConfig({ BASETEN_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY, XAI_API_KEY: FAKE_KEY }).textProvider).toBe("baseten");
    expect(loadConfig({ OPENAI_API_KEY: FAKE_KEY, XAI_API_KEY: FAKE_KEY }).textProvider).toBe("openai");
    expect(loadConfig({ XAI_API_KEY: FAKE_KEY }).textProvider).toBe("xai");
    expect(loadConfig({}).textProvider).toBe("template");
  });

  it("GHOST_DECISION_PROVIDER / GHOST_TEXT_PROVIDER accept baseten, and degrade without a key", () => {
    const forced = loadConfig({ TYPESAFE_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY, BASETEN_API_KEY: FAKE_KEY, GHOST_DECISION_PROVIDER: "baseten", GHOST_TEXT_PROVIDER: "baseten" });
    expect(forced).toMatchObject({ decisionProvider: "baseten", textProvider: "baseten" });
    expect(createDecisionProvider(forced).name).toBe("baseten");
    const keyless = loadConfig({ OPENAI_API_KEY: FAKE_KEY, GHOST_DECISION_PROVIDER: "baseten", GHOST_TEXT_PROVIDER: "baseten" });
    expect(createDecisionProvider(keyless).name).toBe("heuristic");
    expect(keyless.textProvider).toBe("template");
    expect(keyless.baseten).toBeUndefined();
  });

  it("keeps the Baseten config only while Baseten is an active provider", () => {
    expect(loadConfig({ BASETEN_API_KEY: FAKE_KEY, GHOST_DECISION_PROVIDER: "heuristic" }).baseten).toBeDefined(); // still drafts text
    expect(loadConfig({ BASETEN_API_KEY: FAKE_KEY, GHOST_DECISION_PROVIDER: "heuristic", GHOST_TEXT_PROVIDER: "template" }).baseten).toBeUndefined();
    expect(loadConfig({ BASETEN_API_KEY: FAKE_KEY, GHOST_PROVIDER: "heuristic" })).toMatchObject({ decisionProvider: "heuristic", textProvider: "template", baseten: undefined });
    expect(loadConfig({ BASETEN_API_KEY: FAKE_KEY, TYPESAFE_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY, GHOST_TEXT_PROVIDER: "openai" }).baseten).toBeUndefined();
  });

  it("forcing heuristic + template guarantees ZERO network, whatever keys exist", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("network is not allowed");
    }) as typeof fetch;
    try {
      const app = createApp(loadConfig({ BASETEN_API_KEY: FAKE_KEY, XAI_API_KEY: FAKE_KEY, GHOST_DECISION_PROVIDER: "heuristic", GHOST_TEXT_PROVIDER: "template" }));
      const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const form = (await (await post("/v1/predict/form", sampleFormRequest())).json()) as { provider: string };
      const text = (await (await post("/v1/ghost-text?stream=0", { fieldLabel: "Why us?", pageContext: {}, facts: { school: "Waterloo" }, pastAnswers: [] })).json()) as { provider: string };
      expect(form.provider).toBe("heuristic");
      expect(text.provider).toBe("template");
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("GET /v1/health with Baseten", () => {
  it("reports the provider, both models and the sampling plan, and never the key", async () => {
    const config = loadConfig({ BASETEN_API_KEY: FAKE_KEY, BASETEN_TEXT_MODEL: "zai-org/GLM-4.7", BASETEN_SAMPLES: "5" });
    const app = new Hono();
    registerPredictRoutes(app, config, { provider: createDecisionProvider(config, { fetch: fakeFetch(() => completion(GOOD)).fetch }) });
    const body = (await (await app.request("/v1/health")).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, provider: "baseten", calibrated: false, textProvider: "baseten", model: MODEL, textModel: "zai-org/GLM-4.7", sampling: { samples: 5, hedge: 1, confidenceSource: "consensus" } });
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
  });

  it("names the text model of the other providers too, and nothing for the template", () => {
    const xai = loadConfig({ XAI_API_KEY: FAKE_KEY });
    expect(textModel(xai)).toBe("grok-4.20-non-reasoning");
    expect(textModel(loadConfig({}))).toBeUndefined();
    const config = loadConfig({ BASETEN_API_KEY: FAKE_KEY });
    expect(providerModel(createDecisionProvider(config), config)).toBe(MODEL);
  });
});

describe("thinking control table", () => {
  it("switches thinking off the way each family was verified to accept", () => {
    expect(thinkingControl("zai-org/GLM-5.3-Flash")).toEqual({ mode: "off", body: { chat_template_kwargs: { enable_thinking: false } } });
    expect(thinkingControl("deepseek-ai/DeepSeek-V4.1-Flash")).toEqual({ mode: "off", body: { chat_template_kwargs: { thinking: false, enable_thinking: false } } });
    expect(thinkingControl("openai/gpt-oss-120b")).toEqual({ mode: "low", body: { reasoning_effort: "low" } });
  });

  it("sends nothing to models that reject or ignore the switch", () => {
    expect(thinkingControl("zai-org/GLM-5.3-Fast")).toEqual({ mode: "required", body: {} }); // 400 otherwise
    expect(thinkingControl("zai-org/GLM-5.2-Fast").mode).toBe("required");
    expect(thinkingControl("thinkingmachines/inkling-small")).toEqual({ mode: "required", body: {} });
  });

  it("asks an unknown model (our own deployment) not to think", () => {
    expect(thinkingControl("ghost/tab-model-v1")).toEqual({ mode: "unknown", body: { chat_template_kwargs: { enable_thinking: false } } });
  });

  it("leaves token headroom for models that must reason", () => {
    expect(maxTokensFor(12)).toBe(48 + 16 * 12);
    expect(maxTokensFor(12, "required")).toBe(48 + 16 * 12 + 700);
    expect(maxTokensFor(10_000)).toBe(2000);
  });
});

describe("decision plan", () => {
  it("puts ALL questions into ONE prompt and constrains every answer with an enum", () => {
    const plan = buildDecisionPlan(MODEL, { ticket: "charged twice" }, QUESTIONS);
    expect(plan.schema).toEqual({
      type: "object",
      properties: {
        route: { type: "string", enum: ["billing", "shipping", "none"] },
        refunded: { type: "string", enum: ["yes", "no"] },
        urgency: { type: "string", enum: ["0", "1", "2"] },
      },
      required: ["route", "refunded", "urgency"],
      additionalProperties: false,
    });
    expect(plan.messages).toHaveLength(2);
    const user = JSON.parse(plan.messages[1]?.content ?? "{}") as { state: unknown; optionSets: Record<string, unknown>; questions: Record<string, Record<string, unknown>> };
    expect(user.state).toEqual({ ticket: "charged twice" });
    expect(user.optionSets).toEqual({ set0: { billing: "payment problems", shipping: null, none: "nothing fits" } });
    expect(user.questions.route).toEqual({ type: "choice", instructions: "Route `ticket`.", options: "set0" });
    expect(user.questions.urgency?.levels).toEqual({ "0": "low", "1": "medium", "2": "high" });
  });

  it("sends the option list of a 12-field form once, not once per field", () => {
    const { state, questions } = buildFormDecision("http://localhost:5173", sampleFormFields(), SAMPLE_FACT_KEYS);
    const plan = buildDecisionPlan(MODEL, state, questions);
    const user = JSON.parse(plan.messages[1]?.content ?? "{}") as { optionSets: Record<string, unknown>; questions: Record<string, { options: string }> };
    expect(Object.keys(user.optionSets)).toEqual(["set0"]);
    expect(Object.values(user.questions).every((q) => q.options === "set0")).toBe(true);
    expect(Object.keys((plan.schema.properties ?? {}) as object)).toHaveLength(12);
    expect(plan.maxTokens).toBe(48 + 16 * 12);
  });

  it("keeps short option names, aliases long or odd ones to codes, and maps the codes back", () => {
    const long = "button:nth-of-type(3) > span.the-really-long-selector-of-a-candidate";
    expect(aliasOptions(["email", "needs_text", long, "has space", "none"])).toEqual(["email", "needs_text", "o2", "o3", "none"]);
    expect(aliasOptions(["o1", long])).toEqual(["o1", "o1_"]); // a generated code never shadows a real option

    const plan = buildDecisionPlan(MODEL, "state", { next: { type: "choice", instructions: "Which?", criteria: { [long]: "Apply button", "has space": null, none: null } } });
    expect(plan.schema.properties).toEqual({ next: { type: "string", enum: ["o0", "o1", "none"] } });
    const user = JSON.parse(plan.messages[1]?.content ?? "{}") as { optionSets: Record<string, Record<string, string | null>> };
    expect(user.optionSets.set0).toEqual({ o0: `${long}: Apply button`, o1: "has space", none: null });
    expect(plan.decode({ next: "o0" })).toEqual({ next: long });
    expect(plan.decode({ next: long })).toEqual({}); // only offered codes count
  });

  it("decodes votes by type and drops anything that was not offered", () => {
    const plan = buildDecisionPlan(MODEL, "state", QUESTIONS);
    expect(plan.decode({ route: "billing", refunded: "no", urgency: "1" })).toEqual({ route: "billing", refunded: false, urgency: 1 });
    expect(plan.decode({ route: "refunds", refunded: "maybe", urgency: "7", extra: "x" })).toEqual({});
    expect(plan.decode({ urgency: 2, route: null })).toEqual({ urgency: 2 });
  });

  it("derives a session affinity that is stable per schema and model", () => {
    const form = (n: number) => buildFormDecision("http://a.test", sampleFormFields().slice(0, n), SAMPLE_FACT_KEYS);
    const a = buildDecisionPlan(MODEL, form(12).state, form(12).questions);
    const sameSchemaOtherPage = buildDecisionPlan(MODEL, { page: "another" }, form(12).questions);
    expect(a.affinity).toMatch(/^ghost-[0-9a-f]{16}$/);
    expect(sameSchemaOtherPage.affinity).toBe(a.affinity);
    expect(buildDecisionPlan(MODEL, form(5).state, form(5).questions).affinity).not.toBe(a.affinity);
    expect(buildDecisionPlan("zai-org/GLM-4.7", form(12).state, form(12).questions).affinity).not.toBe(a.affinity);
  });

  it("builds a strict json_schema request with thinking off, and no logprobs unless asked", () => {
    const plan = buildDecisionPlan(MODEL, "state", QUESTIONS);
    const body = buildRequestBody(MODEL, plan, { temperature: 0.7 });
    expect(body).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      model: MODEL,
      messages: plan.messages,
      temperature: 0.7,
      max_tokens: 48 + 16 * 3,
      response_format: { type: "json_schema", json_schema: { name: "ghost_decision", strict: true, schema: plan.schema } },
    });
    expect(buildRequestBody(MODEL, plan, { temperature: 0, logprobs: true })).toMatchObject({ logprobs: true, top_logprobs: 5 });
    expect(buildRequestBody("zai-org/GLM-5.3-Fast", plan, { temperature: 0 })).not.toHaveProperty("chat_template_kwargs");
  });
});

describe("parseAnswerJson", () => {
  it("reads plain, fenced and wrapped answers, and drops a <think> block", () => {
    expect(parseAnswerJson('{"f0":"email"}')).toEqual({ f0: "email" });
    expect(parseAnswerJson('```json\n{"f0":"email"}\n```')).toEqual({ f0: "email" });
    expect(parseAnswerJson('{"answers":{"f0":"email"}}')).toEqual({ f0: "email" });
    expect(parseAnswerJson('<think>the label says email</think>\n{"f0":"email"}')).toEqual({ f0: "email" });
  });

  it("salvages the complete pairs of a reply cut off by the token limit", () => {
    expect(parseAnswerJson('{\n  "f0": "firstName",\n  "f1": "lastName",\n  "f2": "em')).toEqual({ f0: "firstName", f1: "lastName" });
  });

  it("returns undefined for text with no answer in it", () => {
    expect(parseAnswerJson("I cannot help with that.")).toBeUndefined();
    expect(parseAnswerJson("[1,2]")).toBeUndefined();
  });
});

describe("baseten provider: hedged self-consistency", () => {
  it("fires K + H identical requests in parallel and answers from the first K", async () => {
    const { fetch, calls } = fakeFetch(() => completion(GOOD));
    const provider = createBasetenProvider({ baseten: baseten(), fetch });
    const result = await provider.decide({ ticket: "charged twice" }, QUESTIONS);

    expect(calls).toHaveLength(4); // K=3 samples + H=1 hedge
    expect(new Set(calls.map((c) => JSON.stringify(c.body))).size).toBe(1);
    const first = calls[0];
    expect(first?.url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(first?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(first?.headers["x-session-affinity"]).toMatch(/^ghost-[0-9a-f]{16}$/);
    expect(first?.body).toMatchObject({ model: MODEL, temperature: 0.7, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema" } });
    expect(first?.body).not.toHaveProperty("logprobs");
    expect(first?.body).not.toHaveProperty("n"); // n > 1 is not supported: sampling means parallel requests

    expect(result).toMatchObject({ provider: "baseten", model: MODEL, calibrated: false, usage: { inputTokens: 300, outputTokens: 30 } });
    expect(result.sampling).toMatchObject({ samplesExpected: 3, hedge: 1, launched: 4, samplesReceived: 3, partial: false, logprobsSeen: false });
    expect(result.answers.route).toMatchObject({ type: "choice", choice: "billing", confidenceSource: "consensus", votes: 3 });
    expect(result.answers.route).toMatchObject({ confidence: (3 + 1 / 3) / 4 });
    expect(result.answers.refunded).toMatchObject({ type: "noul", noul: 3.5 / 4 });
    expect(result.answers.urgency).toMatchObject({ type: "score", score: 2, legend: { "2": "high" } });
    expect(provider.calibrated).toBe(false);
  });

  it("consensus probabilities sum to 1, and disagreement lowers confidence below the gate", async () => {
    const replies = [GOOD, { ...GOOD, route: "shipping" }, GOOD, GOOD];
    const { fetch } = fakeFetch(() => completion(replies.shift()));
    const result = await createBasetenProvider({ baseten: baseten({ hedge: 0 }), fetch }).decide("state", QUESTIONS);
    const route = result.answers.route;
    if (route?.type !== "choice") throw new Error("no route answer");
    expect(route.choice).toBe("billing");
    expect(Object.values(route.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(route.confidence).toBeCloseTo((2 + 1 / 3) / 4, 12);
    expect(route.confidence).toBeLessThan(0.7);
  });

  it("aborts the straggler once K answers are in (tail-latency hedging)", async () => {
    const delays = [5, 2000, 10, 15];
    const { fetch, calls } = fakeFetch((call) => after(delays[calls.length - 1] ?? 0, call, () => completion(GOOD)));
    const started = performance.now();
    const result = await createBasetenProvider({ baseten: baseten(), fetch }).decide("state", QUESTIONS);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.sampling).toMatchObject({ samplesReceived: 3, abandoned: 1, partial: false });
    expect(calls.map((c) => c.signal?.aborted)).toEqual([true, true, true, true]); // the shared signal: only request 1 was still running
  });

  it("discards an invalid sample (a reasoning model that ran out of tokens) and lets the hedge fill in", async () => {
    const thinking = Response.json({ choices: [{ finish_reason: "length", message: { role: "assistant", content: null, reasoning_content: "Let me think about field 0..." } }] });
    let n = 0;
    const { fetch, calls } = fakeFetch(() => ((n += 1) === 1 ? thinking : completion(GOOD)));
    const result = await createBasetenProvider({ baseten: baseten(), fetch }).decide("state", QUESTIONS);
    expect(calls).toHaveLength(4);
    expect(result.sampling).toMatchObject({ samplesReceived: 3, failed: 1 });
    expect(JSON.stringify(result.answers)).not.toContain("Let me think");
  });

  it("at the deadline it answers from what arrived, with lower confidence", async () => {
    const { fetch, calls } = fakeFetch((call) => after(calls.length === 1 ? 5 : 5000, call, () => completion(GOOD)));
    const result = await createBasetenProvider({ baseten: baseten(), fetch, timeoutMs: 80 }).decide("state", QUESTIONS);
    expect(result.sampling).toMatchObject({ samplesReceived: 1, partial: true, abandoned: 3 });
    expect(result.answers.route).toMatchObject({ choice: "billing", votes: 1, expected: 3 });
    expect(result.answers.route).toMatchObject({ confidence: ((1 + 1 / 3) / 2) * (1 / 3) });
    expect(calls.every((c) => c.signal?.aborted)).toBe(true);
  });

  it("with zero samples at the deadline it throws, so the heuristic fallback takes over", async () => {
    const { fetch } = fakeFetch((call) => after(5000, call, () => completion(GOOD)));
    const provider = createBasetenProvider({ baseten: baseten(), fetch, timeoutMs: 40 });
    await expect(provider.decide("state", QUESTIONS)).rejects.toMatchObject({ name: "DecisionProviderError", message: "baseten: no valid sample within 40 ms" });
  });

  it("finishes inside the server's 2.5 s decision deadline by default", async () => {
    const { BASETEN_DEADLINE_MS } = await import("../src/providers/baseten");
    const { DECISION_TIMEOUT_MS } = await import("../src/providers/timeout");
    expect(BASETEN_DEADLINE_MS).toBeLessThan(DECISION_TIMEOUT_MS);
    expect(BASETEN_DEADLINE_MS).toBeGreaterThanOrEqual(2000);
  });

  it("never retries beyond the hedge: 4 failed requests are 4 requests, then it throws with the status only", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(`{"error":"boom ${FAKE_KEY}"}`, { status: 500 }));
    const provider = createBasetenProvider({ baseten: baseten(), fetch });
    const err = await provider.decide("state", QUESTIONS).catch((e: unknown) => e as Error & { status?: number });
    expect(err).toMatchObject({ name: "DecisionProviderError", message: "baseten: HTTP 500", status: 500 });
    expect(String(err)).not.toContain(FAKE_KEY);
    expect(calls).toHaveLength(4);
  });

  it("uses temperature 0 when there is nothing to compare (K = 1)", async () => {
    const { fetch, calls } = fakeFetch(() => completion(GOOD));
    const result = await createBasetenProvider({ baseten: baseten({ samples: 1, hedge: 1 }), fetch }).decide("state", QUESTIONS);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.temperature).toBe(0);
    expect(result.answers.route?.type === "choice" && result.answers.route.confidence).toBeLessThan(0.7);
  });

  it("makes no request for an empty decision", async () => {
    const { fetch, calls } = fakeFetch(() => completion({}));
    expect((await createBasetenProvider({ baseten: baseten(), fetch }).decide("state", {})).answers).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("sends decisions to BASETEN_DECISION_MODEL_URL when a dedicated deployment is configured", async () => {
    const { fetch, calls } = fakeFetch(() => completion(GOOD));
    await createBasetenProvider({ baseten: baseten({ decisionBaseUrl: "https://model-abc.api.baseten.co/environments/production/sync/v1/", decisionModel: "ghost/tab-v1" }), fetch }).decide("state", QUESTIONS);
    expect(calls[0]?.url).toBe("https://model-abc.api.baseten.co/environments/production/sync/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("ghost/tab-v1");
  });
});

describe("baseten provider: auth failures and rate limits", () => {
  it("401 pauses the provider for 60 s, logs once without the key, then tries again", async () => {
    let clock = 1_000_000;
    const lines: string[] = [];
    let status = 401;
    const { fetch, calls } = fakeFetch(() => (status === 200 ? completion(GOOD) : new Response(`{"error":"bad key ${FAKE_KEY}"}`, { status })));
    const provider = createBasetenProvider({ baseten: baseten(), fetch, now: () => clock, log: (line) => lines.push(line) });

    await expect(provider.decide("state", QUESTIONS)).rejects.toMatchObject({ status: 401, message: "baseten: HTTP 401" });
    const afterFirst = calls.length;
    expect(afterFirst).toBeLessThanOrEqual(4);

    clock += 59_000;
    await expect(provider.decide("state", QUESTIONS)).rejects.toMatchObject({ message: "baseten: paused after an auth failure" });
    expect(calls).toHaveLength(afterFirst); // zero network while paused
    expect((await provider.warmUp()).ok).toBe(false);
    expect(calls).toHaveLength(afterFirst);

    clock += 2_000;
    status = 403;
    await expect(provider.decide("state", QUESTIONS)).rejects.toMatchObject({ status: 403 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("BASETEN_API_KEY");
    expect(lines.join("\n")).not.toContain(FAKE_KEY);

    clock += 61_000;
    status = 200;
    expect((await provider.decide("state", QUESTIONS)).answers.route).toMatchObject({ choice: "billing" });
  });

  it("fans out only as far as the remaining request budget allows (measured limit: 15 requests per minute)", async () => {
    let clock = 5_000_000;
    let remaining = "2";
    const { fetch, calls } = fakeFetch(() => completion(GOOD, { headers: { "x-ratelimit-remaining-requests": remaining } }));
    const provider = createBasetenProvider({ baseten: baseten(), fetch, now: () => clock });

    await provider.decide("state", QUESTIONS);
    expect(calls).toHaveLength(4); // nothing known yet: full fan-out

    const second = await provider.decide("state", QUESTIONS);
    expect(calls).toHaveLength(6); // 2 left: the hedge goes first, then a sample
    expect(second.sampling).toMatchObject({ launched: 2, samplesReceived: 2, partial: true });
    expect(second.answers.route?.type === "choice" && second.answers.route.confidence).toBeLessThan(0.7);

    remaining = "0";
    await provider.decide("state", QUESTIONS);
    const before = calls.length;
    await provider.decide("state", QUESTIONS);
    expect(calls.length - before).toBe(1); // always one request, so the budget is re-learned

    clock += 61_000; // a new window: the remembered budget is stale
    await provider.decide("state", QUESTIONS);
    expect(calls.length - before).toBe(1 + 4);
  });

  it("models the refill between forms: a bucket that said 1 is left has 4 again after 12 s at 15 requests per minute", async () => {
    let clock = 9_000_000;
    const { fetch, calls } = fakeFetch(() => completion(GOOD, { headers: { "x-ratelimit-remaining-requests": "1", "x-ratelimit-limit-requests": "15" } }));
    const provider = createBasetenProvider({ baseten: baseten(), fetch, now: () => clock });
    await provider.decide("state", QUESTIONS);
    expect(calls).toHaveLength(4);

    clock += 4_000; // one request came back: 1 + 1
    expect((await provider.decide("state", QUESTIONS)).sampling.launched).toBe(2);

    clock += 12_000; // header said 1 again, plus 3 refilled
    expect((await provider.decide("state", QUESTIONS)).sampling.launched).toBe(4);

    clock += 100; // nothing refilled yet: only the 1 the header promised
    expect((await provider.decide("state", QUESTIONS)).sampling.launched).toBe(1);
  });

  it("a 429 burst throws (heuristic fallback), is not fatal, and shrinks the next fan-out", async () => {
    let limited = true;
    const { fetch, calls } = fakeFetch(() => (limited ? new Response('{"error":"Rate limit exceeded"}', { status: 429 }) : completion(GOOD, { headers: { "x-ratelimit-remaining-requests": "12" } })));
    const provider = createBasetenProvider({ baseten: baseten(), fetch });
    await expect(provider.decide("state", QUESTIONS)).rejects.toMatchObject({ status: 429, message: "baseten: HTTP 429" });
    expect(calls).toHaveLength(4);

    limited = false;
    const probe = await provider.decide("state", QUESTIONS);
    expect(calls).toHaveLength(5);
    expect(probe.sampling).toMatchObject({ launched: 1, rateLimited: 0 });
    await provider.decide("state", QUESTIONS);
    expect(calls).toHaveLength(9); // the header said 12 are left: full fan-out again
  });
});

describe("baseten provider: warm-up", () => {
  it("sends exactly ONE one-token request for the standard form schema", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json({ choices: [{ finish_reason: "length", message: { content: null } }] }));
    const result = await createBasetenProvider({ baseten: baseten(), fetch }).warmUp();
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ max_tokens: 1, temperature: 0, response_format: { type: "json_schema" }, chat_template_kwargs: { enable_thinking: false } });
    const schema = (calls[0]?.body.response_format as { json_schema: { schema: { required: string[] } } }).json_schema.schema;
    expect(schema.required).toHaveLength(12);
  });

  it("never throws", async () => {
    const down = createBasetenProvider({ baseten: baseten(), fetch: fakeFetch(() => new Response("{}", { status: 503 })).fetch });
    expect(await down.warmUp()).toMatchObject({ ok: false, status: 503 });
    const offline = createBasetenProvider({ baseten: baseten(), fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch });
    expect(await offline.warmUp()).toMatchObject({ ok: false });
  });

  it("never runs under Vitest, and runs once when the factory is told to", async () => {
    const silent = fakeFetch(() => completion(GOOD));
    createDecisionProvider(loadConfig({ BASETEN_API_KEY: FAKE_KEY }), { fetch: silent.fetch });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(silent.calls).toHaveLength(0);

    const warmed = fakeFetch(() => completion(GOOD));
    const lines: string[] = [];
    createDecisionProvider(loadConfig({ BASETEN_API_KEY: FAKE_KEY }), { fetch: warmed.fetch, warmUp: true, log: (line) => lines.push(line) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(warmed.calls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[ghost\] baseten warm-up \d+ms ok=true model=zai-org\/GLM-5\.3-Flash$/);
  });
});

describe("baseten provider: logprob capability probe (off by default)", () => {
  const content = '{"route":"billing"}';
  const tokens = [
    { token: '{"', logprob: 0 },
    { token: "route", logprob: 0 },
    { token: '":"', logprob: 0 },
    { token: "bill", logprob: Math.log(0.8) },
    { token: "ing", logprob: Math.log(0.5) },
    { token: '"}', logprob: 0 },
  ];

  it("multiplies the probabilities of the tokens that spell the value", () => {
    expect(valueProbabilities(content, tokens, ["route"]).route).toBeCloseTo(0.4, 12);
    expect(valueProbabilities(content, tokens, ["missing"])).toEqual({});
    expect(valueProbabilities("different text", tokens, ["route"])).toEqual({}); // tokens that do not spell the content cannot be aligned
  });

  it("finds logprobs only when the response really carries them", () => {
    expect(readLogprobs({ message: { content } })).toBeUndefined();
    expect(readLogprobs({ logprobs: null })).toBeUndefined();
    expect(readLogprobs({ logprobs: { content: [] } })).toBeUndefined();
    expect(readLogprobs({ logprobs: { content: tokens } })).toEqual(tokens);
  });

  it("asks for logprobs only with BASETEN_LOGPROBS=1 and upgrades the confidence source when they arrive", async () => {
    const questions: Questions = { route: QUESTIONS.route as Questions[string] };
    const { fetch, calls } = fakeFetch(() => completion(content, { extra: { logprobs: { content: tokens } } }));
    const result = await createBasetenProvider({ baseten: baseten({ logprobs: true }), fetch }).decide("state", questions);
    expect(calls[0]?.body).toMatchObject({ logprobs: true, top_logprobs: 5 });
    expect(result.sampling.logprobsSeen).toBe(true);
    expect(result.answers.route).toMatchObject({ choice: "billing", confidenceSource: "logprobs" });
    expect(result.answers.route?.type === "choice" && result.answers.route.confidence).toBeCloseTo(0.4, 12);
  });

  it("stays on consensus when the API accepts the flag and returns none (today's behaviour)", async () => {
    const { fetch } = fakeFetch(() => completion(GOOD));
    const result = await createBasetenProvider({ baseten: baseten({ logprobs: true }), fetch }).decide("state", QUESTIONS);
    expect(result.sampling.logprobsSeen).toBe(false);
    expect(result.answers.route).toMatchObject({ confidenceSource: "consensus" });
  });
});

describe("POST /v1/predict/form through Baseten", () => {
  const EXPECTED = ["firstName", "lastName", "email", "phone", "linkedin", "github", "website", "school", "degree", "graduationDate", "referralSource", "needs_text"];

  function appWith(respond: (call: FakeCall) => Response | Promise<Response>, timeoutMs?: number) {
    const config = loadConfig({ BASETEN_API_KEY: FAKE_KEY, GHOST_FAST_PATH: "0" });
    const fake = fakeFetch(respond);
    const app = new Hono();
    registerPredictRoutes(app, config, { provider: createDecisionProvider(config, { fetch: fake.fetch }), timeoutMs, log: () => undefined });
    const post = () => app.request("/v1/predict/form", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sampleFormRequest()) });
    return { post, calls: fake.calls };
  }

  it("maps a whole form with ONE logical decision, and keeps the internal confidence source off the wire", async () => {
    const answers = Object.fromEntries(EXPECTED.map((key, i) => [`f${i}`, key]));
    const { post, calls } = appWith(() => completion(answers));
    const body = (await (await post()).json()) as { provider: string; calibrated: boolean; assignments: { factKey: string; confidence: number; source: string; calibrated: boolean }[] };
    expect(calls).toHaveLength(4);
    expect(body).toMatchObject({ provider: "baseten", calibrated: false });
    expect(body.assignments.map((a) => a.factKey)).toEqual(EXPECTED);
    expect(body.assignments.every((a) => a.source === "baseten" && !a.calibrated && a.confidence > 0.7 && a.confidence < 1)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("confidenceSource");
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);

    await post();
    expect(calls).toHaveLength(4); // the repeat visit is a cache hit: zero model calls
  });

  it("falls back to the heuristic when no sample arrives in time", async () => {
    const { post } = appWith((call) => after(5000, call, () => completion({})), 60);
    const body = (await (await post()).json()) as { provider: string; fallbackFrom?: string };
    expect(body).toMatchObject({ provider: "heuristic", fallbackFrom: "baseten" });
  });
});
