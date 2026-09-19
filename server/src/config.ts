export type DecisionProviderName = "typesafe" | "jev-gateway" | "baseten" | "llm" | "heuristic";
export type TextProviderName = "baseten" | "openai" | "xai" | "template";

export interface LlmConfig {
  name: "openai" | "xai" | "baseten";
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Extra request-body fields, e.g. Baseten's `chat_template_kwargs` that switches thinking off. */
  extraBody?: Record<string, unknown>;
  /** Extra request headers, e.g. Baseten's `x-session-affinity`. Never a place for keys. */
  headers?: Record<string, string>;
  /** Reasoning models: ignore `reasoning_content` and drop `<think>` blocks so reasoning never reaches a ghost. */
  stripReasoning?: boolean;
  /** Name of the output-token limit. OpenAI and xAI deprecated `max_tokens`; Baseten's Model APIs were verified with it. */
  maxTokensParam?: "max_completion_tokens" | "max_tokens";
}

export const BASETEN_DEFAULT_BASE_URL = "https://inference.baseten.co/v1";
/** Verified live: thinking can be switched off per request on this model (378 ms plain call). Most of the catalog reasons by default. */
export const BASETEN_DEFAULT_MODEL = "zai-org/GLM-5.3-Flash";

export interface BasetenConfig {
  apiKey: string;
  baseUrl: string;
  decisionModel: string;
  textModel: string;
  /** K: valid samples a decision waits for. Every sample is a billed request. */
  samples: number;
  /** H: extra identical requests fired with the K, so one slow replica cannot hold the decision. */
  hedge: number;
  /** BASETEN_DECISION_MODEL_URL: OpenAI-compatible base URL of a dedicated deployment (our own Tab model). Decisions only. */
  decisionBaseUrl?: string;
  /** BASETEN_LOGPROBS=1: ask for logprobs and use them when a response carries them. Off by default: the Model APIs return none. */
  logprobs: boolean;
  /** One tiny request at server start so the first form does not pay the cold json_schema compile. GHOST_WARMUP=0 disables. */
  warmup: boolean;
}

export interface ServerConfig {
  port: number;
  /** Listen address. Loopback unless GHOST_HOST says otherwise: the API is unauthenticated and spends paid model quota. */
  host: string;
  decisionProvider: DecisionProviderName;
  textProvider: TextProviderName;
  typesafeApiKey?: string;
  aiGatewayApiKey?: string;
  llm?: LlmConfig;
  /** Set only when BASETEN_API_KEY is present AND Baseten is the active decision or text provider. */
  baseten?: BasetenConfig;
  /** Skip the model call when the heuristic already maps every field with high confidence. */
  fastPath: boolean;
  /** Stage 8 parallel executor. Set only when BOTH BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are present. */
  browserbase?: { apiKey: string; projectId: string; concurrency?: number; contextId?: string };
  /** Stage 8 API executor. Set only when COMPOSIO_API_KEY is present. */
  composio?: { apiKey: string; userId: string; connectedAccounts: Record<string, string | undefined>; defaults: Record<string, string> };
  /** GHOST_PUBLIC_DEMO_URL: where cloud browsers can reach the site that runs on localhost here. */
  publicDemoUrl?: string;
  /** GHOST_EXTENSION_ID: the only chrome-extension origin that may run real loop batches (see executors/access.ts). */
  extensionId?: string;
  /** GHOST_EXECUTE_TOKEN: per-install secret a caller without an Origin (the desktop daemon) sends as X-Ghost-Token. Never logged. */
  executeToken?: string;
  /** Optional, manual-only agent outcome capture. No automatic request/error instrumentation is enabled. */
  sentry?: { dsn: string; environment: string; release?: string };
}

/** Every cloud session is billed, so BROWSERBASE_CONCURRENCY is clamped. Keep in step with MAX_CONCURRENCY in executors/browserbase.ts. */
const MAX_BROWSERBASE_CONCURRENCY = 10;

type Env = Record<string, string | undefined>;

