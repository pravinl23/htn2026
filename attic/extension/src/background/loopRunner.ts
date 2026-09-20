// The loop executor's background half (docs/loops.md 3.5). The worker owns the run: it hands out one step at a
// time, checks every outcome, stops the whole run on the first surprise and never lets an irreversible step run
// twice. Pages pull their work ("ghost:loop-step-request") so a run survives full page loads and a sleeping worker:
// everything the runner knows lives in chrome.storage.session (loopState plus the small record below).
//
// Locked steps have a commit point. The order for one is "armed" only when it answers a step request sent from
// the page the step runs on; the executor runs it only then. A second request for an armed step means its result
// was lost, and the step is NOT handed out again.
import type { LoopProgram, LoopStep } from "@ghost/shared";
import { LOOP_MODES, sanitizeStartRows } from "../lib/loopMessages";
import type {
  LoopMessageOf, LoopMode, LoopStartRow, LoopStepOrder, LoopStepOutcome, LoopStepReply, LoopUiState,
} from "../lib/loopMessages";
import { armsLockedStep, isLockedStep, isReservedVar, isValidReserved, stepPagePattern } from "../lib/loopRouting";
import { kvStorage } from "./kvStorage";
import type { KvStorage } from "./kvStorage";
import { currentStep, toRunProgress, toUiState } from "./loopState";
import type { LoopState, LoopStateStore } from "./loopState";

export const LOOP_RUN_KEY = "ghost.loop.run";
/** The same step handed out this often without a result means the pages are going in circles. */
export const MAX_DELIVERIES = 6;
const VALUE_MAX = 2000;
const VAR_MAX = 300;
const ERROR_CODE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export type ProgressMessage = LoopMessageOf<"ghost:loop-progress">;
export type StartMessage = LoopMessageOf<"ghost:loop-start">;

export interface RemoteExecuteJob {
  mode: "parallel" | "api";
  /** Origin of the site the loop was recorded on. */
  baseUrl: string;
  program: LoopProgram;
  /** One entry per checked item, with the vars the preview extracted. */
  items: LoopStartRow[];
}

export type RemoteExecuteResult =
  /** No server, no route, not authorized, or the mode has no key (a simulated report counts as unavailable: nothing ran). */
  | { status: "unavailable" }
  | { status: "report"; results: Array<{ index: number; ok: boolean }> };

/** POST /v1/loop/preview + /v1/loop/execute on the local server. Must resolve, never reject; `signal` cancels the run. */
export type RemoteExecutor = (job: RemoteExecuteJob, signal: AbortSignal) => Promise<RemoteExecuteResult>;

export interface LoopRunnerDeps {
  loopState: LoopStateStore;
  /** chrome.tabs.sendMessage. A tab that is loading has no listener: failures are swallowed, the page asks on load. */
  emit(tabId: number, message: ProgressMessage): Promise<unknown> | void;
  storage?: KvStorage;
  executeRemote?: RemoteExecutor;
  newRunId?(): string;
  /** The run reached done, failed or cancelled. */
  onFinished?(state: LoopState): Promise<unknown> | void;
}

export interface StepRequest {
  url?: unknown;
  pathPattern?: unknown;
}

export interface LoopRunner {
  /** "ghost:loop-start": only from the tab that was shown the proposal, only with confirmIrreversible === true. */
  start(message: StartMessage, tabId: number | undefined): Promise<LoopUiState>;
  /** Esc. After the run ended it closes the final report (back to idle). */
  cancel(tabId: number | undefined, runId?: unknown): Promise<LoopUiState>;
  stepRequest(request: StepRequest, tabId: number | undefined): Promise<LoopStepReply>;
  stepResult(rawOutcome: unknown, tabId: number | undefined): Promise<LoopStepReply>;
  tabClosed(tabId: number): Promise<void>;
  /** Worker start: a server-side run cannot be picked up again, so it is reported as interrupted. */
  recover(): Promise<void>;
}

/** What the runner remembers next to loopState. */
interface RunRecord {
  runId: string;
  confirmed: boolean;
  issued: { item: number; stepIndex: number; count: number } | null;
  armed: { item: number; stepIndex: number } | null;
  rows: LoopStartRow[];
}

const NONE: LoopStepReply = { kind: "none" };
const WAIT: LoopStepReply = { kind: "wait" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 100_000;
}

function isRemote(mode: LoopMode): mode is "parallel" | "api" {
  return mode === "parallel" || mode === "api";
}

function isTerminal(state: LoopState): boolean {
  return state.phase === "done" || state.phase === "failed" || state.phase === "cancelled";
}

