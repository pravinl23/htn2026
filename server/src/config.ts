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
}

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
  };
}
