import { describe, expect, it } from "vitest";
import { detectLoop, synthesizeProgram } from "@ghost/shared";
import type { LoopProgram } from "@ghost/shared";
import { REPLY_LABEL, invoiceFactsByUrl, invoiceSession } from "../../shared/test/helpers/traceBuilder";
import type { LoopProposal } from "../src/lib/loopMessages";
import { createMemoryKv } from "../src/background/kvStorage";
import {
  IDLE_STATE, LOOP_STATE_KEY, createLoopStateStore, currentStep, defaultMode, irreversibleReport, isBusy, reduceLoop,
  reviveLoopState, toRunProgress, toUiState,
} from "../src/background/loopState";
import type { LoopAction, LoopState } from "../src/background/loopState";

function invoiceProgram(): LoopProgram {
  const tb = invoiceSession(2);
  const candidate = detectLoop(tb.events(), tb.now);
  const program = candidate ? synthesizeProgram(candidate, invoiceFactsByUrl(), { total: 50 }) : null;
  if (!program) throw new Error("expected the canonical program");
  return program;
}

function proposalOf(remaining: number[]): LoopProposal {
  return { program: invoiceProgram(), remaining, total: 50 };
}

function run(state: LoopState, ...actions: LoopAction[]): LoopState {
  return actions.reduce(reduceLoop, state);
}

const PROPOSE: LoopAction = { type: "propose", proposal: proposalOf([2, 3, 4]), tabId: 1 };
const CONFIRM: LoopAction = { type: "confirm", runId: "run-1", confirmIrreversible: true };

/** Every step of the current item, reported as done. */
function finishItem(state: LoopState): LoopState {
  const item = currentStep(state)?.item;
  let next = state;
  for (let step = currentStep(next); step && step.item === item; step = currentStep(next)) {
    next = reduceLoop(next, { type: "step-done", item: step.item, stepIndex: step.stepIndex });
  }
  return next;
}

describe("reduceLoop: the way to a run", () => {
  it("walks idle -> proposed -> previewing -> confirmed -> running -> done", () => {
    const proposed = reduceLoop(IDLE_STATE, PROPOSE);
    expect(proposed).toMatchObject({ phase: "proposed", tabId: 1, items: [] });
    const previewing = reduceLoop(proposed, { type: "preview" });
    expect(previewing.phase).toBe("previewing");
    const confirmed = reduceLoop(previewing, CONFIRM);
    expect(confirmed).toMatchObject({ phase: "confirmed", runId: "run-1", mode: "visible" });
    expect(confirmed.items).toEqual([2, 3, 4].map((index) => ({ index, status: "pending" })));
    const running = reduceLoop(confirmed, { type: "start" });
    expect(running).toMatchObject({ phase: "running", itemIndex: 0, stepIndex: 0 });
    expect(running.items[0]?.status).toBe("running");

    const afterOne = finishItem(running);
    expect(afterOne).toMatchObject({ phase: "running", itemIndex: 1, stepIndex: 0, irreversibleDone: 1 });
    expect(afterOne.items.map((i) => i.status)).toEqual(["done", "running", "pending"]);
    const done = finishItem(finishItem(afterOne));
    expect(done.phase).toBe("done");
    expect(done.items.every((i) => i.status === "done")).toBe(true);
    expect(done.irreversibleDone).toBe(3);
    expect(irreversibleReport(done)).toEqual([`${REPLY_LABEL} x 3`]);
    expect(currentStep(done)).toBeNull();
  });

  it("never runs without the confirmation, and never confirms irreversible steps without the explicit flag", () => {
    const proposed = reduceLoop(IDLE_STATE, PROPOSE);
    expect(reduceLoop(proposed, { type: "start" })).toBe(proposed);
    expect(reduceLoop(proposed, { type: "step-done", item: 2, stepIndex: 0 })).toBe(proposed);
    expect(reduceLoop(proposed, { ...CONFIRM, confirmIrreversible: false })).toBe(proposed);
    expect(reduceLoop(proposed, { ...CONFIRM, runId: "" })).toBe(proposed);
    expect(reduceLoop(IDLE_STATE, CONFIRM)).toBe(IDLE_STATE);
    expect(reduceLoop(IDLE_STATE, { type: "start" })).toBe(IDLE_STATE);

    const harmless = proposalOf([2]);
    harmless.program = { ...harmless.program, irreversible: [], steps: harmless.program.steps.filter((s) => s.op !== "click") };
    const state = run(IDLE_STATE, { type: "propose", proposal: harmless, tabId: 1 }, { ...CONFIRM, confirmIrreversible: false });
    expect(state.phase).toBe("confirmed");
  });

  it("runs only the checked rows, and only rows that were proposed", () => {
    const confirmed = run(IDLE_STATE, PROPOSE, { ...CONFIRM, items: [4, 2, 17], mode: "background" });
    expect(confirmed.items.map((i) => i.index)).toEqual([2, 4]);
    expect(confirmed.mode).toBe("background");
    const proposed = reduceLoop(IDLE_STATE, PROPOSE);
    expect(reduceLoop(proposed, { ...CONFIRM, items: [] })).toBe(proposed);
    expect(reduceLoop(proposed, { ...CONFIRM, items: [17] })).toBe(proposed);
  });

  it("defaults to background mode above 10 items", () => {
    expect(defaultMode(10)).toBe("visible");
    expect(defaultMode(11)).toBe("background");
    const many = Array.from({ length: 48 }, (_, i) => i + 2);
    expect(run(IDLE_STATE, { type: "propose", proposal: proposalOf(many), tabId: 1 }, CONFIRM).mode).toBe("background");
  });

  it("ignores an empty proposal and a proposal during a preview or a run", () => {
    expect(reduceLoop(IDLE_STATE, { type: "propose", proposal: proposalOf([]), tabId: 1 })).toBe(IDLE_STATE);
    const previewing = run(IDLE_STATE, PROPOSE, { type: "preview" });
    expect(reduceLoop(previewing, PROPOSE)).toBe(previewing);
    const running = run(IDLE_STATE, PROPOSE, CONFIRM, { type: "start" });
    expect(reduceLoop(running, PROPOSE)).toBe(running);
    const updated = run(IDLE_STATE, PROPOSE, { type: "propose", proposal: proposalOf([3, 4]), tabId: 2 });
    expect(updated).toMatchObject({ phase: "proposed", tabId: 2 });
    expect(updated.proposal?.remaining).toEqual([3, 4]);
  });
});

