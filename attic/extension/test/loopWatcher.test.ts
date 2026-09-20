import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoopProgram, PageFact, TraceEvent } from "@ghost/shared";
import { DEMO_ORIGIN, INBOX_LIST, REPLY_LABEL, handleInvoice, invoiceSession } from "../../shared/test/helpers/traceBuilder";
import { createMemoryKv } from "../src/background/kvStorage";
import type { KvStorage } from "../src/background/kvStorage";
import { createRemoteSynthesizer, mergeRemoteProgram } from "../src/background/loopRemote";
import type { RemoteSynthesizer } from "../src/background/loopRemote";
import { LOOP_DEBOUNCE_MS, LOW_CONFIDENCE, createLoopWatcher, programKey } from "../src/background/loopWatcher";
import type { LoopWatcher, ProposalMessage } from "../src/background/loopWatcher";
import { createTraceStore } from "../src/background/traceStore";
import type { TraceStore } from "../src/background/traceStore";
import { createClock, inboxFacts, reportInvoiceFacts, settle } from "./loop-helpers";

interface Harness {
  trace: TraceStore;
  watcher: LoopWatcher;
  emitted: Array<{ tabId: number; message: ProposalMessage }>;
  /** Appends the events one by one, as the router does, and lets the debounce fire after each. */
  feed(events: TraceEvent[]): Promise<void>;
}

interface HarnessOptions {
  storage?: KvStorage;
  watcherStorage?: KvStorage;
  synthesizeRemote?: RemoteSynthesizer;
  isBusy?: () => boolean;
}

function harness(opts: HarnessOptions = {}): Harness {
  const clock = createClock();
  const trace = createTraceStore({ storage: opts.storage ?? createMemoryKv(), now: clock.now });
  const emitted: Harness["emitted"] = [];
  let fire: (() => void) | null = null;
  const watcher = createLoopWatcher({
    trace,
    storage: opts.watcherStorage ?? createMemoryKv(),
    now: clock.now,
    timers: { set: (fn) => (fire = fn), clear: () => (fire = null) },
    emit: (tabId, message) => void emitted.push({ tabId, message }),
    synthesizeRemote: opts.synthesizeRemote,
    isBusy: opts.isBusy,
  });
  const flush = async (): Promise<void> => {
    const due = fire;
    fire = null;
    due?.();
    await settle();
  };
  return {
    trace, watcher, emitted,
    async feed(events) {
      for (const e of events) {
        clock.set(e.t);
        const stored = await trace.append(e, { tabId: e.tabId, origin: DEMO_ORIGIN });
        if (stored) watcher.onEvent(stored);
        await flush();
      }
    },
  };
}

const withoutTotals = (fact: PageFact): boolean => fact.label !== "Total" && fact.label !== "Amount due";

afterEach(() => vi.useRealTimers());

