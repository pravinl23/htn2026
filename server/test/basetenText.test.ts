import { DEMO_PROFILE } from "@ghost/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createLlmClient, createThinkFilter, stripThinkBlocks } from "../src/llm/client";
import { chatJsonResponse, fakeFetch, streamResponse, type Responder } from "../src/llm/testing";
import { basetenTextLlm } from "../src/providers/baseten";
import { registerTextRoutes } from "../src/routes/text";

const FAKE_KEY = "test-key-not-real";
const REASONING = "The applicant studies at Waterloo, so I should mention robots.";
const DRAFT = ["I am applying to Northwind Robotics ", "because I like building robots that ", "help people. I would bring steady follow-through."];
const BODY = {
  fieldLabel: "Why Northwind?",
  fieldSignature: "textarea|why|3",
  pageContext: { company: "Northwind Robotics", role: "Software Engineering Intern", description: "Build software for warehouse robots." },
  facts: { school: DEMO_PROFILE.facts.school, major: DEMO_PROFILE.facts.major },
  pastAnswers: [],
};

type SseEvent = { delta?: string; done?: boolean; text?: string; provider?: string; latencyMs?: number; firstTokenMs?: number; fallbackFrom?: string };

function sse(deltas: Record<string, unknown>[]): string {
  return `${deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`).join("")}data: [DONE]\n\n`;
}

function appWith(responder: Responder, env: Record<string, string> = { BASETEN_API_KEY: FAKE_KEY }) {
  const fake = fakeFetch(responder);
  const app = new Hono();
  registerTextRoutes(app, loadConfig(env), { fetch: fake.fetch });
  const post = (path: string, body: unknown): Promise<Response> => Promise.resolve(app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { post, calls: fake.calls };
}

async function readEvents(res: Response): Promise<SseEvent[]> {
  return (await res.text()).split("\n\n").filter(Boolean).map((block) => JSON.parse(block.slice(6)) as SseEvent);
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe("createThinkFilter", () => {
  const TEXT = `<think>${REASONING}</think>\n\nI like robots. <b>Really.</b>`;

  it("removes a <think> block whatever boundaries the stream is cut at", () => {
    for (let size = 1; size <= TEXT.length; size += 1) {
      const filter = createThinkFilter();
      let out = "";
      for (let i = 0; i < TEXT.length; i += size) out += filter.push(TEXT.slice(i, i + size));
      out += filter.flush();
      expect(out).toBe("I like robots. <b>Really.</b>");
    }
  });

  it("passes text without a block through unchanged, and only holds back a possible tag start", () => {
    const filter = createThinkFilter();
    expect(filter.push("a < b and ")).toBe("a < b and ");
    expect(filter.push("x <th")).toBe("x ");
    expect(filter.push("ree> y")).toBe("<three> y");
    expect(filter.flush()).toBe("");
  });

  it("releases a held-back tail at the end of the stream", () => {
    const filter = createThinkFilter();
    expect(filter.push("1 <")).toBe("1 ");
    expect(filter.flush()).toBe("<");
  });

  it("drops a block that never closes, and handles several blocks", () => {
    const open = createThinkFilter();
    expect(open.push("Hello. <think>still thinking")).toBe("Hello. ");
    expect(open.flush()).toBe("");
    const two = createThinkFilter();
    expect(two.push("<think>a</think>One. <think>b</think>Two.") + two.flush()).toBe("One. Two.");
  });
});

describe("stripThinkBlocks", () => {
  it("removes blocks, an orphan closing tag and an unclosed block", () => {
    expect(stripThinkBlocks(`<think>${REASONING}</think>\n{"a":1}`)).toBe('{"a":1}');
    expect(stripThinkBlocks(`${REASONING}</think>\n\nAnswer.`)).toBe("Answer.");
    expect(stripThinkBlocks("Answer. <think>and then")).toBe("Answer. ");
    expect(stripThinkBlocks("  untouched text ")).toBe("  untouched text ");
  });
});

describe("Baseten through the OpenAI-compatible client", () => {
  const config = loadConfig({ BASETEN_API_KEY: FAKE_KEY }).baseten;
  if (!config) throw new Error("no baseten config");
  const llm = basetenTextLlm(config);

  it("describes the text endpoint: thinking off, reasoning stripped, replica affinity, max_tokens", () => {
    expect(llm).toEqual({
      name: "baseten",
      apiKey: FAKE_KEY,
      baseUrl: "https://inference.baseten.co/v1",
      model: "zai-org/GLM-5.3-Flash",
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      headers: { "x-session-affinity": "ghost-text" },
      stripReasoning: true,
      maxTokensParam: "max_tokens",
    });
  });

  it("sends the extra body and header, and extras can never replace the model, the limit or the auth header", async () => {
    const { fetch, calls } = fakeFetch(() => streamResponse(sse([{ content: "ok" }])));
    const hostile = { ...llm, extraBody: { ...llm.extraBody, model: "other/model", max_tokens: 99_999, stream: false }, headers: { ...llm.headers, Authorization: "Bearer other" } };
    await collect(createLlmClient(hostile, { fetch }).streamChat({ messages: [{ role: "user", content: "hi" }], maxTokens: 120, temperature: 0.6 }));
    expect(calls[0]?.url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(calls[0]?.headers).toMatchObject({ authorization: `Bearer ${FAKE_KEY}`, "x-session-affinity": "ghost-text" });
    expect(calls[0]?.body).toEqual({ chat_template_kwargs: { enable_thinking: false }, model: "zai-org/GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }], max_tokens: 120, temperature: 0.6, stream: true });
  });

  it("ignores reasoning_content deltas and inline <think> blocks while streaming", async () => {
    const stream = sse([{ role: "assistant" }, { reasoning_content: REASONING }, { content: "<thi" }, { content: `nk>${REASONING}</th` }, { content: "ink>\nI like " }, { reasoning_content: "more" }, { content: "robots." }]);
    const client = createLlmClient(llm, { fetch: fakeFetch(() => streamResponse(stream, 11)).fetch });
    expect((await collect(client.streamChat({ messages: [], maxTokens: 50 }))).join("")).toBe("I like robots.");
  });

  it("strips reasoning from a non-streamed JSON answer", async () => {
    const client = createLlmClient(llm, { fetch: fakeFetch(() => chatJsonResponse(`<think>${REASONING}</think>{"firstName":"Alex"}`)).fetch });
    expect(await client.chat({ messages: [], maxTokens: 50, json: true })).toBe('{"firstName":"Alex"}');
  });

  it("leaves other providers exactly as they were", async () => {
    const { fetch, calls } = fakeFetch(() => streamResponse(sse([{ content: "<think>kept</think>ok" }])));
    const xai = loadConfig({ XAI_API_KEY: FAKE_KEY }).llm;
    if (!xai) throw new Error("no xai config");
    expect((await collect(createLlmClient(xai, { fetch }).streamChat({ messages: [], maxTokens: 10 }))).join("")).toBe("<think>kept</think>ok");
    expect(calls[0]?.body).toEqual({ model: "grok-4.20-non-reasoning", messages: [], max_completion_tokens: 10, stream: true });
    expect(calls[0]?.headers).not.toHaveProperty("x-session-affinity");
  });
});

describe("POST /v1/ghost-text with the Baseten text provider", () => {
  it("streams the draft, measures first-token and total latency, and never leaks reasoning", async () => {
    const stream = sse([{ role: "assistant" }, { reasoning_content: REASONING }, { content: `<think>${REASONING}</think>` }, ...DRAFT.map((content) => ({ content }))]);
    const { post, calls } = appWith(() => streamResponse(stream, 13));
    const events = await readEvents(await post("/v1/ghost-text", BODY));
    const done = events[events.length - 1];
    expect(done).toMatchObject({ done: true, provider: "baseten", text: DRAFT.join("") });
    expect(done?.fallbackFrom).toBeUndefined();
    expect(done?.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(done?.latencyMs).toBeGreaterThanOrEqual(done?.firstTokenMs ?? Infinity);
    expect(events.slice(0, -1).map((e) => e.delta).join("")).toBe(DRAFT.join(""));
    expect(JSON.stringify(events)).not.toContain("Waterloo, so I should");
    expect(JSON.stringify(events)).not.toContain("<think>");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(calls[0]?.body).toMatchObject({ model: "zai-org/GLM-5.3-Flash", stream: true, chat_template_kwargs: { enable_thinking: false } });
    expect(calls[0]?.body).toHaveProperty("max_tokens");
    expect(calls[0]?.body).not.toHaveProperty("max_completion_tokens");
  });

  it("falls back to the template when a thinking-only model returns no content", async () => {
    const { post } = appWith(() => streamResponse(sse([{ reasoning_content: REASONING }, { reasoning_content: "still thinking" }])));
    const body = (await (await post("/v1/ghost-text?stream=0", BODY)).json()) as { provider: string; fallbackFrom?: string; text: string };
    expect(body).toMatchObject({ provider: "template", fallbackFrom: "baseten" });
    expect(body.text).not.toContain("should mention robots");
  });

  it("uses BASETEN_TEXT_MODEL and BASETEN_BASE_URL", async () => {
    const { post, calls } = appWith(() => streamResponse(sse(DRAFT.map((content) => ({ content })))), { BASETEN_API_KEY: FAKE_KEY, BASETEN_TEXT_MODEL: "deepseek-ai/DeepSeek-V4.1-Flash", BASETEN_BASE_URL: "https://example.test/v1/" });
    await (await post("/v1/ghost-text?stream=0", BODY)).json();
    expect(calls[0]?.url).toBe("https://example.test/v1/chat/completions");
    expect(calls[0]?.body).toMatchObject({ model: "deepseek-ai/DeepSeek-V4.1-Flash", chat_template_kwargs: { thinking: false, enable_thinking: false } });
  });

  it("prefers Baseten over OpenAI and xAI, and GHOST_TEXT_PROVIDER still wins", async () => {
    const all = { BASETEN_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY, XAI_API_KEY: FAKE_KEY };
    const auto = appWith(() => streamResponse(sse(DRAFT.map((content) => ({ content })))), all);
    expect(await (await auto.post("/v1/ghost-text?stream=0", BODY)).json()).toMatchObject({ provider: "baseten" });
    const forced = appWith(() => streamResponse(sse(DRAFT.map((content) => ({ content })))), { ...all, GHOST_TEXT_PROVIDER: "openai" });
    expect(await (await forced.post("/v1/ghost-text?stream=0", BODY)).json()).toMatchObject({ provider: "openai" });
    expect(forced.calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("GHOST_TEXT_PROVIDER=template makes zero requests even with a Baseten key", async () => {
    const { post, calls } = appWith(() => new Response("unused"), { BASETEN_API_KEY: FAKE_KEY, GHOST_TEXT_PROVIDER: "template" });
    expect(await (await post("/v1/ghost-text?stream=0", BODY)).json()).toMatchObject({ provider: "template" });
    expect(calls).toHaveLength(0);
  });

  it("resume extraction goes through the same client in JSON mode", async () => {
    const { post, calls } = appWith(() => chatJsonResponse(`<think>${REASONING}</think>{"firstName":"Alex","lastName":"Chen"}`));
    const body = (await (await post("/v1/profile/extract", { resumeText: "Alex Chen\nUniversity of Waterloo" })).json()) as { provider: string; facts: Record<string, string> };
    expect(body.provider).toBe("baseten");
    expect(body.facts).toMatchObject({ firstName: "Alex", lastName: "Chen" });
    expect(calls[0]?.body).toMatchObject({ response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: false } });
  });
});
