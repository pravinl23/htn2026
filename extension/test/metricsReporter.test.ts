// Counters and calibration pairs from controller events, batched to the worker every 5 s or on pagehide.
import type { Ghost } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricsReporter, REPORT_INTERVAL_MS, savedTitle } from "../src/content/metricsReporter";
import type { ReporterDeps } from "../src/content/metricsReporter";
import { Overlay } from "../src/content/overlay";
import { createServedLedger, observePredictions } from "../src/content/servedLedger";
import { createEmitter } from "../src/lib/events";
import type { GhostEmitter } from "../src/lib/events";
import type { MetricsBatch, MetricsCounters, MetricsReply } from "../src/lib/messages";

const FIELD = { signature: "sig", label: "First name", kind: "text", rect: { x: 0, y: 0, width: 0, height: 0 } } as const;
const ghost = (over: Partial<Ghost> = {}): Ghost => ({ signature: "sig", action: "fill", value: "Alex", displayText: "Alex", confidence: 0.93, locked: false, source: "offline", ...over });
const totals = (over: Partial<MetricsCounters> = {}): MetricsCounters => ({ ghostsShown: 0, ghostsAccepted: 0, keystrokesSaved: 0, clicksSaved: 0, ...over });

describe("metrics reporter", () => {
  let events: GhostEmitter;
  let win: EventTarget;
  let sent: MetricsBatch[];
  let reporter: MetricsReporter;
  let reply: MetricsReply | null;

  function start(over: Partial<ReporterDeps> = {}): MetricsReporter {
    reporter = new MetricsReporter({
      events,
      win: win as unknown as Window,
      send: async (batch) => {
        sent.push(batch);
        return reply;
      },
      ...over,
    });
    reporter.start();
    return reporter;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    events = createEmitter();
    win = new EventTarget();
    sent = [];
    reply = { ok: true };
  });

  afterEach(() => {
    reporter.stop();
    vi.useRealTimers();
  });

  it("batches: nothing is sent per event, one message goes out after 5 seconds", async () => {
    start();
    events.emit("ghosts:shown", { count: 3, source: "offline" });
    events.emit("ghost:accepted", { ghost: ghost(), field: FIELD, ms: 2 });
    events.emit("ghost:accepted", { ghost: ghost({ action: "select", value: "ca" }), field: FIELD, ms: 2 });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{
      counters: { ghostsShown: 3, ghostsAccepted: 2, keystrokesSaved: 4, clicksSaved: 1 },
      pairs: [{ c: 0.93, a: 1, s: "offline", cal: false }, { c: 0.93, a: 1, s: "offline", cal: false }],
    }]);
  });

  it("an idle page never sends and never keeps a timer", async () => {
    start();
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS * 3);
    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes on pagehide without waiting for the timer", async () => {
    start();
    events.emit("ghosts:shown", { count: 2, source: "cache" });
    win.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((b) => b.counters.ghostsShown)).toEqual([2]);
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
    expect(sent).toHaveLength(1);
  });

  it("'not accepted' means escaped or typed over; a refused write and a closed page say nothing", async () => {
    start();
    events.emit("ghosts:shown", { count: 4, source: "offline" });
    events.emit("ghost:dismissed", { ghost: ghost({ confidence: 0.75 }), reason: "escape" });
    events.emit("ghost:dismissed", { ghost: ghost({ confidence: 0.8 }), reason: "typed" });
    events.emit("ghost:dismissed", { ghost: ghost({ confidence: 0.9 }), reason: "refused" });
    win.dispatchEvent(new Event("pagehide")); // the fourth ghost was simply left behind
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]?.pairs).toEqual([{ c: 0.75, a: 0, s: "offline", cal: false }, { c: 0.8, a: 0, s: "offline", cal: false }]);
    expect(sent[0]?.counters).toEqual(totals({ ghostsShown: 4 }));
  });

  it("never judges the locked Submit ghost", async () => {
    start();
    events.emit("ghost:dismissed", { ghost: ghost({ action: "click", locked: true }), reason: "escape" });
    await reporter.flush();
    expect(sent).toEqual([]);
  });

  it("marks a pair calibrated only for a served ghost whose assignment came from a calibrated provider", async () => {
    const ledger = createServedLedger();
    const predict = observePredictions(async () => ({
      provider: "jev", cache: "miss" as const, latencyMs: 120,
      assignments: [{ signature: "jev", factKey: "firstName", confidence: 0.97, calibrated: true }, { signature: "llm", factKey: "lastName", confidence: 0.9, calibrated: false }],
    }), ledger);
    await predict({ origin: "http://localhost:5173", formSignature: "form-1", fields: [], factKeys: [] });
    start({ isCalibrated: (signature) => ledger.get(signature)?.calibrated === true });
    events.emit("ghost:accepted", { ghost: ghost({ signature: "jev", source: "server" }), field: FIELD, ms: 1 });
    events.emit("ghost:accepted", { ghost: ghost({ signature: "jev", source: "cache" }), field: FIELD, ms: 1 });
    events.emit("ghost:accepted", { ghost: ghost({ signature: "llm", source: "server" }), field: FIELD, ms: 1 });
    events.emit("ghost:accepted", { ghost: ghost({ signature: "jev", source: "offline" }), field: FIELD, ms: 1 }); // pinned offline version: not Jev's number
    await reporter.flush();
    expect(sent[0]?.pairs.map((p) => [p.s, p.cal])).toEqual([["server", true], ["cache", true], ["server", false], ["offline", false]]);
  });

  it("keeps what the worker did not take and tries again", async () => {
    reply = null; // worker asleep, extension reloading
    start();
    events.emit("ghost:accepted", { ghost: ghost(), field: FIELD, ms: 1 });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
    expect(reporter.pending().counters.ghostsAccepted).toBe(1);
    reply = { ok: true };
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.pairs).toHaveLength(1);
    expect(reporter.pending().counters.ghostsAccepted).toBe(0);
  });

  it("sends at most 200 pairs per message and the rest in the next one", async () => {
    start();
    for (let i = 0; i < 230; i++) events.emit("ghost:dismissed", { ghost: ghost(), reason: "typed" });
    await reporter.flush();
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS);
    expect(sent.map((b) => b.pairs.length)).toEqual([200, 30]);
  });

  it("publishes the lifetime total: stored + in flight + unsent, corrected by every reply", async () => {
    const seen: MetricsCounters[] = [];
    reply = { ok: true, totals: totals({ ghostsAccepted: 11, keystrokesSaved: 1004, ghostsShown: 20 }) };
    start({ loadTotals: async () => totals({ keystrokesSaved: 1000, ghostsAccepted: 10 }), onTotals: (t) => seen.push(t) });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)?.keystrokesSaved).toBe(1000);
    events.emit("ghost:accepted", { ghost: ghost(), field: FIELD, ms: 1 });
    expect(seen.at(-1)).toEqual(totals({ keystrokesSaved: 1004, ghostsAccepted: 11 }));
    await reporter.flush();
    expect(seen.at(-1)).toEqual(reply.totals);
  });

  it("stop() unsubscribes and cancels the timer", async () => {
    start();
    events.emit("ghosts:shown", { count: 1, source: "offline" });
    reporter.stop();
    events.emit("ghosts:shown", { count: 5, source: "offline" });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS * 2);
    expect(sent).toEqual([]);
    expect(reporter.pending().counters.ghostsShown).toBe(1);
  });
});

