import { isSensitive } from "@ghost/shared";
import { AGENT_OPERATIONS } from "@ghost/shared";
import type {
  AgentCandidate,
  AgentDecisionRequest,
  AgentDecisionResponse,
  AgentExecutableOperation,
  AgentHistoryEntry,
  AgentOperation,
  AgentRunOutcome,
  CapturedField,
  FieldAssignment,
  FieldKind,
  FieldOption,
  FormPredictRequest,
} from "@ghost/shared";

/**
 * Runtime messages between the content script and the background worker. `target` is a one-shot token
 * the content script stamps on the element (`data-ghost-target`) for the length of the request: real
 * input lands on whatever is focused or under the point when it finally runs, so the worker checks
 * that this is still the element Ghost validated.
 */
export type GhostMessage =
  | { type: "ghost:toggle" }
  | { type: "ghost:debugger-fill"; value: string; target: string }
  | { type: "ghost:debugger-click"; x: number; y: number; target: string }
  | { type: "ghost:predict-form"; request: FormPredictRequest }
  | { type: "ghost:agent-next"; request: AgentDecisionRequest }
  | { type: "ghost:agent-outcome"; outcome: AgentRunOutcome }
  | { type: "ghost:health" }
  | { type: "ghost:metrics"; batch: MetricsBatch };

export const TARGET_ATTR = "data-ghost-target";
export const TARGET_TOKEN = /^[A-Za-z0-9-]{8,64}$/;

/** Reply the background worker sends for the two debugger messages. */
export interface DebuggerReply {
  ok: boolean;
  error?: string;
}

const TYPES: ReadonlySet<string> = new Set([
  "ghost:toggle", "ghost:debugger-fill", "ghost:debugger-click", "ghost:predict-form", "ghost:agent-next", "ghost:agent-outcome", "ghost:health", "ghost:metrics",
]);

export function isGhostMessage(msg: unknown): msg is GhostMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const type = (msg as { type?: unknown }).type;
  return typeof type === "string" && TYPES.has(type);
}

// ---------- free-text drafts (Stage 3) ----------

/** Name of the chrome.runtime Port a content script opens for ONE streamed draft. Disconnecting it aborts the stream. */
export const TEXT_PORT = "ghost:text";

export interface TextPageContext {
  company?: string;
  role?: string;
  description?: string;
}

/** Body of `POST /v1/ghost-text`. Built in the content script, re-validated by the background worker. */
export interface GhostTextRequest {
  fieldLabel: string;
  fieldSignature: string;
  maxChars?: number;
  pageContext: TextPageContext;
  facts: Record<string, string>;
  pastAnswers: Array<{ question: string; answer: string }>;
}

/** Content script -> background, first and only message on a `ghost:text` port. */
export interface TextPortStart {
  type: "start";
  request: GhostTextRequest;
}

/** Background -> content script. `done` and `error` are terminal; the worker disconnects right after. */
export type TextPortEvent =
  | { type: "delta"; delta: string }
  | { type: "done"; text: string; provider: string; latencyMs: number | null; firstTokenMs: number | null }
  | { type: "error"; error: string };

/**
 * The only profile facts the text route ever sees. Contact details (email, phone, address), LinkedIn,
 * work authorization and sponsorship never leave the extension for a draft.
 */
export const TEXT_FACT_KEYS: readonly string[] = [
  "fullName", "firstName", "lastName", "school", "degree", "major", "graduationDate", "location", "github", "website",
];

export const TEXT_LIMITS = {
  label: 300, signature: 500, name: 200, description: 2000, factValue: 500, pastAnswers: 3, question: 300, answer: 2000,
  minMaxChars: 20, maxMaxChars: 5000,
} as const;

const CONTACT_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+|(?:\+?\d[\s().-]{0,3}){9,}/;

/** True when the text carries something that reads as an email address or a phone number. */
export function hasContactValue(text: string): boolean {
  return CONTACT_VALUE.test(text);
}

/** Allowlisted, non-empty facts whose value does not itself look like an email address or a phone number. */
export function textFacts(facts: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of TEXT_FACT_KEYS) {
    const value = facts[key];
    if (typeof value !== "string" || !value.trim() || CONTACT_VALUE.test(value)) continue;
    out[key] = value.trim().slice(0, TEXT_LIMITS.factValue);
  }
  return out;
}