describe("reduceLoop: steps", () => {
  const running = run(IDLE_STATE, PROPOSE, CONFIRM, { type: "start" });

  it("advances only on the step it is waiting for", () => {
    expect(reduceLoop(running, { type: "step-done", item: 2, stepIndex: 1 })).toBe(running);
    expect(reduceLoop(running, { type: "step-done", item: 3, stepIndex: 0 })).toBe(running);
    const next = reduceLoop(running, { type: "step-done", item: 2, stepIndex: 0 });
    expect(next.stepIndex).toBe(1);
    expect(reduceLoop(next, { type: "step-done", item: 2, stepIndex: 0 })).toBe(next); // a duplicate report
  });

  it("collects extracted values per item and forgets them with the item", () => {
    const opened = reduceLoop(running, { type: "step-done", item: 2, stepIndex: 0 });
    const extracted = reduceLoop(opened, { type: "step-done", item: 2, stepIndex: 1, extracted: { var: "vendor", value: "Initech" } });
    expect(extracted.vars).toEqual({ vendor: "Initech" });
    expect(finishItem(extracted).vars).toEqual({});
  });

  it("counts an irreversible step only when it actually ran", () => {
    const program = invoiceProgram();
    const lockedAt = program.irreversible[0]?.stepIndex ?? -1;
    let state = running;
    for (let i = 0; i < lockedAt; i++) state = reduceLoop(state, { type: "step-done", item: 2, stepIndex: i });
    expect(state.irreversibleDone).toBe(0);
    expect(currentStep(state)?.step).toMatchObject({ op: "click", locked: true });
    state = reduceLoop(state, { type: "step-done", item: 2, stepIndex: lockedAt });
    expect(state.irreversibleDone).toBe(1);
    expect(state.irreversibleByStep).toEqual({ [String(lockedAt)]: 1 });
  });
});

