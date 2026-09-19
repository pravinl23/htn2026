import type { AgentRunOutcome } from "@ghost/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { registerAgentTelemetryRoutes } from "../src/routes/agentTelemetry";
import { AgentReplayStore, NoopAgentOutcomeSink, scrubSentryAgentEvent } from "../src/telemetry/agentOutcomes";
import type { AgentOutcomeSink } from "../src/telemetry/agentOutcomes";

const JSON_HEADERS = { "Content-Type": "application/json" };
const OUTCOME: AgentRunOutcome = {
  schemaVersion: "ghost.agent-run.v1",
  runId: "55555555-5555-4555-8555-555555555555",
  state: "blocked",
  reason: "low-confidence",
  duration: "250-999ms",
  steps: 1,
  decisions: [{
    step: 1, operation: "CLICK", provider: "typesafe", calibrated: true, fallback: false,
    confidence: "55-69", latency: "100-249ms",
    candidates: { total: 2, locked: 1, filled: 0, requiredOpen: 1, availableOperations: ["FILL", "CLICK"] },
  }],
  actions: [],
};

function setup(sink: AgentOutcomeSink, store = new AgentReplayStore()) {
  const app = new Hono();
  registerAgentTelemetryRoutes(app, loadConfig({}), { sink, store });
  const post = (body: unknown) => app.request("/v1/agent/outcomes", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  return { app, post, store };
}

describe("agent outcome routes", () => {
  it("enables Sentry only for a valid explicit DSN and disables it in offline e2e mode", () => {
    const env = {
      SENTRY_DSN: "https://public-key@o123.ingest.sentry.io/456",
      SENTRY_ENVIRONMENT: "hackathon",
      SENTRY_RELEASE: "ghost@demo-1",
    };
    expect(loadConfig(env).sentry).toEqual({
      dsn: "https://public-key@o123.ingest.sentry.io/456",
      environment: "hackathon",
      release: "ghost@demo-1",
    });
    expect(loadConfig({ ...env, GHOST_PROVIDER: "heuristic" }).sentry).toBeUndefined();
    expect(loadConfig({ SENTRY_DSN: "not-a-dsn" }).sentry).toBeUndefined();
    expect(loadConfig({ SENTRY_DSN: "https://secret:password@o123.ingest.sentry.io/456" }).sentry).toBeUndefined();
  });

  it("validates again, queues Sentry, and exposes a blocked run as a replay", async () => {
    const capture = vi.fn(async () => "event-id");
    const sink: AgentOutcomeSink = { enabled: true, capture };
    const { app, post } = setup(sink);
    const dirty = { ...OUTCOME, goal: "private", url: "https://private.example", profile: { email: "sam@example.com" } };
    const response = await post(dirty);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, captured: true, replayId: OUTCOME.runId });
    expect(capture).toHaveBeenCalledWith(OUTCOME, expect.objectContaining({ caseId: OUTCOME.runId, observed: OUTCOME }));

    const replayResponse = await app.request("/v1/agent/replays");
    const replayBody = await replayResponse.json() as { count: number; fixtures: unknown[] };
    expect(replayBody.count).toBe(1);
    expect(replayBody.fixtures).toHaveLength(1);
    expect(JSON.stringify(replayBody)).not.toMatch(/private|sam@example|url|profile|goal/i);
  });

  it("captures successful outcomes but only turns blocked outcomes into replay candidates", async () => {
    const capture = vi.fn(async () => "event-id");
    const { app, post } = setup({ enabled: true, capture });
    const done: AgentRunOutcome = { ...OUTCOME, state: "done", reason: "completed", decisions: [{ ...OUTCOME.decisions[0]!, operation: "DONE" }] };
    expect(await (await post(done)).json()).toEqual({ accepted: true, captured: true });
    expect(capture).toHaveBeenCalledWith(done, undefined);
    expect(await (await app.request("/v1/agent/replays")).json()).toMatchObject({ count: 0, fixtures: [] });
  });

  it("rejects malformed or widened telemetry and tolerates a disabled sink", async () => {
    const { post } = setup(new NoopAgentOutcomeSink());
    expect((await post({ ...OUTCOME, runId: "secret" })).status).toBe(400);
    expect((await post({ ...OUTCOME, decisions: [{ ...OUTCOME.decisions[0], operation: "SHELL" }] })).status).toBe(400);
    expect(await (await post(OUTCOME)).json()).toEqual({ accepted: true, captured: false, replayId: OUTCOME.runId });
  });

  it("keeps the local review queue bounded and newest-first", () => {
    const store = new AgentReplayStore(2);
    for (const digit of ["5", "6", "7"]) store.add({ ...OUTCOME, runId: digit.repeat(8) + `-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}` });
    expect(store.list().map((fixture) => fixture.caseId[0])).toEqual(["7", "6"]);
  });
});

describe("Sentry event scrubber", () => {
  it("rebuilds the outbound event and drops request, user, breadcrumbs, exceptions, and hostile extras", () => {
    const event = scrubSentryAgentEvent({
      event_id: "a".repeat(32),
      environment: "hackathon",
      release: "ghost@demo-1",
      request: { url: "https://private.example" },
      user: { email: "sam@example.com" },
      breadcrumbs: [{ message: "private" }],
      exception: { values: [{ value: "private" }] },
      extra: { agent_outcome: { ...OUTCOME, goal: "private" }, private: "secret" },
    });
    expect(event).toMatchObject({
      message: "ghost.agent_run.blocked",
      level: "warning",
      environment: "hackathon",
      release: "ghost@demo-1",
      tags: { feature: "jev-computer-use", state: "blocked", reason: "low-confidence", provider: "typesafe", operation: "CLICK" },
      extra: { agent_outcome: OUTCOME, agent_replay: { caseId: OUTCOME.runId } },
    });
    const encoded = JSON.stringify(event);
    expect(encoded).not.toMatch(/private|secret|sam@example|request|user|breadcrumb|exception|goal/);
  });

  it("drops an event if the allowlisted outcome is absent or invalid", () => {
    expect(scrubSentryAgentEvent({ extra: { private: true } })).toBeNull();
    expect(scrubSentryAgentEvent({ extra: { agent_outcome: { ...OUTCOME, steps: 999 } } })).toBeNull();
  });
});