/**
 * Rebuilds a request from untrusted input, keeping only known fields within the server's limits. The
 * worker runs this on everything a port sends, so a compromised renderer cannot widen what is sent.
 */
export function sanitizeTextRequest(raw: unknown): GhostTextRequest | null {
  if (!isObject(raw)) return null;
  const fieldLabel = clip(raw.fieldLabel, TEXT_LIMITS.label);
  const fieldSignature = clip(raw.fieldSignature, TEXT_LIMITS.signature);
  if (!fieldLabel || !fieldSignature || isSensitive({ label: fieldLabel })) return null;
  const page = isObject(raw.pageContext) ? raw.pageContext : {};
  const request: GhostTextRequest = {
    fieldLabel,
    fieldSignature,
    pageContext: compact({
      company: clip(page.company, TEXT_LIMITS.name),
      role: clip(page.role, TEXT_LIMITS.name),
      description: clip(page.description, TEXT_LIMITS.description),
    }),
    facts: textFacts(isObject(raw.facts) ? raw.facts : {}),
    pastAnswers: cleanPastAnswers(raw.pastAnswers),
  };
  const maxChars = cleanMaxChars(raw.maxChars);
  if (maxChars !== undefined) request.maxChars = maxChars;
  return request;
}

export function isTextPortStart(msg: unknown): msg is { type: "start"; request: unknown } {
  return isObject(msg) && msg.type === "start";
}

export function isTextPortEvent(msg: unknown): msg is TextPortEvent {
  if (!isObject(msg)) return false;
  if (msg.type === "delta") return typeof msg.delta === "string";
  if (msg.type === "done") return typeof msg.text === "string" && typeof msg.provider === "string";
  return msg.type === "error" && typeof msg.error === "string";
}

function cleanPastAnswers(raw: unknown): GhostTextRequest["pastAnswers"] {
  if (!Array.isArray(raw)) return [];
  const out: GhostTextRequest["pastAnswers"] = [];
  for (const item of raw) {
    const question = isObject(item) ? clip(item.question, TEXT_LIMITS.question) : undefined;
    const answer = isObject(item) ? clip(item.answer, TEXT_LIMITS.answer) : undefined;
    if (!question || !answer || out.length >= TEXT_LIMITS.pastAnswers) continue;
    // An old answer that quotes the user's email or phone would carry it into a prompt.
    if (!isSensitive({ label: question }) && !hasContactValue(answer)) out.push({ question, answer });
  }
  return out;
}

function cleanMaxChars(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < TEXT_LIMITS.minMaxChars) return undefined;
  return Math.min(TEXT_LIMITS.maxMaxChars, Math.floor(raw));
}

function clip(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, max) || undefined : undefined;
}

function compact(context: TextPageContext): TextPageContext {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)) as TextPageContext;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------- form prediction (Stage 2) ----------

/** What every server-backed message resolves to. `error` is a short code, never page or profile content. */
export type ServerResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** One field's answer. `source` and `calibrated` come from the server; the offline mapper sets neither. */
export interface ServedAssignment extends FieldAssignment {
  source?: string;
  calibrated?: boolean;
}

/** `POST /v1/predict/form` as the extension reads it. */
export interface FormPrediction {
  assignments: ServedAssignment[];
  provider: string;
  calibrated: boolean;
  latencyMs: number | null;
  /** Set when the provider failed and the server answered with its heuristic: not worth remembering. */
  fallbackFrom?: string;
}

export interface ServerHealth {
  provider: string;
  calibrated: boolean;
  textProvider: string;
  model?: string;
  version?: string;
}

/** The server's own limits (docs/server-api.md), so a form never earns a 400. */
export const FORM_LIMITS = { fields: 100, factKeys: 64, options: 50, id: 300, label: 500, name: 200, hint: 100, placeholder: 300 } as const;

const FACT_KEY = /^[A-Za-z][\w.-]{0,63}$/;
const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0 } as const;
/** Kinds that can take a value. Buttons, links and file inputs never reach the server. */
const WIRE_KINDS: ReadonlySet<string> = new Set<FieldKind>([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox",
]);

