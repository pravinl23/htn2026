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
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(buildBody(config.model, req, stream)),
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
        return contentOf(await res.json());
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
        for await (const data of sseData(res.body)) {
          if (data === "[DONE]") return;
          const delta = deltaOf(data);
          if (delta) yield delta;
        }
      } catch (err) {
        throw deadline.explain(err);
      } finally {
        deadline.stop();
      }
    },
  };
}

function buildBody(model: string, req: ChatRequest, stream: boolean): Record<string, unknown> {
  return {
    model,
    messages: req.messages,
    // max_tokens is deprecated on both api.openai.com and api.x.ai in favour of this field.
    max_completion_tokens: req.maxTokens,
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
