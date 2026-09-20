/** The little the two fetching adapters share: a deadline, a hard byte cap, and errors that carry no value. */

export const USER_AGENT = "Ghost-local-scan";

/** Why a fetch did not produce a document. Short, fixed words: a reason is logged, so it is never a value. */
export type FetchFailure = "timeout" | "network" | "not found" | "rate limited" | "blocked" | "too large" | "not text" | "malformed" | "upstream";

export function failureFromStatus(status: number): FetchFailure {
  if (status === 404 || status === 410) return "not found";
  if (status === 403 || status === 429) return "rate limited";
  return "upstream";
}

export function failureFromError(err: unknown, timedOut: boolean): FetchFailure {
  if (timedOut) return "timeout";
  return err instanceof SyntaxError ? "malformed" : "network";
}

export interface Deadline {
  signal: AbortSignal;
  timedOut: () => boolean;
  clear: () => void;
}

export function startDeadline(timeoutMs: number): Deadline {
  const ctrl = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    ctrl.abort();
  }, timeoutMs);
  return { signal: ctrl.signal, timedOut: () => expired, clear: () => clearTimeout(timer) };
}

/**
 * Reads at most `maxBytes` and then stops the stream. A `Content-Length` is only a claim, so the cap is
 * enforced while reading: a page that streams forever costs one buffer, not the process.
 */
export async function readCappedText(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (!body) return { text: (await res.text()).slice(0, maxBytes), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      chunks.push(value);
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buffer = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, at);
    at += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8").decode(buffer.subarray(0, maxBytes)), truncated };
}
