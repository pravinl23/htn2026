// Routes the trace and proposal messages of lib/loopMessages.ts to the trace store, the episodic memory, the
// loop watcher and the run state. The run messages (start, cancel, step request/result) belong to the executor:
// `handle` returns null for them so another handler can take over.
import { getSettings, onStorageChanged } from "../lib/storage";
import { isLoopMessage } from "../lib/loopMessages";
import type { LoopUiState } from "../lib/loopMessages";
import { createEpisodicMemory } from "./episodic";
import type { EpisodicMemory } from "./episodic";
import { createRemoteSynthesizer } from "./loopRemote";
import { createLoopStateStore, isBusy, toUiState } from "./loopState";
import type { LoopStateStore } from "./loopState";
import { createLoopWatcher } from "./loopWatcher";
import type { LoopWatcher } from "./loopWatcher";
import { createTraceStore } from "./traceStore";
import type { TraceSource, TraceStore } from "./traceStore";

/** How many earlier events describe "the state before this action" (stateSummary reads the last 3 after noise removal). */
const SUMMARY_WINDOW = 12;

export interface LoopServices {
  trace: TraceStore;
  memory: EpisodicMemory;
  loopState: LoopStateStore;
  watcher: LoopWatcher;
}

/** The parts of chrome.runtime.MessageSender the router reads. */
export interface LoopSender {
  id?: string;
  origin?: string;
  url?: string;
  tab?: { id?: number };
}

export interface TraceRouterDeps {
  services: LoopServices;
  extensionId: string;
  isEnabled?(): Promise<boolean>;
}

export interface TraceRouter {
  services: LoopServices;
  /** Null when the message is not one of: trace-event, page-facts, loop-state?, loop-dismiss. */
  handle(message: unknown, sender: LoopSender): Promise<unknown> | null;
  /** Ghost was switched off: forget the trace and any proposal. A run in progress is cancelled. */
  disable(): Promise<void>;
}

function sourceOf(sender: LoopSender): TraceSource | null {
  let origin = sender.origin;
  try {
    origin ??= sender.url ? new URL(sender.url).origin : undefined;
  } catch {
    return null;
  }
  return origin ? { tabId: sender.tab?.id, origin } : null;
}

export function createTraceRouter(deps: TraceRouterDeps): TraceRouter {
  const { trace, memory, loopState, watcher } = deps.services;
  const isEnabled = deps.isEnabled ?? (async () => (await getSettings()).enabled);
  let queue: Promise<unknown> = Promise.resolve();

  /** One event at a time, so "the events before it" is exact. */
  function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  async function record(rawEvent: unknown, source: TraceSource): Promise<boolean> {
    if (!(await isEnabled())) return false;
    const before = await trace.recent(SUMMARY_WINDOW);
    const event = await trace.append(rawEvent, source);
    if (!event) return false;
    await memory.observe(before, event);
    watcher.onEvent(event);
    return true;
  }

  async function facts(report: { url?: unknown; facts?: unknown }, source: TraceSource): Promise<boolean> {
    if (!(await isEnabled()) || !(await trace.setFacts(report, source))) return false;
    watcher.onFacts();
    return true;
  }

  async function dismiss(programId: unknown): Promise<LoopUiState> {
    if (typeof programId === "string") await watcher.dismiss(programId);
    const { state } = await loopState.dispatch({ type: "dismiss" });
    await trace.clear();
    return toUiState(state);
  }

  async function uiState(tabId: number | undefined): Promise<LoopUiState> {
    const state = await loopState.get();
    return state.tabId === tabId ? toUiState(state) : { phase: "idle" };
  }

  return {
    services: deps.services,
    handle(message, sender) {
      if (sender.id !== deps.extensionId || !isLoopMessage(message)) return null;
      const source = sourceOf(sender);
      if (message.type === "ghost:loop-state?") return uiState(sender.tab?.id);
      if (message.type === "ghost:loop-dismiss") return inOrder(() => dismiss(message.programId));
      if (message.type !== "ghost:trace-event" && message.type !== "ghost:page-facts") return null;
      if (!source) return Promise.resolve(false);
      return message.type === "ghost:trace-event" ? inOrder(() => record(message.event, source)) : inOrder(() => facts(message, source));
    },
    async disable() {
      watcher.cancel();
      await loopState.dispatch({ type: "cancel" });
      await loopState.dispatch({ type: "reset" });
      await trace.clear();
    },
  };
}

/** The production wiring. Call once, synchronously, at worker start (it registers a storage listener). */
export function startLoopBackground(): TraceRouter {
  const trace = createTraceStore();
  const loopState = createLoopStateStore();
  const watcher = createLoopWatcher({
    trace,
    synthesizeRemote: createRemoteSynthesizer(),
    isBusy: async () => isBusy(await loopState.get()),
    onProposal: (proposal, tabId) => loopState.dispatch({ type: "propose", proposal, tabId }),
    emit: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  });
  const router = createTraceRouter({ services: { trace, memory: createEpisodicMemory(), loopState, watcher }, extensionId: chrome.runtime.id });
  onStorageChanged((changes) => {
    if (changes.settings && !changes.settings.enabled) router.disable().catch((error: unknown) => console.warn("[ghost] loop reset failed", error));
  });
  return router;
}
