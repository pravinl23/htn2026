import type { ActionCandidate } from "@ghost/shared";
import { ACTION_SPECS } from "./catalog";
import type { ResolvedCapability } from "./candidates";

const DEFAULT_BASE_URL = "https://backend.composio.dev/api/v3.1";
const REQUEST_TIMEOUT_MS = 15_000;
const CONNECTION_CACHE_MS = 2 * 60_000;
const SESSION_TOOLKITS = ["gmail", "googlecalendar", "slack", "github", "linear", "notion"];

export class ComposioWorkflowError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = "ComposioWorkflowError";
  }
}

interface SessionResponse {
  session_id?: unknown;
}

interface SearchResponse {
  success?: unknown;
  results?: Array<{ primary_tool_slugs?: unknown; related_tool_slugs?: unknown }>;
  tool_schemas?: Record<string, { toolkit?: unknown; tool_slug?: unknown; description?: unknown; input_schema?: unknown }>;
}

export interface ConnectedToolkit {
  toolkit: string;
  accountId: string;
  status: string;
  alias?: string;
}

export interface ComposioWorkflowClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

/** Thin v3.1 REST client. It never logs bodies: upstream errors can echo arguments or account metadata. */
export class ComposioWorkflowClient {
  private readonly doFetch: typeof fetch;
  private readonly baseUrl: string;
  private readonly sessions = new Map<string, string>();
  private readonly connections = new Map<string, { expiresAt: number; value: ConnectedToolkit[] }>();
  private readonly capabilities = new Map<string, { expiresAt: number; value: ResolvedCapability | undefined }>();
  private readonly now: () => number;

  constructor(private readonly options: ComposioWorkflowClientOptions) {
    this.doFetch = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", "x-api-key": this.options.apiKey, ...(init.headers ?? {}) },
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ComposioWorkflowError("composio-unreachable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ComposioWorkflowError(`composio-http-${response.status}`, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new ComposioWorkflowError("composio-bad-response", response.status);
    }
  }