describe("loopWatcher proposals", () => {
  it("proposes the canonical invoice loop exactly once: next item 2, 48 of 50 remaining", async () => {
    const remote = vi.fn<RemoteSynthesizer>();
    const h = harness({ synthesizeRemote: remote });
    await reportInvoiceFacts(h.trace);
    await h.feed(invoiceSession(2).events());

    expect(h.emitted).toHaveLength(1);
    const { tabId, message } = h.emitted[0] ?? {};
    expect(tabId).toBe(1);
    expect(message?.type).toBe("ghost:loop-proposal");
    expect(message?.program.iterator).toMatchObject({ listSignature: INBOX_LIST, nextIndex: 2, total: 50, stride: 1 });
    expect(message?.total).toBe(50);
    expect(message?.remaining).toHaveLength(48);
    expect(message?.remaining[0]).toBe(2);
    expect(message?.remaining[47]).toBe(49);
    expect(message?.program.irreversible.map((e) => e.description)).toEqual([REPLY_LABEL]);
    expect(message?.program.unresolved).toEqual([]);
    expect(remote).not.toHaveBeenCalled(); // heuristics explained every value: nothing typed leaves the extension

    expect(await h.watcher.evaluate()).toBeNull();
    expect(h.emitted).toHaveLength(1);
  });

  it("proposes nothing before the second run is complete", async () => {
    const h = harness();
    await reportInvoiceFacts(h.trace);
    await h.feed(invoiceSession(2).events().slice(0, -1));
    expect(h.emitted).toEqual([]);
  });

  it("skips items that already show a handled marker", async () => {
    const h = harness();
    await reportInvoiceFacts(h.trace, { inbox: inboxFacts(50, "0,1,5,49") });
    await h.feed(invoiceSession(2).events());
    const remaining = h.emitted[0]?.message.remaining ?? [];
    expect(remaining).toHaveLength(46);
    expect(remaining).not.toContain(5);
    expect(remaining).not.toContain(49);
  });

  it("waits for the list length, then proposes when the facts arrive", async () => {
    const h = harness();
    await reportInvoiceFacts(h.trace, { inbox: null });
    await h.feed(invoiceSession(2).events());
    expect(h.emitted).toEqual([]);

    await reportInvoiceFacts(h.trace);
    h.watcher.onFacts();
    expect(await h.watcher.evaluate()).not.toBeNull();
    expect(h.emitted).toHaveLength(1);
  });

  it("updates the proposal when the user handles a third item by hand", async () => {
    const h = harness();
    await reportInvoiceFacts(h.trace);
    await h.feed(invoiceSession(3).events());
    expect(h.emitted.map((e) => e.message.program.iterator.nextIndex)).toEqual([2, 3]);
    expect(h.emitted[1]?.message.remaining).toHaveLength(47);
  });

  it("stays quiet while a preview is open or a run is active", async () => {
    const h = harness({ isBusy: () => true });
    await reportInvoiceFacts(h.trace);
    await h.feed(invoiceSession(2).events());
    expect(h.emitted).toEqual([]);
  });

  it("ignores Ghost's own actions", async () => {
    const h = harness();
    await reportInvoiceFacts(h.trace);
    await h.feed(invoiceSession(2).events().map((e) => ({ ...e, synthetic: true })));
    expect(h.emitted).toEqual([]);
  });

  it("still records the proposal when the tab is gone", async () => {
    const trace = createTraceStore({ storage: createMemoryKv(), now: () => invoiceSession(2).now });
    for (const e of invoiceSession(2).events()) await trace.append(e, { tabId: 1, origin: DEMO_ORIGIN });
    await reportInvoiceFacts(trace);
    const onProposal = vi.fn();
    const watcher = createLoopWatcher({
      trace, storage: createMemoryKv(), now: () => invoiceSession(2).now, onProposal,
      emit: () => Promise.reject(new Error("no receiver")),
    });
    expect((await watcher.evaluate())?.remaining).toHaveLength(48);
    expect(onProposal).toHaveBeenCalledWith(expect.objectContaining({ total: 50 }), 1);
  });
});

