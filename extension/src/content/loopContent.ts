// Content-side entry of the loop engine (docs/loops.md 3.4 and 3.5): proposal -> preview sheet -> the ONE batch
// confirmation -> "ghost:loop-start" -> steps pulled from the worker -> progress and the final report in the sheet.
// The recorder and the page facts are started by trace.ts (syncLoopCapture); this module is everything after a
// loop was detected. A fresh content script asks "ghost:loop-state?" first, so a sheet or a run survives page loads.
import type { Ghost, LoopProgram } from "@ghost/shared";
import { normalizeUrl } from "@ghost/shared";
import { isLoopMessage } from "../lib/loopMessages";
import type { LoopExecutorOption, LoopMessage, LoopMode, LoopProposal, LoopRunProgress, LoopStartRow, LoopUiState } from "../lib/loopMessages";
import { onStorageChanged } from "../lib/storage";
import { itemUrlFromElement, previewItems, resolveItemUrls } from "./dryRun";
import type { DryRunOptions, DryRunRow, FramePool } from "./dryRun";
import { watchForOrphan } from "./lifecycle";
import { itemKeyOf, listItems } from "./listContext";
import { createLoopDriver } from "./loopDriver";
import type { LoopDriver } from "./loopDriver";
import { createLoopExecutor } from "./loopExecutor";
import type { ExecutorOptions, LoopExecutor } from "./loopExecutor";
import { LoopPanel } from "./loopPanel";
import type { LoopModeOption, LoopPanelDeps, LoopRunRequest } from "./loopPanel";
import { createFrameSurface, createVisibleSurface } from "./loopSurface";
import type { FrameSurface } from "./loopSurface";
import type { OverlayState } from "./overlay";
import { resolveLocator } from "./pageFacts";

/** About 120 ms per step (docs/loops.md 3.5): long enough to see the cursor land, short enough to stay fast. */
export const STEP_GLIDE_MS = 120;
const EXECUTORS_WAIT_MS = 400;
const LIST_POLL_MS = 500;

export interface LoopContentDeps {
  /** The Tab-walk overlay: in visible mode the ghost cursor glides onto each target through it. */
  overlay?: { render(state: OverlayState): void };
  /** Ghost's on/off switch. Nothing is shown or run while it is off. */
  isEnabled?(): boolean;
  /** Stops the Tab-walk controller's ghosts while the sheet is open, so one Tab press never serves two masters. */
  pauseGhosts?(paused: boolean): void;
  doc?: Document;
  /** Test seams. Defaults: chrome.runtime messaging, a real LoopPanel, real hidden iframes, event.isTrusted. */
  send?(message: LoopMessage): Promise<unknown>;
  listen?(handler: (message: unknown) => void): () => void;
  panel?: LoopPanel;
  frames?(): FramePool;
  isUserEvent?(event: Event): boolean;
  executor?: ExecutorOptions;
  preview?: Partial<DryRunOptions>;
  glideMs?: number;
}

export interface LoopContentHandle {
  /** Ask the worker what this tab should show and do right now. Resolves once it is applied. */
  sync(): Promise<void>;
  /** Removes the sheet, the frames and the listeners. A run in progress stays the worker's; another page can pick it up. */
  stop(): void;
  readonly panel: LoopPanel;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function runtimeSend(message: LoopMessage): Promise<unknown> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return Promise.resolve(undefined);
  return chrome.runtime.sendMessage(message);
}

