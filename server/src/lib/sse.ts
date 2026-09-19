/** Yields the payload of every `data:` line. Buffers across chunk boundaries so a split line is never lost. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const data = dataOf(line);
        if (data !== undefined) yield data;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function dataOf(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  const data = line.slice(5).trim();
  return data === "" ? undefined : data;
}

export function formatSseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export type SseSend = (payload: unknown) => void;

/** Streams JSON events to the client. `signal` aborts when the client disconnects so upstream work can stop. */
export function sseResponse(run: (send: SseSend, signal: AbortSignal) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const disconnected = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send: SseSend = (payload) => {
        if (!disconnected.signal.aborted) controller.enqueue(encoder.encode(formatSseEvent(payload)));
      };
      void run(send, disconnected.signal)
        .catch(() => undefined)
        .finally(() => {
          if (!disconnected.signal.aborted) controller.close();
        });
    },
    cancel() {
      disconnected.abort();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
