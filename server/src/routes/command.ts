import type { DecisionProvider } from "@ghost/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createCommandPredictor } from "../command/predict";
import { COMMAND_LIMITS, parseCommandRequest } from "../command/validation";
import type { ServerConfig } from "../config";
import { getMetrics, type Metrics } from "../lib/metrics";
import { createDecisionProvider, createHeuristicProvider } from "../providers/index";
import { BadRequest, readJsonBody } from "../providers/validation";

export const COMMAND_ROUTE = "/v1/predict/command";

export interface CommandDeps {
  /** Injected in tests. Defaults to Jev when configured, else the heuristic. */
  provider?: DecisionProvider;
  timeoutMs?: number;
  metrics?: Metrics;
  log?: (line: string) => void;
}

/**
 * A shell asks after every prompt and on typing, so only Jev (fast, calibrated, 1,200 requests per minute) answers
 * here. Baseten fans one decision out to several rate-limited requests and the LLM adapter is slow and uncalibrated:
 * with those configured the terminal gets the in-code heuristic instead.
 */
export function commandProvider(config: ServerConfig): DecisionProvider {
  if (config.decisionProvider === "typesafe" || config.decisionProvider === "jev-gateway") return createDecisionProvider(config);
  return createHeuristicProvider();
}

function badRequest(c: Context, err: unknown): Response {
  if (err instanceof BadRequest) return c.json({ error: err.message }, err.status);
  throw err;
}

export function registerCommandRoutes(app: Hono, config: ServerConfig, deps: CommandDeps = {}): void {
  const provider = deps.provider ?? commandProvider(config);
  const metrics = deps.metrics ?? getMetrics(config);
  const log = deps.log ?? ((line: string) => console.log(line));
  const recordedPerCall = provider.name === "heuristic" ? undefined : provider.name;
  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);

  // Numbers and names only: never commands, the prefix, the directory or the branch.
  const predict = createCommandPredictor({
    provider,
    timeoutMs: deps.timeoutMs,
    onModelCall: (info) => {
      metrics.recordLatency(COMMAND_ROUTE, info.provider, info.latencyMs, info.ok);
      log(`[ghost] ${info.provider} ${COMMAND_ROUTE} ${info.latencyMs}ms questions=${info.questions} calibrated=${info.calibrated} cache=miss${info.ok ? "" : " failed=1"}`);
    },
  });

  app.post(COMMAND_ROUTE, bodyLimit({ maxSize: COMMAND_LIMITS.bodyBytes, onError: tooLarge }), async (c) => {
    try {
      const req = parseCommandRequest(await readJsonBody(c.req, COMMAND_LIMITS.bodyBytes));
      const prediction = await predict(req);
      if (prediction.provider !== "heuristic" || prediction.fallbackFrom) metrics.recordCache(prediction.cache === "hit");
      metrics.recordRequest(COMMAND_ROUTE, prediction, recordedPerCall);
      return c.json(prediction);
    } catch (err) {
      return badRequest(c, err);
    }
  });
}
