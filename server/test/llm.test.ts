import { describe, expect, it } from "vitest";
import type { LlmConfig } from "../src/config";
import { sseData } from "../src/lib/sse";
import { createLlmClient, LlmError } from "../src/llm/client";
import { chatJsonResponse, chatStreamText, fakeFetch, hangUntilAborted, streamResponse } from "../src/llm/testing";

const FAKE_KEY = "test-key-not-real";
const XAI: LlmConfig = { name: "xai", apiKey: FAKE_KEY, baseUrl: "https://api.x.ai/v1/", model: "grok-test" };

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

describe("sseData", () => {
  it("reassembles data lines split across chunk boundaries", async () => {
    const text = 'data: {"a":1}\n\n: keep-alive comment\nevent: ping\ndata: {"b":"héllo wörld"}\r\n\r\ndata: [DONE]\n\n';
    for (const chunkSize of [1, 2, 3, 5, 11, 1000]) {
      const body = streamResponse(text, chunkSize).body;
      if (!body) throw new Error("no body");
      expect(await collect(sseData(body))).toEqual(['{"a":1}', '{"b":"héllo wörld"}', "[DONE]"]);
    }
  });

  it("yields a final data line that has no trailing newline", async () => {
    const body = streamResponse('data: {"a":1}\n\ndata: {"b":2}', 4).body;
    if (!body) throw new Error("no body");
    expect(await collect(sseData(body))).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("createLlmClient.streamChat", () => {
  it("yields text deltas in order and stops at [DONE]", async () => {
    const deltas = ["I am ", "applying ", "because…", " 🚀 done."];
    const { fetch, calls } = fakeFetch(() => streamResponse(`${chatStreamText(deltas)}data: {"choices":[{"delta":{"content":"after done"}}]}\n\n`, 5));
    const client = createLlmClient(XAI, { fetch });
    expect(await collect(client.streamChat({ messages: [{ role: "user", content: "hi" }], maxTokens: 120, temperature: 0.5 }))).toEqual(deltas);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(calls[0]?.body).toEqual({ model: "grok-test", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 120, temperature: 0.5, stream: true });
  });

  it("skips malformed and empty events instead of crashing", async () => {
    const text = 'data: not json\n\ndata: {"choices":[]}\n\ndata: {"choices":[{"delta":{"content":""}}]}\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
    const client = createLlmClient(XAI, { fetch: fakeFetch(() => streamResponse(text, 9)).fetch });
    expect(await collect(client.streamChat({ messages: [], maxTokens: 10 }))).toEqual(["ok"]);
  });

  it("aborts the upstream request when the consumer stops early", async () => {
    const { fetch, calls } = fakeFetch(() => streamResponse(chatStreamText(["one ", "two ", "three"]), 16));
    const client = createLlmClient(XAI, { fetch });
    for await (const delta of client.streamChat({ messages: [], maxTokens: 10 })) {
      expect(delta).toBe("one ");
      break;
    }
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it("turns an upstream error into an LlmError that never carries the response body or the key", async () => {
    const leakyBody = JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}` } });
    const client = createLlmClient(XAI, { fetch: fakeFetch(() => new Response(leakyBody, { status: 401 })).fetch });
    const err = await collect(client.streamChat({ messages: [], maxTokens: 10 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).status).toBe(401);
    expect(String((err as LlmError).message)).not.toContain(FAKE_KEY);
  });

  it("times out a hung upstream", async () => {
    const client = createLlmClient(XAI, { fetch: fakeFetch(hangUntilAborted).fetch, timeoutMs: 20 });
    await expect(collect(client.streamChat({ messages: [], maxTokens: 10 }))).rejects.toThrow(/timeout after 20ms/);
  });
});

describe("createLlmClient.chat", () => {
  it("requests JSON mode and returns the message content", async () => {
    const { fetch, calls } = fakeFetch(() => chatJsonResponse('{"facts":{}}'));
    const openai: LlmConfig = { name: "openai", apiKey: FAKE_KEY, baseUrl: "https://api.openai.com/v1", model: "gpt-test" };
    const text = await createLlmClient(openai, { fetch }).chat({ messages: [{ role: "user", content: "x" }], maxTokens: 50, temperature: 0, json: true });
    expect(text).toBe('{"facts":{}}');
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.body).toEqual({ model: "gpt-test", messages: [{ role: "user", content: "x" }], max_completion_tokens: 50, temperature: 0, response_format: { type: "json_object" } });
  });

  it("rejects a response without message content", async () => {
    const client = createLlmClient(XAI, { fetch: fakeFetch(() => Response.json({ choices: [] })).fetch });
    await expect(client.chat({ messages: [], maxTokens: 5 })).rejects.toBeInstanceOf(LlmError);
  });

  it("honours a caller abort signal", async () => {
    const ctrl = new AbortController();
    const client = createLlmClient(XAI, { fetch: fakeFetch(hangUntilAborted).fetch, timeoutMs: 5_000 });
    const pending = client.chat({ messages: [], maxTokens: 5, signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});
