import { describe, expect, it, vi } from "vitest";
import type { TraceEvent } from "@ghost/shared";
import { DEMO_ORIGIN, INVOICES, invoiceFacts, invoicePath, invoiceSession } from "../../shared/test/helpers/traceBuilder";
import type { LoopMessage, LoopUiState } from "../src/lib/loopMessages";
import { createEpisodicMemory } from "../src/background/episodic";
import { createMemoryKv } from "../src/background/kvStorage";
import { createLoopStateStore, isBusy } from "../src/background/loopState";
import { createLoopWatcher } from "../src/background/loopWatcher";
import type { ProposalMessage } from "../src/background/loopWatcher";
import { createTraceRouter } from "../src/background/traceRouter";
import type { LoopSender, TraceRouter } from "../src/background/traceRouter";
import { createTraceStore } from "../src/background/traceStore";
import { INBOX_URL, asContentEvent, createClock, inboxFacts, settle } from "./loop-helpers";

const EXTENSION_ID = "ghost-extension-id";
const SENDER: LoopSender = { id: EXTENSION_ID, origin: DEMO_ORIGIN, tab: { id: 1 } };

interface Rig {
  router: TraceRouter;
  emitted: ProposalMessage[];
  enabled: { value: boolean };
  send(message: LoopMessage, sender?: LoopSender): Promise<unknown>;
  play(events: TraceEvent[]): Promise<void>;
}

function rig(): Rig {
  const clock = createClock();
  const session = createMemoryKv();
  const trace = createTraceStore({ storage: session, now: clock.now });
  const loopState = createLoopStateStore({ storage: session });
  const emitted: ProposalMessage[] = [];
  const enabled = { value: true };
  const watcher = createLoopWatcher({
    trace, storage: session, now: clock.now, debounceMs: 0,
    isBusy: async () => isBusy(await loopState.get()),
    onProposal: (proposal, tabId) => loopState.dispatch({ type: "propose", proposal, tabId }),
    emit: (_tabId, message) => void emitted.push(message),
  });
  const services = { trace, memory: createEpisodicMemory({ storage: createMemoryKv() }), loopState, watcher };
  const router = createTraceRouter({ services, extensionId: EXTENSION_ID, isEnabled: async () => enabled.value });
  const send: Rig["send"] = async (message, sender = SENDER) => router.handle(message, sender);
  return {
    router, emitted, enabled, send,
    async play(events) {
      for (const e of events) {
        clock.set(e.t);
        await send({ type: "ghost:trace-event", event: asContentEvent(e) });
        await settle();
      }
    },
  };
}

async function reportFacts(r: Rig): Promise<void> {
  await r.send({ type: "ghost:page-facts", url: INBOX_URL, pathPattern: "/invoices", facts: inboxFacts() });
  for (const inv of INVOICES) {
    await r.send({ type: "ghost:page-facts", url: DEMO_ORIGIN + invoicePath(inv), pathPattern: "/invoices/:id", facts: invoiceFacts(inv) });
  }
}

describe("traceRouter", () => {
  it("records, remembers, detects and answers loop-state? for the list tab only", async () => {
    const r = rig();
    await reportFacts(r);
    await r.play(invoiceSession(2).events());

    expect(r.emitted).toHaveLength(1);
    expect(await r.router.services.memory.size()).toBeGreaterThan(0);
    const mine = (await r.send({ type: "ghost:loop-state?" })) as LoopUiState;
    expect(mine).toMatchObject({ phase: "proposed", proposal: { total: 50 } });
    expect(mine.phase === "proposed" && mine.proposal.remaining).toHaveLength(48);
    expect(await r.send({ type: "ghost:loop-state?" }, { ...SENDER, tab: { id: 2 } })).toEqual({ phase: "idle" });
  });

  it("dismiss forgets the proposal, clears the trace, and the program stays away", async () => {
    const r = rig();
    await reportFacts(r);
    await r.play(invoiceSession(2).events());
    const programId = r.emitted[0]?.program.id ?? "";

    expect(await r.send({ type: "ghost:loop-dismiss", programId })).toEqual({ phase: "idle" });
    expect(await r.router.services.trace.events()).toEqual([]);
    expect(await r.send({ type: "ghost:loop-state?" })).toEqual({ phase: "idle" });

    await reportFacts(r);
    await r.play(invoiceSession(2).events());
    expect(r.emitted).toHaveLength(1);
  });

  it("drops messages from another extension, from a frame without an origin, and from a foreign origin", async () => {
    const r = rig();
    const [event] = invoiceSession(1).events();
    if (!event) throw new Error("fixture");
    const message: LoopMessage = { type: "ghost:trace-event", event: asContentEvent(event) };
    expect(r.router.handle(message, { ...SENDER, id: "someone-else" })).toBeNull();
    expect(r.router.handle(message, { tab: { id: 1 }, origin: DEMO_ORIGIN })).toBeNull();
    expect(await r.send(message, { id: EXTENSION_ID, tab: { id: 1 } })).toBe(false);
    expect(await r.send(message, { ...SENDER, origin: "https://evil.example" })).toBe(false);
    expect(await r.send(message, { id: EXTENSION_ID, url: `${DEMO_ORIGIN}/invoices?x=1`, tab: { id: 1 } })).toBe(true);
    expect(await r.router.services.trace.events()).toHaveLength(1);
  });

  it("leaves the run messages and everything unknown to other handlers", () => {
    const r = rig();
    expect(r.router.handle({ type: "ghost:loop-cancel" }, SENDER)).toBeNull();
    expect(r.router.handle({ type: "ghost:loop-step-request", url: INBOX_URL, pathPattern: "/invoices" }, SENDER)).toBeNull();
    expect(r.router.handle({ type: "ghost:health" }, SENDER)).toBeNull();
    expect(r.router.handle("junk", SENDER)).toBeNull();
  });

  it("records nothing while Ghost is disabled, and disabling forgets the trace and the proposal", async () => {
    const r = rig();
    r.enabled.value = false;
    await reportFacts(r);
    await r.play(invoiceSession(2).events());
    expect(await r.router.services.trace.events()).toEqual([]);
    expect(await r.router.services.trace.factsByUrl()).toEqual({});
    expect(await r.router.services.memory.size()).toBe(0);

    r.enabled.value = true;
    await reportFacts(r);
    await r.play(invoiceSession(2).events());
    expect(r.emitted).toHaveLength(1);
    await r.router.disable();
    expect(await r.router.services.trace.events()).toEqual([]);
    expect((await r.router.services.loopState.get()).phase).toBe("idle");
  });

  it("cancels a run in progress when Ghost is disabled", async () => {
    const r = rig();
    await reportFacts(r);
    await r.play(invoiceSession(2).events());
    const { loopState } = r.router.services;
    await loopState.dispatch({ type: "confirm", runId: "run-1", confirmIrreversible: true });
    await loopState.dispatch({ type: "start" });
    const spy = vi.spyOn(loopState, "dispatch");
    await r.router.disable();
    expect(spy.mock.calls.map(([action]) => action.type)).toEqual(["cancel", "reset"]);
    expect((await loopState.get()).phase).toBe("idle");
  });
});
