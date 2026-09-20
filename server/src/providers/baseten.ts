import { createHash } from "node:crypto";
import { criterionText, type DecisionProvider, type DecisionResult, type DecisionState, type Questions } from "@ghost/shared";
import type { BasetenConfig, LlmConfig } from "../config";
import { stripThinkBlocks } from "../llm/client";
import { consensus, type ConsensusAnswer, type Sample } from "./consensus";
import { DecisionProviderError, isRecord } from "./errors";
import { buildFormDecision } from "./formQuestions";
import { hedge } from "./hedge";
import { SAMPLE_FACT_KEYS, sampleFormFields } from "./sampleForm";
import { DECISION_TIMEOUT_MS } from "./timeout";

/**
 * Baseten Model APIs (OpenAI-compatible) as a decision provider: hedged self-consistency over structured outputs.
 * ONE logical decision per form. The same json_schema-constrained request is fired K + H times in parallel at
 * temperature 0.7; the first K valid answers are voted on (consensus.ts) and the stragglers are aborted (hedge.ts).
 * Measured on these APIs: logprobs are accepted but never returned, so agreement between samples is the confidence signal.
 */

const NAME = "baseten";
/** formPredict races the provider against DECISION_TIMEOUT_MS. Finishing a little earlier lets a partial vote win that race. */
export const BASETEN_DEADLINE_MS = DECISION_TIMEOUT_MS - 200;
export const SAMPLE_TEMPERATURE = 0.7;
const AUTH_PAUSE_MS = 60_000;
/**
 * Measured on a fresh account: `x-ratelimit-limit-requests: 15`, and `x-ratelimit-remaining-requests` behaves like a token
 * bucket (about 8 after an idle stretch, one request back every 4 s). A remembered budget is trusted for one window.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_REMAINING_HEADER = "x-ratelimit-remaining-requests";
const RATE_LIMIT_HEADER = "x-ratelimit-limit-requests";
const WARMUP_TIMEOUT_MS = 15_000;
const REASONING_HEADROOM_TOKENS = 700;
const MAX_CODE_CHARS = 24;
const PLAIN_CODE = /^[A-Za-z0-9_.:-]+$/;

// ---------------------------------------------------------------------------------------------------------------
// Thinking control. Every model in the catalog reasons by default, which costs seconds and returns content=null on
// short limits. Only the first two GLM / DeepSeek rows were verified live (GLM-5.3-Flash, DeepSeek-V4.1-Flash); the
// rest of each family is assumed to behave the same.
// ---------------------------------------------------------------------------------------------------------------

export type ThinkingMode = "off" | "low" | "required" | "unknown";

export interface ThinkingControl {
  mode: ThinkingMode;
  /** Request-body fields that apply the mode. */
  body: Record<string, unknown>;
}

