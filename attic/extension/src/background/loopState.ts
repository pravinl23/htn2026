// The loop run state machine (docs/loops.md 3.5). The background worker owns it and keeps it in
// chrome.storage.session, so a run survives page loads and the worker going to sleep.
//   idle -> proposed -> previewing -> confirmed -> running(itemIndex, stepIndex) -> done | failed | cancelled
// `running` is only reachable through `confirm`, and a program whose safety class demands an explicit
// confirmation (shared/src/loop/safety.ts) is only confirmed with confirmIrreversible: true — the single batch
// confirmation. The class is derived here from the program itself, so no content script can talk it down.
// The reducer is pure.
import { classifyStep, requiredConfirmation } from "@ghost/shared";
import type { LoopProgram, LoopStep } from "@ghost/shared";
import { LOOP_MODES } from "../lib/loopMessages";
import type { LoopItemProgress, LoopMode, LoopProposal, LoopRunProgress, LoopUiState } from "../lib/loopMessages";
import { kvStorage } from "./kvStorage";
import type { KvStorage } from "./kvStorage";

export const LOOP_STATE_KEY = "ghost.loop.state";
/** docs/loops.md 3.5: more items than this run in hidden iframes by default. */
export const BACKGROUND_MODE_ABOVE = 10;
const REASON_MAX = 60;

export type LoopPhase = "idle" | "proposed" | "previewing" | "confirmed" | "running" | "done" | "failed" | "cancelled";

export interface LoopFailure {
  /** Index of the item in the iterator's list. */
  item: number;
  stepIndex: number;
  /** Short code, never page content. */
  reason: string;
}

export interface LoopState {
  phase: LoopPhase;
  proposal: LoopProposal | null;
  /** The tab that owns the list page. */
  tabId: number | null;
  runId: string | null;
  mode: LoopMode;
  /** The items of the run, in order. Empty until confirmed. */
  items: LoopItemProgress[];
  /** Position in `items` (not the list index) and the step of the program that runs next. */
  itemIndex: number;
  stepIndex: number;
  /** Values extracted so far for the current item, by variable name. */
  vars: Record<string, string>;
  irreversibleDone: number;
  /** Irreversible steps that actually ran, by step index, for the final report. */
  irreversibleByStep: Record<string, number>;
  failure?: LoopFailure;
}

export type LoopAction =
  | { type: "propose"; proposal: LoopProposal; tabId: number }
  | { type: "preview" }
  /** `items` are list indexes (the checked rows); left out, every remaining item runs. */
  | { type: "confirm"; runId: string; confirmIrreversible: boolean; mode?: LoopMode; items?: readonly number[] }
  | { type: "start" }
  /** The step at (item, stepIndex) ran and was verified. Ignored unless it is the step the run is waiting for. */
  | { type: "step-done"; item: number; stepIndex: number; extracted?: { var: string; value: string } }
  | { type: "fail"; item: number; stepIndex: number; reason: string }
  | { type: "cancel" }
  | { type: "dismiss" }
  | { type: "reset" };

export const IDLE_STATE: LoopState = Object.freeze({
  phase: "idle", proposal: null, tabId: null, runId: null, mode: "visible", items: [], itemIndex: 0, stepIndex: 0,
  vars: {}, irreversibleDone: 0, irreversibleByStep: {},
}) as LoopState;

const PROPOSABLE: ReadonlySet<LoopPhase> = new Set(["idle", "proposed", "done", "failed", "cancelled"]);

export function defaultMode(itemCount: number): LoopMode {
  return itemCount > BACKGROUND_MODE_ABOVE ? "background" : "visible";
}

/** High-impact by the shared classifier: the recorder's lock, the program's own list, or an irreversible label. */
function isIrreversible(program: LoopProgram, stepIndex: number): boolean {
  const step: LoopStep | undefined = program.steps[stepIndex];
  if (!step) return false;
  return classifyStep(step, program.irreversible.some((effect) => effect.stepIndex === stepIndex)) === "high-impact";
}

function propose(state: LoopState, action: Extract<LoopAction, { type: "propose" }>): LoopState {
  if (!PROPOSABLE.has(state.phase) || action.proposal.remaining.length === 0) return state;
  return { ...IDLE_STATE, phase: "proposed", proposal: action.proposal, tabId: action.tabId };
}

function confirm(state: LoopState, action: Extract<LoopAction, { type: "confirm" }>): LoopState {
  const proposal = state.proposal;
  if (!proposal || (state.phase !== "proposed" && state.phase !== "previewing") || action.runId === "") return state;
  // A high-impact batch (a locked step, a listed effect, or a step whose own label reads irreversible) can only
  // be confirmed with the explicit flag the sheet sets from an Enter or a click. Never downgradable.
  if (requiredConfirmation(proposal.program) === "explicit" && action.confirmIrreversible !== true) return state;
  const wanted = action.items ? new Set(action.items) : null;
  const indexes = proposal.remaining.filter((index) => !wanted || wanted.has(index));
  if (indexes.length === 0) return state;
  const items = indexes.map((index): LoopItemProgress => ({ index, status: "pending" }));
  return { ...state, phase: "confirmed", runId: action.runId, mode: action.mode ?? defaultMode(items.length), items };
}

