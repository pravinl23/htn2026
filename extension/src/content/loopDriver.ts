// The pull loop of a run (docs/loops.md 3.5): ask the worker for this tab's pending step, run it, report, take the
// next step from the reply. A fresh content script simply asks again, so a run survives full page loads; nothing
// about the run is kept here.
import { normalizeUrl } from "@ghost/shared";
import type { LoopMessage, LoopMode, LoopStepOrder, LoopStepOutcome, LoopStepReply } from "../lib/loopMessages";
import { armsLockedStep, isLockedStep } from "../lib/loopRouting";
import type { LoopExecutor, StepResult } from "./loopExecutor";
import { markSynthetic } from "./trace";

export interface LoopDriverDeps {
  /** chrome.runtime.sendMessage. A rejection (worker asleep, extension reloaded) ends the pump; the next kick retries. */
  send(message: LoopMessage): Promise<unknown>;
  /** The executor for a mode the pages of this tab can run; null for the server-side modes. */
  executorFor(mode: LoopMode): LoopExecutor | null;
  doc?: Document;
  /** The pump stopped: no run for this tab, the run moved on without us, or stop() was called. */
  onIdle?(): void;
}

export interface LoopDriver {
  /** Start pumping unless already doing so. Safe to call on every page load and every progress message. */
  kick(): void;
  /** Cancel or Esc: no further step starts. A step that is already running still reports. */
  stop(): void;
  readonly pumping: boolean;
}

const MAX_WAITS = 3;
const WAIT_MS = 150;
const NONE: LoopStepReply = { kind: "none" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Replies come from our own worker, but a missing listener answers undefined. */
function asReply(raw: unknown): LoopStepReply {
  if (!isObject(raw) || raw.kind === "none") return NONE;
  if (raw.kind === "wait") return { kind: "wait" };
  return raw.kind === "step" && isObject(raw.order) && isObject(raw.order.step) ? (raw as LoopStepReply) : NONE;
}

function outcomeOf(order: LoopStepOrder, result: StepResult): LoopStepOutcome {
  const outcome: LoopStepOutcome = { runId: order.runId, item: order.item, stepIndex: order.stepIndex, ok: result.ok };
  if (result.extracted) outcome.extracted = result.extracted;
  if (!result.ok) outcome.error = result.error ?? "failed";
  return outcome;
}

export function createLoopDriver(deps: LoopDriverDeps): LoopDriver {
  const doc = deps.doc ?? document;
  let pumping = false;
  let stopped = false;

  async function request(url: string, pathPattern: string): Promise<LoopStepReply> {
    return asReply(await deps.send({ type: "ghost:loop-step-request", url, pathPattern }));
  }

  async function report(order: LoopStepOrder, result: StepResult): Promise<LoopStepReply> {
    return asReply(await deps.send({ type: "ghost:loop-step-result", outcome: outcomeOf(order, result) }));
  }

  function ownPlace(): { url: string; pathPattern: string } | null {
    const here = normalizeUrl(doc.location.href);
    return here ? { url: here.url, pathPattern: here.pathPattern } : null;
  }

  async function pump(): Promise<void> {
    const here = ownPlace();
    if (!here) return;
    let reply = await request(here.url, here.pathPattern);
    /** The page the last step REQUEST was sent from; null when the step came chained in the reply to a result. */
    let askedFrom: string | null = here.pathPattern;
    let rearmed = "";
    let waits = 0;
    while (!stopped) {
      if (reply.kind === "wait" && waits++ < MAX_WAITS) {
        await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
        reply = await request(here.url, here.pathPattern);
        askedFrom = here.pathPattern;
        continue;
      }
      if (reply.kind !== "step") return;
      const order = reply.order;
      const executor = deps.executorFor(order.mode);
      if (!executor) return;
      if (order.mode === "visible") markSynthetic(2000); // the whole visible run is Ghost's own activity
      const armed = armsLockedStep(order.step, order.iterator, askedFrom);
      const key = `${order.item}:${order.stepIndex}`;
      if (isLockedStep(order.step) && !armed && rearmed !== key) {
        // The commit point of a locked step: bring its page up, then ask again FROM that page. Once per step.
        rearmed = key;
        const ready = await executor.prepare(order);
        if (stopped) return;
        reply = ready.ok ? await request(ready.url, ready.pathPattern) : await report(order, { ok: false, error: ready.error });
        askedFrom = ready.ok ? ready.pathPattern : null;
        continue;
      }
      const result = await executor.run(order, armed);
      reply = await report(order, result);
      askedFrom = null;
      waits = 0;
      if (result.ok && !stopped) result.afterReport?.();
    }
  }

  return {
    get pumping() {
      return pumping;
    },
    kick() {
      if (pumping) return;
      pumping = true;
      stopped = false;
      void pump()
        .catch(() => undefined)
        .finally(() => {
          pumping = false;
          deps.onIdle?.();
        });
    },
    stop() {
      stopped = true;
    },
  };
}
