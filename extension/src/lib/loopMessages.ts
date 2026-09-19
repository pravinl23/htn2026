import { isSensitive } from "@ghost/shared";
import type {
  FactLocator, FieldKind, LoopIterator, LoopProgram, LoopStep, NextCandidate, PageFact, TraceCellRef, TraceEvent,
  TraceEventType, TraceListRef, TraceTarget,
} from "@ghost/shared";

/**
 * Runtime messages for the action trace (Stage 5) and the loop engine (Stage 6), see docs/loops.md.
 * Kept apart from messages.ts on purpose. "C -> B" is content script to background worker
 * (chrome.runtime.sendMessage), "B -> C" is the worker to one tab (chrome.tabs.sendMessage).
 * The worker checks sender.id === chrome.runtime.id and runs the sanitizers below on everything C -> B.
 */

/** A trace event as the content script knows it: the worker stamps tabId from the sender. */
export type ContentTraceEvent = Omit<TraceEvent, "tabId">;

export type LoopMode = "visible" | "background" | "parallel" | "api";
export const LOOP_MODES: readonly LoopMode[] = ["visible", "background", "parallel", "api"];

/** What the worker found after the second run: the program, the item indexes still to do, and the list length. */
export interface LoopProposal {
  program: LoopProgram;
  remaining: number[];
  total: number;
}

export type LoopItemStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type LoopRunState = "running" | "done" | "failed" | "cancelled";

export interface LoopItemProgress {
  index: number;
  status: LoopItemStatus;
  /** Short code, never page content. */
  error?: string;
}

export interface LoopRunProgress {
  runId: string;
  programId: string;
  mode: LoopMode;
  state: LoopRunState;
  items: LoopItemProgress[];
  done: number;
  total: number;
  /** Irreversible steps that actually ran, for the final report. */
  irreversibleDone: number;
  /** Set when state is "failed": the item the run stopped on. */
  failedItem?: number;
}

/**
 * Reply to "ghost:loop-state?": what the loop UI of this tab should show right now. A run carries its proposal
 * so a page that loaded in the middle of a visible run can rebuild the sheet.
 */
export type LoopUiState =
  | { phase: "idle" }
  | { phase: "proposed"; proposal: LoopProposal }
  | { phase: "running"; run: LoopRunProgress; proposal?: LoopProposal }
  | { phase: "finished"; run: LoopRunProgress; proposal?: LoopProposal };

/** One previewed row handed over with "ghost:loop-start": what the server executors (parallel, api) run from. */
export interface LoopStartRow {
  index: number;
  /** The page the item opens into. */
  url: string;
  vars: Record<string, string>;
}

/** Reply to "ghost:loop-executors?", from GET /v1/executors. Modes left out keep the panel's defaults. */
export interface LoopExecutorOption {
  mode: LoopMode;
  available: boolean;
  reason?: string;
}

/** One step of one item, with everything a page needs to run it without the whole program. */
export interface LoopStepOrder {
  runId: string;
  mode: LoopMode;
  /** Index of the item in the iterator's list. */
  item: number;
  stepIndex: number;
  step: LoopStep;
  iterator: LoopIterator;
  /** Values extracted so far for this item, by variable name. */
  vars: Record<string, string>;
  /** True only after the single batch confirmation; a locked step without it must not run. */
  confirmed: boolean;
}

/** Reply to "ghost:loop-step-request" and to "ghost:loop-step-result": the next thing this page should do. */
export type LoopStepReply =
  | { kind: "step"; order: LoopStepOrder }
  /** The run continues on another page or in another frame. */
  | { kind: "wait" }
  /** No active run for this tab (finished, failed, cancelled, or never started). */
  | { kind: "none" };

export interface LoopStepOutcome {
  runId: string;
  item: number;
  stepIndex: number;
  ok: boolean;
  /** For an extract step: the value read and how it was found (1 exact locator, 0.6 fallback, 0 missing). */
  extracted?: { var: string; value: string; confidence: number };
  /** Short code such as "target-missing", "value-mismatch", "locked-unconfirmed". Never page content. */
  error?: string;
}

/** Reply to "ghost:next-candidates". */
export type NextPredictionReply =
  | { ok: true; candidateId: string; confidence: number; provider: string; calibrated: boolean; latencyMs: number | null }
  | { ok: false; error: string };