/** Only our own worker may drive the sheet: a message from any other sender is ignored. */
function runtimeListen(handler: (message: unknown) => void): () => void {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return () => undefined;
  const listener = (message: unknown, sender: chrome.runtime.MessageSender): void => {
    if (sender.id === chrome.runtime.id && sender.tab === undefined) handler(message);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

function isTopFrame(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function asUiState(raw: unknown): LoopUiState {
  if (!isObject(raw) || typeof raw.phase !== "string") return { phase: "idle" };
  if (raw.phase === "proposed" && isProposal(raw.proposal)) return { phase: "proposed", proposal: raw.proposal };
  if ((raw.phase === "running" || raw.phase === "finished") && isRun(raw.run)) return raw as LoopUiState;
  return { phase: "idle" };
}

function isProposal(raw: unknown): raw is LoopProposal {
  return isObject(raw) && isObject(raw.program) && isObject(raw.program.iterator) && Array.isArray(raw.program.steps) && Array.isArray(raw.remaining);
}

function isRun(raw: unknown): raw is LoopRunProgress {
  return isObject(raw) && typeof raw.runId === "string" && typeof raw.state === "string" && Array.isArray(raw.items);
}

function asModes(raw: unknown): LoopModeOption[] {
  if (!Array.isArray(raw)) return [];
  return (raw as LoopExecutorOption[]).filter((o) => isObject(o) && typeof o.mode === "string" && typeof o.available === "boolean");
}

function startRows(rows: readonly DryRunRow[]): LoopStartRow[] {
  return rows.filter((row) => row.url !== "").map((row) => ({ index: row.index, url: normalizeUrl(row.url)?.url ?? row.url, vars: { ...row.vars } }));
}

function proposalKey(proposal: LoopProposal): string {
  return `${proposal.program.id}|${proposal.remaining.join(",")}`;
}

export function startLoopContent(deps: LoopContentDeps = {}): LoopContentHandle {
  const doc = deps.doc ?? document;
  const send = deps.send ?? runtimeSend;
  const isEnabled = deps.isEnabled ?? (() => true);
  const panel = deps.panel ?? new LoopPanel(doc);
  const glideMs = deps.glideMs ?? STEP_GLIDE_MS;
  const executors = new Map<LoopMode, LoopExecutor>();
  let frames: FrameSurface | null = null;
  let shownKey = "";
  let shownProgram: LoopProgram | null = null;
  let runId: string | null = null;
  let pending: LoopProposal | null = null;
  let listTimer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  let alive = isTopFrame(); // frames (and the hidden preview frames) never get a sheet of their own

  const ask = (message: LoopMessage): Promise<unknown> => send(message).catch(() => undefined);

  function pause(next: boolean): void {
    if (paused === next) return;
    paused = next;
    deps.pauseGhosts?.(next);
  }

  // ---------- the ghost cursor (visible mode) ----------

  async function showTarget(el: HTMLElement, locked: boolean): Promise<void> {
    if (!deps.overlay || glideMs <= 0) return;
    const ghost: Ghost = { signature: "ghost-loop-step", action: "click", displayText: "", confidence: 1, locked, source: "loop" };
    el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    deps.overlay.render({ ghosts: [{ ghost, el, status: "current" }] });
    await new Promise((resolve) => setTimeout(resolve, glideMs));
  }

  function clearCursor(): void {
    if (deps.overlay && shownProgram) deps.overlay.render({ ghosts: [] });
  }

  // ---------- executors ----------

  function executorFor(mode: LoopMode): LoopExecutor | null {
    if (mode !== "visible" && mode !== "background") return null; // parallel and api run on the server
    const known = executors.get(mode);
    if (known) return known;
    if (mode === "background") frames = createFrameSurface({ doc, frames: deps.frames?.() });
    const surface = mode === "background" && frames ? frames : createVisibleSurface({ doc, showTarget });
    const executor = createLoopExecutor(surface, deps.executor);
    executors.set(mode, executor);
    return executor;
  }

  function releaseExecutors(): void {
    frames?.dispose();
    frames = null;
    executors.clear();
  }

  const driver: LoopDriver = createLoopDriver({ send, executorFor, doc });

  // ---------- the sheet ----------

  const panelDeps: LoopPanelDeps = {
    onConfirm: (run) => void confirm(run),
    onDismiss: () => {
      const programId = shownProgram?.id;
      closed();
      if (programId) void ask({ type: "ghost:loop-dismiss", programId });
    },
    onCancel: () => {
      driver.stop();
      void ask(runId ? { type: "ghost:loop-cancel", runId } : { type: "ghost:loop-cancel" }).then((reply) => apply(asUiState(reply)));
    },
    onClose: () => {
      closed();
      void ask({ type: "ghost:loop-cancel" }); // after a run ended this only closes the worker's final report
    },
    ...(deps.isUserEvent ? { isUserEvent: deps.isUserEvent } : {}),
  };

  function closed(): void {
    shownKey = "";
    shownProgram = null;
    runId = null;
    stopListPoll();
    releaseExecutors();
    pause(false);
  }

  /** Sent ONLY from the sheet's confirm control (an explicit Enter or click): the single batch confirmation. */
  async function confirm(run: LoopRunRequest): Promise<void> {
    if (!shownProgram) return;
    const reply = await ask({
      type: "ghost:loop-start", programId: shownProgram.id, mode: run.mode, items: run.items, confirmIrreversible: true, rows: startRows(run.rows),
    });
    const state = asUiState(reply);
    if (state.phase === "running" || state.phase === "finished") return apply(state);
    // The worker refused (the proposal is gone, another tab owns it): say so instead of showing a run that is not happening.
    panel.update({ state: "failed", items: run.items.map((index) => ({ index, status: "skipped", error: "not-started" })) });
  }

  function onListPage(program: LoopProgram): boolean {
    const here = normalizeUrl(doc.location.href);
    return here !== null && here.origin === program.iterator.origin.toLowerCase() && here.pathPattern === program.iterator.pathPattern;
  }

  async function modesFor(): Promise<LoopModeOption[]> {
    const timeout = new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), EXECUTORS_WAIT_MS));
    return asModes(await Promise.race([ask({ type: "ghost:loop-executors?" }), timeout]));
  }

  async function showProposal(proposal: LoopProposal): Promise<void> {
    if (!alive || !isEnabled() || (shownKey === proposalKey(proposal) && panel.state === "proposed")) return;
    const { program, remaining } = proposal;
    const items = onListPage(program) ? listItems(doc, program.iterator.listSignature) : [];
    if (items.length === 0) return waitForList(proposal); // the list page is not on screen yet: the rows need its links
    stopListPoll();
    const modes = await modesFor();
    if (!alive) return;
    const abort = new AbortController();
    const urls = resolveItemUrls(remaining, (index) => (items[index] ? itemUrlFromElement(items[index]) : null));
    const previewFrames = deps.frames?.();
    shownKey = proposalKey(proposal);
    shownProgram = program;
    runId = null;
    pause(true);
    panel.show({
      program, remaining, modes,
      itemLabel: (index) => (items[index] ? itemKeyOf(items[index]) : ""),
      rows: previewItems(program, urls, {
        resolve: resolveLocator, doc, indexes: [...remaining], signal: abort.signal, fallbackVars: (program.unresolved ?? []).map((u) => u.var),
        ...(previewFrames ? { frames: previewFrames } : {}), ...deps.preview,
      }),
      abortPreview: () => abort.abort(),
    }, panelDeps);
  }

  function waitForList(proposal: LoopProposal): void {
    pending = proposal;
    listTimer ??= setInterval(() => {
      if (pending && onListPage(pending.program)) void showProposal(pending);
    }, LIST_POLL_MS);
  }

  function stopListPoll(): void {
    pending = null;
    if (listTimer) clearInterval(listTimer);
    listTimer = null;
  }

  /** A page that loaded in the middle of a run (or after it) rebuilds the sheet from the worker's state. */
  function showRun(run: LoopRunProgress, proposal: LoopProposal | undefined): void {
    const sameRun = runId === run.runId && panel.state !== "hidden";
    if (!sameRun && proposal && !(panel.state === "running" && shownProgram?.id === proposal.program.id)) {
      const items = onListPage(proposal.program) ? listItems(doc, proposal.program.iterator.listSignature) : [];
      shownKey = proposalKey(proposal);
      shownProgram = proposal.program;
      panel.show({ program: proposal.program, remaining: run.items.map((item) => item.index), itemLabel: (i) => (items[i] ? itemKeyOf(items[i]) : "") }, panelDeps);
    }
    runId = run.runId;
    pause(true);
    panel.update(run);
  }

  function apply(state: LoopUiState): void {
    if (!alive || !isEnabled()) return;
    if (state.phase === "proposed") return void showProposal(state.proposal);
    if (state.phase === "idle") {
      if (panel.state !== "hidden" && panel.state !== "proposed") panel.hide();
      if (panel.state === "hidden") closed();
      return;
    }
    showRun(state.run, state.proposal);
    if (state.phase === "running") return driver.kick();
    driver.stop();
    clearCursor();
    releaseExecutors();
  }

  function onMessage(message: unknown): void {
    if (!alive || !isLoopMessage(message)) return;
    if (message.type === "ghost:loop-proposal" && isProposal(message)) void showProposal({ program: message.program, remaining: message.remaining, total: message.total });
    if (message.type === "ghost:loop-progress" && isRun(message.run)) apply(message.run.state === "running" ? { phase: "running", run: message.run } : { phase: "finished", run: message.run });
  }

  function shutDown(): void {
    driver.stop();
    clearCursor();
    panel.hide();
    closed();
  }

  const unlisten = alive ? (deps.listen ?? runtimeListen)(onMessage) : () => undefined;
  // Ghost switched off: the worker cancels the run and forgets the proposal; this tab only has to let go.
  const unwatch = alive ? onStorageChanged((changes) => void (changes.settings && !changes.settings.enabled && shutDown())) : () => undefined;

  // An orphaned content script (extension reloaded) must let go of the page; only meaningful with a real runtime.
  const hasRuntime = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  const unorphan = alive && hasRuntime ? watchForOrphan(() => handle.stop()) : () => undefined;

  const handle: LoopContentHandle = {
    panel,
    async sync() {
      if (alive && isEnabled()) apply(asUiState(await ask({ type: "ghost:loop-state?" })));
    },
    stop() {
      if (!alive) return;
      shutDown();
      alive = false;
      unlisten();
      unwatch();
      unorphan();
      panel.destroy();
    },
  };
  void handle.sync();
  return handle;
}
