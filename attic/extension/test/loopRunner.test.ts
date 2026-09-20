import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopMessageOf, LoopProposal, LoopStepOutcome, LoopStepReply } from "../src/lib/loopMessages";
import { ITEM_URL_VAR, rowVar } from "../src/lib/loopRouting";
import { createMemoryKv } from "../src/background/kvStorage";
import type { KvStorage } from "../src/background/kvStorage";
import { createLoopBackground, createRemoteExecutor, fetchExecutors } from "../src/background/loopBackground";
import { createLoopRunner, LOOP_RUN_KEY, MAX_DELIVERIES, sanitizeOutcome } from "../src/background/loopRunner";
import type { LoopRunner, ProgressMessage, RemoteExecutor } from "../src/background/loopRunner";
import { createLoopStateStore } from "../src/background/loopState";
import type { LoopStateStore } from "../src/background/loopState";
import type { TraceRouter } from "../src/background/traceRouter";
import { invoiceProgram, REPLY_STEP, SITE_ORIGIN } from "./fixtures/fakeSite";

const TAB = 7;
const PROGRAM = invoiceProgram();
const PROPOSAL: LoopProposal = { program: PROGRAM, remaining: [2, 3, 4], total: 5 };
const ITEM_PAGE = "/invoices/:id";
const itemUrl = (index: number): string => `${SITE_ORIGIN}/invoices/INV-${1001 + index}`;

interface Harness {
  storage: KvStorage;
  loopState: LoopStateStore;
  runner: LoopRunner;
  progress: ProgressMessage[];
  finished: string[];
}

function harness(extra: { executeRemote?: RemoteExecutor; storage?: KvStorage } = {}): Harness {
  const storage = extra.storage ?? createMemoryKv();
  const loopState = createLoopStateStore({ storage });
  const progress: ProgressMessage[] = [];
  const finished: string[] = [];
  let runs = 0;
  const runner = createLoopRunner({
    loopState, storage, executeRemote: extra.executeRemote,
    emit: (_tabId, message) => void progress.push(message),
    newRunId: () => `run-${++runs}`,
    onFinished: (state) => void finished.push(state.phase),
  });
  return { storage, loopState, runner, progress, finished };
}

function startMessage(extra: Partial<LoopMessageOf<"ghost:loop-start">> = {}): LoopMessageOf<"ghost:loop-start"> {
  return { type: "ghost:loop-start", programId: PROGRAM.id, mode: "background", items: [2, 3, 4], confirmIrreversible: true, ...extra };
}

async function started(h: Harness, extra: Partial<LoopMessageOf<"ghost:loop-start">> = {}): Promise<void> {
  await h.loopState.dispatch({ type: "propose", proposal: PROPOSAL, tabId: TAB });
  const ui = await h.runner.start(startMessage(extra), TAB);
  expect(ui.phase).toBe("running");
}

function orderOf(reply: LoopStepReply): { item: number; stepIndex: number; op: string } {
  if (reply.kind !== "step") throw new Error(`expected a step, got ${reply.kind}`);
  return { item: reply.order.item, stepIndex: reply.order.stepIndex, op: reply.order.step.op };
}

const VALUES = ["Vendor", "INV", "Sep 1, 2026", "$1.00"];

/** What a well-behaved page reports for each step of the invoice program. */
function outcomeFor(reply: LoopStepReply): LoopStepOutcome {
  if (reply.kind !== "step") throw new Error("no step to answer");
  const { order } = reply;
  const base = { runId: order.runId, item: order.item, stepIndex: order.stepIndex, ok: true };
  if (order.step.op === "open-item") return { ...base, extracted: { var: ITEM_URL_VAR, value: itemUrl(order.item), confidence: 1 } };
  if (order.step.op === "extract") return { ...base, extracted: { var: order.step.var, value: `${VALUES[order.stepIndex - 1]} ${order.item}`, confidence: 1 } };
  if (order.step.op === "fill" && order.vars[rowVar("/sheet")] === undefined) return { ...base, extracted: { var: rowVar("/sheet"), value: String(order.item), confidence: 1 } };
  return base;
}

