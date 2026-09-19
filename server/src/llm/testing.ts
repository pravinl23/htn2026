/** Test-only fakes for the OpenAI-compatible wire format. No network, no keys. */

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export type Responder = (call: FakeCall) => Response | Promise<Response>;

export function fakeFetch(responder: Responder): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: FakeCall = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return responder(call);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

/** The SSE text an OpenAI-compatible server sends for these deltas. */
export function chatStreamText(deltas: string[]): string {
  const events = deltas.map((content) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n${events.join("")}data: [DONE]\n\n`;
}

/** Streams `text` in pieces of `chunkSize` bytes so SSE lines get split at arbitrary boundaries. */
export function streamResponse(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export function chatJsonResponse(content: string): Response {
  return Response.json({ choices: [{ index: 0, message: { role: "assistant", content } }] });
}

/** Never resolves until the request is aborted, like a hung upstream. */
export function hangUntilAborted(call: FakeCall): Promise<Response> {
  return new Promise((_, reject) => {
    call.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}
