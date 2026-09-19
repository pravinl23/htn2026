export type DecisionProviderName = "typesafe" | "jev-gateway" | "llm" | "heuristic";
export type TextProviderName = "openai" | "xai" | "template";

export interface LlmConfig {
  name: "openai" | "xai";
  apiKey: string;
  baseUrl: string;
  model: string;
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

/** Provider precedence from CLAUDE.md: TypeSafe direct, Jev via AI Gateway, LLM adapter, heuristic. Overridable for tests. */
export function loadConfig(env: Env = process.env): ServerConfig {
  const llm = llmFromEnv(env);
  const auto: DecisionProviderName = env.TYPESAFE_API_KEY ? "typesafe" : env.AI_GATEWAY_API_KEY ? "jev-gateway" : llm ? "llm" : "heuristic";
  // GHOST_PROVIDER=heuristic (set by the e2e web server) means fully offline: no decision model and no text model.
  const offline = env.GHOST_PROVIDER === "heuristic";
  const forcedDecision = (env.GHOST_DECISION_PROVIDER || (offline ? "heuristic" : undefined)) as DecisionProviderName | undefined;
  const forcedText = (env.GHOST_TEXT_PROVIDER || (offline ? "template" : undefined)) as TextProviderName | undefined;
  return {
    port: Number(env.PORT ?? 8787),
    host: env.GHOST_HOST || "127.0.0.1",
    decisionProvider: forcedDecision ?? auto,
    textProvider: forcedText ?? (llm ? llm.name : "template"),
    typesafeApiKey: env.TYPESAFE_API_KEY || undefined,
    aiGatewayApiKey: env.AI_GATEWAY_API_KEY || undefined,
    llm: forcedText === "template" && forcedDecision === "heuristic" ? undefined : llm,
    fastPath: env.GHOST_FAST_PATH !== "0",
    // Offline (e2e) never opens cloud browsers or calls external APIs: the simulated executors answer instead.
    browserbase: offline ? undefined : browserbaseFromEnv(env),
    composio: offline ? undefined : composioFromEnv(env),
    publicDemoUrl: env.GHOST_PUBLIC_DEMO_URL || undefined,
    extensionId: /^[a-p]{32}$/.test(env.GHOST_EXTENSION_ID ?? "") ? env.GHOST_EXTENSION_ID : undefined,
    // Short secrets are ignored rather than accepted: a guessable token is worse than none, because it looks like protection.
    executeToken: (env.GHOST_EXECUTE_TOKEN ?? "").length >= 16 ? env.GHOST_EXECUTE_TOKEN : undefined,
  };
}
