import { isRecord } from "../providers/errors";
import { sleep } from "../providers/timeout";
import type { VisionBudget } from "./budget";

export const VISION_TIMEOUT_MS = 8_000;
/** One batched call answers every box, so the deadline grows with the batch: 40 icons cost 40 short answers. */
const TIMEOUT_PER_BOX_MS = 400;
const TIMEOUT_MAX_MS = 24_000;

/** The deadline for a call carrying `boxes` boxes. Never below the 8 s base, never above 24 s. */
export function visionTimeoutMs(boxes: number): number {
  return Math.min(TIMEOUT_MAX_MS, VISION_TIMEOUT_MS + TIMEOUT_PER_BOX_MS * Math.max(0, boxes));
}
/** A 5xx is retried once, only when this much of the deadline is left. A 4xx (429 included) is never retried. */
const RETRY_MIN_LEFT_MS = 2_500;
const RETRY_BACKOFF_MS = 200;

export type VisionErrorKind = "timeout" | "budget" | "upstream" | "network" | "malformed" | "refused" | "incomplete";

/** Carries a kind and an HTTP status at most: upstream bodies can echo request data, so they are never read into it. */
export class VisionError extends Error {
  constructor(
    readonly kind: VisionErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VisionError";
  }
}

export interface VisionModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface CallOptions {
  fetch: typeof fetch;
  budget: VisionBudget;
  timeoutMs?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  /** Part of `output`. Zero on a model asked for `reasoning.effort: "none"`. */
  reasoning: number;
}

export interface CallResult {
  /** The parsed JSON the model wrote (Structured Outputs). */
  json: unknown;
  /** Billed requests made: 1, or 2 after a retried 5xx. */
  attempts: number;
  /** What OpenAI billed, for the log line and the cost numbers in docs/openai.md. Absent if the reply omitted it. */
  usage?: TokenUsage;
}

const wholeNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/** The `usage` block of a Responses reply: token COUNTS only, never any text. */
export function usageOf(response: unknown): TokenUsage | undefined {
  if (!isRecord(response) || !isRecord(response.usage)) return undefined;
  const details = isRecord(response.usage.output_tokens_details) ? response.usage.output_tokens_details : {};
  return { input: wholeNumber(response.usage.input_tokens), output: wholeNumber(response.usage.output_tokens), reasoning: wholeNumber(details.reasoning_tokens) };
}

/**
 * The raw HTTP response has no `output_text` (that is an SDK convenience): the answer is the `output_text` parts of the
 * `message` items in `output`. A `refusal` part, `status: "incomplete"` or an `error` object is a failure.
 */
export function outputTextOf(response: unknown): string {
  if (!isRecord(response)) throw new VisionError("malformed", "response is not an object");
  if (response.status === "incomplete") throw new VisionError("incomplete", "response incomplete");
  if (isRecord(response.error) || response.status === "failed") throw new VisionError("upstream", "response failed");
  const parts: string[] = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      if (part.type === "refusal") throw new VisionError("refused", "model refused");
      if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  if (parts.length === 0) throw new VisionError("malformed", "response has no output_text");
  return parts.join("");
}

/**
 * ONE logical call to POST {baseUrl}/responses under an 8 s deadline. Every attempt takes a unit of the process budget
 * BEFORE it is sent, so a failed or timed-out call still counts.
 */
export async function callResponses(config: VisionModelConfig, body: Record<string, unknown>, options: CallOptions): Promise<CallResult> {
  const timeoutMs = options.timeoutMs ?? VISION_TIMEOUT_MS;
  const url = `${config.baseUrl.replace(/\/+$/, "")}/responses`;
  const controller = new AbortController();
  const startedAt = Date.now();
  const payload = JSON.stringify(body);
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Rejects on expiry even if a fetch implementation ignores the abort signal.
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new VisionError("timeout", `timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  const attempt = async (): Promise<CallResult> => {
    // Only the first unit can be missing ("budget", nothing billed yet): the retry's unit is taken in the same synchronous
    // step that decides to retry, BEFORE the backoff, so a concurrent request cannot take it while this one sleeps.
    if (!options.budget.take()) throw new VisionError("budget", "vision budget exhausted");
    for (;;) {
      attempts += 1;
      const res = await options.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: payload,
        signal: controller.signal,
      });
      if (res.ok) {
        const body = (await res.json()) as unknown;
        return { json: JSON.parse(outputTextOf(body)) as unknown, attempts, ...(usageOf(body) ? { usage: usageOf(body) } : {}) };
      }
      await res.body?.cancel().catch(() => undefined);
      const left = timeoutMs - (Date.now() - startedAt);
      if (res.status < 500 || attempts > 1 || left < RETRY_MIN_LEFT_MS || !options.budget.take()) {
        throw new VisionError("upstream", `openai responded ${res.status}`, res.status);
      }
      await sleep(RETRY_BACKOFF_MS, controller.signal);
    }
  };

  try {
    return await Promise.race([attempt(), expired]);
  } catch (err) {
    if (controller.signal.aborted) throw new VisionError("timeout", `timed out after ${timeoutMs} ms`);
    if (err instanceof VisionError) throw err;
    throw new VisionError(err instanceof SyntaxError ? "malformed" : "network", err instanceof SyntaxError ? "malformed response" : "network error");
  } finally {
    clearTimeout(timer);
  }
}