describe("reduceLoop: failure and cancel", () => {
  const running = finishItem(run(IDLE_STATE, PROPOSE, CONFIRM, { type: "start" }));

  it("stops the whole run on the first failure and names the item", () => {
    const failed = reduceLoop(running, { type: "fail", item: 3, stepIndex: 0, reason: "target-missing" });
    expect(failed.phase).toBe("failed");
    expect(failed.failure).toEqual({ item: 3, stepIndex: 0, reason: "target-missing" });
    expect(failed.items).toEqual([
      { index: 2, status: "done" }, { index: 3, status: "failed", error: "target-missing" }, { index: 4, status: "skipped" },
    ]);
    expect(reduceLoop(failed, { type: "step-done", item: 3, stepIndex: 0 })).toBe(failed);
    expect(reduceLoop(failed, { type: "start" })).toBe(failed);
    expect(toRunProgress(failed)).toMatchObject({ state: "failed", failedItem: 3, done: 1, total: 3, irreversibleDone: 1 });
  });

  it("ignores a failure report for a step it is not waiting for, and clips the reason", () => {
    expect(reduceLoop(running, { type: "fail", item: 4, stepIndex: 0, reason: "x" })).toBe(running);
    const failed = reduceLoop(running, { type: "fail", item: 3, stepIndex: 0, reason: "r".repeat(500) });
    expect(failed.failure?.reason).toHaveLength(60);
  });

  it("cancels a confirmed or running run, and nothing else", () => {
    const cancelled = reduceLoop(running, { type: "cancel" });
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.items.map((i) => i.status)).toEqual(["done", "skipped", "skipped"]);
    expect(reduceLoop(cancelled, { type: "step-done", item: 3, stepIndex: 0 })).toBe(cancelled);
    expect(run(IDLE_STATE, PROPOSE, CONFIRM, { type: "cancel" }).phase).toBe("cancelled");
    const proposed = reduceLoop(IDLE_STATE, PROPOSE);
    expect(reduceLoop(proposed, { type: "cancel" })).toBe(proposed);
    expect(reduceLoop(IDLE_STATE, { type: "cancel" })).toBe(IDLE_STATE);
  });

  it("dismisses a proposal or a preview, never a run", () => {
    expect(run(IDLE_STATE, PROPOSE, { type: "dismiss" })).toBe(IDLE_STATE);
    expect(run(IDLE_STATE, PROPOSE, { type: "preview" }, { type: "dismiss" })).toBe(IDLE_STATE);
    expect(reduceLoop(running, { type: "dismiss" })).toBe(running);
  });

  it("can propose again after a finished run, and reset from anywhere", () => {
    const cancelled = reduceLoop(running, { type: "cancel" });
    expect(reduceLoop(cancelled, PROPOSE)).toMatchObject({ phase: "proposed", runId: null, irreversibleDone: 0 });
    expect(reduceLoop(running, { type: "reset" })).toBe(IDLE_STATE);
    expect(reduceLoop(IDLE_STATE, { type: "reset" })).toBe(IDLE_STATE);
  });
});

describe("loop ui state", () => {
  it("maps the phases onto what a tab shows", () => {
    const proposed = reduceLoop(IDLE_STATE, PROPOSE);
    const running = run(proposed, CONFIRM, { type: "start" });
    expect(toUiState(IDLE_STATE)).toEqual({ phase: "idle" });
    expect(toUiState(proposed)).toMatchObject({ phase: "proposed", proposal: { total: 50 } });
    expect(toUiState(reduceLoop(proposed, { type: "preview" })).phase).toBe("proposed");
    expect(toUiState(reduceLoop(proposed, CONFIRM))).toMatchObject({ phase: "running", run: { runId: "run-1", state: "running", done: 0, total: 3 } });
    expect(toUiState(running).phase).toBe("running");
    expect(toUiState(reduceLoop(running, { type: "cancel" }))).toMatchObject({ phase: "finished", run: { state: "cancelled" } });
    expect([IDLE_STATE, proposed, running].map(isBusy)).toEqual([false, false, true]);
  });
});

describe("loop state store", () => {
  it("persists every transition and resumes after a worker restart", async () => {
    const storage = createMemoryKv();
    const store = createLoopStateStore({ storage });
    expect(await store.get()).toEqual(IDLE_STATE);
    for (const action of [PROPOSE, CONFIRM, { type: "start" } as const, { type: "step-done", item: 2, stepIndex: 0 } as const]) {
      expect((await store.dispatch(action)).changed).toBe(true);
    }
    const resumed = createLoopStateStore({ storage });
    expect(await resumed.get()).toMatchObject({ phase: "running", runId: "run-1", itemIndex: 0, stepIndex: 1 });
    expect(currentStep(await resumed.get())).toMatchObject({ item: 2, stepIndex: 1 });
    expect(await resumed.dispatch({ type: "dismiss" })).toMatchObject({ changed: false });
  });

  it("applies concurrent dispatches one at a time", async () => {
    const store = createLoopStateStore({ storage: createMemoryKv() });
    await Promise.all([store.dispatch(PROPOSE), store.dispatch(CONFIRM), store.dispatch({ type: "start" })]);
    expect((await store.get()).phase).toBe("running");
  });

  it("removes the key when the state returns to idle", async () => {
    const storage = createMemoryKv();
    const store = createLoopStateStore({ storage });
    await store.dispatch(PROPOSE);
    expect(await storage.get(LOOP_STATE_KEY)).toBeDefined();
    await store.dispatch({ type: "dismiss" });
    expect(await storage.get(LOOP_STATE_KEY)).toBeUndefined();
  });

  it("reads a corrupt snapshot as idle", () => {
    const running = run(IDLE_STATE, PROPOSE, CONFIRM, { type: "start" });
    expect(reviveLoopState(JSON.parse(JSON.stringify(running)))).toEqual(running);
    for (const raw of [null, 7, {}, { phase: "running" }, { ...running, phase: "sprinting" }, { ...running, items: [{ index: "2" }] }, { ...running, proposal: { program: {} } }, { ...running, stepIndex: -1 }]) {
      expect(reviveLoopState(raw)).toBe(IDLE_STATE);
    }
    expect(reviveLoopState({ ...running, mode: "warp" }).mode).toBe("visible");
  });
});