describe("loopWatcher dismissal", () => {
  it("never brings back a dismissed program, even after a worker restart", async () => {
    const watcherStorage = createMemoryKv();
    const first = harness({ watcherStorage });
    await reportInvoiceFacts(first.trace);
    await first.feed(invoiceSession(2).events());
    const program = first.emitted[0]?.message.program;
    expect(program).toBeDefined();
    await first.watcher.dismiss(program?.id ?? "");
    await first.trace.clear();

    // The user carries on by hand with items 2 and 3: same task, other values.
    const more = invoiceSession(0, { start: invoiceSession(2).now + 60_000 });
    handleInvoice(more.navigate("/invoices"), 2);
    handleInvoice(more.navigate("/invoices"), 3);
    await reportInvoiceFacts(first.trace);
    await first.feed(more.events());
    expect(first.emitted).toHaveLength(1);

    const control = harness(); // the same events DO make a proposal for someone who dismissed nothing
    await reportInvoiceFacts(control.trace);
    await control.feed(more.events());
    expect(control.emitted.map((e) => e.message.program.iterator.nextIndex)).toEqual([4]);

    const restarted = harness({ watcherStorage });
    await reportInvoiceFacts(restarted.trace);
    await restarted.feed(invoiceSession(2).events());
    expect(restarted.emitted).toEqual([]);
  });

  it("dismissing an unknown program id changes nothing", async () => {
    const h = harness();
    await h.watcher.dismiss("loop-unknown");
    await reportInvoiceFacts(h.trace);
    await h.feed(invoiceSession(2).events());
    expect(h.emitted).toHaveLength(1);
  });

  it("keys a program by its list and step shapes, not by values or extracts", async () => {
    const a = harness();
    await reportInvoiceFacts(a.trace);
    await a.feed(invoiceSession(2).events());
    const b = harness();
    await reportInvoiceFacts(b.trace, { keep: withoutTotals });
    await b.feed(invoiceSession(3).events());
    const [pa, pb] = [a.emitted[0]?.message.program, b.emitted[1]?.message.program];
    if (!pa || !pb) throw new Error("expected two programs");
    expect(pb.steps.length).toBeLessThan(pa.steps.length); // one extract less
    expect(programKey(pb)).toBe(programKey(pa));
    const other: LoopProgram = { ...pa, iterator: { ...pa.iterator, listSignature: "ul#archive" } };
    expect(programKey(other)).not.toBe(programKey(pa));
  });
});

describe("loopWatcher debounce", () => {
  it("evaluates once, 250 ms after the last event", async () => {
    vi.useFakeTimers();
    const events = vi.fn(async () => []);
    const watcher = createLoopWatcher({ trace: { events, factsByUrl: async () => ({}), listInfo: async () => null }, storage: createMemoryKv(), emit: () => undefined });
    const [event] = invoiceSession(1).events();
    if (!event) throw new Error("fixture");
    watcher.onEvent(event);
    await vi.advanceTimersByTimeAsync(LOOP_DEBOUNCE_MS - 50);
    watcher.onEvent(event);
    await vi.advanceTimersByTimeAsync(LOOP_DEBOUNCE_MS - 1);
    expect(events).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveBeenCalledTimes(1);

    watcher.onEvent({ ...event, synthetic: true });
    watcher.onFacts();
    watcher.cancel();
    await vi.advanceTimersByTimeAsync(LOOP_DEBOUNCE_MS * 2);
    expect(events).toHaveBeenCalledTimes(1);
  });
});

