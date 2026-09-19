import type { ServerLoopProgram, ServerLoopStep } from "../loop/transforms";
import { ExecutorRefusal, type ExecuteJob, type ExecuteReport, type ExecutorMode, type ItemResult, type StopReason } from "./types";

export type FillStep = Extract<ServerLoopStep, { op: "fill" }>;
export type ClickStep = Extract<ServerLoopStep, { op: "click" }>;

export interface IrreversibleEffect {
  stepIndex: number;
  description: string;
}

/**
 * In a server-run batch EVERY click needs the batch confirmation. The server only sees a label: the strong lock signals
 * of shared/src/locks.ts (button type, form membership, data-ghost-lock) never reach it, so "Reply: received", "Save",
 * "Continue" or "Mark as paid" would otherwise depend on the client's `locked` flag alone. When in doubt, lock.
 * Opening the item is `open-item`, not a click, and stays free.
 */
export function isIrreversibleStep(step: ServerLoopStep): boolean {
  if (step.op === "click") return true;
  if (step.op === "fill") return step.locked === true;
  return false;
}

/** Steps that change something outside the browser session: fills and clicks. */
export function isEffectStep(step: ServerLoopStep): boolean {
  return step.op === "fill" || step.op === "click";
}

/** Union of what the program declares and what its steps imply, one entry per step. */
export function irreversibleEffects(program: ServerLoopProgram): IrreversibleEffect[] {
  const byStep = new Map<number, string>();
  for (const effect of program.irreversible) byStep.set(effect.stepIndex, effect.description);
  program.steps.forEach((step, stepIndex) => {
    if (!isIrreversibleStep(step) || byStep.has(stepIndex)) return;
    if (step.op === "click" || step.op === "fill") byStep.set(stepIndex, step.target.label);
  });
  return [...byStep.entries()].sort(([a], [b]) => a - b).map(([stepIndex, description]) => ({ stepIndex, description }));
}

/** The single batch confirmation (CLAUDE.md rule 2), enforced again inside every executor. */
export function assertConfirmed(job: ExecuteJob): void {
  const irreversible = irreversibleEffects(job.program);
  if (irreversible.length > 0 && !job.confirmIrreversible) {
    throw new ExecutorRefusal("the batch was not confirmed: the program has irreversible steps", { irreversible });
  }
}

/** Own properties only: a var called "constructor" must read as missing, never as Object.prototype.constructor. */
export function ownVar(vars: Record<string, string>, name: string): string | undefined {
  return Object.hasOwn(vars, name) ? vars[name] : undefined;
}

/** The value a fill writes. Undefined when the item carries no value for the step's var. */
export function fillValue(step: FillStep, vars: Record<string, string>): string | undefined {
  return "const" in step.value ? step.value.const : ownVar(vars, step.value.var);
}

export function stopReasonOf(signal: AbortSignal | undefined): StopReason | undefined {
  if (!signal?.aborted) return undefined;
  const reason: unknown = signal.reason;
  return reason === "disconnected" || reason === "deadline" ? reason : "cancelled";
}

const STOP_TEXT: Record<StopReason, string> = {
  cancelled: "the run was cancelled",
  disconnected: "the client went away",
  deadline: "the run hit its deadline",
};

export function stoppedMessage(reason: StopReason): string {
  return `stopped: ${STOP_TEXT[reason]}`;
}

export function report(mode: ExecutorMode, results: ItemResult[], startedAt: number, simulated: boolean, now: () => number, signal?: AbortSignal): ExecuteReport {
  const stopped = stopReasonOf(signal);
  return { mode, results, startedAt, finishedAt: now(), simulated, ...(stopped ? { stopped } : {}) };
}

export function skippedResult(index: number, failedIndex: number | undefined, signal?: AbortSignal): ItemResult {
  const stopped = stopReasonOf(signal);
  if (stopped && failedIndex === undefined) return { index, ok: false, steps: 0, error: `skipped: ${STOP_TEXT[stopped]}` };
  return { index, ok: false, steps: 0, error: `skipped: the run stopped${failedIndex === undefined ? "" : ` after item ${failedIndex} failed`}` };
}
