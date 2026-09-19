// The only place the extension talks to the prediction server. Runs in the service worker, so a page's
// CSP cannot block the request and the page can neither observe nor forge it.
import { sanitizeAgentRunOutcome } from "@ghost/shared";
import { getProfile, getSettings } from "../lib/storage";
import { parseAgentDecision, parseFormPrediction, parseHealth, sanitizeAgentRequest, sanitizeFormRequest } from "../lib/messages";
import type { AgentDecisionResponse } from "@ghost/shared";
import type { FormPrediction, GhostMessage, GhostTextRequest, ServerHealth, ServerResult } from "../lib/messages";

export type FetchLike = typeof fetch;

/** `settings.serverUrl` without a trailing slash, or null when it is not a plain http(s) URL. */
export function normalizeServerUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export async function serverBaseUrl(): Promise<string | null> {
  return normalizeServerUrl((await getSettings()).serverUrl);
}

/** Opens the streaming draft. The server requires `Content-Type: application/json` on every POST. */
export function openGhostText(base: string, request: GhostTextRequest, signal: AbortSignal, fetchImpl: FetchLike = fetch): Promise<Response> {
  return fetchImpl(`${base}/v1/ghost-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(request),
    signal,
    credentials: "omit",
    cache: "no-store",
  });
}

// ---------- form prediction and health (Stage 2) ----------

/** A slow server must never hold a form back: past this the page simply stays on the offline ghosts. */
export const REQUEST_TIMEOUT_MS = 3000;

export type ServerMessage = Extract<GhostMessage, { type: "ghost:predict-form" | "ghost:agent-next" | "ghost:agent-outcome" | "ghost:health" }>;

export interface AgentOutcomeReceipt {
  accepted: true;
  captured: boolean;
  replayId?: string;
}

export interface ServerClientDeps {
  fetch?: FetchLike;
  getServerUrl?: () => Promise<string | null>;
  /** The keys of the stored profile: nothing else is accepted as a fact key. */
  getFactKeys?: () => Promise<string[]>;
  timeoutMs?: number;
}

/** What chrome.runtime.MessageSender tells us about the frame that asked. */
export interface SenderFrame {
  origin?: string;
  url?: string;
}

export function isServerMessage(msg: unknown): msg is ServerMessage {
  const type = (msg as { type?: unknown } | null)?.type;
  return type === "ghost:predict-form" || type === "ghost:agent-next" || type === "ghost:agent-outcome" || type === "ghost:health";
}

/** One JSON round trip with a deadline. Errors are short codes: they travel to a content script and its HUD. */
async function callServer<T>(path: string, body: unknown, parse: (raw: unknown) => T | null, deps: ServerClientDeps): Promise<ServerResult<T>> {
  const base = await (deps.getServerUrl ?? serverBaseUrl)().catch(() => null);
  if (!base) return { ok: false, error: "no-server-url" };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await (deps.fetch ?? fetch)(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal,
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok) return { ok: false, error: `http-${response.status}` };
    const data = parse(await response.json());
    return data ? { ok: true, data } : { ok: false, error: "bad-response" };
  } catch {
    return { ok: false, error: abort.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function profileFactKeys(): Promise<string[]> {
  return Object.keys((await getProfile()).facts);
}

/**
 * POST /v1/predict/form. The body is rebuilt first: value-free fields, and fact keys that really are keys
 * of the stored profile, so not even a compromised content script can pass a VALUE off as a key.
 */
export async function predictForm(rawRequest: unknown, deps: ServerClientDeps = {}): Promise<ServerResult<FormPrediction>> {
  const request = sanitizeFormRequest(rawRequest);
  if (!request) return { ok: false, error: "bad-request" };
  const known = new Set(await (deps.getFactKeys ?? profileFactKeys)().catch(() => []));
  const factKeys = request.factKeys.filter((key) => known.has(key));
  if (factKeys.length === 0) return { ok: false, error: "bad-request" };
  return callServer("/v1/predict/form", { ...request, factKeys }, parseFormPrediction, deps);
}

export function checkHealth(deps: ServerClientDeps = {}): Promise<ServerResult<ServerHealth>> {
  return callServer("/v1/health", undefined, parseHealth, deps);
}

export function predictAgent(rawRequest: unknown, deps: ServerClientDeps = {}): Promise<ServerResult<AgentDecisionResponse>> {
  const request = sanitizeAgentRequest(rawRequest);
  if (!request) return Promise.resolve({ ok: false, error: "bad-request" });
  return callServer("/v1/agent/next", request, parseAgentDecision, deps);
}

export function reportAgentOutcome(raw: unknown, deps: ServerClientDeps = {}): Promise<ServerResult<AgentOutcomeReceipt>> {
  const outcome = sanitizeAgentRunOutcome(raw);
  if (!outcome) return Promise.resolve({ ok: false, error: "bad-request" });
  return callServer("/v1/agent/outcomes", outcome, parseOutcomeReceipt, deps);
}

function originOf(sender: SenderFrame): string | null {
  if (sender.origin) return sender.origin;
  try {
    return sender.url ? new URL(sender.url).origin : null;
  } catch {
    return null;
  }
}

/** The origin is the asking frame's as Chrome reports it, not whatever the message claims. */
export function handleServerMessage(message: ServerMessage, sender: SenderFrame, deps: ServerClientDeps = {}): Promise<ServerResult<FormPrediction | AgentDecisionResponse | AgentOutcomeReceipt | ServerHealth>> {
  if (message.type === "ghost:health") return checkHealth(deps);
  if (message.type === "ghost:agent-outcome") return reportAgentOutcome(message.outcome, deps);
  const request: unknown = message.request;
  const origin = originOf(sender);
  if (!origin || typeof request !== "object" || request === null) return Promise.resolve({ ok: false, error: "bad-request" });
  if (message.type === "ghost:predict-form") return predictForm({ ...request, origin }, deps);
  const url = sender.url?.split(/[?#]/)[0] ?? "";
  const page = typeof (request as { page?: unknown }).page === "object" && (request as { page?: unknown }).page !== null ? (request as { page: object }).page : {};
  return predictAgent({ ...request, page: { ...page, origin, url } }, deps);
}

function parseOutcomeReceipt(raw: unknown): AgentOutcomeReceipt | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.accepted !== true || typeof value.captured !== "boolean") return null;
  if (value.replayId !== undefined && typeof value.replayId !== "string") return null;
  return { accepted: true, captured: value.captured, ...(value.replayId ? { replayId: value.replayId } : {}) };
}