function withItem(state: LoopState, position: number, patch: Partial<LoopItemProgress>): LoopItemProgress[] {
  return state.items.map((item, i) => (i === position ? { ...item, ...patch } : item));
}

function start(state: LoopState): LoopState {
  if (state.phase !== "confirmed") return state;
  return { ...state, phase: "running", itemIndex: 0, stepIndex: 0, vars: {}, items: withItem(state, 0, { status: "running" }) };
}

function isCurrent(state: LoopState, item: number, stepIndex: number): boolean {
  return state.phase === "running" && state.items[state.itemIndex]?.index === item && state.stepIndex === stepIndex;
}

function countIrreversible(state: LoopState, program: LoopProgram, stepIndex: number): Pick<LoopState, "irreversibleDone" | "irreversibleByStep"> {
  if (!isIrreversible(program, stepIndex)) return { irreversibleDone: state.irreversibleDone, irreversibleByStep: state.irreversibleByStep };
  const key = String(stepIndex);
  const byStep = { ...state.irreversibleByStep, [key]: (state.irreversibleByStep[key] ?? 0) + 1 };
  return { irreversibleDone: state.irreversibleDone + 1, irreversibleByStep: byStep };
}

function stepDone(state: LoopState, action: Extract<LoopAction, { type: "step-done" }>): LoopState {
  const program = state.proposal?.program;
  if (!program || !isCurrent(state, action.item, action.stepIndex)) return state;
  const counted = { ...state, ...countIrreversible(state, program, action.stepIndex) };
  const vars = action.extracted ? { ...state.vars, [action.extracted.var]: action.extracted.value } : state.vars;
  if (action.stepIndex + 1 < program.steps.length) return { ...counted, vars, stepIndex: action.stepIndex + 1 };
  const finished = { ...counted, vars: {}, stepIndex: 0, items: withItem(state, state.itemIndex, { status: "done" }) };
  const next = state.itemIndex + 1;
  if (next >= state.items.length) return { ...finished, phase: "done" };
  return { ...finished, itemIndex: next, items: withItem(finished, next, { status: "running" }) };
}

/** Everything that did not finish is skipped: the run never goes on after a surprise. */
function stopItems(state: LoopState, current: Partial<LoopItemProgress>): LoopItemProgress[] {
  return state.items.map((item, i) => {
    if (i === state.itemIndex && item.status === "running") return { ...item, ...current };
    return item.status === "pending" ? { ...item, status: "skipped" } : item;
  });
}

function fail(state: LoopState, action: Extract<LoopAction, { type: "fail" }>): LoopState {
  if (!isCurrent(state, action.item, action.stepIndex)) return state;
  const reason = action.reason.slice(0, REASON_MAX) || "failed";
  return {
    ...state, phase: "failed", vars: {}, items: stopItems(state, { status: "failed", error: reason }),
    failure: { item: action.item, stepIndex: action.stepIndex, reason },
  };
}

function cancel(state: LoopState): LoopState {
  if (state.phase !== "confirmed" && state.phase !== "running") return state;
  return { ...state, phase: "cancelled", vars: {}, items: stopItems(state, { status: "skipped", error: "cancelled" }) };
}

/** Pure. An action that is not allowed in the current phase returns the SAME state object. */
export function reduceLoop(state: LoopState, action: LoopAction): LoopState {
  switch (action.type) {
    case "propose": return propose(state, action);
    case "preview": return state.phase === "proposed" ? { ...state, phase: "previewing" } : state;
    case "confirm": return confirm(state, action);
    case "start": return start(state);
    case "step-done": return stepDone(state, action);
    case "fail": return fail(state, action);
    case "cancel": return cancel(state);
    case "dismiss": return state.phase === "proposed" || state.phase === "previewing" ? IDLE_STATE : state;
    case "reset": return state.phase === "idle" ? state : IDLE_STATE;
  }
}

/** The step the run is waiting for, or null when nothing is running. */
export function currentStep(state: LoopState): { item: number; stepIndex: number; step: LoopStep } | null {
  const item = state.items[state.itemIndex];
  const step = state.proposal?.program.steps[state.stepIndex];
  return state.phase === "running" && item && step ? { item: item.index, stepIndex: state.stepIndex, step } : null;
}

export function isBusy(state: LoopState): boolean {
  return state.phase === "previewing" || state.phase === "confirmed" || state.phase === "running";
}

export function toRunProgress(state: LoopState): LoopRunProgress | null {
  if (!state.proposal || state.runId === null || state.items.length === 0) return null;
  const terminal = state.phase === "done" || state.phase === "failed" || state.phase === "cancelled";
  const run: LoopRunProgress = {
    runId: state.runId, programId: state.proposal.program.id, mode: state.mode,
    state: terminal ? (state.phase as "done" | "failed" | "cancelled") : "running",
    items: state.items.map((item) => ({ ...item })),
    done: state.items.filter((item) => item.status === "done").length,
    total: state.items.length,
    irreversibleDone: state.irreversibleDone,
  };
  if (state.failure) run.failedItem = state.failure.item;
  return run;
}

