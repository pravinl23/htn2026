import type { GhostWalkOutcome } from "@shabang/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { registerWalkTelemetryRoutes, WALK_OUTCOME_BODY_BYTES } from "../src/routes/walkTelemetry";
import { NoopWalkOutcomeSink, WalkReplayStore, scrubSentryWalkEvent } from "../src/telemetry/walkOutcomes";
import type { WalkOutcomeSink } from "../src/telemetry/walkOutcomes";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** A calibrated, confident proposal the user rejected: the calibration failure worth reviewing. */
const OUTCOME: GhostWalkOutcome = {
  schemaVersion: "shabang.walk-outcome.v1",
  runId: "55555555-5555-4555-8555-555555555555",
  state: "parked",
  reason: "locked-action",
  duration: "250-999ms",
  provider: "typesafe",
  latency: "100-249ms",
  proposals: [
    { index: 1, action: "fill", source: "server", calibrated: true, confidence: "95-plus", locked: false, outcome: "typed-over" },
    { index: 2, action: "click", source: "offline", calibrated: false, confidence: "95-plus", locked: true, outcome: "unresolved" },
  ],
  summary: { shown: 2, accepted: 0, dismissed: 1, locked: 1 },
};

/** Every proposal accepted and nothing locked taken: a healthy walk, so only a counter. */
const HEALTHY: GhostWalkOutcome = {
  ...OUTCOME,
  proposals: [{ index: 1, action: "fill", source: "server", calibrated: true, confidence: "95-plus", locked: false, outcome: "accepted" }],
  summary: { shown: 1, accepted: 1, dismissed: 0, locked: 0 },
};

function setup(sink: WalkOutcomeSink, store = new WalkReplayStore()) {
  const app = new Hono();
  registerWalkTelemetryRoutes(app, loadConfig({}), { sink, store });
  const post = (body: unknown) => app.request("/v1/walk/outcomes", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  return { app, post, store };
}

describe("walk outcome routes", () => {
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
    expect(loadConfig({ ...env, SHABANG_PROVIDER: "heuristic" }).sentry).toBeUndefined();
    expect(loadConfig({ SENTRY_DSN: "not-a-dsn" }).sentry).toBeUndefined();
    expect(loadConfig({ SENTRY_DSN: "https://secret:password@o123.ingest.sentry.io/456" }).sentry).toBeUndefined();
  });

  it("validates again, queues Sentry, and exposes a reviewable walk as a replay", async () => {
    const capture = vi.fn(async () => "event-id");
    const sink: WalkOutcomeSink = { enabled: true, capture };
    const { app, post } = setup(sink);
    const dirty = { ...OUTCOME, goal: "private", url: "https://private.example", profile: { email: "sam@example.com" } };
    const response = await post(dirty);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, captured: true, replayId: OUTCOME.runId });
    expect(capture).toHaveBeenCalledWith(OUTCOME, expect.objectContaining({ caseId: OUTCOME.runId, observed: OUTCOME }));

    const replayResponse = await app.request("/v1/walk/replays");
    const replayBody = await replayResponse.json() as { count: number; fixtures: unknown[] };
    expect(replayBody.count).toBe(1);
    expect(replayBody.fixtures).toHaveLength(1);
    expect(JSON.stringify(replayBody)).not.toMatch(/private|sam@example|url|profile|goal|label|signature/i);
  });

  it("captures healthy walks but only turns reviewable ones into replay candidates", async () => {
    const capture = vi.fn(async () => "event-id");
    const { app, post } = setup({ enabled: true, capture });
    expect(await (await post(HEALTHY)).json()).toEqual({ accepted: true, captured: true });
    expect(capture).toHaveBeenCalledWith(HEALTHY, undefined);
    expect(await (await app.request("/v1/walk/replays")).json()).toMatchObject({ count: 0, fixtures: [] });
  });

  it("treats an accepted locked proposal as reviewable, whatever else the walk says", async () => {
    const { post, store } = setup(new NoopWalkOutcomeSink());
    const violation: GhostWalkOutcome = {
      ...HEALTHY,
      proposals: [{ index: 1, action: "click", source: "server", calibrated: false, confidence: "under-55", locked: true, outcome: "accepted" }],
      summary: { shown: 1, accepted: 1, dismissed: 0, locked: 1 },
    };
    expect((await post(violation)).status).toBe(200);
    expect(store.list()).toHaveLength(1);
  });

  it("rejects malformed or widened telemetry and tolerates a disabled sink", async () => {
    const { post } = setup(new NoopWalkOutcomeSink());
    expect((await post({ ...OUTCOME, runId: "secret" })).status).toBe(400);
    expect((await post({ ...OUTCOME, proposals: [{ ...OUTCOME.proposals[0], action: "navigate" }] })).status).toBe(400);
    expect((await post({ ...OUTCOME, proposals: [{ ...OUTCOME.proposals[0], outcome: "submitted" }] })).status).toBe(400);
    // A summary that under-reports what the proposals show must not be believed.
    expect((await post({ ...OUTCOME, summary: { shown: 0, accepted: 0, dismissed: 0, locked: 0 } })).status).toBe(400);
    expect(await (await post(OUTCOME)).json()).toEqual({ accepted: true, captured: false, replayId: OUTCOME.runId });
  });

  it("bounds streamed and declared outcome bodies", async () => {
    const { app } = setup(new NoopWalkOutcomeSink());
    const response = await app.request("/v1/walk/outcomes", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ padding: "x".repeat(WALK_OUTCOME_BODY_BYTES) }),
    });
    expect(response.status).toBe(413);
  });

  it("keeps the local review queue bounded and newest-first", () => {
    const store = new WalkReplayStore(2);
    for (const digit of ["5", "6", "7"]) {
      store.add({ ...OUTCOME, runId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}` });
    }
    expect(store.list().map((fixture) => fixture.caseId[0])).toEqual(["7", "6"]);
  });
});

describe("Sentry event scrubber", () => {
  it("rebuilds the outbound event and drops request, user, breadcrumbs, exceptions, and hostile extras", () => {
    const event = scrubSentryWalkEvent({
      event_id: "a".repeat(32),
      environment: "hackathon",
      release: "ghost@demo-1",
      request: { url: "https://private.example" },
      user: { email: "sam@example.com" },
      breadcrumbs: [{ message: "private" }],
      exception: { values: [{ value: "private" }] },
      extra: { walk_outcome: { ...OUTCOME, goal: "private" }, private: "secret" },
    });
    expect(event).toMatchObject({
      message: "ghost.walk.parked",
      level: "warning",
      environment: "hackathon",
      release: "ghost@demo-1",
      tags: { feature: "ghost-walk", state: "parked", reason: "locked-action", provider: "typesafe" },
      extra: { walk_outcome: OUTCOME, walk_replay: { caseId: OUTCOME.runId } },
    });
    const encoded = JSON.stringify(event);
    expect(encoded).not.toMatch(/private|secret|sam@example|request|user|breadcrumb|exception|goal/);
  });

  it("marks a healthy walk info and attaches no replay", () => {
    const event = scrubSentryWalkEvent({ extra: { walk_outcome: HEALTHY } }) as Record<string, unknown>;
    expect(event.level).toBe("info");
    expect(event.extra).not.toHaveProperty("walk_replay");
  });

  it("drops an event if the allowlisted outcome is absent or invalid", () => {
    expect(scrubSentryWalkEvent({ extra: { private: true } })).toBeNull();
    expect(scrubSentryWalkEvent({ extra: { walk_outcome: { ...OUTCOME, summary: { shown: 999, accepted: 0, dismissed: 0, locked: 0 } } } })).toBeNull();
  });
});