/** A field as the server may see it: what it is, never what is in it, and never a sensitive one. */
export function toWireField(raw: unknown): CapturedField | null {
  if (!isObject(raw) || typeof raw.kind !== "string" || !WIRE_KINDS.has(raw.kind)) return null;
  const signature = identifier(raw.signature);
  if (!signature) return null;
  const field: CapturedField = { signature, label: clip(raw.label, FORM_LIMITS.label) ?? "", kind: raw.kind as FieldKind, rect: { ...ZERO_RECT } };
  const hints = {
    inputType: clip(raw.inputType, 40),
    name: clip(raw.name, FORM_LIMITS.name),
    id: clip(raw.id, FORM_LIMITS.name),
    autocomplete: clip(raw.autocomplete, FORM_LIMITS.hint),
    placeholder: clip(raw.placeholder, FORM_LIMITS.placeholder),
    context: clip(raw.context, FORM_LIMITS.label),
  };
  if (isSensitive({ ...hints, label: field.label })) return null;
  Object.assign(field, dropUndefined(hints));
  const options = wireOptions(raw.options);
  if (options) field.options = options;
  if (typeof raw.required === "boolean") field.required = raw.required;
  return field;
}

/**
 * Rebuilds a predict request from untrusted input. Profile VALUES cannot get through: only fact keys
 * that look like keys, and fields without their current value. The worker runs this on every message.
 */
export function sanitizeFormRequest(raw: unknown): FormPredictRequest | null {
  if (!isObject(raw)) return null;
  const origin = identifier(raw.origin);
  const formSignature = identifier(raw.formSignature);
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).map(toWireField).filter((f): f is CapturedField => f !== null);
  const keys = (Array.isArray(raw.factKeys) ? raw.factKeys : []).filter((k): k is string => typeof k === "string" && FACT_KEY.test(k));
  const factKeys = [...new Set(keys)].slice(0, FORM_LIMITS.factKeys);
  if (!origin || !formSignature || fields.length === 0 || factKeys.length === 0) return null;
  return { origin, formSignature, fields: fields.slice(0, FORM_LIMITS.fields), factKeys };
}

/** Keeps what is well formed of a list of assignments (a server reply, or something read back from storage). */
export function cleanAssignments(raw: unknown): ServedAssignment[] {
  if (!Array.isArray(raw)) return [];
  const out: ServedAssignment[] = [];
  for (const item of raw.slice(0, FORM_LIMITS.fields)) {
    if (!isObject(item) || typeof item.confidence !== "number" || !Number.isFinite(item.confidence)) continue;
    const signature = identifier(item.signature);
    if (!signature || typeof item.factKey !== "string" || !FACT_KEY.test(item.factKey)) continue;
    const assignment: ServedAssignment = { signature, factKey: item.factKey, confidence: Math.min(1, Math.max(0, item.confidence)) };
    if (typeof item.source === "string") assignment.source = item.source.slice(0, 40);
    if (typeof item.calibrated === "boolean") assignment.calibrated = item.calibrated;
    out.push(assignment);
  }
  return out;
}

export function parseFormPrediction(raw: unknown): FormPrediction | null {
  if (!isObject(raw) || !Array.isArray(raw.assignments) || typeof raw.provider !== "string") return null;
  const prediction: FormPrediction = {
    assignments: cleanAssignments(raw.assignments),
    provider: raw.provider.slice(0, 40),
    calibrated: raw.calibrated === true,
    latencyMs: typeof raw.latencyMs === "number" && Number.isFinite(raw.latencyMs) ? raw.latencyMs : null,
  };
  if (typeof raw.fallbackFrom === "string") prediction.fallbackFrom = raw.fallbackFrom.slice(0, 40);
  return prediction;
}

export function parseHealth(raw: unknown): ServerHealth | null {
  if (!isObject(raw) || raw.ok !== true || typeof raw.provider !== "string") return null;
  const health: ServerHealth = {
    provider: raw.provider.slice(0, 40),
    calibrated: raw.calibrated === true,
    textProvider: typeof raw.textProvider === "string" ? raw.textProvider.slice(0, 40) : "unknown",
  };
  if (typeof raw.model === "string") health.model = raw.model.slice(0, 80);
  if (typeof raw.version === "string") health.version = raw.version.slice(0, 40);
  return health;
}

