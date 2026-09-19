import { sanitizeAgentRunOutcome } from "@ghost/shared";
import type { Hono } from "hono";
import type { ServerConfig } from "../config";
import { AgentReplayStore, createAgentOutcomeSink } from "../telemetry/agentOutcomes";
import type { AgentOutcomeSink } from "../telemetry/agentOutcomes";

export interface AgentTelemetryDeps {
  sink?: AgentOutcomeSink;
  store?: AgentReplayStore;
}

export function registerAgentTelemetryRoutes(app: Hono, config: ServerConfig, deps: AgentTelemetryDeps = {}): void {
  const sink = deps.sink ?? createAgentOutcomeSink(config);
  const store = deps.store ?? new AgentReplayStore();

  app.post("/v1/agent/outcomes", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const outcome = sanitizeAgentRunOutcome(raw);
    if (!outcome) return c.json({ error: "invalid agent outcome" }, 400);
    const replay = store.add(outcome);
    const eventId = await sink.capture(outcome, replay).catch(() => undefined);
    return c.json({
      accepted: true as const,
      captured: eventId !== undefined,
      ...(replay ? { replayId: replay.caseId } : {}),
    });
  });

  app.get("/v1/agent/replays", (c) => {
    const fixtures = store.list();
    return c.json({ schemaVersion: "ghost.agent-replay.v1", count: fixtures.length, fixtures });
  });
}
