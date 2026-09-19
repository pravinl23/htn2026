import { randomBytes, randomUUID } from "node:crypto";
import type { ActionCandidate, StructuredActionResult, WorkflowState, WorkflowSuggestion } from "@ghost/shared";

interface Approval {
  token: string;
  userId: string;
  workflowId: string;
  candidate: ActionCandidate;
  confirmation: "tab" | "review" | "explicit";
  expiresAt: number;
}

export class WorkflowStore {
  private readonly states = new Map<string, WorkflowState>();
  private readonly users = new Map<string, string>();
  private readonly candidates = new Map<string, ActionCandidate>();
  private readonly approvals = new Map<string, Approval>();
  private readonly localCompletions = new Map<string, { userId: string; workflowId: string; candidate: ActionCandidate; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  current(userId: string): WorkflowState | undefined {
    const id = this.users.get(userId);
    return id ? this.states.get(id) : undefined;
  }

  start(userId: string, kind: WorkflowState["kind"], step: string, facts: WorkflowState["facts"] = {}): WorkflowState {
    const at = this.now();
    const state: WorkflowState = { id: randomUUID(), userId, kind, step, status: "active", createdAt: at, updatedAt: at, facts: { ...facts }, history: [] };
    this.states.set(state.id, state);
    this.users.set(userId, state.id);
    return state;
  }

  get(userId: string, workflowId: string): WorkflowState | undefined {
    const state = this.states.get(workflowId);
    return state?.userId === userId ? state : undefined;
  }

  saveSuggestion(userId: string, suggestion: WorkflowSuggestion, candidate: ActionCandidate): WorkflowState {
    const state = this.get(userId, suggestion.workflowId);
    if (!state) throw new Error("workflow not found");
    state.currentSuggestion = suggestion;
    state.updatedAt = this.now();
    this.candidates.set(`${state.id}:${candidate.id}`, candidate);
    return state;
  }

  candidate(userId: string, workflowId: string, actionId: string): ActionCandidate | undefined {
    return this.get(userId, workflowId) ? this.candidates.get(`${workflowId}:${actionId}`) : undefined;
  }

  approve(userId: string, workflowId: string, actionId: string, confirmation: Approval["confirmation"]): Approval | undefined {
    const state = this.get(userId, workflowId);
    const candidate = this.candidate(userId, workflowId, actionId);
    if (!state || !candidate || state.currentSuggestion?.action.id !== actionId) return undefined;
    const token = randomBytes(24).toString("base64url");
    const approval: Approval = { token, userId, workflowId, candidate, confirmation, expiresAt: this.now() + 5 * 60_000 };
    this.approvals.set(token, approval);
    return approval;
  }

  redeem(token: string, userId: string, workflowId: string): Approval | undefined {
    const approval = this.approvals.get(token);
    this.approvals.delete(token);
    if (!approval || approval.userId !== userId || approval.workflowId !== workflowId || approval.expiresAt < this.now()) return undefined;
    return approval;
  }

  approval(token: string, userId: string, workflowId: string): Approval | undefined {
    const approval = this.approvals.get(token);
    return approval && approval.userId === userId && approval.workflowId === workflowId && approval.expiresAt >= this.now() ? approval : undefined;
  }

  beginLocalCompletion(userId: string, workflowId: string, candidate: ActionCandidate): string {
    const token = randomBytes(24).toString("base64url");
    this.localCompletions.set(token, { userId, workflowId, candidate, expiresAt: this.now() + 60_000 });
    return token;
  }

  finishLocalCompletion(token: string, userId: string, workflowId: string): ActionCandidate | undefined {
    const pending = this.localCompletions.get(token);
    this.localCompletions.delete(token);
    if (!pending || pending.userId !== userId || pending.workflowId !== workflowId || pending.expiresAt < this.now()) return undefined;
    return pending.candidate;
  }

  record(result: StructuredActionResult): WorkflowState | undefined {
    const state = this.states.get(result.workflowId);
    if (!state) return undefined;
    state.history.push({ actionId: result.actionId, ok: result.ok, facts: result.facts, errorCode: result.errorCode });
    if (result.ok && result.facts) Object.assign(state.facts, result.facts);
    state.currentSuggestion = undefined;
    state.updatedAt = this.now();
    return state;
  }

  advance(state: WorkflowState, step: string, status: WorkflowState["status"] = "active"): void {
    state.step = step;
    state.status = status;
    state.updatedAt = this.now();
  }
}