const THINKING_TABLE: { match: RegExp; control: ThinkingControl }[] = [
  // Verified: GLM-5.3-Fast answers 400 (conflicts with thinking mode 'required') when asked to stop thinking.
  { match: /^zai-org\/GLM-[\d.]+-Fast$/i, control: { mode: "required", body: {} } },
  { match: /^zai-org\/GLM-/i, control: { mode: "off", body: { chat_template_kwargs: { enable_thinking: false } } } },
  { match: /^deepseek-ai\//i, control: { mode: "off", body: { chat_template_kwargs: { thinking: false, enable_thinking: false } } } },
  // Verified: accepts reasoning_effort and still spends about 30 reasoning tokens.
  { match: /^openai\/gpt-oss/i, control: { mode: "low", body: { reasoning_effort: "low" } } },
  // Verified: inkling-small ignores the switch.
  { match: /^thinkingmachines\/inkling/i, control: { mode: "required", body: {} } },
];

export function thinkingControl(model: string): ThinkingControl {
  const row = THINKING_TABLE.find((r) => r.match.test(model));
  return row?.control ?? { mode: "unknown", body: { chat_template_kwargs: { enable_thinking: false } } };
}

/** The OpenAI-compatible client config for streamed ghost text: thinking off, reasoning stripped, replica affinity for the shared system prompt. */
export function basetenTextLlm(baseten: BasetenConfig): LlmConfig {
  return {
    name: "baseten",
    apiKey: baseten.apiKey,
    baseUrl: baseten.baseUrl,
    model: baseten.textModel,
    extraBody: thinkingControl(baseten.textModel).body,
    headers: { "x-session-affinity": "ghost-text" },
    stripReasoning: true,
    maxTokensParam: "max_tokens",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Request plan: prompt, schema and the decoder that maps answer codes back to option names.
// ---------------------------------------------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a decision function. The user message is JSON with `state` and `questions`. Answer EVERY question about the state.",
  "Reply with one JSON object that maps each question name to exactly one of that question's allowed codes. No explanations.",
  "choice question: `options` names an entry of `optionSets`, which maps each allowed code to its meaning. Answer none (when offered) if nothing fits.",
  // This used to name two rows of the ambiguous benchmark ("someone else's phone, an employer's website"), which handed
  // this provider the answer key that Jev — which has no system-prompt channel — never got, and made the published
  // comparison meaningless. The exclusion now travels in each option's `not_for`, which every provider receives.
  "An option must fit exactly. When an option says what it is `not for`, that exclusion is binding: answer none instead.",
  "noul question: answer yes or no.",
  "score question: `levels` maps the codes 0..N to descriptions ordered low to high. Answer the code of the level that fits best.",
  "Backticked paths in instructions, like `fields[3]`, point into the state.",
].join("\n");

/** Short plain options (fact keys, none) stay readable for the model; anything long or odd becomes a code like o7. */
export function aliasOptions(options: string[]): string[] {
  const isPlain = (o: string): boolean => o.length <= MAX_CODE_CHARS && PLAIN_CODE.test(o);
  const taken = new Set(options.filter(isPlain));
  return options.map((option, i) => {
    if (isPlain(option)) return option;
    let code = `o${i}`;
    while (taken.has(code)) code += "_";
    taken.add(code);
    return code;
  });
}

export interface DecisionPlan {
  messages: { role: "system" | "user"; content: string }[];
  schema: Record<string, unknown>;
  /** Stable per schema and model, so repeated forms land on the replica that already compiled this grammar. */
  affinity: string;
  maxTokens: number;
  /** Raw JSON answer -> votes. Codes that were never offered are dropped. */
  decode(raw: Record<string, unknown>): Sample;
}

export function maxTokensFor(questionCount: number, mode: ThinkingMode = "off"): number {
  const reasoning = mode === "low" || mode === "required" ? REASONING_HEADROOM_TOKENS : 0;
  return Math.min(2000, 48 + 16 * questionCount) + reasoning;
}

export function buildDecisionPlan(model: string, state: DecisionState, questions: Questions): DecisionPlan {
  const setNames = new Map<string, string>();
  const optionSets: Record<string, Record<string, string | null>> = {};
  const prompt: Record<string, unknown> = {};
  const properties: Record<string, unknown> = {};
  const decoders = new Map<string, (code: string) => unknown>();

  for (const [name, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      const codes = aliasOptions(options);
      const key = JSON.stringify(q.criteria);
      let set = setNames.get(key);
      if (!set) {
        set = `set${setNames.size}`;
        setNames.set(key, set);
        const meanings: Record<string, string | null> = {};
        options.forEach((option, i) => {
          // Jev takes structured criteria natively; this transport is a text prompt, so flatten them.
          const description = criterionText(q.criteria[option] ?? null);
          const code = codes[i] ?? option;
          meanings[code] = code === option ? description : description ? `${option}: ${description}` : option;
        });
        optionSets[set] = meanings;
      }
      prompt[name] = { type: "choice", instructions: q.instructions, options: set };
      properties[name] = { type: "string", enum: codes };
      const byCode = new Map(codes.map((code, i) => [code, options[i]]));
      decoders.set(name, (code) => byCode.get(code));
    } else if (q.type === "noul") {
      prompt[name] = { type: "noul", instructions: q.instructions, ...(q.criteria ? { yes: q.criteria.true, no: q.criteria.false } : {}) };
      properties[name] = { type: "string", enum: ["yes", "no"] };
      decoders.set(name, (code) => (code === "yes" ? true : code === "no" ? false : undefined));
    } else {
      const levels = Object.fromEntries(q.criteria.map((text, level) => [String(level), text]));
      prompt[name] = { type: "score", instructions: q.instructions, levels };
      properties[name] = { type: "string", enum: Object.keys(levels) };
      decoders.set(name, (code) => (Object.hasOwn(levels, code) ? Number(code) : undefined));
    }
  }

  const schema = { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  const affinity = `ghost-${createHash("sha256").update(`${model}\n${JSON.stringify(schema)}`).digest("hex").slice(0, 16)}`;
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ state, optionSets, questions: prompt }) },
    ],
    schema,
    affinity,
    maxTokens: maxTokensFor(decoders.size, thinkingControl(model).mode),
    decode(raw) {
      const sample: Sample = {};
      for (const [name, decoder] of decoders) {
        const code = raw[name];
        const vote = typeof code === "string" || typeof code === "number" ? decoder(String(code)) : undefined;
        if (vote !== undefined) sample[name] = vote;
      }
      return sample;
    },
  };
}

