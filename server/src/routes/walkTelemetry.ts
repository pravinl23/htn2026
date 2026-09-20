import { sanitizeGhostWalkOutcome } from "@ghost/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "../config";
import { BadRequest, readJsonBody } from "../providers/validation";
import { WalkReplayStore, createWalkOutcomeSink } from "../telemetry/walkOutcomes";
import type { WalkOutcomeSink } from "../telemetry/walkOutcomes";
import { reportWalkToSentry } from "./walkSentry";

/** Which client drew the ghost. A closed set: an unknown header is dropped, never echoed into a metric tag. */
function surfaceOf(header: string | undefined): "extension" | "desktop" | "terminal" {
  return header === "desktop" || header === "terminal" ? header : "extension";
}

export interface WalkTelemetryDeps {
  sink?: WalkOutcomeSink;
  store?: WalkReplayStore;
}

export const WALK_OUTCOME_BODY_BYTES = 64_000;

export function registerWalkTelemetryRoutes(app: Hono, config: ServerConfig, deps: WalkTelemetryDeps = {}): void {
  const sink = deps.sink ?? createWalkOutcomeSink(config);
  const store = deps.store ?? new WalkReplayStore();

  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);
  app.post("/v1/walk/outcomes", bodyLimit({ maxSize: WALK_OUTCOME_BODY_BYTES, onError: tooLarge }), async (c) => {
    try {
      const outcome = sanitizeGhostWalkOutcome(await readJsonBody(c.req, WALK_OUTCOME_BODY_BYTES));
      if (!outcome) return c.json({ error: "invalid walk outcome" }, 400);
      const replay = store.add(outcome);
      // Two Sentry surfaces, deliberately: the sink captures ONE durable event per walk (with the replay
      // fixture attached), while this adds the per-proposal metrics and the walk log line that make
      // accept-vs-reject queryable in the dashboard rather than readable one event at a time.
      reportWalkToSentry(outcome, surfaceOf(c.req.header("x-ghost-surface")));
      const eventId = await sink.capture(outcome, replay).catch(() => undefined);
      return c.json({
        accepted: true as const,
        captured: eventId !== undefined,
        ...(replay ? { replayId: replay.caseId } : {}),
      });
    } catch (error) {
      if (error instanceof BadRequest) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  app.get("/v1/walk/replays", (c) => {
    const fixtures = store.list();
    return c.json({ schemaVersion: "ghost.walk-replay.v1", count: fixtures.length, fixtures });
  });
}
