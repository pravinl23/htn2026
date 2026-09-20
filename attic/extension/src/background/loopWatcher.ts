// "Do it twice": watches the trace and proposes a loop once (docs/loops.md 3.2 and 3.3).
// After every user event (debounced 250 ms): detectLoop -> synthesizeProgram -> list total -> planRemaining
// -> "ghost:loop-proposal" to the tab that owns the list page.
//
// The list total comes from the page facts of the list page (LIST_LENGTH_LABEL in traceStore.ts), not from a
// round trip: when the second run ends the list tab usually shows an item page and could not answer. Without
// a total nothing is proposed yet; the next facts report or event tries again.
import { detectLoop, planRemaining, synthesizeProgram } from "@ghost/shared";
import type { FactsByUrl, LoopCandidate, LoopProgram, LoopStep, TraceEvent } from "@ghost/shared";
import type { LoopMessageOf, LoopProposal } from "../lib/loopMessages";
import { kvStorage } from "./kvStorage";
import type { KvStorage } from "./kvStorage";
import { mergeRemoteProgram } from "./loopRemote";
import type { RemoteSynthesizer } from "./loopRemote";
import type { TraceStore } from "./traceStore";

export const LOOP_DEBOUNCE_MS = 250;
export const LOOP_MEMORY_KEY = "ghost.loop.seen";
/** An unresolved program that the server could not complete never reads as confident. */
export const LOW_CONFIDENCE = 0.5;
const MAX_REMEMBERED = 50;

export type ProposalMessage = LoopMessageOf<"ghost:loop-proposal">;

export interface WatcherTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LoopWatcherDeps {
  trace: Pick<TraceStore, "events" | "factsByUrl" | "listInfo">;
  /** Delivers the proposal to one tab (chrome.tabs.sendMessage). A closed tab may reject: the proposal stays in the run state. */
  emit(tabId: number, message: ProposalMessage): Promise<unknown> | void;
  /** Called before `emit`, so "ghost:loop-state?" already answers "proposed" when the tab asks. */
  onProposal?(proposal: LoopProposal, tabId: number): Promise<unknown> | void;
  /** Absent when no server is configured. Asked only for programs with unresolved steps. */
  synthesizeRemote?: RemoteSynthesizer;
  /** True while a preview is open or a run is active: nothing new is proposed then. */
  isBusy?(): Promise<boolean> | boolean;
  /** chrome.storage.session by default: dismissed and already proposed programs are remembered for the session. */
  storage?: KvStorage;
  now?(): number;
  timers?: WatcherTimers;
  debounceMs?: number;
}

export interface LoopWatcher {
  /** Call after every appended event. Synthetic events never start an evaluation. */
  onEvent(event: TraceEvent): void;
  /** Call after a facts report: a total or a value source may have arrived. */
  onFacts(): void;
  /** Runs the pipeline now. Resolves to the proposal that was emitted, or null. */
  evaluate(): Promise<LoopProposal | null>;
  /** The user closed the proposal: this program is not proposed again this session. */
  dismiss(programId: string): Promise<void>;
  /** Drops a pending debounce (Ghost was disabled). */
  cancel(): void;
}

