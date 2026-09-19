import type { ActionCandidate, ContextSnapshot, DecisionProvider, StructuredActionResult, WorkflowState } from "@ghost/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "../config";
import { UNTRUSTED_REAL_RUN, admit } from "../executors/access";
import { createDecisionProvider } from "../providers";
import { BadRequest, readJsonBody } from "../providers/validation";
import { ACTION_SPECS } from "../workflows/catalog";
import { advanceAfterAction, getRelevantActions, inferWorkflowKind, initialStep } from "../workflows/candidates";
import { ComposioWorkflowClient, ComposioWorkflowError } from "../workflows/composioClient";
import { InvalidContext, normalizeContextSnapshot } from "../workflows/context";
import { requestWorkflowPrediction, type WorkflowThresholds } from "../workflows/predict";
import { executeSimulated } from "../workflows/simulated";
import { WorkflowStore } from "../workflows/store";

const BODY_LIMIT = 96 * 1024;
const PREDICT_ROUTE = "/v1/workflows/predict";

export interface WorkflowRouteDeps {
  provider?: DecisionProvider;
  composio?: ComposioWorkflowClient;
  store?: WorkflowStore;
  thresholds?: Partial<WorkflowThresholds>;
  now?: () => number;
}

function string(value: unknown, name: string, max = 120): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new BadRequest(`${name} is required`);
  return value.trim();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequest("request body must be an object");
  return value as Record<string, unknown>;
}

function badRequest(c: Context, error: unknown): Response {
  if (error instanceof BadRequest || error instanceof InvalidContext) return c.json({ error: error.message }, 400);
  if (error instanceof ComposioWorkflowError) return c.json({ error: error.code }, error.status && error.status >= 400 && error.status < 500 ? 409 : 502);
  throw error;
}

function desiredActions(state: WorkflowState, context: ContextSnapshot): string[] {
  const ids: string[] = [];
  if (state.kind === "meeting") {
    if (state.step === "check-availability") ids.push("calendar.check_availability");
    if (state.step === "draft-response") ids.push("gmail.create_draft");
    if (state.step === "create-event") ids.push("calendar.create_event");
  }
  if (state.kind === "issue" && state.step === "create-issue") ids.push("github.create_issue");
  ids.push(...(context.relevantActionIds ?? []).filter((id) => ACTION_SPECS[id]?.definition.executor === "composio"));
  return [...new Set(ids)].slice(0, 8);
}

function prefetchActions(context: ContextSnapshot): string[] {
  const kind = inferWorkflowKind(context);
  const ids = kind === "meeting"
    ? ["calendar.check_availability", "gmail.create_draft", "calendar.create_event"]
    : kind === "issue"
      ? ["github.create_issue"]
      : [];
  ids.push(...(context.relevantActionIds ?? []).filter((id) => ACTION_SPECS[id]?.definition.executor === "composio"));
  return [...new Set(ids)].slice(0, 8);
}

function safeFacts(value: Record<string, unknown>): Record<string, string | boolean | number> {
  const result: Record<string, string | boolean | number> = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (!/^[A-Za-z][\w.-]{0,63}$/.test(key)) continue;
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) result[key] = item;
    else if (typeof item === "string" && item.length <= 500 && !/(token|secret|password|credential|auth)/i.test(key)) result[key] = item;
  }
  return result;
}

function makeResult(candidate: ActionCandidate, workflowId: string, facts: Record<string, unknown>, simulated: boolean, now: () => number): StructuredActionResult {
  return { workflowId, actionId: candidate.id, ok: true, facts: safeFacts(facts), simulated, completedAt: now() };
}

function advance(store: WorkflowStore, state: WorkflowState, actionId: string): void {
  const next = advanceAfterAction(state, actionId);
  store.advance(state, next.step, next.completed ? "completed" : "active");
}

