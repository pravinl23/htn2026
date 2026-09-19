import { Hono } from "hono";
import { cors } from "hono/cors";

const ALLOWED_ORIGIN = /^(chrome-extension:\/\/[a-z]+|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

export function createApp(): Hono {
  const app = new Hono();
  app.use("*", cors({ origin: (origin) => (ALLOWED_ORIGIN.test(origin) ? origin : null) }));
  app.get("/v1/health", (c) => c.json({ ok: true, provider: "heuristic" }));
  return app;
}
