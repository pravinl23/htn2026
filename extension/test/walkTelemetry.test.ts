import type { CapturedField, Ghost, GhostWalkOutcome } from "@ghost/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmitter } from "../src/lib/events";
import { WalkOutcomeReporter, observeWalkProvider } from "../src/content/walkTelemetry";

const RUN_ID = "33333333-3333-4333-8333-333333333333";

function ghost(overrides: Partial<Ghost> = {}): Ghost {
  return {
    signature: "input#email",
    action: "fill",
    value: "alex.chen.dev@example.com",
    displayText: "alex.chen.dev@example.com",
    confidence: 0.97,
    locked: false,
    source: "server",
    ...overrides,
  };
}

const FIELD = { signature: "input#email", label: "Email", kind: "email" } as unknown as CapturedField;

function setup(options: { remaining?: Ghost[]; calibrated?: boolean } = {}) {
  const events = createEmitter();
  const sent: GhostWalkOutcome[] = [];
  const win = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const reporter = new WalkOutcomeReporter({
    events,
    send: (outcome) => void sent.push(outcome),
    remaining: () => options.remaining ?? [],
    isCalibrated: () => options.calibrated ?? true,
    createRunId: () => RUN_ID,
    now: () => 1_000,
    win,
  });
  reporter.start();
  return { events, sent, reporter, win };
}

