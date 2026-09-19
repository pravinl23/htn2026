import { sanitizeAgentRunOutcome } from "@ghost/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "../config";
import { BadRequest, readJsonBody } from "../providers/validation";
import { AgentReplayStore, createAgentOutcomeSink } from "../telemetry/agentOutcomes";
import type { AgentOutcomeSink } from "../telemetry/agentOutcomes";

export interface AgentTelemetryDeps {
  sink?: AgentOutcomeSink;
  store?: AgentReplayStore;
}

export const AGENT_OUTCOME_BODY_BYTES = 64_000;

export function registerAgentTelemetryRoutes(app: Hono, config: ServerConfig, deps: AgentTelemetryDeps = {}): void {
  const sink = deps.sink ?? createAgentOutcomeSink(config);
  const store = deps.store ?? new AgentReplayStore();

  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);
  app.post("/v1/agent/outcomes", bodyLimit({ maxSize: AGENT_OUTCOME_BODY_BYTES, onError: tooLarge }), async (c) => {
    try {
      const outcome = sanitizeAgentRunOutcome(await readJsonBody(c.req, AGENT_OUTCOME_BODY_BYTES));
      if (!outcome) return c.json({ error: "invalid agent outcome" }, 400);
      const replay = store.add(outcome);
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

  app.get("/v1/agent/replays", (c) => {
    const fixtures = store.list();
    return c.json({ schemaVersion: "ghost.agent-replay.v1", count: fixtures.length, fixtures });
  });
}
