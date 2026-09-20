import { criterionText, instructionsText, type Answer, type Answers, type ChoiceQuestion, type DecisionProvider, type DecisionState, type Question, type Questions } from "@shabang/shared";
import type { LlmConfig } from "../config";
import { DecisionProviderError, isRecord } from "./errors";
import { clamp01, spreadProbabilities } from "./probabilities";
import { DECISION_TIMEOUT_MS, withDeadline } from "./timeout";

const NAME = "llm";
/** Self-reported LLM confidence is overconfident, so it is capped and the provider reports calibrated=false. */
const MAX_PSEUDO_CONFIDENCE = 0.9;
const DEFAULT_PSEUDO_CONFIDENCE = 0.7;

const SYSTEM_PROMPT = [
  "You are a decision function. You receive JSON with `state` and `questions` and answer EVERY question about the state.",
  'Reply with one JSON object and nothing else: {"answers":{"<question name>":<answer>}}.',
  // Compact answers on purpose: the call is output-bound (about 6 ms per token live), and arrays cost a quarter fewer tokens than objects.
  'choice question: ["<exactly one key of that question\'s criteria>",<confidence 0..1>]. Use "none" when no option fits.',
  "noul question: <probability 0..1 that the statement is true>, as a bare number.",
  "score question: [<index into criteria, 0 = lowest>,<confidence 0..1>].",
  "Backticked paths in instructions, like `fields[3]`, point into the state. Never add explanations.",
  "When a question's criteria is a string, it names an entry of `criteriaSets` that holds the actual criteria.",
].join("\n");

export interface LlmProviderOptions {
  llm: LlmConfig;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function maxTokensFor(questionCount: number): number {
  return Math.min(1500, 48 + 24 * questionCount);
}

/**
 * A form asks one choice question per field, all with the same criteria. Sending that option list once instead of
 * once per question cut a 12-field prompt from about 2300 to about 700 tokens in live runs. Prompt shape only:
 * the Jev wire format is untouched.
 */
export function shareCriteria(questions: Questions): { questions: Record<string, unknown>; criteriaSets?: Record<string, unknown> } {
  const uses = new Map<string, number>();
  const keyOf = (q: Question): string | undefined => (q.type === "choice" ? JSON.stringify(q.criteria) : undefined);
  for (const q of Object.values(questions)) {
    const key = keyOf(q);
    if (key) uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  const names = new Map<string, string>();
  const criteriaSets: Record<string, unknown> = {};
  const compact: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    const key = keyOf(q);
    if (q.type !== "choice" || !key || (uses.get(key) ?? 0) < 2) {
      compact[name] = q;
      continue;
    }
    const set = names.get(key) ?? `set${names.size}`;
    names.set(key, set);
    criteriaSets[set] = q.criteria;
    compact[name] = { ...q, criteria: set };
  }
  return names.size === 0 ? { questions } : { criteriaSets, questions: compact };
}

/**
 * This transport is a text prompt whose contract says `instructions` is a string and each criterion is a
 * description. Jev's structured form has to be flattened before it goes out, or a weaker model answers
 * `none` at confidence 0 for every field. The ownership wording is preserved, not dropped.
 */
export function toTextQuestions(questions: Questions): Questions {
  const out: Questions = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type !== "choice") {
      out[name] = q;
      continue;
    }
    const criteria: ChoiceQuestion["criteria"] = {};
    for (const [option, criterion] of Object.entries(q.criteria)) criteria[option] = criterionText(criterion);
    out[name] = { ...q, instructions: instructionsText(q.instructions), criteria };
  }
  return out;
}

export function buildChatBody(model: string, state: DecisionState, questions: Questions): Record<string, unknown> {
  return {
    model,
    temperature: 0,
    // max_tokens is deprecated on both api.openai.com and api.x.ai in favour of this field.
    max_completion_tokens: maxTokensFor(Object.keys(questions).length),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ state, ...shareCriteria(toTextQuestions(questions)) }) },
    ],
  };
}