export function buildRequestBody(model: string, plan: DecisionPlan, options: { temperature: number; logprobs?: boolean; maxTokens?: number }): Record<string, unknown> {
  return {
    ...thinkingControl(model).body,
    model,
    messages: plan.messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens ?? plan.maxTokens,
    response_format: { type: "json_schema", json_schema: { name: "ghost_decision", strict: true, schema: plan.schema } },
    ...(options.logprobs ? { logprobs: true, top_logprobs: 5 } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Response parsing.
// ---------------------------------------------------------------------------------------------------------------

const STRING_PAIR = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

function unquote(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(`"${text}"`);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Parses the answer object. A reply cut off by the token limit still yields its complete `"name":"code"` pairs. */
export function parseAnswerJson(content: string): Record<string, unknown> | undefined {
  const text = stripThinkBlocks(content).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return isRecord(parsed.answers) ? parsed.answers : parsed;
  } catch {
    // fall through to the salvage below
  }
  const pairs: Record<string, unknown> = {};
  for (const match of text.matchAll(STRING_PAIR)) {
    const name = unquote(match[1] ?? "");
    const code = unquote(match[2] ?? "");
    if (name !== undefined && code !== undefined) pairs[name] = code;
  }
  return Object.keys(pairs).length > 0 ? pairs : undefined;
}

export interface TokenLogprob {
  token: string;
  logprob: number;
}

interface Completion {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
  tokens?: TokenLogprob[];
}

/** Capability probe: the Model APIs accept `logprobs` and return none today. If a response ever carries them, they are picked up here. */
export function readLogprobs(choice: unknown): TokenLogprob[] | undefined {
  const logprobs = isRecord(choice) ? choice.logprobs : undefined;
  const content = isRecord(logprobs) && Array.isArray(logprobs.content) ? logprobs.content : [];
  const tokens = content.flatMap((t: unknown) => (isRecord(t) && typeof t.token === "string" && typeof t.logprob === "number" ? [{ token: t.token, logprob: t.logprob }] : []));
  return tokens.length > 0 && tokens.length === content.length ? tokens : undefined;
}

function readCompletion(body: unknown): Completion {
  const choices = isRecord(body) && Array.isArray(body.choices) ? body.choices : [];
  const first: unknown = choices[0];
  const message = isRecord(first) ? first.message : undefined;
  // Reasoning models answer content=null plus reasoning_content when the limit ran out: that is an invalid sample, never an answer.
  const content = isRecord(message) && typeof message.content === "string" ? message.content : "";
  if (!content.trim()) throw new DecisionProviderError(NAME, "response has no content");
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : undefined;
  const counted = usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number";
  return {
    content,
    ...(counted ? { usage: { inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number } } : {}),
    tokens: readLogprobs(first),
  };
}

const VALUE_AFTER_NAME = String.raw`\s*:\s*"((?:[^"\\]|\\.)*)"`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Probability the model put on each answered value: exp of the summed logprobs of the tokens that overlap the value.
 * Tokens the grammar forces (quotes, names) have logprob about 0, so including a neighbour barely moves the product.
 */
export function valueProbabilities(content: string, tokens: TokenLogprob[], names: string[]): Record<string, number> {
  if (tokens.map((t) => t.token).join("") !== content) return {};
  const out: Record<string, number> = {};
  for (const name of names) {
    const match = new RegExp(escapeRegExp(JSON.stringify(name)) + VALUE_AFTER_NAME).exec(content);
    if (!match) continue;
    const end = match.index + match[0].length - 1;
    const start = end - (match[1] ?? "").length;
    let offset = 0;
    let logprob = 0;
    for (const t of tokens) {
      const next = offset + t.token.length;
      if (next > start && offset < end) logprob += t.logprob;
      offset = next;
    }
    out[name] = Math.exp(logprob);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The provider.
// ---------------------------------------------------------------------------------------------------------------

export interface BasetenSampling {
  /** K and H as configured. */
  samplesExpected: number;
  hedge: number;
  launched: number;
  samplesReceived: number;
  failed: number;
  abandoned: number;
  /** True when the deadline cut the vote short: confidences are scaled down by samplesReceived / K. */
  partial: boolean;
  /** Requests answered 429. The next decision fans out only as far as the remaining request budget allows. */
  rateLimited: number;
  arrivalsMs: number[];
  logprobsSeen: boolean;
}

/** Server-internal result: the wire-format DecisionResult plus where each confidence came from. */
export interface BasetenDecisionResult extends DecisionResult {
  answers: Record<string, ConsensusAnswer>;
  sampling: BasetenSampling;
}

export interface BasetenProvider extends DecisionProvider {
  decide(state: DecisionState, questions: Questions): Promise<BasetenDecisionResult>;
  /** ONE tiny request that makes Baseten compile the standard form schema before the first real form needs it. Never throws. */
  warmUp(): Promise<{ ok: boolean; latencyMs: number; status?: number }>;
}

export interface BasetenProviderOptions {
  baseten: BasetenConfig;
  fetch?: typeof fetch;
  /** Deadline for the whole vote. Default: a little under the server's 2.5 s decision deadline. */
  timeoutMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

interface SampleResult extends Completion {
  votes: Sample;
}

function isAuthError(err: unknown): boolean {
  return err instanceof DecisionProviderError && (err.status === 401 || err.status === 403);
}

function sumUsage(samples: SampleResult[]): DecisionResult["usage"] {
  const counted = samples.flatMap((s) => (s.usage ? [s.usage] : []));
  if (counted.length === 0) return undefined;
  return { inputTokens: counted.reduce((n, u) => n + u.inputTokens, 0), outputTokens: counted.reduce((n, u) => n + u.outputTokens, 0) };
}

/** Logprob upgrade for choice answers: mean token probability among the samples that voted for the winner, times the raw vote share and coverage. */
function applyLogprobs(answers: Record<string, ConsensusAnswer>, samples: SampleResult[], expected: number): boolean {
  const scored = samples.flatMap((s) => (s.tokens ? [{ votes: s.votes, p: valueProbabilities(s.content, s.tokens, Object.keys(s.votes)) }] : []));
  if (scored.length === 0) return false;
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type !== "choice" || answer.tie) continue;
    const winners = scored.flatMap((s) => (s.votes[name] === answer.choice && typeof s.p[name] === "number" ? [s.p[name]] : []));
    if (winners.length === 0) continue;
    const share = samples.filter((s) => s.votes[name] === answer.choice).length / Math.max(1, answer.votes);
    const mean = winners.reduce((sum, p) => sum + p, 0) / winners.length;
    answer.confidence = Math.min(1, mean * share * Math.min(1, answer.votes / expected));
    answer.confidenceSource = "logprobs";
  }
  return true;
}

export function createBasetenProvider(options: BasetenProviderOptions): BasetenProvider {
  const { baseten, timeoutMs = BASETEN_DEADLINE_MS } = options;
  const model = baseten.decisionModel;
  const url = `${(baseten.decisionBaseUrl ?? baseten.baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => (process.env.VITEST ? undefined : console.warn(line)));
  const expected = baseten.samples;
  // Sampling only makes sense when several answers are compared; a single request is asked for its best answer.
  const temperature = expected > 1 ? SAMPLE_TEMPERATURE : 0;
  let pausedUntil = 0;
  let authLogged = false;
  let budget: { remaining: number; at: number } | undefined;
  /** Requests per minute, once a response has said so. Without it the remembered budget never grows back on its own. */
  let perMinute: number | undefined;

  /** What the API last said is left, plus what the bucket refilled since (never more than the limit itself). */
  function available(): number | undefined {
    if (!budget) return undefined;
    const age = now() - budget.at;
    if (age > RATE_WINDOW_MS) return undefined;
    if (!perMinute) return budget.remaining;
    return Math.min(perMinute, budget.remaining + Math.floor((Math.max(0, age) * perMinute) / 60_000));
  }

  /**
   * K + H parallel requests drain a small per-minute request limit in a few forms, and a 429 burst answers nothing.
   * So the fan-out never exceeds the estimated budget: the hedge goes first, then samples (which lowers
   * confidence through the votes / K scaling). One request is always sent, so the budget is re-learned.
   */
  function fanOut(): number {
    const wanted = expected + baseten.hedge;
    const left = available();
    return left === undefined ? wanted : Math.max(1, Math.min(wanted, left));
  }

  function headerNumber(res: Response, name: string): number {
    const header = res.headers.get(name);
    return header === null || header.trim() === "" ? Number.NaN : Number(header);
  }

  function noteRateBudget(res: Response): void {
    const limit = headerNumber(res, RATE_LIMIT_HEADER);
    if (Number.isFinite(limit) && limit > 0) perMinute = Math.floor(limit);
    const remaining = headerNumber(res, RATE_REMAINING_HEADER);
    if (res.status === 429) budget = { remaining: 0, at: now() };
    else if (Number.isFinite(remaining)) budget = { remaining: Math.max(0, Math.floor(remaining)), at: now() };
  }

  async function post(plan: DecisionPlan, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const doFetch = options.fetch ?? globalThis.fetch;
    const res = await doFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${baseten.apiKey}`, "Content-Type": "application/json", "x-session-affinity": plan.affinity },
      body: JSON.stringify(body),
      signal,
    });
    noteRateBudget(res);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      // Status only: upstream error bodies can echo parts of a key.
      throw new DecisionProviderError(NAME, `HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as unknown;
  }

  /** No retries beyond hedging. A rejected key pauses the provider so a bad key costs one burst, not one per form. */
  function pauseAfterAuthFailure(status: number | undefined): void {
    pausedUntil = now() + AUTH_PAUSE_MS;
    if (authLogged) return;
    authLogged = true;
    log(`[ghost] baseten: HTTP ${status ?? "?"} from the API, check BASETEN_API_KEY. Provider paused for ${AUTH_PAUSE_MS / 1000} s at a time; the heuristic answers meanwhile.`);
  }

  async function sampleOnce(plan: DecisionPlan, signal: AbortSignal): Promise<SampleResult> {
    const completion = readCompletion(await post(plan, buildRequestBody(model, plan, { temperature, logprobs: baseten.logprobs }), signal));
    const raw = parseAnswerJson(completion.content);
    const votes = raw ? plan.decode(raw) : {};
    if (Object.keys(votes).length === 0) throw new DecisionProviderError(NAME, "sample has no usable answer");
    return { ...completion, votes };
  }

  return {
    name: NAME,
    // Vote fractions are a useful ranking signal, not an audited calibration.
    calibrated: false,
    async decide(state, questions) {
      const started = performance.now();
      if (now() < pausedUntil) throw new DecisionProviderError(NAME, "paused after an auth failure");
      const sampling: BasetenSampling = { samplesExpected: expected, hedge: baseten.hedge, launched: 0, samplesReceived: 0, failed: 0, abandoned: 0, partial: false, rateLimited: 0, arrivalsMs: [], logprobsSeen: false };
      if (Object.keys(questions).length === 0) return { answers: {}, provider: NAME, model, calibrated: false, latencyMs: 0, sampling };

      const plan = buildDecisionPlan(model, state, questions);
      const total = fanOut();
      const left = available();
      if (left !== undefined) budget = { remaining: Math.max(0, left - total), at: now() };
      const race = await hedge({ total, need: Math.min(expected, total), deadlineMs: timeoutMs, run: (_, signal) => sampleOnce(plan, signal), isFatal: isAuthError });
      const rateLimited = race.errors.filter((e) => e instanceof DecisionProviderError && e.status === 429).length;
      if (race.fatal !== undefined) {
        const status = race.fatal instanceof DecisionProviderError ? race.fatal.status : undefined;
        pauseAfterAuthFailure(status);
        throw new DecisionProviderError(NAME, `HTTP ${status ?? "?"}`, status);
      }
      if (race.values.length === 0) {
        const upstream = race.errors.find((e): e is DecisionProviderError => e instanceof DecisionProviderError);
        throw new DecisionProviderError(NAME, race.deadlineHit ? `no valid sample within ${timeoutMs} ms` : (upstream?.message.replace(`${NAME}: `, "") ?? "every request failed"), upstream?.status);
      }

      const answers = consensus(questions, race.values.map((s) => s.votes), { expected });
      if (Object.keys(answers).length === 0) throw new DecisionProviderError(NAME, "no usable answers");
      const logprobsSeen = applyLogprobs(answers, race.values, expected);
      const usage = sumUsage(race.values);
      return {
        answers,
        provider: NAME,
        model,
        calibrated: false,
        latencyMs: Math.round(performance.now() - started),
        ...(usage ? { usage } : {}),
        sampling: { ...sampling, launched: race.launched, samplesReceived: race.values.length, failed: race.failed, abandoned: race.abandoned, partial: race.values.length < expected, rateLimited, arrivalsMs: race.arrivalsMs, logprobsSeen },
      };
    },
    async warmUp() {
      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);
      if (now() < pausedUntil) return { ok: false, latencyMs: 0 };
      const { state, questions } = buildFormDecision("http://localhost", sampleFormFields(), SAMPLE_FACT_KEYS);
      const plan = buildDecisionPlan(model, state, questions);
      try {
        // The grammar is compiled before the first token, so one output token is enough and costs almost nothing.
        await post(plan, buildRequestBody(model, plan, { temperature: 0, maxTokens: 1 }), AbortSignal.timeout(WARMUP_TIMEOUT_MS));
        return { ok: true, latencyMs: elapsed() };
      } catch (err) {
        if (isAuthError(err)) pauseAfterAuthFailure((err as DecisionProviderError).status);
        return { ok: false, latencyMs: elapsed(), ...(err instanceof DecisionProviderError && err.status ? { status: err.status } : {}) };
      }
    },
  };
}
