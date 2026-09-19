import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "../config";
import { CACHE_SERIES, getMetrics, type Metrics } from "../lib/metrics";
import { createLlmClient } from "../llm/client";
import { createLoopSynthesizer } from "../loop/synthesize";
import { LOOP_LIMITS, parseSynthesizeRequest } from "../loop/validation";
import { BadRequest, readJsonBody } from "../providers/validation";

const ROUTE = "/v1/loop/synthesize";

/** Test seam: the third argument is optional so `registerLoopRoutes(app, config)` stays the public signature. */
export interface LoopRouteDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  metrics?: Metrics;
  log?: (line: string) => void;
}

export function registerLoopRoutes(app: Hono, config: ServerConfig, deps: LoopRouteDeps = {}): void {
  const client = config.llm ? createLlmClient(config.llm, { fetch: deps.fetch }) : undefined;
  const metrics = deps.metrics ?? getMetrics(config);
  const log = deps.log ?? ((line: string) => (process.env.VITEST ? undefined : console.log(line)));
  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);

  const synthesize = createLoopSynthesizer({
    client,
    timeoutMs: deps.timeoutMs,
    // One line and one latency sample per model call, failures included. Numbers and names only: never typed values, page text or keys.
    onModelCall(info) {
      metrics.recordLatency(ROUTE, info.provider, info.latencyMs, info.ok);
      log(`[ghost] ${info.provider} ${ROUTE} ${info.latencyMs}ms questions=${info.questions} calibrated=false cache=miss${info.ok ? "" : " failed=1"}`);
    },
  });

  // bodyLimit counts streamed (chunked) bytes too; a Content-Length check alone lets a chunked body fill memory first.
  app.post(ROUTE, bodyLimit({ maxSize: LOOP_LIMITS.bodyBytes, onError: tooLarge }), async (c) => {
    try {
      const req = parseSynthesizeRequest(await readJsonBody(c.req, LOOP_LIMITS.bodyBytes));
      const result = await synthesize(req);
      // Model calls were recorded one by one above; everything else was answered purely in code (or from the cache).
      if (result.cache === "hit") metrics.recordLatency(ROUTE, CACHE_SERIES, result.latencyMs);
      else if (result.modelCalls === 0) metrics.recordLatency(ROUTE, "heuristic", result.latencyMs);
      if (result.cache) metrics.recordCache(result.cache === "hit");
      return c.json(result);
    } catch (err) {
      if (err instanceof BadRequest) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
}