describe("WalkOutcomeReporter", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    return () => warn.mockRestore();
  });

  it("turns a walk that parks on a locked action into one redacted outcome", () => {
    const locked = ghost({ signature: "button#submit", action: "click", locked: true, value: undefined, displayText: "Submit application" });
    const { events, sent } = setup({ remaining: [locked] });
    events.emit("ghosts:shown", { count: 2, source: "server" });
    events.emit("ghost:accepted", { ghost: ghost(), field: FIELD, ms: 12 });
    events.emit("walk:finished");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      schemaVersion: "ghost.walk-outcome.v1",
      runId: RUN_ID,
      state: "parked",
      reason: "locked-action",
      proposals: [
        { index: 1, action: "fill", source: "server", calibrated: true, confidence: "95-plus", locked: false, outcome: "accepted" },
        { index: 2, action: "click", source: "server", locked: true, outcome: "unresolved" },
      ],
      summary: { shown: 2, accepted: 1, dismissed: 0, locked: 1 },
    });
  });

  it("never copies a label, a value, a signature or a URL into the envelope", () => {
    const { events, sent } = setup();
    events.emit("ghosts:shown", { count: 1, source: "server" });
    events.emit("ghost:accepted", { ghost: ghost(), field: FIELD, ms: 12 });
    events.emit("walk:finished");
    expect(JSON.stringify(sent[0])).not.toMatch(/alex\.chen|example\.com|Email|input#email|Submit/i);
  });

  it("records the user's verdict on each proposal", () => {
    const { events, sent } = setup();
    events.emit("ghosts:shown", { count: 3, source: "server" });
    events.emit("ghost:dismissed", { ghost: ghost(), reason: "escape" });
    events.emit("ghost:dismissed", { ghost: ghost({ action: "select" }), reason: "typed" });
    events.emit("ghost:dismissed", { ghost: ghost({ action: "check" }), reason: "refused" });
    events.emit("walk:finished");
    expect(sent[0]?.proposals.map((proposal) => proposal.outcome)).toEqual(["escaped", "typed-over", "refused"]);
    expect(sent[0]?.summary).toMatchObject({ shown: 3, accepted: 0, dismissed: 3 });
  });

  it("keeps only closed, value-free answer metadata for Sentry", () => {
    const { events, sent } = setup();
    events.emit("ghosts:shown", { count: 1, source: "offline" });
    events.emit("ghost:dismissed", {
      ghost: ghost({ source: "offline", answer: { class: "declaration", source: "guess", needsReview: true } }),
      reason: "typed",
    });
    events.emit("walk:finished");
    expect(sent[0]?.proposals[0]?.answer).toEqual({ class: "declaration", source: "guess", needsReview: true });
    expect(JSON.stringify(sent[0])).not.toMatch(/authorized|greenhouse|yes/i);
  });

  it("reports the walk as exhausted when nothing locked is left", () => {
    const { events, sent } = setup({ remaining: [] });
    events.emit("ghosts:shown", { count: 1, source: "cache" });
    events.emit("ghost:accepted", { ghost: ghost({ source: "cache" }), field: FIELD, ms: 4 });
    events.emit("walk:finished");
    expect(sent[0]).toMatchObject({ state: "exhausted", reason: "no-ghosts-left" });
  });

  it("reports an abandoned walk when Ghost is switched off mid-walk", () => {
    const { events, sent, reporter } = setup();
    events.emit("ghosts:shown", { count: 1, source: "server" });
    reporter.stop();
    expect(sent[0]).toMatchObject({ state: "abandoned", reason: "disabled" });
  });

  it("stays silent for a walk that never showed a ghost", () => {
    const { events, sent } = setup();
    events.emit("walk:finished");
    expect(sent).toEqual([]);
  });

  it("starts a fresh run after a walk ends, so outcomes never merge", () => {
    const ids: string[] = [];
    const events = createEmitter();
    const reporter = new WalkOutcomeReporter({
      events,
      send: (outcome) => void ids.push(outcome.runId),
      createRunId: () => `${ids.length}3333333-3333-4333-8333-333333333333`,
      win: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    reporter.start();
    for (const _ of [0, 1]) {
      events.emit("ghosts:shown", { count: 1, source: "server" });
      events.emit("ghost:accepted", { ghost: ghost(), field: FIELD, ms: 1 });
      events.emit("walk:finished");
    }
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("cannot break a walk when sending throws", () => {
    const events = createEmitter();
    const reporter = new WalkOutcomeReporter({
      events,
      send: () => {
        throw new Error("worker gone");
      },
      createRunId: () => RUN_ID,
      win: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    reporter.start();
    events.emit("ghosts:shown", { count: 1, source: "server" });
    events.emit("ghost:accepted", { ghost: ghost(), field: FIELD, ms: 1 });
    expect(() => events.emit("walk:finished")).not.toThrow();
  });
});

describe("observeWalkProvider", () => {
  it("passes the answer through untouched and notes only the provider and latency", async () => {
    const events = createEmitter();
    const sent: GhostWalkOutcome[] = [];
    const reporter = new WalkOutcomeReporter({
      events,
      send: (outcome) => void sent.push(outcome),
      createRunId: () => RUN_ID,
      win: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    reporter.start();
    const answer = { assignments: [], provider: "typesafe", cache: "miss" as const, latencyMs: 320 };
    const wrapped = observeWalkProvider(async () => answer, reporter);
    await expect(wrapped({ origin: "https://x.test", formSignature: "f", factKeys: [], fields: [] })).resolves.toBe(answer);

    events.emit("ghosts:shown", { count: 1, source: "server" });
    events.emit("ghost:accepted", { ghost: ghost(), field: FIELD, ms: 1 });
    events.emit("walk:finished");
    expect(sent.at(-1)).toMatchObject({ provider: "typesafe", latency: "250-499ms" });
  });

  it("leaves the walk on `none` when the predictor stayed offline", async () => {
    const events = createEmitter();
    const sent: GhostWalkOutcome[] = [];
    const reporter = new WalkOutcomeReporter({
      events,
      send: (outcome) => void sent.push(outcome),
      createRunId: () => RUN_ID,
      win: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    reporter.start();
    const wrapped = observeWalkProvider(async () => null, reporter);
    await expect(wrapped({ origin: "https://x.test", formSignature: "f", factKeys: [], fields: [] })).resolves.toBeNull();
    events.emit("ghosts:shown", { count: 1, source: "offline" });
    events.emit("ghost:accepted", { ghost: ghost({ source: "offline" }), field: FIELD, ms: 1 });
    events.emit("walk:finished");
    expect(sent.at(-1)).toMatchObject({ provider: "none", latency: "none" });
  });
});
