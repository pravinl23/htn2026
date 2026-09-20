/**
 * What `createApp` needs from observability, in one call.
 *
 * With Sentry off this returns empty dependency objects and no middleware, so every route is registered exactly as it
 * was before this folder existed: same provider, same metrics instance, same behaviour, no wrapper in any hot path.
 */
import type { MiddlewareHandler } from "hono";
import type { ServerConfig } from "../config";
import { createDecisionProvider } from "../providers/index";
import type { LoopRouteDeps } from "../routes/loop";
import type { PredictDeps } from "../routes/predict";
import type { TextRouteDeps } from "../routes/text";
import type { VisionRouteDeps } from "../routes/vision";
import { tracedFetch } from "./fetch";
import { tracingMiddleware } from "./middleware";
import { instrumentDecisionProvider } from "./provider";
import { isEnabled } from "./sentry";

export interface AppInstrumentation {
  /** Undefined when Sentry is off: `createApp` then adds no middleware at all. */
  middleware?: MiddlewareHandler;
  predict: PredictDeps;
  text: TextRouteDeps;
  loop: LoopRouteDeps;
  vision: VisionRouteDeps;
}

const OFF: AppInstrumentation = { predict: {}, text: {}, loop: {}, vision: {} };

export function instrumentApp(config: ServerConfig): AppInstrumentation {
  if (!isEnabled()) return OFF;
  return {
    middleware: tracingMiddleware(),
    // The decision provider is created here instead of inside the route so the model call can be wrapped in a span.
    // It is still created exactly once, so a Baseten warm-up still happens exactly once.
    predict: { provider: instrumentDecisionProvider(createDecisionProvider(config, { fetch: tracedFetch("decision") })) },
    text: { fetch: tracedFetch("ghost-text") },
    loop: { fetch: tracedFetch("loop") },
    vision: { fetch: tracedFetch("vision") },
  };
}

export { initObservability, describe } from "./instrument";
export { isEnabled, flush } from "./sentry";
export { recordWalk, recordWalkOutcome } from "./walkSink";