describe("loopWatcher with unresolved steps", () => {
  async function propose(synthesizeRemote?: RemoteSynthesizer): Promise<ProposalMessage> {
    const h = harness({ synthesizeRemote });
    await reportInvoiceFacts(h.trace, { keep: withoutTotals });
    await h.feed(invoiceSession(2).events());
    const message = h.emitted[0]?.message;
    if (!message) throw new Error("expected a proposal");
    return message;
  }

  it("keeps the heuristic program, flagged low confidence, when no server is configured", async () => {
    const { program, remaining } = await propose();
    expect(program.unresolved?.map((u) => u.label)).toEqual(["Total"]);
    expect(program.confidence).toBeLessThanOrEqual(LOW_CONFIDENCE);
    expect(remaining).toHaveLength(48);
  });

  it("tolerates a server that times out, throws, or has no such route", async () => {
    const failing: RemoteSynthesizer[] = [
      () => Promise.reject(new Error("timeout")),
      createRemoteSynthesizer({ getServerUrl: async () => "http://localhost:8787", fetch: vi.fn(async () => new Response("not found", { status: 404 })) }),
      createRemoteSynthesizer({ getServerUrl: async () => "http://localhost:8787", fetch: vi.fn(async () => Promise.reject(new TypeError("unreachable"))) }),
      createRemoteSynthesizer({ getServerUrl: async () => null, fetch: vi.fn() }),
      async () => ({ program: { steps: "garbage" } }),
    ];
    for (const remote of failing) {
      const { program } = await propose(remote);
      expect(program.unresolved).toHaveLength(1);
      expect(program.confidence).toBeLessThanOrEqual(LOW_CONFIDENCE);
    }
  });

  it("sends the two runs and only the visited pages, and merges the answer", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({
      provider: "openai",
      program: { steps: [{ op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "total" }, transform: "number" } }] },
    }));
    const { program } = await propose(createRemoteSynthesizer({ getServerUrl: async () => "http://localhost:8787/", fetch: fetchMock }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://localhost:8787/v1/loop/synthesize");
    const body = JSON.parse(String(init?.body)) as { runs: TraceEvent[][]; pageSamples: Record<string, unknown> };
    expect(body.runs).toHaveLength(2);
    // INV-1003 and INV-1004 were reported too, but the runs never visited them.
    expect(Object.keys(body.pageSamples).sort()).toEqual([`${DEMO_ORIGIN}/invoices`, `${DEMO_ORIGIN}/invoices/INV-1001`, `${DEMO_ORIGIN}/invoices/INV-1002`]);
    expect(String(init?.body)).not.toContain("ghost:list-length");

    expect(program.unresolved).toEqual([]);
    expect(program.confidence).toBeGreaterThan(LOW_CONFIDENCE);
    const extractAt = program.steps.findIndex((s) => s.op === "extract" && s.var === "total");
    const fillAt = program.steps.findIndex((s) => s.op === "fill" && "var" in s.value && s.value.var === "total");
    expect(extractAt).toBeGreaterThan(program.steps.findIndex((s) => s.op === "open-item"));
    expect(extractAt).toBeLessThan(fillAt);
    const [effect] = program.irreversible;
    expect(program.steps[effect?.stepIndex ?? -1]).toMatchObject({ op: "click", locked: true });
  });
});

describe("mergeRemoteProgram", () => {
  async function unresolvedProgram(): Promise<LoopProgram> {
    const h = harness();
    await reportInvoiceFacts(h.trace, { keep: withoutTotals });
    await h.feed(invoiceSession(2).events());
    const program = h.emitted[0]?.message.program;
    if (!program) throw new Error("expected a proposal");
    return program;
  }

  it("takes nothing but extract steps for unresolved variables on pages the program shows", async () => {
    const program = await unresolvedProgram();
    const hostile = {
      program: {
        iterator: { listSignature: "ul#everything" },
        irreversible: [],
        steps: [
          { op: "click", target: { label: "Delete all", kind: "button" }, locked: false },
          { op: "extract", var: "vendor", from: { pathPattern: "/invoices/:id", locator: { by: "id", value: "x" } } },
          { op: "extract", var: "total", from: { pathPattern: "/admin/secrets", locator: { by: "id", value: "x" } } },
          { op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "xpath", value: "//x" } } },
        ],
      },
    };
    expect(mergeRemoteProgram(program, hostile)).toBeNull();
    expect(mergeRemoteProgram(program, null)).toBeNull();
    expect(mergeRemoteProgram(program, "text")).toBeNull();
  });

  it("keeps every locked step locked and every other step as it was", async () => {
    const program = await unresolvedProgram();
    const reply = { steps: [{ op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "label", value: "Amount due" }, transform: "eval" } }] };
    const merged = mergeRemoteProgram(program, reply);
    expect(merged?.steps.filter((s) => s.op !== "extract" || s.var !== "total")).toEqual(program.steps);
    expect(merged?.steps.find((s) => s.op === "extract" && s.var === "total")).toEqual({
      op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "label", value: "Amount due" } },
    });
    expect(merged?.irreversible.map((e) => e.description)).toEqual(program.irreversible.map((e) => e.description));
    expect(merged?.iterator).toEqual(program.iterator);
  });
});
