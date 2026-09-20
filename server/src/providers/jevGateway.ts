import {
  instructionsText,
  JEV_GATEWAY_MODEL,
  type Answer,
  type Answers,
  type ChoiceQuestion,
  type DecisionProvider,
  type DecisionState,
  type Question,
  type Questions,
} from "@ghost/shared";
import { DecisionProviderError, isRecord } from "./errors";
import { maxProbability } from "./probabilities";
import { DECISION_TIMEOUT_MS, sleep, withDeadline } from "./timeout";

const NAME = "jev-gateway";
const RETRYABLE_STATUS = new Set([429, 529]);

/** Question shape of the AI SDK's experimental_evaluate: same as Jev's except yes/no is called "boolean". */
export type GatewayQuestion =
  // Criteria stay structured: this path proxies to the same Jev, so it gets the same typed criteria the
  // direct provider sends. Instructions do not — the SDK types them as a string, so they are flattened.
  | { type: "choice"; instructions: string; criteria: ChoiceQuestion["criteria"] }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "boolean"; instructions: string; criteria?: { true: string; false: string } };

export type GatewayAnswer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> }
  | { type: "boolean"; probability: number };

export interface EvaluateArgs {
  model: string;
  state: DecisionState;
  questions: Record<string, GatewayQuestion>;
  abortSignal: AbortSignal;
  maxRetries: number;
}

export interface EvaluateResult {
  answers: Record<string, GatewayAnswer>;
  usage?: { inputTokens?: number; outputTokens?: number };
  providerMetadata?: Record<string, unknown>;
  response?: { modelId?: string };
}

export type EvaluateFn = (args: EvaluateArgs) => Promise<EvaluateResult>;

export interface JevGatewayOptions {
  /** Injected in tests. The default is the AI SDK's experimental_evaluate, which authenticates from AI_GATEWAY_API_KEY. */
  evaluate?: EvaluateFn;
  /** Only needed when the key is not already in process.env.AI_GATEWAY_API_KEY (the SDK reads it from there). */
  apiKey?: string;
  /** Deadline for the whole decide() call, retries included. */
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Gateway and API-call errors carry `statusCode`; a RetryError wraps the last one as `lastError`. */
function statusOf(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.statusCode === "number") return error.statusCode;
  return statusOf(error.lastError) ?? statusOf(error.cause);
}

// "ai" is a large module: load it lazily so tests and keyless runs never pay for it.
let sdk: Promise<typeof import("ai")> | undefined;
function loadSdk(): Promise<typeof import("ai")> {
  sdk ??= import("ai");
  return sdk;
}

function sdkEvaluate(apiKey: string | undefined): EvaluateFn {
  return async (args) => {
    const { experimental_evaluate, createGateway } = await loadSdk();
    type SdkArgs = Parameters<typeof experimental_evaluate>[0];
    const sdkArgs = args as unknown as SdkArgs;
    const keyInEnv = !apiKey || process.env.AI_GATEWAY_API_KEY === apiKey;
    const model = keyInEnv ? sdkArgs.model : createGateway({ apiKey }).evaluationModel(args.model);
    const result = await experimental_evaluate({ ...sdkArgs, model });
    return result as unknown as EvaluateResult;
  };
}

export function toGatewayQuestion(question: Question): GatewayQuestion {
  if (question.type === "noul") return { type: "boolean", instructions: question.instructions, ...(question.criteria ? { criteria: question.criteria } : {}) };
  if (question.type === "score") return question;
  // The ownership wording is preserved, just flattened into the one string the SDK's type allows.
  return { type: "choice", instructions: instructionsText(question.instructions), criteria: question.criteria };
}

/** TypeSafe confidence arrives in providerMetadata.typesafe.confidence, as one number or keyed by question name. */
function reportedConfidence(metadata: EvaluateResult["providerMetadata"], name: string): number | undefined {
  const typesafe = metadata?.typesafe;
  const confidence = isRecord(typesafe) ? typesafe.confidence : undefined;
  if (typeof confidence === "number") return confidence;
  const perQuestion = isRecord(confidence) ? confidence[name] : undefined;
  return typeof perQuestion === "number" ? perQuestion : undefined;
}

function toAnswer(raw: GatewayAnswer | undefined, expected: Question["type"], confidence: number | undefined): Answer | undefined {
  if (!raw) return undefined;
  if (raw.type === "boolean") return expected === "noul" ? { type: "noul", noul: raw.probability } : undefined;
  if (raw.type !== expected) return undefined;
  const probabilities = raw.probabilities ?? {};
  const resolved = confidence ?? maxProbability(probabilities) ?? 0;
  if (raw.type === "choice") return { type: "choice", choice: raw.choice, probabilities, confidence: resolved };
  return { type: "score", score: raw.score, probabilities, confidence: resolved };
}

function toAnswers(result: EvaluateResult, questions: Questions): Answers {
  const answers: Answers = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = toAnswer(result.answers?.[name], question.type, reportedConfidence(result.providerMetadata, name));
    if (!answer) throw new DecisionProviderError(NAME, `missing or malformed answer for question ${name}`);
    answers[name] = answer;
  }
  return answers;
}

/** Jev through Vercel AI Gateway with the AI SDK. One evaluate() call answers every question. */
export function createJevGatewayProvider(options: JevGatewayOptions = {}): DecisionProvider {
  const { timeoutMs = DECISION_TIMEOUT_MS, maxRetries = 2, backoffMs = 200 } = options;
  const evaluate = options.evaluate ?? sdkEvaluate(options.apiKey);
  const pause = options.sleep ?? sleep;

  // The SDK's own backoff starts at 2000 ms, which cannot fit a 2.5 s deadline, so it is told not to retry and
  // 429/529 are retried here on the same short schedule as the direct provider.
  async function evaluateWithRetry(args: Omit<EvaluateArgs, "maxRetries">): Promise<EvaluateResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await evaluate({ ...args, maxRetries: 0 });
      } catch (err) {
        const status = statusOf(err);
        if (status === undefined || !RETRYABLE_STATUS.has(status) || attempt >= maxRetries || args.abortSignal.aborted) throw err;
        await pause(backoffMs * 2 ** attempt, args.abortSignal);
      }
    }
  }
  if (!options.evaluate) void loadSdk().catch(() => undefined); // warm the import so the first form does not pay for it

  return {
    name: NAME,
    calibrated: true,
    async decide(state: DecisionState, questions: Questions) {
      const started = performance.now();
      const mapped: Record<string, GatewayQuestion> = {};
      for (const [name, question] of Object.entries(questions)) mapped[name] = toGatewayQuestion(question);
      const result = await withDeadline(timeoutMs, (abortSignal) =>
        evaluateWithRetry({ model: JEV_GATEWAY_MODEL, state, questions: mapped, abortSignal }),
      );
      const { inputTokens, outputTokens } = result.usage ?? {};
      return {
        answers: toAnswers(result, questions),
        provider: NAME,
        model: result.response?.modelId ?? JEV_GATEWAY_MODEL,
        calibrated: true,
        latencyMs: Math.round(performance.now() - started),
        ...(typeof inputTokens === "number" && typeof outputTokens === "number" ? { usage: { inputTokens, outputTokens } } : {}),
      };
    },
  };
}
