/** Operations Jev may select in one computer-use decision. */
export const AGENT_OPERATIONS = ["FILL", "SELECT", "CHECK", "CLICK", "WAIT", "DONE", "BLOCKED"] as const;

export type AgentOperation = (typeof AGENT_OPERATIONS)[number];
export type AgentExecutableOperation = Exclude<AgentOperation, "WAIT" | "DONE" | "BLOCKED">;

/**
 * One value-free action candidate. Values stay in the local executor; Jev sees only whether a field
 * is already filled and which operations the observed element safely supports.
 */
export interface AgentCandidate {
  id: string;
  kind: "button" | "link" | "field";
  label: string;
  context?: string;
  required: boolean;
  locked: boolean;
  filled: boolean;
  operations: AgentExecutableOperation[];
}

export interface AgentHistoryEntry {
  operation: AgentOperation;
  targetId?: string;
  targetLabel?: string;
  ok: boolean;
  changed: boolean;
  error?: string;
}

export interface AgentPageState {
  origin: string;
  url: string;
  title: string;
}

export interface AgentDecisionRequest {
  goal: string;
  page: AgentPageState;
  candidates: AgentCandidate[];
  recentActions: AgentHistoryEntry[];
}

export interface AgentDecisionResponse {
  operation: AgentOperation;
  targetId?: string;
  confidence: number;
  operationConfidence: number;
  targetConfidence?: number;
  provider: string;
  calibrated: boolean;
  latencyMs: number;
  fallbackFrom?: string;
}
