// The options page talks to the local prediction server directly: it is an extension page (no page CSP
// in the way, nothing hostile watching) and the server's CORS allows chrome-extension:// origins.
import { getSettings } from "../lib/storage";

export type ServerFailure = "offline" | "http" | "invalid";

export class ServerError extends Error {
  constructor(readonly kind: ServerFailure, message: string) {
    super(message);
    this.name = "ServerError";
  }
}

export interface ServerDeps {
  fetch?: typeof fetch;
  serverUrl?: string;
  timeoutMs?: number;
}

export interface Health {
  provider: string;
  calibrated: boolean;
  textProvider: string;
  model?: string;
}

export interface ExtractResult {
  /** Untrusted: whatever the server put under "facts". resume-merge.ts filters it. */
  facts: unknown;
  provider: string;
  latencyMs: number | null;
}

export const RESUME_MAX_CHARS = 20_000;

export function offlineMessage(serverUrl: string): string {
  return `Cannot reach the Ghost server at ${serverUrl}. Start the server with pnpm dev.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function httpError(response: Response): Promise<ServerError> {
  const body: unknown = await response.json().catch(() => null);
  const detail = isRecord(body) && typeof body.error === "string" ? body.error.slice(0, 200) : response.statusText;
  return new ServerError("http", `The Ghost server answered ${response.status}${detail ? `: ${detail}` : ""}`);
}

async function requestJson(path: string, init: RequestInit, deps: ServerDeps, defaultTimeoutMs: number): Promise<unknown> {
  const serverUrl = deps.serverUrl ?? (await getSettings()).serverUrl;
  const doFetch = deps.fetch ?? fetch;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? defaultTimeoutMs);
  let response: Response;
  try {
    response = await doFetch(`${serverUrl}${path}`, { ...init, signal: abort.signal, cache: "no-store", credentials: "omit" });
  } catch {
    throw new ServerError("offline", offlineMessage(serverUrl));
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw await httpError(response);
  return response.json().catch(() => {
    throw new ServerError("invalid", "The Ghost server sent a reply that is not JSON.");
  });
}

export async function fetchHealth(deps: ServerDeps = {}): Promise<Health> {
  const raw = await requestJson("/v1/health", {}, deps, 2000);
  if (!isRecord(raw) || typeof raw.provider !== "string") throw new ServerError("invalid", "Unexpected /v1/health reply.");
  const health: Health = {
    provider: raw.provider,
    calibrated: raw.calibrated === true,
    textProvider: typeof raw.textProvider === "string" ? raw.textProvider : "template",
  };
  if (typeof raw.model === "string") health.model = raw.model;
  return health;
}

/** Raw snapshot; metrics-math.ts normalizes it. */
export function fetchMetrics(deps: ServerDeps = {}): Promise<unknown> {
  return requestJson("/v1/metrics", {}, deps, 3000);
}

export async function extractProfile(resumeText: string, deps: ServerDeps = {}): Promise<ExtractResult> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resumeText: resumeText.slice(0, RESUME_MAX_CHARS) }),
  };
  const raw = await requestJson("/v1/profile/extract", init, deps, 30_000);
  if (!isRecord(raw) || !isRecord(raw.facts)) throw new ServerError("invalid", "Unexpected /v1/profile/extract reply.");
  return {
    facts: raw.facts,
    provider: typeof raw.provider === "string" ? raw.provider : "unknown",
    latencyMs: typeof raw.latencyMs === "number" && Number.isFinite(raw.latencyMs) ? raw.latencyMs : null,
  };
}
