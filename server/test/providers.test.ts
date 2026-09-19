import type { Questions } from "@ghost/shared";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { buildFormDecision } from "../src/providers/formQuestions";
import { createHeuristicProvider } from "../src/providers/heuristic";
import { createDecisionProvider, providerModel } from "../src/providers/index";
import { createJevGatewayProvider, type EvaluateFn } from "../src/providers/jevGateway";
import { buildChatBody, createLlmProvider, maxTokensFor, shareCriteria } from "../src/providers/llm";
import { buildNextDecision } from "../src/providers/nextQuestions";
import { SAMPLE_FACT_KEYS, sampleFormFields } from "../src/providers/sampleForm";
import { createTypesafeProvider, TYPESAFE_URL } from "../src/providers/typesafe";

const FAKE_KEY = "test-key-not-real";

const QUESTIONS: Questions = {
  route: { type: "choice", instructions: "Route `ticket`.", criteria: { billing: "payment problems", shipping: null, none: "nothing fits" } },
  refunded: { type: "noul", instructions: "Was a refund issued?" },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
};

const TYPESAFE_BODY = {
  model: "jev-2026-09",
  answers: {
    route: { type: "choice", choice: "billing", probabilities: { billing: 0.9, shipping: 0.06, none: 0.04 }, confidence: 0.88 },
    refunded: { type: "noul", noul: 0.97 },
    urgency: { type: "score", score: 1.6, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 }, legend: { "0": "low" }, confidence: 0.7 },
  },
  usage: { input_tokens: 120, output_tokens: 9 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function neverResolves(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
}

describe("typesafe provider", () => {
  it("POSTs once with Bearer auth and returns typed answers, usage and model", async () => {
    const fetchMock = vi.fn(async () => json(TYPESAFE_BODY));
    const provider = createTypesafeProvider({ apiKey: FAKE_KEY, fetch: fetchMock as unknown as typeof fetch });
    const result = await provider.decide({ ticket: "charged twice" }, QUESTIONS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TYPESAFE_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${FAKE_KEY}`, "Content-Type": "application/json" });
    expect(result).toMatchObject({ provider: "typesafe", calibrated: true, model: "jev-2026-09", usage: { inputTokens: 120, outputTokens: 9 } });
    expect(result.answers.route).toEqual(TYPESAFE_BODY.answers.route);
    expect(result.answers.refunded).toEqual({ type: "noul", noul: 0.97 });
    expect(result.answers.urgency).toMatchObject({ type: "score", score: 1.6, confidence: 0.7 });
  });

  it("retries 429 and 529 with exponential backoff, then succeeds", async () => {
    const responses = [json({}, 429), json({}, 529), json(TYPESAFE_BODY)];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    const sleeps: number[] = [];
    const provider = createTypesafeProvider({
      apiKey: FAKE_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
    });
    const result = await provider.decide("state", QUESTIONS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([200, 400]);
    expect(result.answers.route).toMatchObject({ choice: "billing" });
  });

  it("gives up after 2 retries", async () => {
    const fetchMock = vi.fn(async () => json({}, 429));
    const provider = createTypesafeProvider({ apiKey: FAKE_KEY, fetch: fetchMock as unknown as typeof fetch, sleep: async () => undefined });
    await expect(provider.decide("state", QUESTIONS)).rejects.toMatchObject({ name: "DecisionProviderError", status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry 401 or 422, and never puts the key in the error", async () => {
    for (const status of [401, 422]) {
      const fetchMock = vi.fn(async () => json({ error: "nope" }, status));
      const provider = createTypesafeProvider({ apiKey: FAKE_KEY, fetch: fetchMock as unknown as typeof fetch });
      const error = await provider.decide("state", QUESTIONS).catch((e: Error) => e);
      expect(error).toMatchObject({ status });
      expect(String((error as Error).message)).not.toContain(FAKE_KEY);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("aborts the request at the deadline", async () => {
    const fetchMock = vi.fn(neverResolves);
    const provider = createTypesafeProvider({ apiKey: FAKE_KEY, fetch: fetchMock as unknown as typeof fetch, timeoutMs: 20 });
    await expect(provider.decide("state", QUESTIONS)).rejects.toMatchObject({ name: "TimeoutError" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
  });

  it("rejects a response that is missing an answer", async () => {
    const partial = { ...TYPESAFE_BODY, answers: { route: TYPESAFE_BODY.answers.route } };
    const provider = createTypesafeProvider({ apiKey: FAKE_KEY, fetch: (async () => json(partial)) as unknown as typeof fetch });
    await expect(provider.decide("state", QUESTIONS)).rejects.toThrow(/refunded/);
  });
});

describe("jev-gateway provider", () => {
  const evaluateResult = {
    answers: {
      route: { type: "choice" as const, choice: "billing", probabilities: { billing: 0.8, shipping: 0.15, none: 0.05 } },
      refunded: { type: "boolean" as const, probability: 0.91 },
      urgency: { type: "score" as const, score: 1.2, probabilities: { "0": 0.2, "1": 0.4, "2": 0.4 } },
    },
    usage: { inputTokens: 283, outputTokens: 21 },
    response: { modelId: "typesafe-ai/jev" },
  };

  it("maps noul to boolean on the way in and probability to noul on the way out", async () => {
    const evaluate = vi.fn<EvaluateFn>(async () => evaluateResult);
    const result = await createJevGatewayProvider({ evaluate }).decide("state", QUESTIONS);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[0].questions.refunded).toEqual({ type: "boolean", instructions: "Was a refund issued?" });
    expect(result.answers.refunded).toEqual({ type: "noul", noul: 0.91 });
    expect(result).toMatchObject({ provider: "jev-gateway", calibrated: true, model: "typesafe-ai/jev", usage: { inputTokens: 283, outputTokens: 21 } });
  });

  it("reads confidence from providerMetadata.typesafe.confidence (per question or single number)", async () => {
    const perQuestion = vi.fn<EvaluateFn>(async () => ({ ...evaluateResult, providerMetadata: { typesafe: { confidence: { route: 0.66 } } } }));
    const a = await createJevGatewayProvider({ evaluate: perQuestion }).decide("state", QUESTIONS);
    expect(a.answers.route).toMatchObject({ confidence: 0.66 });

    const single = vi.fn<EvaluateFn>(async () => ({ ...evaluateResult, providerMetadata: { typesafe: { confidence: 0.71 } } }));
    const b = await createJevGatewayProvider({ evaluate: single }).decide("state", QUESTIONS);
    expect(b.answers.route).toMatchObject({ confidence: 0.71 });
  });

  it("falls back to the max probability when no confidence is reported", async () => {
    const evaluate = vi.fn<EvaluateFn>(async () => evaluateResult);
    const result = await createJevGatewayProvider({ evaluate }).decide("state", QUESTIONS);
    expect(result.answers.route).toMatchObject({ choice: "billing", confidence: 0.8 });
    expect(result.answers.urgency).toMatchObject({ confidence: 0.4 });
  });

  it("times out and aborts the SDK call", async () => {
    let signal: AbortSignal | undefined;
    const evaluate: EvaluateFn = (args) => {
      signal = args.abortSignal;
      return new Promise(() => undefined);
    };
    await expect(createJevGatewayProvider({ evaluate, timeoutMs: 20 }).decide("state", QUESTIONS)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(signal?.aborted).toBe(true);
  });

  it("retries 429 and 529 itself on a short backoff (the SDK's 2000 ms backoff cannot fit the deadline)", async () => {
    const waits: number[] = [];
    const evaluate = vi
      .fn<EvaluateFn>()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { statusCode: 429 }))
      .mockRejectedValueOnce({ name: "AI_RetryError", lastError: { statusCode: 529 } })
      .mockResolvedValue(evaluateResult);
    const provider = createJevGatewayProvider({ evaluate, sleep: async (ms) => void waits.push(ms) });
    expect((await provider.decide("state", QUESTIONS)).answers.route).toMatchObject({ choice: "billing" });
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(evaluate.mock.calls.every(([args]) => args.maxRetries === 0)).toBe(true);
    expect(waits).toEqual([200, 400]);
  });

  it("gives up after 2 retries, and never retries other errors", async () => {
    const busy = vi.fn<EvaluateFn>(async () => Promise.reject(Object.assign(new Error("overloaded"), { statusCode: 529 })));
    await expect(createJevGatewayProvider({ evaluate: busy, sleep: async () => undefined }).decide("state", QUESTIONS)).rejects.toMatchObject({ statusCode: 529 });
    expect(busy).toHaveBeenCalledTimes(3);

    const denied = vi.fn<EvaluateFn>(async () => Promise.reject(Object.assign(new Error("bad key"), { statusCode: 401 })));
    await expect(createJevGatewayProvider({ evaluate: denied, sleep: async () => undefined }).decide("state", QUESTIONS)).rejects.toMatchObject({ statusCode: 401 });
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("a retry still fits inside the deadline", async () => {
    const evaluate = vi.fn<EvaluateFn>().mockRejectedValueOnce(Object.assign(new Error("rate limited"), { statusCode: 429 })).mockResolvedValue(evaluateResult);
    const started = performance.now();
    await createJevGatewayProvider({ evaluate, timeoutMs: 2500 }).decide("state", QUESTIONS);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("rejects when an answer is missing", async () => {
    const evaluate = vi.fn<EvaluateFn>(async () => ({ answers: { route: evaluateResult.answers.route } }));
    await expect(createJevGatewayProvider({ evaluate }).decide("state", QUESTIONS)).rejects.toThrow(/refunded/);
  });
});

describe("llm provider", () => {
  const llm = { name: "openai" as const, apiKey: FAKE_KEY, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };

  function completion(content: string): Response {
    return json({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 300, completion_tokens: 40 } });
  }

  it("answers ALL questions with one JSON-mode request at temperature 0", async () => {
    const content = JSON.stringify({ answers: { route: { choice: "billing", confidence: 0.99 }, refunded: { probability: 0.8 }, urgency: { score: 2, confidence: 0.6 } } });
    const fetchMock = vi.fn(async () => completion(content));
    const result = await createLlmProvider({ llm, fetch: fetchMock as unknown as typeof fetch }).decide({ ticket: "x" }, QUESTIONS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "gpt-4o-mini", temperature: 0, max_completion_tokens: maxTokensFor(3), response_format: { type: "json_object" } });
    expect(body.max_completion_tokens).toBeLessThan(200);
    expect(JSON.parse(body.messages[1].content)).toEqual({ state: { ticket: "x" }, questions: QUESTIONS });

    expect(result).toMatchObject({ provider: "llm", calibrated: false, model: "gpt-4o-mini", usage: { inputTokens: 300, outputTokens: 40 } });
    expect(result.answers.route).toMatchObject({ type: "choice", choice: "billing", confidence: 0.9 }); // capped pseudo-confidence
    expect(result.answers.refunded).toEqual({ type: "noul", noul: 0.8 });
    expect(result.answers.urgency).toMatchObject({ type: "score", score: 2, confidence: 0.6 });
  });

  it("sends criteria shared by several questions once, and leaves unshared questions untouched", () => {
    const { state, questions } = buildFormDecision("http://localhost:5173", sampleFormFields(), SAMPLE_FACT_KEYS);
    const shared = shareCriteria(questions);
    expect(Object.keys(shared.criteriaSets ?? {})).toEqual(["set0"]);
    expect(shared.criteriaSets?.set0).toEqual(questions.f0?.type === "choice" ? questions.f0.criteria : undefined);
    expect(Object.values(shared.questions).every((q) => (q as { criteria: unknown }).criteria === "set0")).toBe(true);
    expect(shareCriteria(QUESTIONS)).toEqual({ questions: QUESTIONS });

    const compact = (buildChatBody("m", state, questions).messages as { content: string }[])[1]?.content ?? "";
    expect(compact.length).toBeLessThan(JSON.stringify({ state, questions }).length / 2);
    expect(compact.match(/"referralSource"/g)).toHaveLength(1);
  });

  it("works against the xAI base URL and tolerates a bare, fenced JSON map", async () => {
    const xai = { name: "xai" as const, apiKey: FAKE_KEY, baseUrl: "https://api.x.ai/v1/", model: "grok-4.20-non-reasoning" };
    const fetchMock = vi.fn(async () => completion('```json\n{"route":{"choice":"shipping"}}\n```'));
    const result = await createLlmProvider({ llm: xai, fetch: fetchMock as unknown as typeof fetch }).decide("s", QUESTIONS);
    expect(fetchMock.mock.calls[0]?.[0 as never]).toBe("https://api.x.ai/v1/chat/completions");
    expect(result.answers.route).toMatchObject({ choice: "shipping", confidence: 0.7 });
    expect(result.answers.refunded).toBeUndefined(); // a question the model skipped has no answer, not a made-up one
  });

  it("reads the compact answer form the prompt asks for: arrays and bare numbers", async () => {
    const fetchMock = vi.fn(async () => completion(JSON.stringify({ answers: { route: ["billing", 0.8], refunded: 0.25, urgency: [1, 0.5] } })));
    const result = await createLlmProvider({ llm, fetch: fetchMock as unknown as typeof fetch }).decide("s", QUESTIONS);
    expect(result.answers.route).toMatchObject({ type: "choice", choice: "billing", confidence: 0.8 });
    expect(result.answers.refunded).toEqual({ type: "noul", noul: 0.25 });
    expect(result.answers.urgency).toMatchObject({ type: "score", score: 1, confidence: 0.5 });
  });

  it("leaves out a choice that was not offered instead of inventing none@0, and throws when nothing is usable", async () => {
    const drifted = vi.fn(async () => completion(JSON.stringify({ answers: { route: { choice: "legal", confidence: 1 }, refunded: 0.4 } })));
    const result = await createLlmProvider({ llm, fetch: drifted as unknown as typeof fetch }).decide("s", QUESTIONS);
    expect(result.answers.route).toBeUndefined();
    expect(result.answers.refunded).toEqual({ type: "noul", noul: 0.4 });

    const useless = vi.fn(async () => completion(JSON.stringify({ answers: { route: ["first_name", 0.9] } })));
    await expect(createLlmProvider({ llm, fetch: useless as unknown as typeof fetch }).decide("s", QUESTIONS)).rejects.toThrow(/no usable answers/);
  });

  it("throws on HTTP errors and on non-JSON content", async () => {
    const failing = createLlmProvider({ llm, fetch: (async () => json({}, 500)) as unknown as typeof fetch });
    await expect(failing.decide("s", QUESTIONS)).rejects.toMatchObject({ status: 500 });
    const chatty = createLlmProvider({ llm, fetch: (async () => completion("Sure! Here you go")) as unknown as typeof fetch });
    await expect(chatty.decide("s", QUESTIONS)).rejects.toThrow(/JSON/);
  });

  it("times out", async () => {
    const provider = createLlmProvider({ llm, fetch: vi.fn(neverResolves) as unknown as typeof fetch, timeoutMs: 20 });
    await expect(provider.decide("s", QUESTIONS)).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("heuristic provider", () => {
  const provider = createHeuristicProvider();

  it("reads fields back out of the form state and maps them with the shared heuristic", async () => {
    const { state, questions } = buildFormDecision("http://localhost:5173", sampleFormFields(), SAMPLE_FACT_KEYS);
    const result = await provider.decide(state, questions);
    expect(result).toMatchObject({ provider: "heuristic", calibrated: false });
    const picked = Object.values(result.answers).map((a) => (a.type === "choice" ? a.choice : ""));
    expect(picked).toEqual([
      "firstName", "lastName", "email", "phone", "linkedin", "github", "website", "school", "degree", "graduationDate", "referralSource", "needs_text",
    ]);
    expect(result.answers.f0).toMatchObject({ confidence: 0.97 });
  });

  it("predicts the candidate that followed the same previous action in memory", async () => {
    const { state, questions } = buildNextDecision({
      origin: "http://localhost:5173",
      url: "http://localhost:5173/mail",
      recentActions: [{ type: "click", label: "Open calendar" }],
      candidates: [
        { id: "a", kind: "button", label: "Archive", locked: false },
        { id: "b", kind: "button", label: "Thursday 2pm", locked: false },
      ],
      memory: [{ previousAction: { type: "click", label: "open calendar" }, action: { type: "click", label: "Thursday 2pm" } }],
    });
    const result = await provider.decide(state, questions);
    expect(result.answers.next).toMatchObject({ choice: "c1", confidence: 0.8 });
  });

  it("answers none for questions it does not understand", async () => {
    const result = await provider.decide("state", QUESTIONS);
    expect(result.answers.route).toMatchObject({ choice: "none", confidence: 0 });
    expect(result.answers.refunded).toEqual({ type: "noul", noul: 0.5 });
  });
});

describe("createDecisionProvider precedence", () => {
  const noNetwork = {
    fetch: (async () => {
      throw new Error("network is not allowed in unit tests");
    }) as unknown as typeof fetch,
    evaluate: (async () => {
      throw new Error("network is not allowed in unit tests");
    }) as EvaluateFn,
  };
  const pick = (env: Record<string, string>) => createDecisionProvider(loadConfig(env), noNetwork);

  it("follows typesafe > jev-gateway > llm > heuristic", () => {
    const all = { TYPESAFE_API_KEY: FAKE_KEY, AI_GATEWAY_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY, XAI_API_KEY: FAKE_KEY };
    expect(pick(all).name).toBe("typesafe");
    expect(pick({ ...all, TYPESAFE_API_KEY: "" }).name).toBe("jev-gateway");
    expect(pick({ OPENAI_API_KEY: FAKE_KEY }).name).toBe("llm");
    expect(pick({ XAI_API_KEY: FAKE_KEY }).name).toBe("llm");
    expect(pick({}).name).toBe("heuristic");
  });

  it("reports calibration: Jev providers are calibrated, the LLM adapter and the heuristic are not", () => {
    expect(pick({ TYPESAFE_API_KEY: FAKE_KEY }).calibrated).toBe(true);
    expect(pick({ AI_GATEWAY_API_KEY: FAKE_KEY }).calibrated).toBe(true);
    expect(pick({ XAI_API_KEY: FAKE_KEY }).calibrated).toBe(false);
    expect(pick({}).calibrated).toBe(false);
  });

  it("honors the GHOST_DECISION_PROVIDER override", () => {
    expect(pick({ TYPESAFE_API_KEY: FAKE_KEY, GHOST_DECISION_PROVIDER: "heuristic" }).name).toBe("heuristic");
    expect(pick({ TYPESAFE_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY, GHOST_DECISION_PROVIDER: "llm" }).name).toBe("llm");
  });

  it("degrades to the heuristic when the forced provider has no credentials or is unknown", () => {
    expect(pick({ GHOST_DECISION_PROVIDER: "typesafe" }).name).toBe("heuristic");
    expect(pick({ GHOST_DECISION_PROVIDER: "jev-gateway" }).name).toBe("heuristic");
    expect(pick({ GHOST_DECISION_PROVIDER: "bogus" }).name).toBe("heuristic");
  });

  it("names the model for /v1/health", () => {
    const config = loadConfig({ XAI_API_KEY: FAKE_KEY });
    expect(providerModel(createDecisionProvider(config, noNetwork), config)).toBe("grok-4.20-non-reasoning");
    const keyless = loadConfig({});
    expect(providerModel(createDecisionProvider(keyless, noNetwork), keyless)).toBeUndefined();
  });
});