function llmFromEnv(env: Env): LlmConfig | undefined {
  if (env.OPENAI_API_KEY) {
    return { name: "openai", apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", model: env.OPENAI_MODEL ?? "gpt-4o-mini" };
  }
  if (env.XAI_API_KEY) {
    return { name: "xai", apiKey: env.XAI_API_KEY, baseUrl: env.XAI_BASE_URL ?? "https://api.x.ai/v1", model: env.XAI_MODEL || "grok-4.20-non-reasoning" };
  }
  return undefined;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Each decision costs samples + hedge requests, so both are clamped. */
export const BASETEN_MAX_SAMPLES = 8;
export const BASETEN_MAX_HEDGE = 4;

function basetenFromEnv(env: Env): BasetenConfig | undefined {
  if (!env.BASETEN_API_KEY) return undefined;
  return {
    apiKey: env.BASETEN_API_KEY,
    baseUrl: env.BASETEN_BASE_URL || BASETEN_DEFAULT_BASE_URL,
    decisionModel: env.BASETEN_DECISION_MODEL || BASETEN_DEFAULT_MODEL,
    textModel: env.BASETEN_TEXT_MODEL || BASETEN_DEFAULT_MODEL,
    samples: boundedInt(env.BASETEN_SAMPLES, 3, 1, BASETEN_MAX_SAMPLES),
    hedge: boundedInt(env.BASETEN_HEDGE, 1, 0, BASETEN_MAX_HEDGE),
    decisionBaseUrl: env.BASETEN_DECISION_MODEL_URL || undefined,
    logprobs: env.BASETEN_LOGPROBS === "1",
    warmup: env.GHOST_WARMUP !== "0",
  };
}

/** A forced text provider without credentials degrades to the template, so it can never cause a surprise network call. */
function resolveTextProvider(forced: TextProviderName | undefined, baseten: BasetenConfig | undefined, llm: LlmConfig | undefined): TextProviderName {
  if (forced === "template") return "template";
  if (forced === "baseten") return baseten ? "baseten" : "template";
  if (forced) return forced;
  return baseten ? "baseten" : llm ? llm.name : "template";
}

function browserbaseFromEnv(env: Env): ServerConfig["browserbase"] {
  if (!env.BROWSERBASE_API_KEY || !env.BROWSERBASE_PROJECT_ID) return undefined;
  const concurrency = Number(env.BROWSERBASE_CONCURRENCY);
  return {
    apiKey: env.BROWSERBASE_API_KEY,
    projectId: env.BROWSERBASE_PROJECT_ID,
    concurrency: Number.isInteger(concurrency) && concurrency > 0 ? Math.min(concurrency, MAX_BROWSERBASE_CONCURRENCY) : undefined,
    contextId: env.BROWSERBASE_CONTEXT_ID || undefined,
  };
}

function composioFromEnv(env: Env): ServerConfig["composio"] {
  if (!env.COMPOSIO_API_KEY) return undefined;
  const defaults: Record<string, string> = { sheetRange: env.COMPOSIO_SHEET_RANGE || "Sheet1" };
  if (env.COMPOSIO_SPREADSHEET_ID) defaults.spreadsheetId = env.COMPOSIO_SPREADSHEET_ID;
  return {
    apiKey: env.COMPOSIO_API_KEY,
    userId: env.COMPOSIO_USER_ID || "default",
    connectedAccounts: { gmail: env.COMPOSIO_GMAIL_ACCOUNT_ID || undefined, googlesheets: env.COMPOSIO_GOOGLESHEETS_ACCOUNT_ID || undefined },
    defaults,
  };
}

function sentryFromEnv(env: Env): ServerConfig["sentry"] {
  const raw = env.SENTRY_DSN;
  if (!raw) return undefined;
  try {
    const dsn = new URL(raw);
    if (!/^https?:$/.test(dsn.protocol) || !dsn.hostname || !dsn.username || dsn.password) return undefined;
    const safe = (value: string | undefined, fallback?: string): string | undefined => {
      const trimmed = value?.trim();
      return trimmed && trimmed.length <= 100 && /^[A-Za-z0-9._/@-]+$/.test(trimmed) ? trimmed : fallback;
    };
    return {
      dsn: dsn.toString(),
      environment: safe(env.SENTRY_ENVIRONMENT, "development") ?? "development",
      release: safe(env.SENTRY_RELEASE),
    };
  } catch {
    return undefined;
  }
}

/** Provider precedence: TypeSafe direct, Jev via AI Gateway, Baseten, LLM adapter (OpenAI / xAI), heuristic. Overridable for tests. */
export function loadConfig(env: Env = process.env): ServerConfig {
  const llm = llmFromEnv(env);
  const basetenEnv = basetenFromEnv(env);
  const auto: DecisionProviderName = env.TYPESAFE_API_KEY ? "typesafe" : env.AI_GATEWAY_API_KEY ? "jev-gateway" : basetenEnv ? "baseten" : llm ? "llm" : "heuristic";
  // GHOST_PROVIDER=heuristic (set by the e2e web server) means fully offline: no decision model and no text model.
  const offline = env.GHOST_PROVIDER === "heuristic";
  const forcedDecision = (env.GHOST_DECISION_PROVIDER || (offline ? "heuristic" : undefined)) as DecisionProviderName | undefined;
  const forcedText = (env.GHOST_TEXT_PROVIDER || (offline ? "template" : undefined)) as TextProviderName | undefined;
  const decisionProvider = forcedDecision ?? auto;
  const textProvider = resolveTextProvider(forcedText, basetenEnv, llm);
  return {
    port: Number(env.PORT ?? 8787),
    host: env.GHOST_HOST || "127.0.0.1",
    decisionProvider,
    textProvider,
    typesafeApiKey: env.TYPESAFE_API_KEY || undefined,
    aiGatewayApiKey: env.AI_GATEWAY_API_KEY || undefined,
    llm: forcedText === "template" && forcedDecision === "heuristic" ? undefined : llm,
    // Forcing another provider (heuristic, template, llm...) drops the Baseten config entirely: no client, no warm-up, zero network.
    baseten: decisionProvider === "baseten" || textProvider === "baseten" ? basetenEnv : undefined,
    fastPath: env.GHOST_FAST_PATH !== "0",
    // Offline (e2e) never opens cloud browsers or calls external APIs: the simulated executors answer instead.
    browserbase: offline ? undefined : browserbaseFromEnv(env),
    composio: offline ? undefined : composioFromEnv(env),
    publicDemoUrl: env.GHOST_PUBLIC_DEMO_URL || undefined,
    extensionId: /^[a-p]{32}$/.test(env.GHOST_EXTENSION_ID ?? "") ? env.GHOST_EXTENSION_ID : undefined,
    // Short secrets are ignored rather than accepted: a guessable token is worse than none, because it looks like protection.
    executeToken: (env.GHOST_EXECUTE_TOKEN ?? "").length >= 16 ? env.GHOST_EXECUTE_TOKEN : undefined,
    sentry: offline ? undefined : sentryFromEnv(env),
  };
}