/** Rebuilds an outcome from untrusted input. Error codes are short slugs, never page content. */
export function sanitizeOutcome(raw: unknown): LoopStepOutcome | null {
  if (!isObject(raw) || typeof raw.runId !== "string" || !isIndex(raw.item) || !isIndex(raw.stepIndex) || typeof raw.ok !== "boolean") return null;
  const outcome: LoopStepOutcome = { runId: raw.runId, item: raw.item, stepIndex: raw.stepIndex, ok: raw.ok };
  if (!raw.ok) outcome.error = typeof raw.error === "string" && ERROR_CODE.test(raw.error) ? raw.error : "failed";
  const extracted = raw.extracted;
  if (isObject(extracted) && typeof extracted.var === "string" && typeof extracted.value === "string" && extracted.var.length <= VAR_MAX) {
    const confidence = typeof extracted.confidence === "number" && Number.isFinite(extracted.confidence) ? extracted.confidence : 0;
    outcome.extracted = { var: extracted.var, value: extracted.value.slice(0, VALUE_MAX), confidence };
  }
  return outcome;
}

function reviveRecord(raw: unknown, runId: string | null): RunRecord | null {
  if (!isObject(raw) || typeof raw.runId !== "string" || raw.runId !== runId) return null;
  const pair = (value: unknown): { item: number; stepIndex: number } | null =>
    isObject(value) && isIndex(value.item) && isIndex(value.stepIndex) ? { item: value.item, stepIndex: value.stepIndex } : null;
  const issued = pair(raw.issued);
  const count = isObject(raw.issued) && isIndex(raw.issued.count) ? raw.issued.count : 1;
  return {
    runId: raw.runId, confirmed: raw.confirmed === true, issued: issued ? { ...issued, count } : null, armed: pair(raw.armed),
    rows: Array.isArray(raw.rows) ? (raw.rows as LoopStartRow[]) : [],
  };
}

/** The step as the page gets it: a step the program lists as irreversible is always delivered locked. */
function deliverable(step: LoopStep, listed: boolean): LoopStep {
  return listed && (step.op === "click" || step.op === "fill") && step.locked !== true ? { ...step, locked: true } : step;
}

function isListed(program: LoopProgram, stepIndex: number): boolean {
  return program.irreversible.some((effect) => effect.stepIndex === stepIndex);
}

function differsFromPreview(rows: readonly LoopStartRow[], item: number, got: { var: string; value: string }): boolean {
  const previewed = rows.find((row) => row.index === item)?.vars[got.var];
  return previewed !== undefined && previewed !== got.value;
}

function cleanItems(raw: unknown): number[] {
  return Array.isArray(raw) ? raw.filter(isIndex) : [];
}

