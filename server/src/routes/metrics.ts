import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "../config";
import { getMetrics, type Metrics } from "../lib/metrics";
import { BadRequest, LIMITS, parseMetricsEvent, readJsonBody } from "../providers/validation";

export interface MetricsDeps {
  metrics?: Metrics;
}

function badRequest(c: Context, err: unknown): Response {
  if (err instanceof BadRequest) return c.json({ error: err.message }, err.status);
  throw err;
}

export function registerMetricsRoutes(app: Hono, config: ServerConfig, deps: MetricsDeps = {}): void {
  const metrics = deps.metrics ?? getMetrics(config);

  app.get("/v1/metrics", (c) => c.json(metrics.snapshot()));

  /** Client counters are deltas since the last report. Calibration pairs are (confidence shown, accepted or not). */
  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);
  app.post("/v1/metrics/event", bodyLimit({ maxSize: LIMITS.metricsBodyBytes, onError: tooLarge }), async (c) => {
    try {
      const event = parseMetricsEvent(await readJsonBody(c.req, LIMITS.metricsBodyBytes));
      metrics.addCounters(event.counters);
      metrics.addCalibration(event.calibration);
      return c.json({ ok: true });
    } catch (err) {
      return badRequest(c, err);
    }
  });
}
