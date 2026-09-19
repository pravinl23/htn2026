import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig, type ServerConfig } from "./config";
import { ALLOWED_ORIGIN, localOnly } from "./lib/guard";
import { registerMetricsRoutes } from "./routes/metrics";
import { registerPredictRoutes } from "./routes/predict";
import { registerTextRoutes } from "./routes/text";

export function createApp(config: ServerConfig = loadConfig()): Hono {
  const app = new Hono();
  app.use("*", localOnly(config.host));
  app.use("*", cors({ origin: (origin) => (ALLOWED_ORIGIN.test(origin) ? origin : null) }));
  registerPredictRoutes(app, config); // /v1/health, /v1/predict/form, /v1/predict/next
  registerTextRoutes(app, config); // /v1/ghost-text, /v1/profile/extract
  registerMetricsRoutes(app, config); // /v1/metrics
  return app;
}
