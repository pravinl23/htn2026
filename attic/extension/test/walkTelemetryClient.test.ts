import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIDENCE_BUCKETS, WALK_TELEMETRY_LIMITS, WALK_TELEMETRY_PATH, WalkTelemetryClient, confidenceBucket,
  createFetchSender, normalizeBase, resetWalkTelemetryBridge, toWalkTelemetryEvent,
} from "../src/content/walkTelemetryClient";
import type { WalkTelemetryBatch, WalkTelemetryEvent } from "../src/content/walkTelemetryClient";

afterEach(() => {
  resetWalkTelemetryBridge();
  vi.useRealTimers();
});

/** Everything a walk knows that must never leave the machine. */
const SECRETS = [
  "Alex Chen", "alex.chen@example.com", "fullName", "Email address", "Why do you want to work here?",
  "https://demo.test/apply?email=alex", "INV-1007", "$3,712.06",
];

function assertClean(event: unknown): void {
  const json = JSON.stringify(event);
  for (const secret of SECRETS) expect(json).not.toContain(secret);
}

describe("the allowlist", () => {
  it("keeps counts, durations, buckets and booleans", () => {
    const event = toWalkTelemetryEvent(
      {
        outcome: "accepted", source: "server", provider: "baseten", surface: "web", confidence: 0.91,
        ghosts: 12, accepted: 9, dismissed: 1, locked: 1, steps: 3, fields: 12,
        latencyMs: 1052.4, walkMs: 8100, firstGhostMs: 240,
        calibrated: false, cached: true, held: true,
      },
      1700,
    );
    expect(event).toEqual({
      outcome: "accepted", source: "server", provider: "baseten", surface: "web", confidence: "confident",
      ghosts: 12, accepted: 9, dismissed: 1, locked: 1, steps: 3, fields: 12,
      latencyMs: 1052, walkMs: 8100, firstGhostMs: 240,
      calibrated: false, cached: true, held: true,
      t: 1700,
    });
  });

  it("drops every label, value, url and unknown key in a hostile outcome", () => {
    const hostile = {
      outcome: "accepted",
      label: "Email address",
      value: "alex.chen@example.com",
      displayText: "Alex Chen",
      signature: "input|email|fullName",
      url: "https://demo.test/apply?email=alex",
      origin: "https://demo.test",
      question: "Why do you want to work here?",
      answer: "Because I love robots",
      invoice: "INV-1007",
      total: "$3,712.06",
      profile: { fullName: "Alex Chen", email: "alex.chen@example.com" },
      fields: [{ label: "Email address", value: "alex.chen@example.com" }],
      nested: { deep: { label: "Email address" } },
      ghosts: 4,
    };
    const event = toWalkTelemetryEvent(hostile, 1);
    expect(event).toEqual({ outcome: "accepted", ghosts: 4, t: 1 });
    assertClean(event);
  });

  it("never forwards an unrecognised enum value as itself", () => {
    const event = toWalkTelemetryEvent({ outcome: "accepted:fullName=Alex Chen", source: "alex.chen@example.com" }, 1);
    expect(event?.outcome).toBe("other");
    expect(event?.source).toBeUndefined();
    assertClean(event);
  });

  it("refuses anything that is not a plain object, and objects with nothing recognisable", () => {
    for (const raw of [null, undefined, 42, "accepted", [{ outcome: "accepted" }], () => undefined]) {
      expect(toWalkTelemetryEvent(raw, 1)).toBeNull();
    }
    expect(toWalkTelemetryEvent({ label: "Email address", value: "Alex Chen" }, 1)).toBeNull();
  });

  it("ignores prototype keys and clamps absurd numbers", () => {
    const event = toWalkTelemetryEvent(Object.create({ ghosts: 9 }) as object, 1);
    expect(event).toBeNull();
    const clamped = toWalkTelemetryEvent({ outcome: "shown", ghosts: 1e12, latencyMs: -5, walkMs: Number.NaN, steps: Infinity }, 1);
    expect(clamped).toEqual({ outcome: "shown", ghosts: 100_000, t: 1 });
  });

  it("buckets confidence and never sends the number", () => {
    expect(confidenceBucket(0.95)).toBe("confident");
    expect(confidenceBucket(0.8)).toBe("guess");
    expect(confidenceBucket(0.42)).toBe("long-shot");
    expect(confidenceBucket("guess")).toBe("guess");
    expect(confidenceBucket("0.91")).toBeUndefined();
    expect(confidenceBucket(Number.NaN)).toBeUndefined();
    const event = toWalkTelemetryEvent({ outcome: "shown", confidence: 0.9123456 }, 1);
    expect(CONFIDENCE_BUCKETS).toContain(event?.confidence);
    expect(JSON.stringify(event)).not.toContain("0.91");
  });

  it("reads the aliases a renamed outcome object might use", () => {
    expect(toWalkTelemetryEvent({ result: "dismissed", skipReason: "sensitive", ghostCount: 2, ms: 300 }, 1)).toEqual({
      outcome: "dismissed", reason: "sensitive", ghosts: 2, latencyMs: 300, t: 1,
    });
    expect(toWalkTelemetryEvent({ outcome: "shown", fallbackFrom: "baseten" }, 1)).toEqual({ outcome: "shown", fallback: true, t: 1 });
  });

  it("carries the four skip reasons that explain a missing ghost", () => {
    for (const reason of ["sensitive", "already-answered", "no-candidate", "paused"]) {
      expect(toWalkTelemetryEvent({ outcome: "skipped", reason }, 1)?.reason).toBe(reason);
    }
    expect(toWalkTelemetryEvent({ outcome: "skipped", reason: "the email field already said alex.chen@example.com" }, 1)?.reason).toBeUndefined();
  });
});