export function createLoopRunner(deps: LoopRunnerDeps): LoopRunner {
  const { loopState } = deps;
  const storage = deps.storage ?? kvStorage("session");
  const newRunId = deps.newRunId ?? (() => globalThis.crypto?.randomUUID?.() ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  let queue: Promise<unknown> = Promise.resolve();
  let remoteAbort: AbortController | null = null;

  /** One message at a time: a cancel can never interleave with the result it races. */
  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  async function record(state: LoopState): Promise<RunRecord | null> {
    return reviveRecord(await storage.get(LOOP_RUN_KEY).catch(() => undefined), state.runId);
  }

  async function broadcast(state: LoopState): Promise<void> {
    const run = toRunProgress(state);
    if (!run || state.tabId === null) return;
    try {
      await deps.emit(state.tabId, { type: "ghost:loop-progress", run });
    } catch {
      // the tab is loading or gone: the page asks for the state when it is back
    }
  }

  async function finished(state: LoopState): Promise<void> {
    remoteAbort = null;
    await storage.remove(LOOP_RUN_KEY).catch(() => undefined);
    await broadcast(state);
    await Promise.resolve(deps.onFinished?.(state)).catch(() => undefined);
  }

  async function failRun(state: LoopState, reason: string): Promise<LoopStepReply> {
    const cur = currentStep(state);
    if (!cur) return NONE;
    const { state: after, changed } = await loopState.dispatch({ type: "fail", item: cur.item, stepIndex: cur.stepIndex, reason });
    if (changed) await finished(after);
    return NONE;
  }

  /** Hands the pending step to the page that asked. `fromPattern` is null on the chained path (reply to a result). */
  async function deliver(state: LoopState, rec: RunRecord, fromPattern: string | null): Promise<LoopStepReply> {
    const cur = currentStep(state);
    const program = state.proposal?.program;
    if (!cur || !program || state.runId === null) return NONE;
    const listed = isListed(program, cur.stepIndex);
    if (isLockedStep(cur.step) && !listed) return failRun(state, "locked-unlisted");
    const step = deliverable(cur.step, listed);
    if (isLockedStep(step) && !rec.confirmed) return failRun(state, "locked-unconfirmed");
    const same = rec.issued?.item === cur.item && rec.issued.stepIndex === cur.stepIndex;
    const count = same ? (rec.issued?.count ?? 0) + 1 : 1;
    if (count > MAX_DELIVERIES) return failRun(state, "step-stuck");
    const armed = armsLockedStep(step, program.iterator, fromPattern) ? { item: cur.item, stepIndex: cur.stepIndex } : null;
    await storage.set(LOOP_RUN_KEY, { ...rec, issued: { item: cur.item, stepIndex: cur.stepIndex, count }, armed });
    const order: LoopStepOrder = {
      runId: state.runId, mode: state.mode, item: cur.item, stepIndex: cur.stepIndex, step, iterator: program.iterator,
      vars: { ...state.vars }, confirmed: rec.confirmed,
    };
    return { kind: "step", order };
  }

  async function advance(state: LoopState, outcome: LoopStepOutcome | null, extracted?: { var: string; value: string }): Promise<LoopState> {
    const cur = currentStep(state);
    if (!cur) return state;
    const action = { type: "step-done" as const, item: outcome?.item ?? cur.item, stepIndex: outcome?.stepIndex ?? cur.stepIndex };
    const { state: after } = await loopState.dispatch(extracted ? { ...action, extracted } : action);
    const itemChanged = after.itemIndex !== state.itemIndex;
    if (isTerminal(after)) await finished(after);
    else if (itemChanged) await broadcast(after);
    return after;
  }

  /** The value a step hands back: the extract's own variable, or one of the executor's reserved variables. */
  function acceptedExtract(step: LoopStep, outcome: LoopStepOutcome, origin: string): { var: string; value: string } | "bad" | undefined {
    const got = outcome.extracted;
    if (step.op === "extract") return got && got.var === step.var && got.value.trim() !== "" ? { var: got.var, value: got.value } : "bad";
    if (!got || !isReservedVar(got.var)) return undefined;
    return isValidReserved(got.var, got.value, origin) ? { var: got.var, value: got.value } : "bad";
  }

  async function activeFor(tabId: number | undefined): Promise<{ state: LoopState; rec: RunRecord } | null> {
    const state = await loopState.get();
    if (state.phase !== "running" || tabId === undefined || state.tabId !== tabId || isRemote(state.mode)) return null;
    const rec = await record(state);
    return rec ? { state, rec } : null;
  }

  async function onRequest(request: StepRequest, tabId: number | undefined): Promise<LoopStepReply> {
    const active = await activeFor(tabId);
    const cur = active ? currentStep(active.state) : null;
    const program = active?.state.proposal?.program;
    if (!active || !cur || !program) return NONE;
    const fromPattern = typeof request.pathPattern === "string" ? request.pathPattern.slice(0, 600) : null;
    const { state, rec } = active;
    if (rec.armed?.item === cur.item && rec.armed.stepIndex === cur.stepIndex) {
      // Armed and asked for again: the result never arrived. In a visible run a page that moved on is the effect
      // of the step (a submit that navigated); anything else is unknown, and an irreversible step is never retried.
      const pattern = stepPagePattern(cur.step, program.iterator);
      const movedOn = state.mode === "visible" && pattern !== null && fromPattern !== null && fromPattern !== pattern;
      if (!movedOn) return failRun(state, "irreversible-unverified");
      const after = await advance(state, null);
      return after.phase === "running" ? deliver(after, { ...rec, issued: null, armed: null }, fromPattern) : NONE;
    }
    return deliver(state, rec, fromPattern);
  }

  async function onResult(rawOutcome: unknown, tabId: number | undefined): Promise<LoopStepReply> {
    const outcome = sanitizeOutcome(rawOutcome);
    const active = await activeFor(tabId);
    const cur = active ? currentStep(active.state) : null;
    const program = active?.state.proposal?.program;
    if (!outcome || !active || !cur || !program || outcome.runId !== active.state.runId) return NONE;
    if (outcome.item !== cur.item || outcome.stepIndex !== cur.stepIndex) return WAIT; // stale: the page asks again
    const { state, rec } = active;
    if (!outcome.ok) return failRun(state, outcome.error ?? "failed");
    const locked = isLockedStep(deliverable(cur.step, isListed(program, cur.stepIndex)));
    if (locked && !(rec.armed?.item === cur.item && rec.armed.stepIndex === cur.stepIndex)) return failRun(state, "locked-unarmed");
    const extracted = acceptedExtract(cur.step, outcome, program.iterator.origin);
    if (extracted === "bad") return failRun(state, cur.step.op === "extract" ? "extract-missing" : "bad-outcome");
    // The user confirmed the values the preview showed: a page that now says something else stops the run.
    if (extracted && cur.step.op === "extract" && differsFromPreview(rec.rows, cur.item, extracted)) return failRun(state, "value-changed");
    const after = await advance(state, outcome, extracted);
    return after.phase === "running" ? deliver(after, { ...rec, issued: null, armed: null }, null) : NONE;
  }

  // ---------- server-side modes ----------

  async function completeItem(state: LoopState): Promise<LoopState> {
    let next = state;
    const position = state.itemIndex;
    while (next.phase === "running" && next.itemIndex === position) {
      const stepBefore = next.stepIndex;
      next = await advance(next, null);
      if (next.phase === "running" && next.itemIndex === position && next.stepIndex === stepBefore) break; // refused: never spin
    }
    return next;
  }

  async function applyRemote(runId: string, result: RemoteExecuteResult): Promise<void> {
    let state = await loopState.get();
    if (state.phase !== "running" || state.runId !== runId) return;
    if (result.status === "unavailable") return void (await failRun(state, "unavailable"));
    const ok = new Set(result.results.filter((r) => r.ok).map((r) => r.index));
    while (state.phase === "running") {
      const item = state.items[state.itemIndex];
      if (!item || !ok.has(item.index)) return void (await failRun(state, "remote-failed"));
      state = await completeItem(state);
    }
  }

  function startRemote(state: LoopState, rec: RunRecord): void {
    const program = state.proposal?.program;
    const mode = state.mode;
    if (!program || !isRemote(mode) || state.runId === null) return;
    const runId = state.runId;
    const wanted = state.items.map((item) => rec.rows.find((row) => row.index === item.index));
    const items = wanted.filter((row): row is LoopStartRow => row !== undefined);
    const abort = (remoteAbort = new AbortController());
    const job: RemoteExecuteJob = { mode, baseUrl: program.iterator.origin, program, items };
    const run = !deps.executeRemote || items.length !== wanted.length
      ? Promise.resolve<RemoteExecuteResult>({ status: "unavailable" })
      : deps.executeRemote(job, abort.signal).catch((): RemoteExecuteResult => ({ status: "unavailable" }));
    void run.then((result) => inOrder(() => applyRemote(runId, result))).catch(() => undefined);
  }

  // ---------- start, cancel ----------

  async function onStart(message: StartMessage, tabId: number | undefined): Promise<LoopUiState> {
    const before = await loopState.get();
    const program = before.proposal?.program;
    const mode = LOOP_MODES.find((m) => m === message.mode);
    const allowed = tabId !== undefined && before.tabId === tabId && program?.id === message.programId && message.confirmIrreversible === true;
    if (!program || !mode || !allowed) return before.tabId === tabId ? toUiState(before) : { phase: "idle" };
    const runId = newRunId();
    const confirmed = await loopState.dispatch({ type: "confirm", runId, confirmIrreversible: true, mode, items: cleanItems(message.items) });
    if (!confirmed.changed) return toUiState(confirmed.state);
    const { state } = await loopState.dispatch({ type: "start" });
    const rec: RunRecord = { runId, confirmed: true, issued: null, armed: null, rows: sanitizeStartRows(message.rows, program.iterator.origin) };
    await storage.set(LOOP_RUN_KEY, rec);
    await broadcast(state);
    if (isRemote(state.mode)) startRemote(state, rec);
    return toUiState(state);
  }

  async function onCancel(tabId: number | undefined, runId: unknown): Promise<LoopUiState> {
    const before = await loopState.get();
    if (tabId === undefined || before.tabId !== tabId) return { phase: "idle" };
    if (typeof runId === "string" && before.runId !== null && runId !== before.runId) return toUiState(before);
    if (isTerminal(before)) return toUiState((await loopState.dispatch({ type: "reset" })).state);
    const { state, changed } = await loopState.dispatch({ type: "cancel" });
    if (changed) {
      remoteAbort?.abort();
      await finished(state);
    }
    return toUiState(state);
  }

  return {
    start: (message, tabId) => inOrder(() => onStart(message, tabId)),
    cancel: (tabId, runId) => inOrder(() => onCancel(tabId, runId)),
    stepRequest: (request, tabId) => inOrder(() => onRequest(request, tabId)),
    stepResult: (rawOutcome, tabId) => inOrder(() => onResult(rawOutcome, tabId)),
    tabClosed: (tabId) =>
      inOrder(async () => {
        const state = await loopState.get();
        if (state.tabId === tabId && (state.phase === "running" || state.phase === "confirmed")) await onCancel(tabId, undefined);
      }),
    recover: () =>
      inOrder(async () => {
        const state = await loopState.get();
        if (state.phase === "running" && isRemote(state.mode) && remoteAbort === null) await failRun(state, "interrupted");
      }),
  };
}