/** The reply to "ghost:loop-state?". */
export function toUiState(state: LoopState): LoopUiState {
  if ((state.phase === "proposed" || state.phase === "previewing") && state.proposal) return { phase: "proposed", proposal: state.proposal };
  const run = toRunProgress(state);
  if (!run || !state.proposal) return { phase: "idle" };
  // The proposal rides along so a page that loaded mid-run (visible mode) can rebuild the sheet.
  return run.state === "running" ? { phase: "running", run, proposal: state.proposal } : { phase: "finished", run, proposal: state.proposal };
}

/** One line per irreversible effect that actually ran, e.g. "Reply: received x 48". */
export function irreversibleReport(state: LoopState): string[] {
  const effects = state.proposal?.program.irreversible ?? [];
  return effects
    .map((effect) => ({ effect, count: state.irreversibleByStep[String(effect.stepIndex)] ?? 0 }))
    .filter(({ count }) => count > 0)
    .map(({ effect, count }) => `${effect.description} x ${count}`);
}

// ---------- persistence ----------

const PHASES: ReadonlySet<string> = new Set<LoopPhase>(["idle", "proposed", "previewing", "confirmed", "running", "done", "failed", "cancelled"]);
const ITEM_STATUSES: ReadonlySet<string> = new Set<LoopItemProgress["status"]>(["pending", "running", "done", "failed", "skipped"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isProposal(raw: unknown): raw is LoopProposal {
  if (!isObject(raw) || !isObject(raw.program) || !Array.isArray(raw.remaining) || !isCount(raw.total)) return false;
  const program = raw.program;
  return typeof program.id === "string" && Array.isArray(program.steps) && Array.isArray(program.irreversible) && isObject(program.iterator)
    && raw.remaining.every(isCount);
}

function isItem(raw: unknown): raw is LoopItemProgress {
  return isObject(raw) && isCount(raw.index) && typeof raw.status === "string" && ITEM_STATUSES.has(raw.status);
}

function stringRecord<T>(raw: unknown, keep: (value: unknown) => value is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (isObject(raw)) for (const [key, value] of Object.entries(raw)) if (keep(value)) out[key] = value;
  return out;
}

/** Anything that does not read back as a coherent state is idle: a run never resumes from a corrupt snapshot. */
export function reviveLoopState(raw: unknown): LoopState {
  if (!isObject(raw) || typeof raw.phase !== "string" || !PHASES.has(raw.phase) || raw.phase === "idle") return IDLE_STATE;
  if (!isProposal(raw.proposal) || !isCount(raw.tabId) || !Array.isArray(raw.items) || !raw.items.every(isItem)) return IDLE_STATE;
  if (!isCount(raw.itemIndex) || !isCount(raw.stepIndex) || !isCount(raw.irreversibleDone)) return IDLE_STATE;
  const state: LoopState = {
    phase: raw.phase as LoopPhase, proposal: raw.proposal, tabId: raw.tabId,
    runId: typeof raw.runId === "string" ? raw.runId : null,
    mode: LOOP_MODES.find((mode) => mode === raw.mode) ?? "visible",
    items: raw.items, itemIndex: raw.itemIndex, stepIndex: raw.stepIndex,
    vars: stringRecord(raw.vars, (v): v is string => typeof v === "string"),
    irreversibleDone: raw.irreversibleDone,
    irreversibleByStep: stringRecord(raw.irreversibleByStep, isCount),
  };
  const failure = raw.failure;
  if (isObject(failure) && isCount(failure.item) && isCount(failure.stepIndex) && typeof failure.reason === "string") {
    state.failure = { item: failure.item, stepIndex: failure.stepIndex, reason: failure.reason.slice(0, REASON_MAX) };
  }
  return state;
}

export interface LoopStateStore {
  get(): Promise<LoopState>;
  /** Read, reduce, write, one action at a time. `changed` is false when the action was not allowed. */
  dispatch(action: LoopAction): Promise<{ state: LoopState; changed: boolean }>;
}

export function createLoopStateStore(deps: { storage?: KvStorage } = {}): LoopStateStore {
  const storage = deps.storage ?? kvStorage("session");
  let queue: Promise<unknown> = Promise.resolve();
  const get = async (): Promise<LoopState> => reviveLoopState(await storage.get(LOOP_STATE_KEY).catch(() => undefined));

  async function apply(action: LoopAction): Promise<{ state: LoopState; changed: boolean }> {
    const before = await get();
    const state = reduceLoop(before, action);
    if (state === before) return { state, changed: false };
    if (state.phase === "idle") await storage.remove(LOOP_STATE_KEY);
    else await storage.set(LOOP_STATE_KEY, state);
    return { state, changed: true };
  }

  return {
    get,
    dispatch(action) {
      const run = queue.then(() => apply(action), () => apply(action));
      queue = run;
      return run;
    },
  };
}