interface Seen {
  dismissed: string[];
  proposed: Array<{ programId: string; key: string; nextIndex: number }>;
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function stepShape(step: LoopStep): string | null {
  if (step.op === "extract") return null; // derived from the facts at hand, not from what the user did
  if (step.op === "open-item") return step.op;
  if (step.op === "goto") return `goto|${step.pathPattern}`;
  const target = step.target.cell ? `CELL(${step.target.cell.colHeader})` : `${step.target.label}#${step.target.kind}`;
  return `${step.op}|${step.at?.pathPattern ?? ""}|${target}`;
}

/** Identifies "the same task" across detections: the iterator's list plus a hash of the step shapes. Values play no part. */
export function programKey(program: LoopProgram): string {
  const shapes = program.steps.map(stepShape).filter((s): s is string => s !== null);
  return `${program.iterator.origin}|${program.iterator.listSignature}|${fnv1a(shapes.join(">"))}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviveSeen(raw: unknown): Seen {
  const seen: Seen = { dismissed: [], proposed: [] };
  if (!isObject(raw)) return seen;
  if (Array.isArray(raw.dismissed)) seen.dismissed = raw.dismissed.filter((k): k is string => typeof k === "string");
  for (const p of Array.isArray(raw.proposed) ? raw.proposed : []) {
    if (isObject(p) && typeof p.programId === "string" && typeof p.key === "string" && typeof p.nextIndex === "number") {
      seen.proposed.push({ programId: p.programId, key: p.key, nextIndex: p.nextIndex });
    }
  }
  return seen;
}

/** All tabs first; when another tab's activity sits between the two runs, the newest event's tab alone. */
function detect(events: readonly TraceEvent[], now: number): LoopCandidate | null {
  const newest = events[events.length - 1];
  return detectLoop(events, now) ?? (newest ? detectLoop(events, now, { tabIds: [newest.tabId] }) : null);
}

function visitedFacts(candidate: LoopCandidate, factsByUrl: FactsByUrl): FactsByUrl {
  const out: FactsByUrl = {};
  for (const e of [...candidate.runA, ...candidate.runB]) {
    const facts = factsByUrl[e.url];
    if (facts) out[e.url] = facts;
  }
  return out;
}

/** The tab where the user clicked the list item in the newer run. */
function listTab(candidate: LoopCandidate, program: LoopProgram): number | null {
  const signature = program.iterator.listSignature;
  const click = [...candidate.runB].reverse().find((e) => e.target?.list?.listSignature === signature);
  return click?.tabId ?? candidate.runB[0]?.tabId ?? null;
}

const defaultTimers: WatcherTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createLoopWatcher(deps: LoopWatcherDeps): LoopWatcher {
  const storage = deps.storage ?? kvStorage("session");
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? Date.now;
  let pending: unknown = null;
  let queue: Promise<unknown> = Promise.resolve();

  const readSeen = async (): Promise<Seen> => reviveSeen(await storage.get(LOOP_MEMORY_KEY).catch(() => undefined));
  const writeSeen = (seen: Seen): Promise<void> =>
    storage.set(LOOP_MEMORY_KEY, { dismissed: seen.dismissed.slice(-MAX_REMEMBERED), proposed: seen.proposed.slice(-MAX_REMEMBERED) }).catch(() => undefined);

  async function complete(program: LoopProgram, candidate: LoopCandidate, factsByUrl: FactsByUrl): Promise<LoopProgram> {
    if (!program.unresolved?.length) return program;
    const request = { runs: [candidate.runA, candidate.runB] as [TraceEvent[], TraceEvent[]], pageSamples: visitedFacts(candidate, factsByUrl), program };
    const reply = deps.synthesizeRemote ? await deps.synthesizeRemote(request).catch(() => null) : null;
    const merged = reply === null || reply === undefined ? null : mergeRemoteProgram(program, reply);
    if (merged && !merged.unresolved?.length) return merged;
    const kept = merged ?? program;
    return { ...kept, confidence: Math.min(kept.confidence, LOW_CONFIDENCE) };
  }

  async function run(): Promise<LoopProposal | null> {
    if (await deps.isBusy?.()) return null;
    const candidate = detect(await deps.trace.events(), now());
    if (!candidate) return null;
    const factsByUrl = await deps.trace.factsByUrl();
    const heuristic = synthesizeProgram(candidate, factsByUrl);
    const tabId = heuristic ? listTab(candidate, heuristic) : null;
    if (!heuristic || tabId === null) return null;
    const key = programKey(heuristic);
    const seen = await readSeen();
    const { iterator } = heuristic;
    if (seen.dismissed.includes(key) || seen.proposed.some((p) => p.key === key && p.nextIndex === iterator.nextIndex)) return null;
    const list = await deps.trace.listInfo(iterator.origin, iterator.pathPattern, iterator.listSignature);
    if (!list) return null;
    const sized = { ...heuristic, iterator: { ...iterator, total: list.total } };
    const remaining = planRemaining(sized, list.total, list.handled);
    if (remaining.length === 0) return null;
    const proposal: LoopProposal = { program: await complete(sized, candidate, factsByUrl), remaining, total: list.total };
    seen.proposed = [...seen.proposed.filter((p) => p.key !== key), { programId: proposal.program.id, key, nextIndex: iterator.nextIndex }];
    await writeSeen(seen);
    await deps.onProposal?.(proposal, tabId);
    await Promise.resolve(deps.emit(tabId, { type: "ghost:loop-proposal", ...proposal })).catch(() => undefined);
    return proposal;
  }

  function evaluate(): Promise<LoopProposal | null> {
    const next = queue.then(run, run);
    queue = next.catch(() => null);
    return next;
  }

  function schedule(): void {
    if (pending !== null) timers.clear(pending);
    pending = timers.set(() => {
      pending = null;
      evaluate().catch((error: unknown) => console.warn("[ghost] loop evaluation failed", error));
    }, deps.debounceMs ?? LOOP_DEBOUNCE_MS);
  }

  return {
    onEvent: (event) => void (event.synthetic ? undefined : schedule()),
    onFacts: schedule,
    evaluate,
    async dismiss(programId) {
      const work = async (): Promise<void> => {
        const seen = await readSeen();
        const keys = seen.proposed.filter((p) => p.programId === programId).map((p) => p.key);
        seen.dismissed = [...new Set([...seen.dismissed, ...keys])];
        await writeSeen(seen);
      };
      const done = queue.then(work, work);
      queue = done.catch(() => undefined);
      await done;
    },
    cancel() {
      if (pending !== null) timers.clear(pending);
      pending = null;
    },
  };
}
