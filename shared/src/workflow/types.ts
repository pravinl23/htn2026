export type WorkflowSafetyLevel = "read" | "reversible" | "high-impact";
export type WorkflowConfirmation = "tab" | "review" | "explicit";
export type WorkflowStatus = "active" | "completed" | "failed" | "cancelled";

export interface FocusedElementContext {
  role: string;
  label?: string;
  identifier?: string;
  /** Present only for a non-secure editable element. Kept short by the context normalizer. */
  editableValue?: string;
  selectedText?: string;
  /** Text already produced locally and safe to offer as a fill. Jev never writes this value. */
  safeValueToInsert?: string;
}

export interface RecentWorkflowAction {
  actionId: string;
  at: number;
  outcome: "accepted" | "rejected" | "ignored" | "succeeded" | "failed";
}

export interface WorkflowResultSummary {
  actionId: string;
  ok: boolean;
  /** Small, non-sensitive facts intentionally carried into the next decision. */
  facts?: Record<string, string | boolean | number>;
  errorCode?: string;
}

/**
 * Compact state that may leave the Mac. It is built from AX metadata, not screenshots. Values from secure or
 * sensitive-labelled elements must be removed before this object is constructed and are checked again by the server.
 */
export interface ContextSnapshot {
  version: 1;
  timestamp: number;
  activeApplication: { name: string; bundleIdentifier: string };
  windowTitle?: string;
  focusedElement?: FocusedElementContext;
  nearbyText?: string[];
  workflow?: { id: string; kind: string; step: string; status: WorkflowStatus };
  recentActions?: RecentWorkflowAction[];
  previousPrediction?: { actionId: string; confidence: number };
  previousActionResult?: WorkflowResultSummary;
  connectedToolkits?: string[];
  relevantActionIds?: string[];
  preferences?: Record<string, string | boolean | number>;
}

export interface ActionParameterDefinition {
  name: string;
  type: "string" | "number" | "boolean" | "string[]" | "object";
  required: boolean;
  description: string;
}

/** A stable application action. Tool slugs and prepared arguments are execution details and never Jev output. */
export interface ActionDefinition {
  id: string;
  title: string;
  description: string;
  executor: "local" | "composio" | "none";
  toolkit?: string;
  toolSlug?: string;
  requiredParameters: ActionParameterDefinition[];
  safety: WorkflowSafetyLevel;
  confirmation: WorkflowConfirmation;
  available: boolean;
  suggestWhen: string;
  excludeWhen: string;
}

export interface ActionCandidate extends ActionDefinition {
  /** Complete arguments prepared by deterministic code. They are never included in Jev criteria. */
  preparedArguments: Record<string, unknown>;
  preview: string;
  simulated?: boolean;
}

export interface WorkflowSuggestion {
  workflowId: string;
  action: ActionDefinition;
  preview: string;
  confidence: number;
  provider: string;
  calibrated: boolean;
  alternatives: Array<{ actionId: string; title: string; confidence: number }>;
  simulated: boolean;
}

export interface WorkflowState {
  id: string;
  userId: string;
  kind: "meeting" | "issue" | "generic";
  step: string;
  status: WorkflowStatus;
  createdAt: number;
  updatedAt: number;
  facts: Record<string, string | boolean | number>;
  history: WorkflowResultSummary[];
  currentSuggestion?: WorkflowSuggestion;
}

export interface StructuredActionResult extends WorkflowResultSummary {
  workflowId: string;
  simulated: boolean;
  completedAt: number;
}