describe("HUD lifetime total", () => {
  it("reads as a sentence with grouped digits", () => {
    expect(savedTitle(totals({ keystrokesSaved: 12345, clicksSaved: 67, ghostsAccepted: 80, ghostsShown: 100 })))
      .toBe("Lifetime: 12,345 keystrokes and 67 clicks saved · 80 of 100 ghosts accepted");
  });

  it("is the title of the HUD's saved item, survives a re-mount, and never mounts a destroyed overlay", () => {
    const overlay = new Overlay(document);
    const item = (): Element | null => overlay.shadow.querySelector(".hud .item.saved");
    overlay.setSavedTitle("Lifetime: 5 keystrokes");
    expect(item()?.getAttribute("title")).toBe("Lifetime: 5 keystrokes");
    overlay.destroy();
    overlay.setSavedTitle("Lifetime: 9 keystrokes");
    expect(document.getElementById("ghost-overlay-host")).toBeNull();
    overlay.render({ ghosts: [] });
    expect(item()?.getAttribute("title")).toBe("Lifetime: 9 keystrokes");
    overlay.destroy();
  });
});

describe("served ledger", () => {
  it("remembers the last answer per field and starts over instead of growing", () => {
    const ledger = createServedLedger(3);
    ledger.note([{ signature: "a", factKey: "email", confidence: 0.9 }, { signature: "b", factKey: "phone", confidence: 0.9 }]);
    ledger.note([{ signature: "a", factKey: "fullName", confidence: 0.8 }]);
    expect(ledger.get("a")?.factKey).toBe("fullName");
    ledger.note([{ signature: "c", factKey: "city", confidence: 0.9 }, { signature: "d", factKey: "country", confidence: 0.9 }]);
    expect(ledger.get("b")).toBeUndefined();
    expect(ledger.get("d")?.factKey).toBe("country");
  });

  it("passes the predictor's answer through untouched, null included", async () => {
    const ledger = createServedLedger();
    expect(await observePredictions(async () => null, ledger)({ origin: "o", formSignature: "f", fields: [], factKeys: [] })).toBeNull();
  });
});
