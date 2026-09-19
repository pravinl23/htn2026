import type { ServerLoopProgram } from "../loop/transforms";

/** Modes the server runs. "visible" and "background" run inside the extension (docs/loops.md 3.5). */
export type ExecutorMode = "parallel" | "api";

export interface ExecuteItem {
  /** Index of the item in the iterator's list. */
  index: number;
  /** The page the item opens into (what "open-item" navigates to). */
  url: string;
  /** Values the extension's dry run already extracted, keyed by the program's var names. */
  vars: Record<string, string>;
}

export interface ExecuteJob {
  /** Extract steps may carry any transform of the closed list /v1/loop/synthesize emits (loop/transforms.ts). */
  program: ServerLoopProgram;
  items: ExecuteItem[];
  /**
   * The ONE batch confirmation. Without it no locked step ever runs. Never read from a request body: the route sets it
   * only after it redeemed a single-use preview token bound to exactly this program and these items (executors/tickets.ts).
   */
  confirmIrreversible: boolean;
  /** Origin of the site the loop was recorded on. */
  baseUrl: string;
}

export interface ItemResult {
  index: number;
  ok: boolean;
  /** Names the step and the reason. Never contains a value. */
  error?: string;
  /** Steps (or API tool calls) completed for this item. */
  steps: number;
  /** True once the item reached a step that writes or clicks: it may be half done, and the server never runs it again for this program. */
  touched?: boolean;
}

/** Why a run ended before its last item. */
export type StopReason = "cancelled" | "disconnected" | "deadline";

export interface ExecuteReport {
  mode: ExecutorMode;
  results: ItemResult[];
  /** Epoch ms. */
  startedAt: number;
  finishedAt: number;
  /** True when no key is configured and nothing really ran. */
  simulated: boolean;
  /** Set when the run was stopped from outside (DELETE, client disconnect, job deadline). */
  stopped?: StopReason;
  /**
   * Parallel mode only. "verified": the first item's row was read back from a SECOND cloud browser before the rest ran.
   * "unverified": the program writes nothing the server knows how to read back (clicks only).
   */
  durability?: "verified" | "unverified";
}

export interface ExecuteProgress {
  index: number;
  ok: boolean;
  done: number;
  total: number;
}

export type ProgressFn = (progress: ExecuteProgress) => void;

export interface RunOptions {
  onProgress?: ProgressFn;
  /** Aborted by DELETE /v1/loop/execute/:runId, a client disconnect or the job deadline. After it fires no new item and no further step starts. */
  signal?: AbortSignal;
}

export interface LoopExecutor {
  readonly mode: ExecutorMode;
  readonly available: boolean;
  /** Why it is unavailable, phrased as what to add. */
  readonly reason?: string;
  /** Everything that can be refused without side effects (unreachable or private URLs, uncovered steps). Throws ExecutorRefusal. Runs at preview time and again inside run(). */
  check(job: ExecuteJob): Promise<void>;
  run(job: ExecuteJob, options?: RunOptions): Promise<ExecuteReport>;
}

/** The job itself cannot run in this mode (unreachable site, uncovered steps, missing confirmation). Maps to HTTP 400. */
export class ExecutorRefusal extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ExecutorRefusal";
  }
}

/** An upstream API failed. Carries a status at most: upstream bodies can echo keys, so they are never included. */
export class ExecutorUpstreamError extends Error {
  constructor(readonly service: "browserbase" | "composio", message: string, readonly status?: number) {
    super(`${service}: ${message}`);
    this.name = "ExecutorUpstreamError";
  }
}