// ---------- Jev computer-use decisions ----------

export const AGENT_LIMITS = { goal: 2000, title: 300, candidates: 80, history: 20, label: 200, context: 300 } as const;
const AGENT_OPERATION_SET: ReadonlySet<string> = new Set<AgentOperation>(AGENT_OPERATIONS);
const AGENT_EXECUTABLE_SET: ReadonlySet<string> = new Set<AgentExecutableOperation>(["FILL", "SELECT", "CHECK", "CLICK"]);

function cleanAgentCandidate(raw: unknown): AgentCandidate | null {
  if (!isObject(raw) || (raw.kind !== "button" && raw.kind !== "link" && raw.kind !== "field")) return null;
  const id = identifier(raw.id);
  const label = clip(raw.label, AGENT_LIMITS.label);
  if (!id || !label || isSensitive({ label, placeholder: typeof raw.context === "string" ? raw.context : undefined })) return null;
  if (typeof raw.required !== "boolean" || typeof raw.locked !== "boolean" || typeof raw.filled !== "boolean" || !Array.isArray(raw.operations)) return null;
  const operations = [...new Set(raw.operations.filter((operation): operation is AgentExecutableOperation => typeof operation === "string" && AGENT_EXECUTABLE_SET.has(operation)))];
  const candidate: AgentCandidate = { id, kind: raw.kind, label, required: raw.required, locked: raw.locked, filled: raw.filled, operations };
  const context = clip(raw.context, AGENT_LIMITS.context);
  if (context) candidate.context = context;
  return candidate;
}

function cleanAgentHistory(raw: unknown): AgentHistoryEntry | null {
  if (!isObject(raw) || typeof raw.operation !== "string" || !AGENT_OPERATION_SET.has(raw.operation)) return null;
  if (typeof raw.ok !== "boolean" || typeof raw.changed !== "boolean") return null;
  const entry: AgentHistoryEntry = { operation: raw.operation as AgentOperation, ok: raw.ok, changed: raw.changed };
  const targetId = identifier(raw.targetId);
  const targetLabel = clip(raw.targetLabel, AGENT_LIMITS.label);
  const error = clip(raw.error, 80);
  if (targetId) entry.targetId = targetId;
  if (targetLabel && !isSensitive({ label: targetLabel })) entry.targetLabel = targetLabel;
  if (error) entry.error = error;
  return entry;
}

/** Rebuilds the value-free request before it leaves the extension process. */
export function sanitizeAgentRequest(raw: unknown): AgentDecisionRequest | null {
  if (!isObject(raw) || !isObject(raw.page)) return null;
  const goal = clip(raw.goal, AGENT_LIMITS.goal);
  const origin = identifier(raw.page.origin);
  const url = clip(raw.page.url, 2000);
  const title = typeof raw.page.title === "string" ? raw.page.title.slice(0, AGENT_LIMITS.title) : null;
  if (!goal || !origin || !url || title === null) return null;
  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : []).slice(0, AGENT_LIMITS.candidates).map(cleanAgentCandidate).filter((item): item is AgentCandidate => item !== null);
  const ids = new Set(candidates.map((candidate) => candidate.id));
  if (candidates.length === 0 || ids.size !== candidates.length) return null;
  const recentActions = (Array.isArray(raw.recentActions) ? raw.recentActions : []).slice(-AGENT_LIMITS.history).map(cleanAgentHistory).filter((item): item is AgentHistoryEntry => item !== null);
  return { goal, page: { origin, url, title }, candidates, recentActions };
}

