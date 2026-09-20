import { JEV_GATEWAY_MODEL, JEV_MODEL, type DecisionProvider } from "@shabang/shared";
import type { ServerConfig } from "../config";
import { createBasetenProvider, type BasetenProvider } from "./baseten";
import { createHeuristicProvider } from "./heuristic";
import { createJevGatewayProvider, type EvaluateFn } from "./jevGateway";
import { createLlmProvider } from "./llm";
import { createTypesafeProvider } from "./typesafe";

export interface ProviderDeps {
  fetch?: typeof fetch;
  evaluate?: EvaluateFn;
  /** Baseten only: send the one warm-up request. Default: when the config asks for it, and never under Vitest. */
  warmUp?: boolean;
  log?: (line: string) => void;
}

/** Fire and forget: the server starts answering at once, and a failed warm-up only means the first form pays the cold start. */
function warmUpInBackground(provider: BasetenProvider, model: string, log: (line: string) => void): void {
  void provider.warmUp().then((r) => log(`[ghost] baseten warm-up ${r.latencyMs}ms ok=${r.ok}${r.status ? ` status=${r.status}` : ""} model=${model}`));
}

/**
 * config.decisionProvider already encodes the precedence (typesafe > jev-gateway > baseten > llm > heuristic) or the
 * SHABANG_DECISION_PROVIDER override. A provider whose credentials are missing degrades to the heuristic,
 * so a forced name can never cause a surprise network call or a crash at startup.
 */
export function createDecisionProvider(config: ServerConfig, deps: ProviderDeps = {}): DecisionProvider {
  switch (config.decisionProvider) {
    case "typesafe":
      if (config.typesafeApiKey) return createTypesafeProvider({ apiKey: config.typesafeApiKey, fetch: deps.fetch });
      break;
    case "jev-gateway":
      if (config.aiGatewayApiKey) return createJevGatewayProvider({ apiKey: config.aiGatewayApiKey, evaluate: deps.evaluate });
      break;
    case "baseten":
      if (config.baseten) {
        const provider = createBasetenProvider({ baseten: config.baseten, fetch: deps.fetch, log: deps.log });
        if (deps.warmUp ?? (config.baseten.warmup && !process.env.VITEST)) warmUpInBackground(provider, config.baseten.decisionModel, deps.log ?? ((line) => console.log(line)));
        return provider;
      }
      break;
    case "llm":
      if (config.llm) return createLlmProvider({ llm: config.llm, fetch: deps.fetch });
      break;
    default:
      break;
  }
  return createHeuristicProvider();
}

/** Model id for /v1/health. The heuristic has none. */
export function providerModel(provider: DecisionProvider, config: ServerConfig): string | undefined {
  if (provider.name === "typesafe") return JEV_MODEL;
  if (provider.name === "jev-gateway") return JEV_GATEWAY_MODEL;
  if (provider.name === "baseten") return config.baseten?.decisionModel;
  if (provider.name === "llm") return config.llm?.model;
  return undefined;
}

/** Text model id for /v1/health. The template has none. */
export function textModel(config: ServerConfig): string | undefined {
  if (config.textProvider === "baseten") return config.baseten?.textModel;
  return config.textProvider === "template" ? undefined : config.llm?.model;
}

export { createBasetenProvider } from "./baseten";
export { createHeuristicProvider } from "./heuristic";
export { createJevGatewayProvider } from "./jevGateway";
export { createLlmProvider } from "./llm";
export { createTypesafeProvider } from "./typesafe";
