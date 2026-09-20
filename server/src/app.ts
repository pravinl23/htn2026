import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig, type ServerConfig } from "./config";
import { ALLOWED_ORIGIN, localOnly } from "./lib/guard";
import { instrumentApp } from "./observability/index";
import { registerCommandRoutes } from "./routes/command";
import { registerExecuteRoutes } from "./routes/execute";
import { registerWalkTelemetryRoutes } from "./routes/walkTelemetry";
import { registerLoopRoutes } from "./routes/loop";
import { registerMetricsRoutes } from "./routes/metrics";
import { registerPredictRoutes } from "./routes/predict";
import { registerPresenceRoutes } from "./routes/presence";
import { registerTextRoutes } from "./routes/text";
import { registerVisionRoutes } from "./routes/vision";

export function createApp(config: ServerConfig = loadConfig()): Hono {
  const app = new Hono();
  // Empty dependencies and no middleware unless SENTRY_DSN is set, so an unconfigured server is byte-for-byte the old one.
  const observability = instrumentApp(config);
  app.use("*", localOnly(config.host));
  app.use("*", cors({ origin: (origin) => (ALLOWED_ORIGIN.test(origin) ? origin : null) }));
  if (observability.middleware) app.use("*", observability.middleware); // one transaction per request (docs/observability.md)
  registerPredictRoutes(app, config, observability.predict); // /v1/health, /v1/predict/form, /v1/predict/next
  registerWalkTelemetryRoutes(app, config); // /v1/walk/outcomes, /v1/walk/replays
  registerTextRoutes(app, config, observability.text); // /v1/ghost-text, /v1/profile/extract
  registerMetricsRoutes(app, config); // /v1/metrics
  registerPresenceRoutes(app, config); // /v1/presence (extension and desktop heartbeats)
  registerLoopRoutes(app, config, observability.loop); // /v1/loop/synthesize
  registerExecuteRoutes(app, config); // /v1/executors, /v1/loop/compile, /v1/loop/preview, /v1/loop/execute (+ DELETE /v1/loop/execute/:runId)
  registerCommandRoutes(app, config); // /v1/predict/command (terminal ghost)
  registerVisionRoutes(app, config, observability.vision); // /v1/vision, /v1/vision/label, /v1/vision/locate (OpenAI vision fallback, docs/openai.md)
  return app;
}
