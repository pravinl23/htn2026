import type { DecisionProvider } from "@shabang/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "../config";
import { getMetrics, type Metrics } from "../lib/metrics";
import { createFormPredictor } from "../providers/formPredict";
import { createDecisionProvider, providerModel, textModel } from "../providers/index";
import { createNextPredictor } from "../providers/nextPredict";
import { BadRequest, LIMITS, parseFormRequest, parseNextRequest, readJsonBody } from "../providers/validation";

const VERSION = process.env.npm_package_version ?? "0.1.0";
const FORM_ROUTE = "/v1/predict/form";
const NEXT_ROUTE = "/v1/predict/next";

export interface PredictDeps {
  /** Injected in tests. Defaults to the provider chosen by the config precedence. */
  provider?: DecisionProvider;
  timeoutMs?: number;
  metrics?: Metrics;
  log?: (line: string) => void;
}

function badRequest(c: Context, err: unknown): Response {
  if (err instanceof BadRequest) return c.json({ error: err.message }, err.status);
  throw err;
}

export function registerPredictRoutes(app: Hono, config: ServerConfig, deps: PredictDeps = {}): void {
  const provider = deps.provider ?? createDecisionProvider(config);
  const metrics = deps.metrics ?? getMetrics(config);
  const log = deps.log ?? ((line: string) => console.log(line));

  // The heuristic never reports model calls, so its requests are recorded as requests.
  const recordedPerCall = provider.name === "heuristic" ? undefined : provider.name;
  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);

  // One line and one latency sample per model call, failures included. Numbers and names only: never field values, profile values or keys.
  const modelCallLogger = (route: string) => (info: { provider: string; latencyMs: number; questions: number; calibrated: boolean; ok: boolean }) => {
    metrics.recordLatency(route, info.provider, info.latencyMs, info.ok);
    log(`[ghost] ${info.provider} ${route} ${info.latencyMs}ms questions=${info.questions} calibrated=${info.calibrated} cache=miss${info.ok ? "" : " failed=1"}`);
  };

  const predictForm = createFormPredictor({ provider, fastPath: config.fastPath, timeoutMs: deps.timeoutMs, onModelCall: modelCallLogger(FORM_ROUTE) });
  const predictNext = createNextPredictor({ provider, timeoutMs: deps.timeoutMs, onModelCall: modelCallLogger(NEXT_ROUTE) });

  app.get("/v1/health", (c) =>
    c.json({
      ok: true,
      provider: provider.name,
      calibrated: provider.calibrated,
      textProvider: config.textProvider,
      model: providerModel(provider, config),
      textModel: textModel(config),
      // Baseten only: every decision costs samples + hedge parallel requests, and confidence is their vote.
      ...(provider.name === "baseten" && config.baseten ? { sampling: { samples: config.baseten.samples, hedge: config.baseten.hedge, confidenceSource: "consensus" } } : {}),
      version: VERSION,
    }),
  );

  // bodyLimit counts streamed (chunked) bytes too; a Content-Length check alone lets a chunked body fill memory first.
  app.post(FORM_ROUTE, bodyLimit({ maxSize: LIMITS.formBodyBytes, onError: tooLarge }), async (c) => {
    try {
      const req = parseFormRequest(await readJsonBody(c.req, LIMITS.formBodyBytes));
      const prediction = await predictForm(req);
      metrics.recordCache(prediction.cache === "hit");
      metrics.recordRequest(FORM_ROUTE, prediction, recordedPerCall);
      return c.json(prediction);
    } catch (err) {
      return badRequest(c, err);
    }
  });

  app.post(NEXT_ROUTE, bodyLimit({ maxSize: LIMITS.nextBodyBytes, onError: tooLarge }), async (c) => {
    try {
      const req = parseNextRequest(await readJsonBody(c.req, LIMITS.nextBodyBytes));
      const prediction = await predictNext(req);
      metrics.recordRequest(NEXT_ROUTE, prediction, recordedPerCall);
      return c.json(prediction);
    } catch (err) {
      return badRequest(c, err);
    }
  });
}
