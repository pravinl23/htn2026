import { JEV_MODEL, type Answer, type Answers, type DecisionProvider, type DecisionState, type Questions } from "@shabang/shared";
import { DecisionProviderError, isRecord } from "./errors";
import { maxProbability } from "./probabilities";
import { DECISION_TIMEOUT_MS, sleep, withDeadline } from "./timeout";

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const NAME = "typesafe";
const RETRYABLE_STATUS = new Set([429, 529]);

export interface TypesafeOptions {
  apiKey: string;
  fetch?: typeof fetch;
  url?: string;
  /** Deadline for the whole decide() call, retries included. */
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [key, v] of Object.entries(value)) if (typeof v === "number") out[key] = v;
  return out;
}

function parseAnswer(raw: unknown, expected: Answer["type"]): Answer | undefined {
  if (!isRecord(raw) || raw.type !== expected) return undefined;
  if (expected === "noul") return typeof raw.noul === "number" ? { type: "noul", noul: raw.noul } : undefined;
  const probabilities = numberRecord(raw.probabilities);
  const confidence = typeof raw.confidence === "number" ? raw.confidence : (maxProbability(probabilities) ?? 0);
  if (expected === "choice") {
    return typeof raw.choice === "string" ? { type: "choice", choice: raw.choice, probabilities, confidence } : undefined;
  }
  if (typeof raw.score !== "number") return undefined;
  const legend = isRecord(raw.legend) ? (raw.legend as Record<string, string>) : undefined;
  return { type: "score", score: raw.score, probabilities, confidence, ...(legend ? { legend } : {}) };
}

function parseAnswers(body: unknown, questions: Questions): Answers {
  if (!isRecord(body) || !isRecord(body.answers)) throw new DecisionProviderError(NAME, "malformed response");
  const answers: Answers = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = parseAnswer(body.answers[name], question.type);
    if (!answer) throw new DecisionProviderError(NAME, `missing or malformed answer for question ${name}`);
    answers[name] = answer;
  }
  return answers;
}

function parseUsage(body: Record<string, unknown>): { inputTokens: number; outputTokens: number } | undefined {
  const usage = body.usage;
  if (!isRecord(usage) || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

/** TypeSafe direct over plain fetch so the wire contract stays explicit: body is exactly { model, state, questions }. */
export function createTypesafeProvider(options: TypesafeOptions): DecisionProvider {
  const { apiKey, url = TYPESAFE_URL, timeoutMs = DECISION_TIMEOUT_MS, maxRetries = 2, backoffMs = 200 } = options;
  const pause = options.sleep ?? sleep;

  async function post(body: string, signal: AbortSignal): Promise<unknown> {
    const doFetch = options.fetch ?? globalThis.fetch;
    for (let attempt = 0; ; attempt += 1) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal,
      });
      if (res.ok) return res.json();
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= maxRetries) throw new DecisionProviderError(NAME, `HTTP ${res.status}`, res.status);
      await pause(backoffMs * 2 ** attempt, signal);
    }
  }

  return {
    name: NAME,
    calibrated: true,
    async decide(state: DecisionState, questions: Questions) {
      const started = performance.now();
      const payload = JSON.stringify({ model: JEV_MODEL, state, questions });
      const body = await withDeadline(timeoutMs, (signal) => post(payload, signal));
      const answers = parseAnswers(body, questions);
      const record = body as Record<string, unknown>;
      const usage = parseUsage(record);
      return {
        answers,
        provider: NAME,
        model: typeof record.model === "string" ? record.model : JEV_MODEL,
        calibrated: true,
        latencyMs: Math.round(performance.now() - started),
        ...(usage ? { usage } : {}),
      };
    },
  };
}