function pseudoConfidence(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.min(MAX_PSEUDO_CONFIDENCE, clamp01(raw)) : DEFAULT_PSEUDO_CONFIDENCE;
}

/** An option that was never offered (say "first_name" for "firstName") is no answer at all: the caller keeps its own guess instead of a confident-looking none. */
function choiceAnswer(raw: Record<string, unknown>, options: string[]): Answer | undefined {
  if (typeof raw.choice !== "string" || !options.includes(raw.choice)) return undefined;
  const confidence = pseudoConfidence(raw.confidence);
  return { type: "choice", choice: raw.choice, probabilities: spreadProbabilities(options, raw.choice, confidence), confidence };
}

/** The prompt asks for compact arrays and bare numbers; the object form is still accepted because models drift back to it. */
function toRecord(raw: unknown, question: Question): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  const [first, second]: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (question.type === "choice") return { choice: first, confidence: second };
  if (question.type === "noul") return { probability: first };
  return { score: first, confidence: second };
}

function toAnswer(raw: unknown, question: Question): Answer | undefined {
  const record = toRecord(raw, question);
  if (question.type === "choice") return choiceAnswer(record, Object.keys(question.criteria));
  if (question.type === "noul") return typeof record.probability === "number" ? { type: "noul", noul: clamp01(record.probability) } : undefined;
  if (typeof record.score !== "number" || !Number.isFinite(record.score)) return undefined;
  const score = Math.min(question.criteria.length - 1, Math.max(0, record.score));
  return { type: "score", score, probabilities: {}, confidence: pseudoConfidence(record.confidence) };
}

function parseContent(body: unknown): Record<string, unknown> {
  const choices = isRecord(body) && Array.isArray(body.choices) ? body.choices : [];
  const first: unknown = choices[0];
  const message = isRecord(first) ? first.message : undefined;
  const content = isRecord(message) && typeof message.content === "string" ? message.content : "";
  const json = content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  try {
    const parsed: unknown = JSON.parse(json);
    if (isRecord(parsed)) return isRecord(parsed.answers) ? parsed.answers : parsed;
  } catch {
    // handled below
  }
  throw new DecisionProviderError(NAME, "model did not return a JSON object");
}

function parseUsage(body: unknown): { inputTokens: number; outputTokens: number } | undefined {
  const usage = isRecord(body) ? body.usage : undefined;
  if (!isRecord(usage) || typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") return undefined;
  return { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
}

/** OpenAI-compatible adapter (OpenAI and xAI). One chat completion answers every question. Confidence is NOT calibrated. */
export function createLlmProvider(options: LlmProviderOptions): DecisionProvider {
  const { llm, timeoutMs = DECISION_TIMEOUT_MS } = options;
  const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    name: NAME,
    calibrated: false,
    async decide(state: DecisionState, questions: Questions) {
      const started = performance.now();
      const doFetch = options.fetch ?? globalThis.fetch;
      const body = await withDeadline(timeoutMs, async (signal) => {
        const res = await doFetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${llm.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildChatBody(llm.model, state, questions)),
          signal,
        });
        if (!res.ok) throw new DecisionProviderError(NAME, `${llm.name} HTTP ${res.status}`, res.status);
        return (await res.json()) as unknown;
      });
      const raw = parseContent(body);
      const answers: Answers = {};
      for (const [name, question] of Object.entries(questions)) {
        const answer = toAnswer(raw[name], question);
        if (answer) answers[name] = answer;
      }
      if (Object.keys(answers).length === 0 && Object.keys(questions).length > 0) throw new DecisionProviderError(NAME, "no usable answers");
      const usage = parseUsage(body);
      return {
        answers,
        provider: NAME,
        model: llm.model,
        calibrated: false,
        latencyMs: Math.round(performance.now() - started),
        ...(usage ? { usage } : {}),
      };
    },
  };
}