export function registerWorkflowRoutes(app: Hono, config: ServerConfig, deps: WorkflowRouteDeps = {}): void {
  const now = deps.now ?? Date.now;
  const store = deps.store ?? new WorkflowStore(now);
  const provider = deps.provider ?? createDecisionProvider(config);
  const composio = deps.composio ?? (config.composio ? new ComposioWorkflowClient({ apiKey: config.composio.apiKey }) : undefined);
  const thresholds: WorkflowThresholds = { high: deps.thresholds?.high ?? 0.75, medium: deps.thresholds?.medium ?? 0.55 };
  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);
  const access = { extensionId: config.extensionId, executeToken: config.executeToken };
  const requireTrusted = (c: Context): Response | undefined => {
    const caller = admit(c, access);
    if (caller instanceof Response) return caller;
    return caller.trusted ? undefined : c.json({ error: UNTRUSTED_REAL_RUN }, 403);
  };

  app.get("/v1/workflows/:userId", (c) => {
    const userId = string(c.req.param("userId"), "userId");
    return c.json({ workflow: store.current(userId) ?? null, composioConfigured: Boolean(composio) });
  });

  app.get("/v1/composio/connections", async (c) => {
    try {
      const userId = string(c.req.query("userId"), "userId");
      if (!composio) return c.json({ configured: false, connections: [] });
      const refusal = requireTrusted(c);
      if (refusal) return refusal;
      return c.json({ configured: true, connections: await composio.listConnectedToolkits(userId) });
    } catch (error) {
      return badRequest(c, error);
    }
  });

  app.post("/v1/composio/connect-link", bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }), async (c) => {
    try {
      if (!composio) return c.json({ error: "COMPOSIO_API_KEY is required" }, 503);
      const refusal = requireTrusted(c);
      if (refusal) return refusal;
      const raw = object(await readJsonBody(c.req, 16 * 1024));
      const userId = string(raw.userId, "userId");
      const toolkit = string(raw.toolkit, "toolkit", 80).toLowerCase();
      const callbackUrl = typeof raw.callbackUrl === "string" && /^https:\/\//.test(raw.callbackUrl) ? raw.callbackUrl : undefined;
      return c.json(await composio.createConnectLink(userId, toolkit, callbackUrl), 201);
    } catch (error) {
      return badRequest(c, error);
    }
  });

  app.post("/v1/composio/oauth-complete", bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }), async (c) => {
    try {
      if (!composio) return c.json({ error: "COMPOSIO_API_KEY is required" }, 503);
      const refusal = requireTrusted(c);
      if (refusal) return refusal;
      const raw = object(await readJsonBody(c.req, 16 * 1024));
      const userId = string(raw.userId, "userId");
      const toolkit = string(raw.toolkit, "toolkit", 80).toLowerCase();
      if (typeof raw.sessionUri === "string" && raw.sessionUri.length) await composio.completeAuth(userId, string(raw.sessionUri, "sessionUri", 2000));
      const connections = await composio.listConnectedToolkits(userId);
      const connection = connections.find((item) => item.toolkit === toolkit && item.status === "ACTIVE");
      return connection ? c.json({ connected: true, connection }) : c.json({ connected: false, toolkit }, 202);
    } catch (error) {
      return badRequest(c, error);
    }
  });

  app.post("/v1/composio/prefetch", bodyLimit({ maxSize: BODY_LIMIT, onError: tooLarge }), async (c) => {
    try {
      if (!composio) return c.json({ error: "COMPOSIO_API_KEY is required" }, 503);
      const refusal = requireTrusted(c);
      if (refusal) return refusal;
      const raw = object(await readJsonBody(c.req, BODY_LIMIT));
      const userId = string(raw.userId, "userId");
      const context = normalizeContextSnapshot(raw.context, now());
      const warmed = await composio.prefetch(userId, prefetchActions(context));
      return c.json({
        connectedToolkits: warmed.connections.filter((item) => item.status === "ACTIVE").map((item) => item.toolkit),
        availableActionIds: [...warmed.capabilities.keys()],
      });
    } catch (error) {
      return badRequest(c, error);
    }
  });

  app.post(PREDICT_ROUTE, bodyLimit({ maxSize: BODY_LIMIT, onError: tooLarge }), async (c) => {
    try {
      const raw = object(await readJsonBody(c.req, BODY_LIMIT));
      const userId = string(raw.userId, "userId");
      const demo = raw.demo === true;
      if (composio && !demo) {
        const refusal = requireTrusted(c);
        if (refusal) return refusal;
      }
      let context = normalizeContextSnapshot(raw.context, now());
      if (composio && !demo) {
        const connections = composio.peekConnectedToolkits(userId);
        context = { ...context, connectedToolkits: [...new Set(connections.filter((item) => item.status === "ACTIVE").map((item) => item.toolkit))] };
      }
      let state = store.current(userId);
      const kind = inferWorkflowKind(context);
      if (!state || state.status !== "active" || (context.workflow?.id && context.workflow.id !== state.id)) state = store.start(userId, kind, initialStep(kind));
      const capabilities = composio && !demo ? composio.peekCapabilities(userId, desiredActions(state, context)) : new Map();
      const candidates = getRelevantActions(context, state, capabilities, demo);
      const prediction = await requestWorkflowPrediction(provider, context, state, candidates, thresholds);
      if (prediction.suggestion && prediction.selectedCandidate) store.saveSuggestion(userId, prediction.suggestion, prediction.selectedCandidate);
      return c.json({ workflow: state, suggestion: prediction.suggestion ?? null, alternatives: prediction.alternatives, candidates: candidates.map(({ preparedArguments: _args, ...candidate }) => candidate), demo });
    } catch (error) {
      return badRequest(c, error);
    }
  });

  app.post("/v1/workflows/approve", bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }), async (c) => {
    try {
      const raw = object(await readJsonBody(c.req, 16 * 1024));
      const userId = string(raw.userId, "userId");
      const workflowId = string(raw.workflowId, "workflowId");
      const actionId = string(raw.actionId, "actionId");
      const confirmation = string(raw.confirmation, "confirmation") as "tab" | "review" | "explicit";
      if (!new Set(["tab", "review", "explicit"]).has(confirmation)) throw new BadRequest("invalid confirmation");
      const candidate = store.candidate(userId, workflowId, actionId);
      if (!candidate) return c.json({ error: "suggestion is stale" }, 409);
      if (candidate.executor === "composio" && !candidate.simulated) {
        const refusal = requireTrusted(c);
        if (refusal) return refusal;
      }
      if (candidate.confirmation !== confirmation) return c.json({ error: `${candidate.confirmation} confirmation is required` }, 409);
      const approval = store.approve(userId, workflowId, actionId, confirmation);
      if (!approval) return c.json({ error: "suggestion is stale" }, 409);
      return c.json({ executionToken: approval.token, expiresAt: approval.expiresAt });
    } catch (error) {
      return badRequest(c, error);
    }
  });

  app.post("/v1/workflows/execute", bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }), async (c) => {
    try {
      const raw = object(await readJsonBody(c.req, 16 * 1024));
      const userId = string(raw.userId, "userId");
      const workflowId = string(raw.workflowId, "workflowId");
      const token = string(raw.executionToken, "executionToken", 200);
      const pending = store.approval(token, userId, workflowId);
      if (pending?.candidate.executor === "composio" && !pending.candidate.simulated) {
        const refusal = requireTrusted(c);
        if (refusal) return refusal;
      }
      const approval = store.redeem(token, userId, workflowId);
      if (!approval) return c.json({ error: "execution token is invalid, used, or expired" }, 409);
      const state = store.get(userId, workflowId);
      if (!state) return c.json({ error: "workflow is stale" }, 409);
      const candidate = approval.candidate;
      if (candidate.executor === "local") {
        const completionToken = store.beginLocalCompletion(userId, workflowId, candidate);
        return c.json({ localAction: { id: candidate.id, arguments: candidate.preparedArguments }, completionToken, workflow: state });
      }
      const simulated = candidate.simulated === true;
      if (!simulated && !composio) return c.json({ error: "COMPOSIO_API_KEY is required" }, 503);
      const facts = simulated ? executeSimulated(candidate) : await composio!.execute(userId, candidate);
      const result = makeResult(candidate, workflowId, facts, simulated, now);
      store.record(result);
      advance(store, state, candidate.id);
      return c.json({ result, workflow: state });
    } catch (error) {
      return badRequest(c, error);
    }
  });

  app.post("/v1/workflows/local-result", bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }), async (c) => {
    try {
      const raw = object(await readJsonBody(c.req, 16 * 1024));
      const userId = string(raw.userId, "userId");
      const workflowId = string(raw.workflowId, "workflowId");
      const completionToken = string(raw.completionToken, "completionToken", 200);
      const candidate = store.finishLocalCompletion(completionToken, userId, workflowId);
      const state = store.get(userId, workflowId);
      if (!candidate || !state) return c.json({ error: "local completion is invalid or expired" }, 409);
      const ok = raw.ok === true;
      const result: StructuredActionResult = {
        workflowId,
        actionId: candidate.id,
        ok,
        ...(ok ? { facts: { localActionCompleted: true } } : { errorCode: string(raw.errorCode ?? "local-action-failed", "errorCode", 80) }),
        simulated: false,
        completedAt: now(),
      };
      store.record(result);
      if (ok) advance(store, state, candidate.id);
      return c.json({ result, workflow: state });
    } catch (error) {
      return badRequest(c, error);
    }
  });
}