/** Plays a page: answers every step until the run stops handing them out. Locked steps are re-requested from their page. */
async function play(h: Harness, until: (reply: LoopStepReply) => boolean = () => false): Promise<{ reply: LoopStepReply; seen: Array<ReturnType<typeof orderOf>> }> {
  const seen: Array<ReturnType<typeof orderOf>> = [];
  let reply = await h.runner.stepRequest({ url: `${SITE_ORIGIN}/invoices`, pathPattern: "/invoices" }, TAB);
  while (reply.kind === "step" && !until(reply)) {
    if (reply.order.stepIndex === REPLY_STEP) reply = await h.runner.stepRequest({ url: itemUrl(reply.order.item), pathPattern: ITEM_PAGE }, TAB);
    if (reply.kind !== "step") break;
    seen.push(orderOf(reply));
    reply = await h.runner.stepResult(outcomeFor(reply), TAB);
  }
  return { reply, seen };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("start", () => {
  it("needs the proposal's own tab, the program id and the explicit confirmation", async () => {
    await h.loopState.dispatch({ type: "propose", proposal: PROPOSAL, tabId: TAB });
    expect((await h.runner.start(startMessage(), 99)).phase).toBe("idle");
    expect((await h.runner.start(startMessage({ programId: "other" }), TAB)).phase).toBe("proposed");
    expect((await h.runner.start({ ...startMessage(), confirmIrreversible: false as unknown as true }, TAB)).phase).toBe("proposed");
    expect((await h.runner.start(startMessage({ mode: "teleport" as "visible" }), TAB)).phase).toBe("proposed");
    expect((await h.loopState.get()).phase).toBe("proposed");
    expect((await h.runner.start(startMessage({ items: [3, 4] }), TAB)).phase).toBe("running");
    expect((await h.loopState.get()).items.map((i) => i.index)).toEqual([3, 4]);
    expect(h.progress.at(-1)?.run).toMatchObject({ state: "running", total: 2 });
  });

  it("hands steps only to the run's tab", async () => {
    await started(h);
    expect(await h.runner.stepRequest({ pathPattern: "/invoices" }, 99)).toEqual({ kind: "none" });
    expect(await h.runner.stepRequest({ pathPattern: "/invoices" }, undefined)).toEqual({ kind: "none" });
    expect(orderOf(await h.runner.stepRequest({ pathPattern: "/invoices" }, TAB))).toEqual({ item: 2, stepIndex: 0, op: "open-item" });
  });
});

describe("a whole run", () => {
  it("walks every step of every item in order, carries the vars, and reports progress per item", async () => {
    await started(h);
    const { reply, seen } = await play(h);
    expect(reply).toEqual({ kind: "none" });
    const n = PROGRAM.steps.length;
    expect(seen.map((s) => s.item)).toEqual([...Array(n).fill(2), ...Array(n).fill(3), ...Array(n).fill(4)]);
    expect(seen.slice(0, n).map((s) => s.op)).toEqual(PROGRAM.steps.map((s) => s.op));
    const state = await h.loopState.get();
    expect(state.phase).toBe("done");
    expect(state.irreversibleDone).toBe(3);
    expect(h.finished).toEqual(["done"]);
    expect(h.progress.map((p) => `${p.run.state}:${p.run.done}`)).toEqual(["running:0", "running:1", "running:2", "done:3"]);
    expect(await h.storage.get(LOOP_RUN_KEY)).toBeUndefined();
  });

  it("gives a step the values extracted so far, and forgets them for the next item", async () => {
    await started(h);
    const { reply } = await play(h, (r) => r.kind === "step" && r.order.step.op === "fill");
    if (reply.kind !== "step") throw new Error("no fill");
    expect(reply.order.vars).toMatchObject({ vendor: "Vendor 2", total: "$1.00 2", [ITEM_URL_VAR]: itemUrl(2) });
    const next = await play(h, (r) => r.kind === "step" && r.order.item === 3 && r.order.stepIndex === 1);
    if (next.reply.kind !== "step") throw new Error("no second item");
    expect(next.reply.order.vars).toEqual({ [ITEM_URL_VAR]: itemUrl(3) });
  });
});

describe("locked steps", () => {
  async function atReply(): Promise<LoopStepReply> {
    await started(h);
    return (await play(h, (r) => r.kind === "step" && r.order.stepIndex === REPLY_STEP)).reply;
  }

  it("arrive locked and confirmed, but are only armed by a request from their own page", async () => {
    const chained = await atReply();
    if (chained.kind !== "step") throw new Error("no reply step");
    expect(chained.order).toMatchObject({ confirmed: true, step: { op: "click", locked: true } });
    // The result of a locked step that was never armed is refused: the run stops.
    expect(await h.runner.stepResult(outcomeFor(chained), TAB)).toEqual({ kind: "none" });
    expect((await h.loopState.get()).failure).toMatchObject({ item: 2, stepIndex: REPLY_STEP, reason: "locked-unarmed" });
    expect((await h.loopState.get()).irreversibleDone).toBe(0);
  });

  it("are not armed from another page", async () => {
    await atReply();
    const wrongPage = await h.runner.stepRequest({ pathPattern: "/sheet" }, TAB);
    await h.runner.stepResult(outcomeFor(wrongPage), TAB);
    expect((await h.loopState.get()).failure?.reason).toBe("locked-unarmed");
  });

  it("are NEVER handed out a second time once armed: a lost result stops the run", async () => {
    await atReply();
    const armed = await h.runner.stepRequest({ pathPattern: ITEM_PAGE }, TAB);
    expect(orderOf(armed)).toEqual({ item: 2, stepIndex: REPLY_STEP, op: "click" });
    // The page reloaded (or the content script died) after the click: it asks again instead of reporting.
    expect(await h.runner.stepRequest({ pathPattern: ITEM_PAGE }, TAB)).toEqual({ kind: "none" });
    const state = await h.loopState.get();
    expect(state.phase).toBe("failed");
    expect(state.failure).toMatchObject({ item: 2, stepIndex: REPLY_STEP, reason: "irreversible-unverified" });
    expect(state.items.map((i) => i.status)).toEqual(["failed", "skipped", "skipped"]);
    expect(h.progress.at(-1)?.run).toMatchObject({ state: "failed", failedItem: 2 });
  });

  it("in a visible run, a page that moved on after the armed click counts as its effect", async () => {
    await started(h, { mode: "visible" });
    await play(h, (r) => r.kind === "step" && r.order.stepIndex === REPLY_STEP);
    await h.runner.stepRequest({ pathPattern: ITEM_PAGE }, TAB);
    const next = await h.runner.stepRequest({ pathPattern: "/thanks" }, TAB);
    expect(orderOf(next)).toMatchObject({ item: 2, stepIndex: REPLY_STEP + 1 });
    expect((await h.loopState.get()).irreversibleDone).toBe(1);
  });

  it("stop the run when the program does not list them as irreversible", async () => {
    const unlisted: LoopProposal = { ...PROPOSAL, program: { ...PROGRAM, irreversible: [] } };
    await h.loopState.dispatch({ type: "propose", proposal: unlisted, tabId: TAB });
    await h.runner.start(startMessage(), TAB);
    const { reply } = await play(h);
    expect(reply).toEqual({ kind: "none" });
    expect((await h.loopState.get()).failure).toMatchObject({ stepIndex: REPLY_STEP, reason: "locked-unlisted" });
  });
});

describe("verification", () => {
  it("stops the whole run on the first failed step and names the item", async () => {
    await started(h);
    const { reply } = await play(h, (r) => r.kind === "step" && r.order.item === 3 && r.order.step.op === "fill");
    if (reply.kind !== "step") throw new Error("no fill");
    const bad: LoopStepOutcome = { runId: reply.order.runId, item: 3, stepIndex: reply.order.stepIndex, ok: false, error: "value-mismatch" };
    expect(await h.runner.stepResult(bad, TAB)).toEqual({ kind: "none" });
    const state = await h.loopState.get();
    expect(state.items).toEqual([{ index: 2, status: "done" }, { index: 3, status: "failed", error: "value-mismatch" }, { index: 4, status: "skipped" }]);
    expect(await h.runner.stepRequest({ pathPattern: "/invoices" }, TAB)).toEqual({ kind: "none" });
    expect(h.finished).toEqual(["failed"]);
  });

  it("refuses an extract without a value, a wrong variable, and a value that differs from the confirmed preview", async () => {
    await started(h, { rows: [{ index: 2, url: itemUrl(2), vars: { vendor: "Vendor 2", number: "SOMETHING ELSE" } }] });
    const first = await h.runner.stepRequest({ pathPattern: "/invoices" }, TAB);
    const vendor = await h.runner.stepResult(outcomeFor(first), TAB);
    const number = await h.runner.stepResult(outcomeFor(vendor), TAB); // matches the preview
    expect(orderOf(number)).toMatchObject({ stepIndex: 2 });
    expect(await h.runner.stepResult(outcomeFor(number), TAB)).toEqual({ kind: "none" });
    expect((await h.loopState.get()).failure).toMatchObject({ item: 2, stepIndex: 2, reason: "value-changed" });

    const again = harness();
    await started(again);
    const open = await again.runner.stepRequest({ pathPattern: "/invoices" }, TAB);
    const extract = await again.runner.stepResult(outcomeFor(open), TAB);
    const empty = { ...outcomeFor(extract), extracted: { var: "vendor", value: "  ", confidence: 1 } };
    expect(await again.runner.stepResult(empty, TAB)).toEqual({ kind: "none" });
    expect((await again.loopState.get()).failure?.reason).toBe("extract-missing");
  });

  it("only takes reserved variables of the right shape from a page", async () => {
    await started(h);
    const open = await h.runner.stepRequest({ pathPattern: "/invoices" }, TAB);
    const evil = { ...outcomeFor(open), extracted: { var: ITEM_URL_VAR, value: "https://evil.example/invoices/INV-1003", confidence: 1 } };
    expect(await h.runner.stepResult(evil, TAB)).toEqual({ kind: "none" });
    expect((await h.loopState.get()).failure?.reason).toBe("bad-outcome");
  });

  it("answers a stale result with wait and gives up on a step that goes in circles", async () => {
    await started(h);
    const open = await h.runner.stepRequest({ pathPattern: "/invoices" }, TAB);
    if (open.kind !== "step") throw new Error("no step");
    expect(await h.runner.stepResult({ runId: open.order.runId, item: 2, stepIndex: 7, ok: true }, TAB)).toEqual({ kind: "wait" });
    expect(await h.runner.stepResult({ runId: "another-run", item: 2, stepIndex: 0, ok: true }, TAB)).toEqual({ kind: "none" });
    for (let i = 1; i < MAX_DELIVERIES; i++) expect((await h.runner.stepRequest({ pathPattern: "/invoices" }, TAB)).kind).toBe("step");
    expect(await h.runner.stepRequest({ pathPattern: "/invoices" }, TAB)).toEqual({ kind: "none" });
    expect((await h.loopState.get()).failure?.reason).toBe("step-stuck");
  });

  it("rebuilds outcomes from untrusted input", () => {
    expect(sanitizeOutcome(null)).toBeNull();
    expect(sanitizeOutcome({ runId: "r", item: -1, stepIndex: 0, ok: true })).toBeNull();
    expect(sanitizeOutcome({ runId: "r", item: 1, stepIndex: 0, ok: false, error: "<script>alert(1)</script>" })).toMatchObject({ error: "failed" });
    expect(sanitizeOutcome({ runId: "r", item: 1, stepIndex: 0, ok: true, extracted: { var: "v", value: "x".repeat(5000), confidence: "high" } })?.extracted)
      .toMatchObject({ var: "v", confidence: 0, value: "x".repeat(2000) });
  });
});

describe("cancel, reload, tab close", () => {
  it("cancels mid-run: no further step is handed out and the rest is skipped", async () => {
    await started(h);
    await play(h, (r) => r.kind === "step" && r.order.item === 3 && r.order.stepIndex === 2);
    expect((await h.runner.cancel(99)).phase).toBe("idle"); // another tab cannot cancel
    const ui = await h.runner.cancel(TAB, "run-1");
    expect(ui).toMatchObject({ phase: "finished", run: { state: "cancelled", done: 1 } });
    expect(await h.runner.stepRequest({ pathPattern: "/invoices" }, TAB)).toEqual({ kind: "none" });
    expect((await h.loopState.get()).items.map((i) => i.status)).toEqual(["done", "skipped", "skipped"]);
    // Esc on the final report closes it.
    expect((await h.runner.cancel(TAB)).phase).toBe("idle");
  });

  it("a reloaded page (and a restarted worker) resumes at the pending step with the vars intact", async () => {
    const storage = createMemoryKv();
    h = harness({ storage });
    await started(h);
    await play(h, (r) => r.kind === "step" && r.order.item === 2 && r.order.step.op === "fill");
    const revived = harness({ storage }); // same session storage, brand-new worker objects
    const pending = await revived.runner.stepRequest({ pathPattern: "/invoices" }, TAB);
    if (pending.kind !== "step") throw new Error("the run did not survive");
    expect(orderOf(pending)).toEqual({ item: 2, stepIndex: 8, op: "fill" });
    expect(pending.order.vars).toMatchObject({ vendor: "Vendor 2", [ITEM_URL_VAR]: itemUrl(2) });
    expect(pending.order.confirmed).toBe(true);
  });

  it("cancels when the run's tab closes", async () => {
    await started(h);
    await h.runner.tabClosed(99);
    expect((await h.loopState.get()).phase).toBe("running");
    await h.runner.tabClosed(TAB);
    expect((await h.loopState.get()).phase).toBe("cancelled");
  });
});

describe("server-side modes", () => {
  const rows = [2, 3, 4].map((index) => ({ index, url: itemUrl(index), vars: { vendor: `Vendor ${index}` } }));

  it("reports unavailable when there is no executor, no route or no rows", async () => {
    await started(h, { mode: "parallel", rows });
    await vi.waitFor(async () => expect((await h.loopState.get()).phase).toBe("failed"));
    expect((await h.loopState.get()).failure?.reason).toBe("unavailable");
    expect(await h.runner.stepRequest({ pathPattern: "/invoices" }, TAB)).toEqual({ kind: "none" }); // pages never run these
  });

  it("hands the previewed vars to the server and applies its report item by item", async () => {
    const executeRemote = vi.fn<RemoteExecutor>(async () => ({ status: "report", results: [{ index: 2, ok: true }, { index: 3, ok: false }] }));
    h = harness({ executeRemote });
    await started(h, { mode: "api", rows });
    await vi.waitFor(async () => expect((await h.loopState.get()).phase).toBe("failed"));
    expect(executeRemote.mock.calls[0]?.[0]).toMatchObject({ mode: "api", baseUrl: SITE_ORIGIN, items: rows });
    expect((await h.loopState.get()).items.map((i) => i.status)).toEqual(["done", "failed", "skipped"]);
  });

  it("tolerates a server without the routes", async () => {
    const fetch404 = vi.fn(async () => new Response("not found", { status: 404 }));
    const remote = createRemoteExecutor({ fetch: fetch404, getServerUrl: async () => "http://localhost:8787" });
    expect(await remote({ mode: "parallel", baseUrl: SITE_ORIGIN, program: PROGRAM, items: rows }, new AbortController().signal)).toEqual({ status: "unavailable" });
    expect(await fetchExecutors({ fetch: fetch404, getServerUrl: async () => "http://localhost:8787" })).toEqual([]);
    expect(await fetchExecutors({ getServerUrl: async () => null })).toEqual([]);
  });

  it("offers a server mode only when it is really available", async () => {
    const body = [
      { mode: "visible", available: false }, { mode: "parallel", available: true, simulated: true, reason: "No Browserbase key" },
      { mode: "api", available: true }, { mode: "warp", available: true },
    ];
    const fetchOk = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    expect(await fetchExecutors({ fetch: fetchOk, getServerUrl: async () => "http://localhost:8787" })).toEqual([
      { mode: "visible", available: true }, { mode: "parallel", available: false, reason: "No Browserbase key" }, { mode: "api", available: true },
    ]);
  });
});

describe("message routing", () => {
  const EXTENSION = "ghost-extension-id";

  function background(): { handle: ReturnType<typeof createLoopBackground>["handle"]; routed: unknown[] } {
    const routed: unknown[] = [];
    const router: TraceRouter = {
      services: { loopState: h.loopState } as TraceRouter["services"],
      handle: (message) => (routed.push(message), Promise.resolve("routed")),
      disable: async () => undefined,
    };
    return { handle: createLoopBackground({ router, runner: h.runner, extensionId: EXTENSION, executors: async () => [] }).handle, routed };
  }

  it("ignores other senders and other messages", () => {
    const { handle } = background();
    expect(handle({ type: "ghost:loop-cancel" }, { id: "someone-else", tab: { id: TAB } })).toBeNull();
    expect(handle({ type: "ghost:predict-form" }, { id: EXTENSION, tab: { id: TAB } })).toBeNull();
  });

  it("routes run messages to the runner and the rest to the trace router", async () => {
    const { handle, routed } = background();
    await h.loopState.dispatch({ type: "propose", proposal: PROPOSAL, tabId: TAB });
    const sender = { id: EXTENSION, tab: { id: TAB } };
    expect(await handle(startMessage(), sender)).toMatchObject({ phase: "running" });
    expect(await handle({ type: "ghost:loop-step-request", url: `${SITE_ORIGIN}/invoices`, pathPattern: "/invoices" }, sender)).toMatchObject({ kind: "step" });
    expect(await handle({ type: "ghost:loop-executors?" }, sender)).toEqual([]);
    expect(await handle({ type: "ghost:loop-state?" }, sender)).toBe("routed");
    expect(routed).toHaveLength(1);
  });

  it("tags what the run's own tab records during a run as Ghost's action", async () => {
    const { handle, routed } = background();
    const event = { t: 1, type: "navigate", origin: SITE_ORIGIN, pathPattern: "/sheet", url: `${SITE_ORIGIN}/sheet` };
    await handle({ type: "ghost:trace-event", event }, { id: EXTENSION, tab: { id: TAB } });
    await started(h, { mode: "visible" });
    await handle({ type: "ghost:trace-event", event }, { id: EXTENSION, tab: { id: TAB } });
    await handle({ type: "ghost:trace-event", event }, { id: EXTENSION, tab: { id: 99 } });
    expect(routed.map((m) => (m as { event: { synthetic?: boolean } }).event.synthetic)).toEqual([undefined, true, undefined]);
  });
});