  async ensureSession(userId: string): Promise<string> {
    const existing = this.sessions.get(userId);
    if (existing) return existing;
    const body = (await this.request("/tool_router/session", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        toolkits: { enable: SESSION_TOOLKITS },
        manage_connections: { enable: true, enable_wait_for_connections: false, enable_connection_removal: true },
        search: { enable: true },
        execute: { enable_multi_execute: false },
      }),
    })) as SessionResponse;
    if (typeof body.session_id !== "string" || !body.session_id.startsWith("trs_")) throw new ComposioWorkflowError("composio-bad-session");
    this.sessions.set(userId, body.session_id);
    return body.session_id;
  }

  async listConnectedToolkits(userId: string): Promise<ConnectedToolkit[]> {
    const query = new URLSearchParams({ statuses: "ACTIVE", user_ids: userId, limit: "100" });
    const body = (await this.request(`/connected_accounts?${query}`)) as { items?: unknown };
    if (!Array.isArray(body.items)) throw new ComposioWorkflowError("composio-bad-accounts");
    const value = body.items.flatMap((item): ConnectedToolkit[] => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      const toolkitRaw = raw.toolkit;
      const toolkit = toolkitRaw && typeof toolkitRaw === "object" ? (toolkitRaw as Record<string, unknown>).slug : undefined;
      if (typeof toolkit !== "string" || typeof raw.id !== "string" || typeof raw.status !== "string") return [];
      return [{ toolkit: toolkit.toLowerCase(), accountId: raw.id, status: raw.status, ...(typeof raw.alias === "string" ? { alias: raw.alias } : {}) }];
    });
    this.connections.set(userId, { expiresAt: this.now() + CONNECTION_CACHE_MS, value });
    return value;
  }

  /** Synchronous cache reads keep Composio entirely out of the latency-sensitive prediction path. */
  peekConnectedToolkits(userId: string): ConnectedToolkit[] {
    const cached = this.connections.get(userId);
    return cached && cached.expiresAt > this.now() ? cached.value : [];
  }

  async createConnectLink(userId: string, toolkit: string, callbackUrl?: string): Promise<{ redirectUrl: string; connectedAccountId?: string }> {
    const sessionId = await this.ensureSession(userId);
    const body = (await this.request(`/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
      method: "POST",
      body: JSON.stringify({ toolkit, ...(callbackUrl ? { callback_url: callbackUrl } : {}) }),
    })) as Record<string, unknown>;
    if (typeof body.redirect_url !== "string" || !/^https:\/\//.test(body.redirect_url)) throw new ComposioWorkflowError("composio-bad-connect-link");
    return { redirectUrl: body.redirect_url, ...(typeof body.connected_account_id === "string" ? { connectedAccountId: body.connected_account_id } : {}) };
  }

  /** Redeems Composio callback identity verification when a project has it enabled. The session URI is single-use. */
  async completeAuth(userId: string, sessionUri: string): Promise<{ connectedAccountId?: string; toolkit?: string }> {
    const body = (await this.request("/connected_accounts/complete_auth", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, session_uri: sessionUri }),
    })) as Record<string, unknown>;
    return {
      ...(typeof body.connected_account_id === "string" ? { connectedAccountId: body.connected_account_id } : {}),
      ...(typeof body.toolkit_slug === "string" ? { toolkit: body.toolkit_slug.toLowerCase() } : {}),
    };
  }

  private pickCapability(actionId: string, body: SearchResponse): ResolvedCapability | undefined {
    const spec = ACTION_SPECS[actionId];
    if (!spec?.definition.toolkit || !spec.toolSlugPatterns) return undefined;
    const result = body.results?.[0];
    const slugs = [
      ...(Array.isArray(result?.primary_tool_slugs) ? result.primary_tool_slugs : []),
      ...(Array.isArray(result?.related_tool_slugs) ? result.related_tool_slugs : []),
      ...Object.keys(body.tool_schemas ?? {}),
    ].filter((slug): slug is string => typeof slug === "string");
    const toolSlug = slugs.find((slug) => spec.toolSlugPatterns!.some((pattern) => pattern.test(slug)));
    if (!toolSlug) return undefined;
    const schema = body.tool_schemas?.[toolSlug];
    const toolkit = typeof schema?.toolkit === "string" ? schema.toolkit.toLowerCase() : spec.definition.toolkit;
    if (toolkit !== spec.definition.toolkit) return undefined;
    return { actionId, toolSlug, toolkit, ...(schema?.input_schema && typeof schema.input_schema === "object" ? { inputSchema: schema.input_schema as Record<string, unknown> } : {}) };
  }

  async discoverCapability(userId: string, actionId: string): Promise<ResolvedCapability | undefined> {
    const cacheKey = `${userId}:${actionId}`;
    const cached = this.capabilities.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const spec = ACTION_SPECS[actionId];
    if (!spec?.searchQuery) return undefined;
    const sessionId = await this.ensureSession(userId);
    const body = (await this.request(`/tool_router/session/${encodeURIComponent(sessionId)}/search`, {
      method: "POST",
      body: JSON.stringify({ queries: [{ use_case: spec.searchQuery }], search_strategy: "tool_search" }),
    })) as SearchResponse;
    const value = body.success === false ? undefined : this.pickCapability(actionId, body);
    this.capabilities.set(cacheKey, { expiresAt: this.now() + 15 * 60_000, value });
    return value;
  }

  async discoverCapabilities(userId: string, actionIds: string[]): Promise<Map<string, ResolvedCapability>> {
    const unique = [...new Set(actionIds)].slice(0, 8);
    const resolved = await Promise.all(unique.map(async (id) => [id, await this.discoverCapability(userId, id)] as const));
    return new Map(resolved.flatMap(([id, value]) => (value ? [[id, value] as const] : [])));
  }

  peekCapabilities(userId: string, actionIds: string[]): Map<string, ResolvedCapability> {
    const resolved = new Map<string, ResolvedCapability>();
    for (const actionId of [...new Set(actionIds)].slice(0, 8)) {
      const cached = this.capabilities.get(`${userId}:${actionId}`);
      if (cached?.value && cached.expiresAt > this.now()) resolved.set(actionId, cached.value);
    }
    return resolved;
  }

  async prefetch(userId: string, actionIds: string[]): Promise<{ connections: ConnectedToolkit[]; capabilities: Map<string, ResolvedCapability> }> {
    const [connections, capabilities] = await Promise.all([this.listConnectedToolkits(userId), this.discoverCapabilities(userId, actionIds)]);
    return { connections, capabilities };
  }

  async execute(userId: string, candidate: ActionCandidate): Promise<Record<string, unknown>> {
    if (!candidate.toolSlug) throw new ComposioWorkflowError("composio-tool-unresolved");
    const sessionId = await this.ensureSession(userId);
    const body = (await this.request(`/tool_router/session/${encodeURIComponent(sessionId)}/execute`, {
      method: "POST",
      body: JSON.stringify({ tool_slug: candidate.toolSlug, arguments: candidate.preparedArguments, enable_auto_workbench_offload: false }),
    })) as Record<string, unknown>;
    if (typeof body.error === "string" && body.error) throw new ComposioWorkflowError("composio-execution-failed");
    return body.data && typeof body.data === "object" && !Array.isArray(body.data) ? (body.data as Record<string, unknown>) : {};
  }
}
