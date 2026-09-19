import { isSensitive, type ContextSnapshot, type RecentWorkflowAction, type WorkflowResultSummary } from "@ghost/shared";

const MAX_WINDOW = 240;
const MAX_TEXT = 600;
const MAX_NEARBY = 10;
const MAX_RECENT = 12;
const MAX_PREFERENCES = 12;
const SECRETISH = /(?:bearer\s+[a-z0-9._~-]+|api[_ -]?key\s*[:=]\s*\S+|token\s*[:=]\s*\S+|-----BEGIN [A-Z ]+PRIVATE KEY-----)/gi;
const PAYMENT_RUN = /\b(?:\d[ -]*?){13,19}\b/g;

export class InvalidContext extends Error {}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(SECRETISH, "[redacted]").replace(PAYMENT_RUN, "[redacted]").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function smallScalar(value: unknown): string | boolean | number | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return text(value, 160);
}

function result(value: unknown): WorkflowResultSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const actionId = text(raw.actionId, 100);
  if (!actionId || typeof raw.ok !== "boolean") return undefined;
  const facts: Record<string, string | boolean | number> = {};
  if (raw.facts && typeof raw.facts === "object" && !Array.isArray(raw.facts)) {
    for (const [key, item] of Object.entries(raw.facts as Record<string, unknown>).slice(0, 16)) {
      const safeKey = text(key, 80);
      const safeValue = smallScalar(item);
      if (safeKey && safeValue !== undefined && !isSensitive({ label: safeKey })) facts[safeKey] = safeValue;
    }
  }
  return { actionId, ok: raw.ok, ...(Object.keys(facts).length ? { facts } : {}), ...(text(raw.errorCode, 80) ? { errorCode: text(raw.errorCode, 80) } : {}) };
}

function recentActions(value: unknown): RecentWorkflowAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set(["accepted", "rejected", "ignored", "succeeded", "failed"]);
  const actions = value.slice(-MAX_RECENT).flatMap((item): RecentWorkflowAction[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const actionId = text(raw.actionId, 100);
    if (!actionId || typeof raw.outcome !== "string" || !allowed.has(raw.outcome)) return [];
    return [{ actionId, at: timestamp(raw.at, 0), outcome: raw.outcome as RecentWorkflowAction["outcome"] }];
  });
  return actions.length ? actions : undefined;
}

/** Defense in depth for native callers and demo/browser callers alike. Unknown fields are deliberately discarded. */
export function normalizeContextSnapshot(input: unknown, now: number = Date.now()): ContextSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidContext("context must be an object");
  const raw = input as Record<string, unknown>;
  const app = raw.activeApplication;
  if (!app || typeof app !== "object" || Array.isArray(app)) throw new InvalidContext("activeApplication is required");
  const appRaw = app as Record<string, unknown>;
  const name = text(appRaw.name, 100);
  const bundleIdentifier = text(appRaw.bundleIdentifier, 180);
  if (!name || !bundleIdentifier) throw new InvalidContext("activeApplication name and bundleIdentifier are required");

  let focusedElement: ContextSnapshot["focusedElement"];
  if (raw.focusedElement && typeof raw.focusedElement === "object" && !Array.isArray(raw.focusedElement)) {
    const focused = raw.focusedElement as Record<string, unknown>;
    const role = text(focused.role, 80);
    const label = text(focused.label, 180);
    if (role && !/secure|password/i.test(role) && !isSensitive({ label: `${label ?? ""} ${role}` })) {
      focusedElement = {
        role,
        ...(label ? { label } : {}),
        ...(text(focused.identifier, 160) ? { identifier: text(focused.identifier, 160) } : {}),
        ...(text(focused.editableValue, 300) ? { editableValue: text(focused.editableValue, 300) } : {}),
        ...(text(focused.selectedText, 300) ? { selectedText: text(focused.selectedText, 300) } : {}),
        ...(text(focused.safeValueToInsert, MAX_TEXT) ? { safeValueToInsert: text(focused.safeValueToInsert, MAX_TEXT) } : {}),
      };
    }
  }

  const nearbyText = Array.isArray(raw.nearbyText)
    ? raw.nearbyText.slice(0, MAX_NEARBY).flatMap((item) => {
        const value = text(item, MAX_TEXT);
        return value ? [value] : [];
      })
    : [];
  const connectedToolkits = Array.isArray(raw.connectedToolkits)
    ? [...new Set(raw.connectedToolkits.flatMap((item) => (text(item, 80) ? [text(item, 80)!.toLowerCase()] : [])))].slice(0, 20)
    : [];
  const relevantActionIds = Array.isArray(raw.relevantActionIds)
    ? [...new Set(raw.relevantActionIds.flatMap((item) => (text(item, 100) ? [text(item, 100)!] : [])))].slice(0, 30)
    : [];

  const preferences: Record<string, string | boolean | number> = {};
  if (raw.preferences && typeof raw.preferences === "object" && !Array.isArray(raw.preferences)) {
    for (const [key, value] of Object.entries(raw.preferences as Record<string, unknown>).slice(0, MAX_PREFERENCES)) {
      const safeKey = text(key, 80);
      const safeValue = smallScalar(value);
      if (safeKey && safeValue !== undefined && !isSensitive({ label: safeKey })) preferences[safeKey] = safeValue;
    }
  }

  const workflowRaw = raw.workflow && typeof raw.workflow === "object" && !Array.isArray(raw.workflow) ? (raw.workflow as Record<string, unknown>) : undefined;
  const workflowId = text(workflowRaw?.id, 100);
  const workflowKind = text(workflowRaw?.kind, 60);
  const workflowStep = text(workflowRaw?.step, 80);
  const workflowStatus = workflowRaw?.status;
  const statuses = new Set(["active", "completed", "failed", "cancelled"]);

  const previousPredictionRaw = raw.previousPrediction && typeof raw.previousPrediction === "object" ? (raw.previousPrediction as Record<string, unknown>) : undefined;
  const previousActionId = text(previousPredictionRaw?.actionId, 100);
  const previousConfidence = previousPredictionRaw?.confidence;

  return {
    version: 1,
    timestamp: timestamp(raw.timestamp, now),
    activeApplication: { name, bundleIdentifier },
    ...(text(raw.windowTitle, MAX_WINDOW) ? { windowTitle: text(raw.windowTitle, MAX_WINDOW) } : {}),
    ...(focusedElement ? { focusedElement } : {}),
    ...(nearbyText.length ? { nearbyText } : {}),
    ...(workflowId && workflowKind && workflowStep && typeof workflowStatus === "string" && statuses.has(workflowStatus)
      ? { workflow: { id: workflowId, kind: workflowKind, step: workflowStep, status: workflowStatus as NonNullable<ContextSnapshot["workflow"]>["status"] } }
      : {}),
    ...(recentActions(raw.recentActions) ? { recentActions: recentActions(raw.recentActions) } : {}),
    ...(previousActionId && typeof previousConfidence === "number" && Number.isFinite(previousConfidence)
      ? { previousPrediction: { actionId: previousActionId, confidence: Math.max(0, Math.min(1, previousConfidence)) } }
      : {}),
    ...(result(raw.previousActionResult) ? { previousActionResult: result(raw.previousActionResult) } : {}),
    ...(connectedToolkits.length ? { connectedToolkits } : {}),
    ...(relevantActionIds.length ? { relevantActionIds } : {}),
    ...(Object.keys(preferences).length ? { preferences } : {}),
  };
}