export type LoopMessage =
  /** C -> B, no reply. One user (or synthetic) action. */
  | { type: "ghost:trace-event"; event: ContentTraceEvent }
  /** C -> B, no reply. Facts of a settled page; only sent when they changed. */
  | { type: "ghost:page-facts"; url: string; pathPattern: string; facts: PageFact[] }
  /** C -> B, reply LoopUiState. Asked on load and after navigations so runs survive page loads. */
  | { type: "ghost:loop-state?" }
  /** B -> C. A loop was detected: show the preview sheet. */
  | { type: "ghost:loop-proposal"; program: LoopProgram; remaining: number[]; total: number }
  /** C -> B. The user closed the proposal (Esc or the close control). */
  | { type: "ghost:loop-dismiss"; programId: string }
  /** C -> B, reply LoopUiState. Sent only from the explicit confirmation control. */
  | { type: "ghost:loop-start"; programId: string; mode: LoopMode; items: number[]; confirmIrreversible: true; rows?: LoopStartRow[] }
  /** C -> B, reply LoopUiState. Esc during a run; after a run ended it closes the final report. */
  | { type: "ghost:loop-cancel"; runId?: string }
  /** C -> B, reply LoopExecutorOption[]. Which execution modes the panel may offer. */
  | { type: "ghost:loop-executors?" }
  /** C -> B, reply LoopStepReply. "What should this page do for the active run?" */
  | { type: "ghost:loop-step-request"; url: string; pathPattern: string }
  /** C -> B, reply LoopStepReply (the next step, so an executor can chain without a second round trip). */
  | { type: "ghost:loop-step-result"; outcome: LoopStepOutcome }
  /** B -> C. Broadcast after every item and on every state change. */
  | { type: "ghost:loop-progress"; run: LoopRunProgress }
  /** C -> B, reply NextPredictionReply. Visible candidates after an action settled; the worker adds the trace and memory. */
  | { type: "ghost:next-candidates"; url: string; pathPattern: string; candidates: NextCandidate[] };

export type LoopMessageType = LoopMessage["type"];
export type LoopMessageOf<T extends LoopMessageType> = Extract<LoopMessage, { type: T }>;

const TYPES: ReadonlySet<string> = new Set<LoopMessageType>([
  "ghost:trace-event", "ghost:page-facts", "ghost:loop-state?", "ghost:loop-proposal", "ghost:loop-dismiss",
  "ghost:loop-start", "ghost:loop-cancel", "ghost:loop-step-request", "ghost:loop-step-result", "ghost:loop-progress",
  "ghost:next-candidates", "ghost:loop-executors?",
]);

/** Shallow check on the type tag only. Payloads that cross from a page's renderer go through the sanitizers. */
export function isLoopMessage(msg: unknown): msg is LoopMessage {
  return isObject(msg) && typeof msg.type === "string" && TYPES.has(msg.type);
}

/**
 * List sizes travel inside "ghost:page-facts" as facts `{ locator: { by: "css", value: <listSignature> }, label, text }`:
 * LIST_LENGTH_LABEL with the item count, LIST_HANDLED_LABEL with comma separated indexes of items that already show
 * a handled marker. Same values as background/traceStore.ts, which keeps them apart from the ordinary facts.
 */
export const LIST_LENGTH_LABEL = "ghost:list-length";
export const LIST_HANDLED_LABEL = "ghost:list-handled";

// ---------- sanitizers (the worker runs these on everything a content script sends) ----------

export const TRACE_LIMITS = {
  signature: 300, label: 160, value: 2000, url: 600, listSignature: 300, itemKey: 160, colHeader: 80,
  facts: 80, factText: 200, locator: 300, candidates: 60, context: 160,
} as const;

const EVENT_TYPES: ReadonlySet<string> = new Set<TraceEventType>(["click", "input", "select", "check", "navigate", "tabswitch", "submit"]);
const KINDS: ReadonlySet<string> = new Set<FieldKind>([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox", "file", "button", "link", "other",
]);
const LOCATOR_KINDS: ReadonlySet<string> = new Set<FactLocator["by"]>(["testid", "data-field", "id", "label", "css"]);
const CANDIDATE_KINDS: ReadonlySet<string> = new Set<NextCandidate["kind"]>(["button", "link", "field"]);
const HTTP_URL = /^https?:\/\/[^/?#\s]+\/[^?#\s]*$/i;

/** Rebuilds an event from untrusted input. Null when malformed or when its target reads as sensitive. */
export function sanitizeTraceEvent(raw: unknown): ContentTraceEvent | null {
  if (!isObject(raw) || typeof raw.type !== "string" || !EVENT_TYPES.has(raw.type)) return null;
  const place = cleanPlace(raw);
  if (!place || typeof raw.t !== "number" || !Number.isFinite(raw.t)) return null;
  const event: ContentTraceEvent = { t: raw.t, type: raw.type as TraceEventType, ...place };
  if (raw.target !== undefined) {
    const target = cleanTarget(raw.target);
    if (!target) return null;
    event.target = target;
  }
  if (typeof raw.value === "string") event.value = raw.value.slice(0, TRACE_LIMITS.value);
  if (raw.synthetic === true) event.synthetic = true;
  return event;
}

/** Rebuilds a fact list from untrusted input: bounded, well formed, and without sensitive labels. */
export function sanitizePageFacts(raw: unknown): PageFact[] {
  if (!Array.isArray(raw)) return [];
  const out: PageFact[] = [];
  for (const item of raw) {
    const fact = cleanFact(item);
    if (fact && out.length < TRACE_LIMITS.facts) out.push(fact);
  }
  return out;
}

export function sanitizeNextCandidates(raw: unknown): NextCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: NextCandidate[] = [];
  for (const item of raw.slice(0, TRACE_LIMITS.candidates)) {
    const candidate = cleanCandidate(item);
    if (candidate) out.push(candidate);
  }
  return out;
}

