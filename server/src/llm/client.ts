import type { LlmConfig } from "../config";
import { sseData } from "../lib/sse";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  /** JSON mode: the model must answer with a single JSON object. */
  json?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LlmClient {
  readonly name: LlmConfig["name"];
  readonly model: string;
  chat(req: ChatRequest): Promise<string>;
  streamChat(req: ChatRequest): AsyncGenerator<string>;
}

export interface LlmClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Carries only a status and a short reason. Upstream error bodies can echo parts of a key, so they are never included. */
export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LlmError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createLlmClient(config: LlmConfig, options: LlmClientOptions = {}): LlmClient {
  const doFetch = options.fetch ?? fetch;
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  async function post(req: ChatRequest, stream: boolean, signal: AbortSignal): Promise<Response> {
    const res = await doFetch(url, {
      method: "POST",
      headers: { ...config.headers, "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(buildBody(config, req, stream)),
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new LlmError(`${config.name} responded ${res.status}`, res.status);
    }
    return res;
  }

  return {
    name: config.name,
    model: config.model,
    async chat(req) {
      const deadline = startDeadline(req, options);
      try {
        const res = await post(req, false, deadline.signal);
        const content = contentOf(await res.json());
        return config.stripReasoning ? stripThinkBlocks(content) : content;
      } catch (err) {
        throw deadline.explain(err);
      } finally {
        deadline.clear();
      }
    },
    async *streamChat(req) {
      const deadline = startDeadline(req, options);
      try {
        const res = await post(req, true, deadline.signal);
        if (!res.body) throw new LlmError("empty response body");
        // Only `delta.content` is ever read, so `reasoning_content` deltas are ignored. The filter removes inline <think> blocks.
        const filter = config.stripReasoning ? createThinkFilter() : undefined;
        for await (const data of sseData(res.body)) {
          if (data === "[DONE]") break;
          const delta = deltaOf(data);
          const visible = delta && filter ? filter.push(delta) : delta;
          if (visible) yield visible;
        }
        const rest = filter?.flush();
        if (rest) yield rest;
      } catch (err) {
        throw deadline.explain(err);
      } finally {
        deadline.stop();
      }
    },
  };
}

function buildBody(config: LlmConfig, req: ChatRequest, stream: boolean): Record<string, unknown> {
  return {
    // First, so a provider's extra fields can never replace the model, the messages or the limits.
    ...config.extraBody,
    model: config.model,
    messages: req.messages,
    // max_tokens is deprecated on both api.openai.com and api.x.ai in favour of max_completion_tokens; Baseten was verified with max_tokens.
    [config.maxTokensParam ?? "max_completion_tokens"]: req.maxTokens,
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.json ? { response_format: { type: "json_object" } } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

interface Deadline {
  signal: AbortSignal;
  /** Clears the timer only. */
  clear(): void;
  /** Clears the timer and aborts the request, so an abandoned stream stops costing tokens. */
  stop(): void;
  explain(err: unknown): Error;
}

function startDeadline(req: ChatRequest, options: LlmClientOptions): Deadline {
  const timeoutMs = req.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const signal = req.signal ? AbortSignal.any([ctrl.signal, req.signal]) : ctrl.signal;
  const clear = (): void => clearTimeout(timer);
  return {
    signal,
    clear,
    stop() {
      clear();
      ctrl.abort();
    },
    explain(err) {
      if (timedOut) return new LlmError(`timeout after ${timeoutMs}ms`);
      if (err instanceof LlmError) return err;
      if (req.signal?.aborted) return new LlmError("aborted");
      return new LlmError(err instanceof SyntaxError ? "malformed response" : "network error");
    },
  };
}

function contentOf(json: unknown): string {
  const content = (json as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new LlmError("response has no message content");
  return content;
}

function deltaOf(data: string): string | undefined {
  try {
    const content = (JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : undefined;
  } catch {
    return undefined; // keep-alive comments or partial garbage: skip, never crash the stream
  }
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/** Length of the longest proper prefix of `tag` that `text` ends with: that tail may be a tag split across deltas. */
function partialTagLength(text: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k -= 1) {
    if (text.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

export interface ThinkFilter {
  /** Returns the part of the stream so far that is safe to show. */
  push(delta: string): string;
  /** Call once at the end of the stream: releases a held-back tail that turned out not to be a tag. */
  flush(): string;
}

/** Streaming removal of `<think>...</think>` blocks, whatever delta boundaries the tags are split at. */
export function createThinkFilter(): ThinkFilter {
  let buffer = "";
  let inside = false;
  let trimStart = false;
  return {
    push(delta) {
      buffer += delta;
      let out = "";
      for (;;) {
        if (inside) {
          const end = buffer.indexOf(THINK_CLOSE);
          if (end === -1) {
            buffer = buffer.slice(buffer.length - partialTagLength(buffer, THINK_CLOSE));
            return out;
          }
          buffer = buffer.slice(end + THINK_CLOSE.length);
          inside = false;
          trimStart = true;
        }
        if (trimStart) {
          buffer = buffer.replace(/^\s+/, "");
          if (buffer === "") return out;
          trimStart = false;
        }
        const start = buffer.indexOf(THINK_OPEN);
        if (start === -1) {
          const held = partialTagLength(buffer, THINK_OPEN);
          out += buffer.slice(0, buffer.length - held);
          buffer = buffer.slice(buffer.length - held);
          return out;
        }
        out += buffer.slice(0, start);
        buffer = buffer.slice(start + THINK_OPEN.length);
        inside = true;
      }
    },
    flush() {
      const rest = inside ? "" : buffer;
      buffer = "";
      return rest;
    },
  };
}

/** Non-streamed variant. Also handles a closing tag with no opening one (templates that open the block in the prompt) and a block that never closes. */
export function stripThinkBlocks(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  const orphanClose = out.lastIndexOf(THINK_CLOSE);
  if (orphanClose !== -1) out = out.slice(orphanClose + THINK_CLOSE.length);
  const unclosed = out.indexOf(THINK_OPEN);
  if (unclosed !== -1) out = out.slice(0, unclosed);
  return out === text ? text : out.replace(/^\s+/, "");
}
