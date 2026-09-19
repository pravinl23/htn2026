import { JEV_GATEWAY_MODEL, JEV_MODEL, type DecisionProvider } from "@ghost/shared";
import type { ServerConfig } from "../config";
import { createHeuristicProvider } from "./heuristic";
import { createJevGatewayProvider, type EvaluateFn } from "./jevGateway";
import { createLlmProvider } from "./llm";
import { createTypesafeProvider } from "./typesafe";

export interface ProviderDeps {
  fetch?: typeof fetch;
  evaluate?: EvaluateFn;
}

/**
 * config.decisionProvider already encodes the precedence (typesafe > jev-gateway > llm > heuristic) or the
 * GHOST_DECISION_PROVIDER override. A provider whose credentials are missing degrades to the heuristic,
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
  if (provider.name === "llm") return config.llm?.model;
  return undefined;
}

export { createHeuristicProvider } from "./heuristic";
export { createJevGatewayProvider } from "./jevGateway";
export { createLlmProvider } from "./llm";
export { createTypesafeProvider } from "./typesafe";