const VAR_NAME = /^[A-Za-z][\w.-]{0,63}$/;
const MAX_START_ROWS = 500;
const MAX_ROW_VARS = 50;

function cleanVars(raw: unknown): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!isObject(raw)) return vars;
  for (const [name, value] of Object.entries(raw).slice(0, MAX_ROW_VARS)) {
    if (VAR_NAME.test(name) && typeof value === "string" && !isSensitive({ label: name })) vars[name] = value.slice(0, TRACE_LIMITS.value);
  }
  return vars;
}

/** Rows of "ghost:loop-start": same-origin http(s) item urls without query or fragment, plain string vars. */
export function sanitizeStartRows(raw: unknown, origin: string): LoopStartRow[] {
  if (!Array.isArray(raw)) return [];
  const out: LoopStartRow[] = [];
  for (const item of raw.slice(0, MAX_START_ROWS)) {
    if (!isObject(item) || !isIndex(item.index) || typeof item.url !== "string") continue;
    const url = item.url.split(/[?#]/)[0] ?? "";
    if (!HTTP_URL.test(url) || !url.toLowerCase().startsWith(`${origin.toLowerCase()}/`)) continue;
    out.push({ index: item.index, url: url.slice(0, TRACE_LIMITS.url), vars: cleanVars(item.vars) });
  }
  return out;
}

/** origin + pathname + pattern from an untrusted message, or null when it is not a plain http(s) url. */
export function cleanPlace(raw: Record<string, unknown>): { origin: string; pathPattern: string; url: string } | null {
  const url = clip(raw.url, TRACE_LIMITS.url);
  const pathPattern = clip(raw.pathPattern, TRACE_LIMITS.url);
  if (!url || !pathPattern || !HTTP_URL.test(url) || !pathPattern.startsWith("/")) return null;
  const origin = /^https?:\/\/[^/]+/i.exec(url)?.[0].toLowerCase() ?? "";
  return { origin, pathPattern, url };
}

function cleanTarget(raw: unknown): TraceTarget | null {
  if (!isObject(raw) || typeof raw.kind !== "string" || !KINDS.has(raw.kind)) return null;
  const signature = identifier(raw.signature, TRACE_LIMITS.signature);
  const label = typeof raw.label === "string" ? raw.label.trim().slice(0, TRACE_LIMITS.label) : "";
  if (!signature || isSensitive({ label })) return null;
  const target: TraceTarget = { signature, label, kind: raw.kind as FieldKind, locked: raw.locked === true };
  const list = cleanList(raw.list);
  const cell = cleanCell(raw.cell);
  if (list) target.list = list;
  if (cell) target.cell = cell;
  return target;
}

function cleanList(raw: unknown): TraceListRef | null {
  if (!isObject(raw) || !isIndex(raw.index)) return null;
  const listSignature = identifier(raw.listSignature, TRACE_LIMITS.listSignature);
  if (!listSignature) return null;
  return { listSignature, index: raw.index, itemKey: clip(raw.itemKey, TRACE_LIMITS.itemKey) ?? "" };
}

function cleanCell(raw: unknown): TraceCellRef | null {
  if (!isObject(raw) || !isIndex(raw.row) || !isIndex(raw.col)) return null;
  return { row: raw.row, col: raw.col, colHeader: clip(raw.colHeader, TRACE_LIMITS.colHeader) ?? "" };
}

function cleanFact(raw: unknown): PageFact | null {
  if (!isObject(raw) || !isObject(raw.locator)) return null;
  const by = raw.locator.by;
  const value = clip(raw.locator.value, TRACE_LIMITS.locator);
  const label = clip(raw.label, TRACE_LIMITS.label);
  const text = clip(raw.text, TRACE_LIMITS.factText);
  if (typeof by !== "string" || !LOCATOR_KINDS.has(by) || !value || !label || !text) return null;
  if (isSensitive({ label })) return null;
  return { locator: { by, value } as FactLocator, label, text };
}

function cleanCandidate(raw: unknown): NextCandidate | null {
  if (!isObject(raw) || typeof raw.kind !== "string" || !CANDIDATE_KINDS.has(raw.kind)) return null;
  const id = identifier(raw.id, TRACE_LIMITS.signature);
  const label = clip(raw.label, TRACE_LIMITS.label);
  if (!id || !label || isSensitive({ label })) return null;
  const candidate: NextCandidate = { id, kind: raw.kind as NextCandidate["kind"], label, locked: raw.locked === true };
  const context = clip(raw.context, TRACE_LIMITS.context);
  if (context && !isSensitive({ label: context })) candidate.context = context;
  return candidate;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 100_000;
}

/** Identifiers must fit as they are: clipping one would change what it names. */
function identifier(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= max ? value : undefined;
}

function clip(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, max) || undefined : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