export function parseAgentDecision(raw: unknown): AgentDecisionResponse | null {
  if (!isObject(raw) || typeof raw.operation !== "string" || !AGENT_OPERATION_SET.has(raw.operation)) return null;
  if (typeof raw.confidence !== "number" || typeof raw.operationConfidence !== "number" || typeof raw.provider !== "string" || typeof raw.calibrated !== "boolean") return null;
  if (typeof raw.latencyMs !== "number" || !Number.isFinite(raw.latencyMs)) return null;
  const targetId = identifier(raw.targetId);
  const executable = AGENT_EXECUTABLE_SET.has(raw.operation);
  if (executable !== Boolean(targetId)) return null;
  const answer: AgentDecisionResponse = {
    operation: raw.operation as AgentOperation,
    confidence: clampConfidence(raw.confidence),
    operationConfidence: clampConfidence(raw.operationConfidence),
    provider: raw.provider.slice(0, 40),
    calibrated: raw.calibrated,
    latencyMs: Math.max(0, raw.latencyMs),
  };
  if (targetId) answer.targetId = targetId;
  if (typeof raw.targetConfidence === "number") answer.targetConfidence = clampConfidence(raw.targetConfidence);
  if (typeof raw.fallbackFrom === "string") answer.fallbackFrom = raw.fallbackFrom.slice(0, 40);
  return answer;
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function isServerResult(msg: unknown): msg is ServerResult<unknown> {
  return isObject(msg) && (msg.ok === true || (msg.ok === false && typeof msg.error === "string"));
}

/** Identifiers must fit as they are: clipping one would change which field or form it names. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= FORM_LIMITS.id ? value : undefined;
}

function wireOptions(raw: unknown): FieldOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, FORM_LIMITS.options).filter(isObject).map((option) => ({
    value: typeof option.value === "string" ? option.value.slice(0, FORM_LIMITS.name) : "",
    label: typeof option.label === "string" ? option.label.slice(0, FORM_LIMITS.name) : "",
  }));
}

function dropUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------- metrics (Stage 7) ----------

export const COUNTER_NAMES = ["ghostsShown", "ghostsAccepted", "keystrokesSaved", "clicksSaved"] as const;
export type MetricsCounters = Record<(typeof COUNTER_NAMES)[number], number>;

/**
 * One judged ghost. c: the confidence it was shown with, a: 1 accepted, 0 escaped or typed over,
 * s: where the ghost came from, cal: true only when a calibrated provider (Jev) stood behind that confidence.
 */
export interface MetricsPair {
  c: number;
  a: 0 | 1;
  s: string;
  cal: boolean;
}

/** What a content script reports: deltas since its last report. Numbers and short labels only, never a value. */
export interface MetricsBatch {
  counters: MetricsCounters;
  pairs: MetricsPair[];
}

/** Reply to `ghost:metrics`: the lifetime totals after this batch, for the HUD's hover text. */
export interface MetricsReply {
  ok: boolean;
  totals?: MetricsCounters;
}

export const METRICS_LIMITS = { counter: 100_000, pairs: 200 } as const;

export function zeroCounters(): MetricsCounters {
  return { ghostsShown: 0, ghostsAccepted: 0, keystrokesSaved: 0, clicksSaved: 0 };
}

/** Whole, non-negative and bounded; anything else counts as nothing. */
export function cleanCounters(raw: unknown, max: number = METRICS_LIMITS.counter): MetricsCounters {
  const out = zeroCounters();
  if (!isObject(raw)) return out;
  for (const name of COUNTER_NAMES) {
    const n = raw[name];
    if (typeof n === "number" && Number.isFinite(n) && n > 0) out[name] = Math.min(max, Math.floor(n));
  }
  return out;
}

export function cleanPair(raw: unknown): MetricsPair | null {
  if (!isObject(raw) || typeof raw.c !== "number" || !(raw.c >= 0 && raw.c <= 1)) return null;
  if (raw.a !== 0 && raw.a !== 1) return null;
  const s = typeof raw.s === "string" && /^[a-z-]{1,20}$/.test(raw.s) ? raw.s : "unknown";
  return { c: raw.c, a: raw.a, s, cal: raw.cal === true };
}

/** The worker's rebuild of a batch: null when there is nothing in it worth a storage write. */
export function sanitizeMetricsBatch(raw: unknown): MetricsBatch | null {
  if (!isObject(raw)) return null;
  const counters = cleanCounters(raw.counters);
  const list = Array.isArray(raw.pairs) ? raw.pairs.slice(0, METRICS_LIMITS.pairs) : [];
  const pairs = list.map(cleanPair).filter((p): p is MetricsPair => p !== null);
  const empty = pairs.length === 0 && COUNTER_NAMES.every((name) => counters[name] === 0);
  return empty ? null : { counters, pairs };
}

export function isMetricsReply(msg: unknown): msg is MetricsReply {
  return isObject(msg) && typeof msg.ok === "boolean";
}