describe("the transport", () => {
  it("posts one JSON batch to the telemetry route", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const send = createFetchSender({ fetch: fetchImpl, base: async () => "http://localhost:8787" });
    const batch: WalkTelemetryBatch = { events: [{ outcome: "accepted", ghosts: 3 }] };

    expect(await send(batch)).toBe(true);
    expect(calls[0]?.url).toBe(`http://localhost:8787${WALK_TELEMETRY_PATH}`);
    expect((calls[0]?.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(batch);
  });

  it("sends nothing when there is no server URL, and answers false on any failure", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await createFetchSender({ fetch: fetchImpl, base: async () => null })(({ events: [] }))).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    const boom = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await createFetchSender({ fetch: boom, base: async () => "http://localhost:8787" })({ events: [] })).toBe(false);
  });

  it("only accepts a plain http(s) base", () => {
    expect(normalizeBase("http://localhost:8787/")).toBe("http://localhost:8787");
    expect(normalizeBase("https://ghost.example/api/")).toBe("https://ghost.example/api");
    expect(normalizeBase("javascript:alert(1)")).toBeNull();
    expect(normalizeBase("http://user:pw@localhost:8787")).toBeNull();
    expect(normalizeBase(undefined)).toBeNull();
  });
});

describe("the client", () => {
  function collector(): { send: (batch: WalkTelemetryBatch) => Promise<boolean>; sent: WalkTelemetryEvent[][] } {
    const sent: WalkTelemetryEvent[][] = [];
    return { sent, send: async (batch) => { sent.push(batch.events); return true; } };
  }

  it("batches on a timer and never blocks the caller", async () => {
    vi.useFakeTimers();
    const { send, sent } = collector();
    const client = new WalkTelemetryClient({ send, flushMs: 50, win: null as unknown as undefined });
    client.record({ outcome: "shown", ghosts: 1 });
    client.record({ outcome: "accepted", ghosts: 1 });
    expect(sent).toHaveLength(0);
    expect(client.pending()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    expect(client.pending()).toHaveLength(0);
    client.stop();
  });

  it("drops a batch the server refused instead of retrying", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const client = new WalkTelemetryClient({
      send: async () => { attempts++; return false; },
      flushMs: 10,
      win: null as unknown as undefined,
    });
    client.record({ outcome: "accepted" });
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toBe(1);
    expect(client.pending()).toHaveLength(0);
    client.stop();
  });

  it("caps the backlog and swallows a sender that throws", async () => {
    vi.useFakeTimers();
    const client = new WalkTelemetryClient({
      send: async () => { throw new Error("boom"); },
      flushMs: 10,
      maxBatch: 2,
      maxBacklog: 5,
      win: null as unknown as undefined,
    });
    for (let i = 0; i < 20; i++) client.record({ outcome: "shown", ghosts: i });
    expect(client.pending()).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(12);
    expect(client.pending()).toHaveLength(3);
    client.stop();
  });

  it("queues nothing it could not scrub, and nothing after stop", () => {
    const { send } = collector();
    const client = new WalkTelemetryClient({ send, flushMs: 1000, win: null as unknown as undefined });
    client.record({ label: "Email address", value: "Alex Chen" });
    expect(client.pending()).toHaveLength(0);
    client.stop();
    client.record({ outcome: "accepted" });
    expect(client.pending()).toHaveLength(0);
  });

  it("makes no network call of its own when nothing was recorded", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => true);
    const client = new WalkTelemetryClient({ send, flushMs: 5, win: null as unknown as undefined });
    await vi.advanceTimersByTimeAsync(50);
    await client.flush();
    expect(send).not.toHaveBeenCalled();
    client.stop();
  });

  it("keeps its limits sane", () => {
    expect(WALK_TELEMETRY_LIMITS.batch).toBeLessThanOrEqual(WALK_TELEMETRY_LIMITS.backlog);
    expect(WALK_TELEMETRY_LIMITS.timeoutMs).toBeLessThanOrEqual(WALK_TELEMETRY_LIMITS.flushMs);
  });
});
