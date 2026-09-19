import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig, type ServerConfig } from "./config";
import { ALLOWED_ORIGIN, localOnly } from "./lib/guard";
import { registerExecuteRoutes } from "./routes/execute";
import { registerLoopRoutes } from "./routes/loop";
import { registerMetricsRoutes } from "./routes/metrics";
import { registerPredictRoutes } from "./routes/predict";
import { registerPresenceRoutes } from "./routes/presence";
import { registerTextRoutes } from "./routes/text";
import { registerWorkflowRoutes } from "./routes/workflows";

export function createApp(config: ServerConfig = loadConfig()): Hono {
  const app = new Hono();
  app.use("*", localOnly(config.host));
  app.use("*", cors({ origin: (origin) => (ALLOWED_ORIGIN.test(origin) ? origin : null) }));
  registerPredictRoutes(app, config); // /v1/health, /v1/predict/form, /v1/predict/next, /v1/agent/next
  registerTextRoutes(app, config); // /v1/ghost-text, /v1/profile/extract
  registerMetricsRoutes(app, config); // /v1/metrics
  registerPresenceRoutes(app, config); // /v1/presence (extension and desktop heartbeats)
  registerLoopRoutes(app, config); // /v1/loop/synthesize
  registerExecuteRoutes(app, config); // /v1/executors, /v1/loop/compile, /v1/loop/preview, /v1/loop/execute (+ DELETE /v1/loop/execute/:runId)
  registerWorkflowRoutes(app, config); // /v1/workflows/* + /v1/composio/*
  return app;
}
