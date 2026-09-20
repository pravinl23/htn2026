/**
 * Every outbound model call, as its own span, with the time to first token inside it.
 *
 * The server already funnels each model integration through an injectable `fetch`, so wrapping that one function is
 * enough to see the network leg of a prediction without touching the integrations themselves. A streamed ghost-text
 * call gets two spans: `llm.stream`, which lasts until the last token, and `llm.first-token` inside it, which is the
 * number the user actually feels.
 *
 * What is read from the request: the HOST, the HTTP method, and from a JSON body only `model`, `stream` and how many
 * messages there are. The prompt, the page context, the facts and the draft are never read and never sent.
 */
import { genAiSystem, hostOf } from "./names";
import { distribution, isEnabled, span, spanManual, spanManualIn, type Attrs, type GhostSpan } from "./sentry";

/** Which part of Ghost owns this call. Decides the span name, nothing else. */
export type FetchLabel = "decision" | "ghost-text" | "loop" | "vision";

interface BodyShape {
  model?: string;
  stream: boolean;
  messages?: number;
}

const SAFE_MODEL = /^[\w.:@/-]{1,64}$/;

/** Reads the SHAPE of an outgoing JSON body. Anything that is not one of the three known keys is ignored. */
function bodyShape(init: RequestInit | undefined): BodyShape {
  const body = init?.body;
  if (typeof body !== "string" || body.length === 0) return { stream: false };
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const model = typeof parsed.model === "string" && SAFE_MODEL.test(parsed.model) ? parsed.model : undefined;
    const messages = Array.isArray(parsed.messages) ? parsed.messages.length : undefined;
    return { model, stream: parsed.stream === true, messages };
  } catch {
    return { stream: false };
  }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function methodOf(input: string | URL | Request, init: RequestInit | undefined): string {
  if (init?.method) return init.method.toUpperCase();
  return typeof input === "object" && "method" in input ? input.method.toUpperCase() : "GET";
}

/** `openai.responses` for vision, `llm.stream` / `llm.chat` for text, `<label>.request` for a decision. */
function spanName(label: FetchLabel, streaming: boolean): string {
  if (label === "vision") return "openai.responses";
  if (label === "decision") return "model.request";
  return streaming ? "llm.stream" : "llm.chat";
}

/** A host is a service, not a URL: `api.openai.com`, never a path and never a query string. */
function systemFor(label: FetchLabel, host: string | undefined): string {
  if (label === "vision") return "openai";
  if (!host) return "unknown";
  if (host.includes("openai")) return "openai";
  if (host.includes("x.ai")) return "xai";
  if (host.includes("baseten")) return "baseten";
  if (host.includes("typesafe")) return genAiSystem("typesafe");
  if (host.includes("vercel") || host.includes("gateway")) return genAiSystem("jev-gateway");
  return "unknown";
}

/**
 * Wraps a streamed body so the span can end when the stream does, and the first byte can be timed.
 * A cancelled or failed stream ends the spans too: a span that never ends is dropped and the trace loses the call.
 */
function timedBody(body: ReadableStream<Uint8Array>, streamSpan: GhostSpan, firstToken: GhostSpan, started: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let sawFirst = false;
  let closed = false;
  const finish = (ok: boolean, chars: number): void => {
    if (closed) return;
    closed = true;
    if (!sawFirst) firstToken.end();
    streamSpan.setAttributes({ "ghost.stream_bytes": chars, "ghost.total_ms": Math.round(performance.now() - started) });
    streamSpan.setStatus(ok);
    streamSpan.end();
  };
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(true, bytes);
          controller.close();
          return;
        }
        if (!sawFirst) {
          sawFirst = true;
          const ms = Math.round(performance.now() - started);
          firstToken.setAttributes({ "ghost.first_token_ms": ms });
          firstToken.end();
          streamSpan.setAttributes({ "gen_ai.response.time_to_first_token_ms": ms });
          distribution("ghost.model.first_token", ms, "millisecond", {});
        }
        bytes += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        finish(false, bytes);
        controller.error(err);
      }
    },
    cancel(reason) {
      finish(false, bytes);
      return reader.cancel(reason);
    },
  });
}

/**
 * Returns `base` untouched when Sentry is off, so an unconfigured server has no wrapper in front of its model calls.
 */
export function tracedFetch(label: FetchLabel, base: typeof fetch = fetch): typeof fetch {
  if (!isEnabled()) return base;
  return async function ghostTracedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const shape = bodyShape(init);
    const host = hostOf(urlOf(input));
    const attributes: Attrs = {
      "gen_ai.system": systemFor(label, host),
      // Both labels are chat completions on the wire. The value has to come from the GenAI well-known list
      // ("chat", "invoke_agent", "execute_tool", ...); our own label goes in ghost.operation instead, where
      // it is still filterable without hiding the span from Sentry's AI views.
      "gen_ai.operation.name": "chat",
      "ghost.operation": label,
      "gen_ai.request.model": shape.model,
      "gen_ai.request.streaming": shape.stream,
      "gen_ai.request.messages": shape.messages,
      "server.address": host,
      "http.request.method": methodOf(input, init),
    };
    const name = spanName(label, shape.stream);
    if (!shape.stream) {
      // Not streamed: the call is over when the response arrives, so an ordinary span is exactly right.
      return span({ name, op: "gen_ai.chat", attributes }, async (active) => {
        const started = performance.now();
        const response = await base(input as Parameters<typeof fetch>[0], init).catch((err: unknown) => {
          active.setStatus(false, err instanceof Error ? err.name : "error");
          throw err;
        });
        active.setAttributes({ "http.response.status_code": response.status, "ghost.latency_ms": Math.round(performance.now() - started) });
        active.setStatus(response.ok, response.ok ? undefined : `http ${response.status}`);
        return response;
      });
    }
    return spanManualIn({ name, op: "gen_ai.chat", attributes }, async (streamSpan) => {
      const started = performance.now();
      // Started now, ended on the first byte: this is the latency the user sees as "the ghost appeared".
      const firstToken = spanManual({ name: "llm.first-token", op: "gen_ai.chat.first_token", attributes: { "gen_ai.request.model": shape.model } });
      let response: Response;
      try {
        response = await base(input as Parameters<typeof fetch>[0], init);
      } catch (err) {
        firstToken.end();
        streamSpan.setStatus(false, err instanceof Error ? err.name : "error");
        streamSpan.end();
        throw err;
      }
      streamSpan.setAttributes({ "http.response.status_code": response.status, "ghost.headers_ms": Math.round(performance.now() - started) });
      if (!response.body) {
        firstToken.end();
        streamSpan.setStatus(response.ok, response.ok ? undefined : `http ${response.status}`);
        streamSpan.end();
        return response;
      }
      return new Response(timedBody(response.body, streamSpan, firstToken, started), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
  } as typeof fetch;
}
