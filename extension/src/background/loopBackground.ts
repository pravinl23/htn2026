// Background entry of the loop engine: the trace router (phase 1) plus the run messages, the server-side
// executors and the mode list. `registerLoopBackground()` is the one call background/index.ts makes; it adds its
// own onMessage listener, so the worker's existing router stays untouched (that one leaves loop messages alone).
import { isLoopMessage, LOOP_MODES } from "../lib/loopMessages";
import type { LoopExecutorOption, LoopMessageOf, LoopMode } from "../lib/loopMessages";
import { createLoopRunner } from "./loopRunner";
import type { LoopRunner, RemoteExecuteJob, RemoteExecuteResult, RemoteExecutor } from "./loopRunner";
import { normalizeServerUrl, serverBaseUrl } from "./serverClient";
import type { FetchLike } from "./serverClient";
import { startLoopBackground } from "./traceRouter";
import type { LoopSender, TraceRouter } from "./traceRouter";

export const EXECUTORS_TIMEOUT_MS = 1500;
const REASON_MAX = 160;

export interface ServerDeps {
  fetch?: FetchLike;
  getServerUrl?: () => Promise<string | null>;
  timeoutMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function baseUrl(deps: ServerDeps): Promise<string | null> {
  const configured = await (deps.getServerUrl ?? serverBaseUrl)().catch(() => null);
  return configured ? normalizeServerUrl(configured) : null;
}

async function requestJson(deps: ServerDeps, url: string, init: RequestInit): Promise<unknown> {
  try {
    const response = await (deps.fetch ?? fetch)(url, { ...init, credentials: "omit", cache: "no-store" });
    return response.ok ? ((await response.json()) as unknown) : null;
  } catch {
    return null;
  }
}

function cleanOption(raw: unknown): LoopExecutorOption | null {
  if (!isObject(raw)) return null;
  const mode = LOOP_MODES.find((m) => m === raw.mode);
  if (!mode) return null;
  // A mode that would only answer with a simulated report, or that this caller may not use, is not offered.
  const usable = raw.available === true && raw.simulated !== true && raw.authorized !== false;
  const option: LoopExecutorOption = { mode, available: usable };
  if (!usable && typeof raw.reason === "string") option.reason = raw.reason.slice(0, REASON_MAX);
  return option;
}

/** GET /v1/executors. An empty list (no server, old server) keeps the panel's defaults: visible and background only. */
export async function fetchExecutors(deps: ServerDeps = {}): Promise<LoopExecutorOption[]> {
  const base = await baseUrl(deps);
  if (!base) return [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? EXECUTORS_TIMEOUT_MS);
  const body = await requestJson(deps, `${base}/v1/executors`, { method: "GET", headers: { Accept: "application/json" }, signal: abort.signal });
  clearTimeout(timer);
  const options = Array.isArray(body) ? body.map(cleanOption).filter((o): o is LoopExecutorOption => o !== null) : [];
  // The in-extension modes never depend on the server.
  return options.map((o) => (o.mode === "visible" || o.mode === "background" ? { mode: o.mode, available: true } : o));
}

function cleanResults(raw: unknown): Array<{ index: number; ok: boolean }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => (isObject(r) && typeof r.index === "number" && Number.isInteger(r.index) ? [{ index: r.index, ok: r.ok === true }] : []));
}

/**
 * The server's two-step protocol (docs/server-api.md): preview binds a single-use ticket to exactly this job, execute
 * redeems it. The user already confirmed the batch in the panel; a simulated answer means nothing ran, so it is
 * reported as unavailable instead of as done.
 */
export function createRemoteExecutor(deps: ServerDeps = {}): RemoteExecutor {
  const post = (url: string, body: unknown, signal: AbortSignal): Promise<unknown> =>
    requestJson(deps, url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal });
  return async (job: RemoteExecuteJob, signal: AbortSignal): Promise<RemoteExecuteResult> => {
    const base = await baseUrl(deps);
    if (!base) return { status: "unavailable" };
    const preview = await post(`${base}/v1/loop/preview`, job, signal);
    if (!isObject(preview) || typeof preview.confirmToken !== "string" || preview.simulated === true) return { status: "unavailable" };
    const answer = await post(`${base}/v1/loop/execute`, { ...job, confirmToken: preview.confirmToken }, signal);
    const report = isObject(answer) ? answer.report : null;
    if (!isObject(report) || report.simulated === true) return { status: "unavailable" };
    return { status: "report", results: cleanResults(report.results) };
  };
}

export interface LoopBackground {
  router: TraceRouter;
  runner: LoopRunner;
  /** Null when the message is not a loop message from our own extension. */
  handle(message: unknown, sender: LoopSender): Promise<unknown> | null;
}

export interface LoopBackgroundDeps {
  router: TraceRouter;
  runner: LoopRunner;
  extensionId: string;
  executors?(): Promise<LoopExecutorOption[]>;
}

/** Routes every loop message: the run messages to the runner, the rest to the phase-1 trace router. */
export function createLoopBackground(deps: LoopBackgroundDeps): LoopBackground {
  const { router, runner } = deps;

  /**
   * A page that loads in the middle of a visible run records its arrival before it knows about the run. Whatever
   * the run's own tab reports while the run is going is Ghost's action: never counted as the user "doing it again".
   */
  async function ownAction(message: LoopMessageOf<"ghost:trace-event">, tabId: number | undefined): Promise<LoopMessageOf<"ghost:trace-event">> {
    const state = await router.services.loopState.get().catch(() => null);
    const running = state !== null && state.phase === "running" && tabId !== undefined && state.tabId === tabId;
    return running ? { ...message, event: { ...message.event, synthetic: true } } : message;
  }

  return {
    router,
    runner,
    handle(message, sender) {
      if (sender.id !== deps.extensionId || !isLoopMessage(message)) return null;
      const tabId = sender.tab?.id;
      if (message.type === "ghost:loop-start") return runner.start(message, tabId);
      if (message.type === "ghost:loop-cancel") return runner.cancel(tabId, message.runId);
      if (message.type === "ghost:loop-step-request") return runner.stepRequest(message, tabId);
      if (message.type === "ghost:loop-step-result") return runner.stepResult(message.outcome, tabId);
      if (message.type === "ghost:loop-executors?") return (deps.executors ?? fetchExecutors)();
      if (message.type === "ghost:trace-event") return ownAction(message, tabId).then((m) => router.handle(m, sender));
      return router.handle(message, sender);
    },
  };
}

export function availableModes(options: readonly LoopExecutorOption[]): LoopMode[] {
  return options.filter((o) => o.available).map((o) => o.mode);
}

/** Production wiring. Call once, synchronously, at worker start (MV3 listeners must be registered right away). */
export function registerLoopBackground(): LoopBackground {
  const router = startLoopBackground();
  const runner = createLoopRunner({
    loopState: router.services.loopState,
    emit: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
    executeRemote: createRemoteExecutor(),
    // The handled items are history now: the watcher must not propose the same loop from them again.
    onFinished: () => router.services.trace.clear(),
  });
  const background = createLoopBackground({ router, runner, extensionId: chrome.runtime.id });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const reply = background.handle(message, sender);
    if (!reply) return false;
    reply.then(sendResponse, () => sendResponse(null));
    return true; // keep the channel open for the async reply
  });
  chrome.tabs?.onRemoved?.addListener((tabId) => void runner.tabClosed(tabId).catch(() => undefined));
  void runner.recover().catch(() => undefined);
  return background;
}
