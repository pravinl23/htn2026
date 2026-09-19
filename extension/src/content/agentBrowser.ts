import type { AgentCandidate, AgentExecutableOperation, CapturedField, Ghost, GhostSettings, Profile } from "@ghost/shared";
import { captureFields, findElement } from "./capture";
import { executeGhost } from "./execute";
import type { DraftScheduler } from "./freeText";
import { isPlaceholderChoice, planForm } from "./predict";
import type { AgentObservation } from "./agentRunner";

export interface BrowserAgentDeps {
  getProfile(): Profile;
  getSettings(): GhostSettings;
  drafts?: DraftScheduler;
  doc?: Document;
  settleAfterClickMs?: number;
}

interface LocalAction {
  candidate: AgentCandidate;
  ghost: Ghost;
  el: HTMLElement;
}

const VALUE_KINDS = new Set(["text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox"]);

function candidateKind(field: CapturedField): AgentCandidate["kind"] {
  return field.kind === "button" || field.kind === "link" ? field.kind : "field";
}

function operationOf(ghost: Ghost): AgentExecutableOperation {
  if (ghost.action === "fill") return "FILL";
  if (ghost.action === "select") return "SELECT";
  if (ghost.action === "check") return "CHECK";
  return "CLICK";
}

function isFilled(field: CapturedField): boolean {
  const value = field.value ?? "";
  if (field.kind === "checkbox") return value === "true";
  if (field.kind === "radio") return value !== "";
  if (field.kind === "select") {
    const option = field.options?.find((candidate) => candidate.value === value);
    return !isPlaceholderChoice(value, option?.label ?? "");
  }
  return VALUE_KINDS.has(field.kind) && value !== "";
}

function contextOf(field: CapturedField, executable: boolean): string | undefined {
  const parts = [field.required ? "required" : "optional", field.context];
  if (!executable && !isFilled(field) && candidateKind(field) === "field") parts.push("no safe local value available");
  return parts.filter(Boolean).join(" — ") || undefined;
}

function fingerprint(page: AgentObservation["page"], candidates: AgentCandidate[]): string {
  const state = JSON.stringify({
    page,
    candidates: candidates.map(({ id, label, locked, filled, operations }) => ({ id, label, locked, filled, operations })),
  });
  let hash = 2166136261;
  for (let i = 0; i < state.length; i++) hash = Math.imul(hash ^ state.charCodeAt(i), 16777619);
  return `agent-${(hash >>> 0).toString(16)}`;
}

function clickGhost(field: CapturedField): Ghost {
  return { signature: field.signature, action: "click", displayText: field.label, confidence: 1, locked: field.locked === true, source: "offline" };
}

/** Browser adapter: values live only in `LocalAction.ghost` and are never copied into the Jev candidates. */
export function createBrowserAgentObserver(deps: BrowserAgentDeps): () => AgentObservation {
  const doc = deps.doc ?? document;
  return () => {
    const fields = captureFields(doc);
    const plan = planForm(fields, [], { profile: deps.getProfile(), settings: deps.getSettings(), drafts: deps.drafts }, "offline");
    const ghosts = new Map(plan.ghosts.map((ghost) => [ghost.signature, ghost]));
    const actions = new Map<string, LocalAction>();
    const candidates: AgentCandidate[] = [];

    for (const field of fields) {
      const el = findElement(field.signature);
      if (!el) continue;
      const actionGhost = field.kind === "button" || field.kind === "link" ? clickGhost(field) : ghosts.get(field.signature);
      const operations = actionGhost && !actionGhost.pending ? [operationOf(actionGhost)] : [];
      const candidate: AgentCandidate = {
        id: field.signature,
        kind: candidateKind(field),
        label: field.label || field.kind,
        context: contextOf(field, operations.length > 0),
        required: field.required === true,
        locked: field.locked === true,
        filled: isFilled(field),
        operations,
      };
      candidates.push(candidate);
      if (actionGhost && operations.length > 0) actions.set(field.signature, { candidate, ghost: actionGhost, el });
    }

    const page = {
      origin: doc.location?.origin ?? "",
      url: (doc.location?.href ?? "").split(/[?#]/)[0] ?? "",
      title: doc.title.slice(0, 300),
    };

    return {
      page,
      candidates,
      fingerprint: fingerprint(page, candidates),
      async execute(operation, targetId) {
        const action = actions.get(targetId);
        if (!action || !action.candidate.operations.includes(operation)) return { ok: false, error: "operation-mismatch" };
        const result = await executeGhost(action.ghost, action.el);
        if (result.ok && operation === "CLICK") await new Promise((resolve) => setTimeout(resolve, deps.settleAfterClickMs ?? 50));
        return { ok: result.ok, ...(result.reason ? { error: result.reason } : {}) };
      },
    };
  };
}
