import { AGENT_OPERATIONS } from "./agent";
import type { AgentExecutableOperation, AgentOperation } from "./agent";

export const AGENT_OUTCOME_SCHEMA = "ghost.agent-run.v1" as const;
export const AGENT_REPLAY_SCHEMA = "ghost.agent-replay.v1" as const;

export const AGENT_OUTCOME_STATES = ["done", "blocked", "cancelled"] as const;
export const AGENT_OUTCOME_REASONS = [
  "completed",
  "empty-goal",
  "cancelled",
  "decision-unavailable",
  "model-blocked",
  "no-progress",
  "low-confidence",
  "invalid-decision",
  "target-invalid",
  "execute-failed",
  "step-budget",
  "other",
] as const;
export const AGENT_OUTCOME_PROVIDERS = ["typesafe", "jev-gateway", "baseten", "llm", "heuristic", "other"] as const;
export const AGENT_CONFIDENCE_BUCKETS = ["under-55", "55-69", "70-84", "85-94", "95-plus"] as const;
export const AGENT_LATENCY_BUCKETS = ["under-100ms", "100-249ms", "250-499ms", "500-999ms", "1s-plus"] as const;
export const AGENT_DURATION_BUCKETS = ["under-250ms", "250-999ms", "1s-4.9s", "5s-14.9s", "15s-plus"] as const;
export const AGENT_ACTION_ERRORS = ["stale", "execute-failed", "other"] as const;

export type AgentOutcomeState = (typeof AGENT_OUTCOME_STATES)[number];
export type AgentOutcomeReason = (typeof AGENT_OUTCOME_REASONS)[number];
export type AgentOutcomeProvider = (typeof AGENT_OUTCOME_PROVIDERS)[number];
export type AgentConfidenceBucket = (typeof AGENT_CONFIDENCE_BUCKETS)[number];
export type AgentLatencyBucket = (typeof AGENT_LATENCY_BUCKETS)[number];
export type AgentDurationBucket = (typeof AGENT_DURATION_BUCKETS)[number];
export type AgentActionError = (typeof AGENT_ACTION_ERRORS)[number];

/** A structural page summary. It has no labels, identifiers, URL, DOM, or values. */
export interface AgentCandidateSummary {
  total: number;
  locked: number;
  filled: number;
  requiredOpen: number;
  availableOperations: AgentExecutableOperation[];
}

export interface AgentOutcomeDecision {
  step: number;
  operation: AgentOperation;
  provider: AgentOutcomeProvider;
  calibrated: boolean;
  fallback: boolean;
  confidence: AgentConfidenceBucket;
  latency: AgentLatencyBucket;
  candidates: AgentCandidateSummary;
}

export interface AgentOutcomeAction {
  operation: AgentOperation;
  ok: boolean;
  changed: boolean;
  error?: AgentActionError;
}

/**
 * The complete terminal telemetry envelope. Its type cannot represent any user-authored text or page identity.
 * Every untrusted boundary must still call sanitizeAgentRunOutcome: TypeScript alone is not a runtime boundary.
 */
export interface AgentRunOutcome {
  schemaVersion: typeof AGENT_OUTCOME_SCHEMA;
  runId: string;
  state: AgentOutcomeState;
  reason: AgentOutcomeReason;
  duration: AgentDurationBucket;
  steps: number;
  decisions: AgentOutcomeDecision[];
  actions: AgentOutcomeAction[];
}

export interface AgentReplayFixture {
  schemaVersion: typeof AGENT_REPLAY_SCHEMA;
  caseId: string;
  observed: AgentRunOutcome;
  expected: {
    state: AgentOutcomeState;
    reason: AgentOutcomeReason;
    maxSteps: number;
    decisionOperations: AgentOperation[];
    actionOperations: AgentOperation[];
  };
}

export interface AgentReplayEvaluation {
  passed: boolean;
  failures: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STEPS = 40;
const MAX_CANDIDATES = 1_000;
const EXECUTABLE: ReadonlySet<string> = new Set<AgentExecutableOperation>(["FILL", "SELECT", "CHECK", "CLICK"]);
const OPERATIONS: ReadonlySet<string> = new Set<AgentOperation>(AGENT_OPERATIONS);
const STATES = new Set<string>(AGENT_OUTCOME_STATES);
const REASONS = new Set<string>(AGENT_OUTCOME_REASONS);
const PROVIDERS = new Set<string>(AGENT_OUTCOME_PROVIDERS);
const CONFIDENCE = new Set<string>(AGENT_CONFIDENCE_BUCKETS);
const LATENCY = new Set<string>(AGENT_LATENCY_BUCKETS);
const DURATION = new Set<string>(AGENT_DURATION_BUCKETS);
const ACTION_ERRORS = new Set<string>(AGENT_ACTION_ERRORS);

export function agentConfidenceBucket(confidence: number): AgentConfidenceBucket {
  const value = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  if (value < 0.55) return "under-55";
  if (value < 0.7) return "55-69";
  if (value < 0.85) return "70-84";
  if (value < 0.95) return "85-94";
  return "95-plus";
}

export function agentLatencyBucket(ms: number): AgentLatencyBucket {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (value < 100) return "under-100ms";
  if (value < 250) return "100-249ms";
  if (value < 500) return "250-499ms";
  if (value < 1_000) return "500-999ms";
  return "1s-plus";
}

export function agentDurationBucket(ms: number): AgentDurationBucket {
  const value = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (value < 250) return "under-250ms";
  if (value < 1_000) return "250-999ms";
  if (value < 5_000) return "1s-4.9s";
  if (value < 15_000) return "5s-14.9s";
  return "15s-plus";
}

export function agentOutcomeProvider(value: string): AgentOutcomeProvider {
  return PROVIDERS.has(value) ? value as AgentOutcomeProvider : "other";
}

export function agentOutcomeReason(value: string | undefined, state: AgentOutcomeState): AgentOutcomeReason {
  if (state === "done") return "completed";
  if (!value) return state === "cancelled" ? "cancelled" : "other";
  if (REASONS.has(value)) return value as AgentOutcomeReason;
  // Executor errors can contain browser-specific detail. Collapse every unknown failure before telemetry.
  return state === "blocked" ? "execute-failed" : "other";
}

export function agentActionError(value: string | undefined): AgentActionError | undefined {
  if (!value) return undefined;
  return ACTION_ERRORS.has(value) ? value as AgentActionError : value === "stale" ? "stale" : "execute-failed";
}

/** Rebuild an outcome from its allowlist, dropping all unknown properties and rejecting invalid structure. */
export function sanitizeAgentRunOutcome(raw: unknown): AgentRunOutcome | null {
  if (!isObject(raw) || raw.schemaVersion !== AGENT_OUTCOME_SCHEMA || typeof raw.runId !== "string" || !UUID.test(raw.runId)) return null;
  if (typeof raw.state !== "string" || !STATES.has(raw.state) || typeof raw.reason !== "string" || !REASONS.has(raw.reason)) return null;
  if (typeof raw.duration !== "string" || !DURATION.has(raw.duration) || !boundedInteger(raw.steps, 0, MAX_STEPS)) return null;
  if (!Array.isArray(raw.decisions) || raw.decisions.length > MAX_STEPS || !Array.isArray(raw.actions) || raw.actions.length > MAX_STEPS) return null;

  const steps = raw.steps as number;
  const decisions: AgentOutcomeDecision[] = [];
  for (const value of raw.decisions) {
    const decision = sanitizeDecision(value);
    if (!decision) return null;
    decisions.push(decision);
  }
  const actions: AgentOutcomeAction[] = [];
  for (const value of raw.actions) {
    const action = sanitizeAction(value);
    if (!action) return null;
    actions.push(action);
  }
  if (!strictlyIncreasing(decisions.map((decision) => decision.step)) || decisions.some((decision) => decision.step > steps)) return null;

  return {
    schemaVersion: AGENT_OUTCOME_SCHEMA,
    runId: raw.runId.toLowerCase(),
    state: raw.state as AgentOutcomeState,
    reason: raw.reason as AgentOutcomeReason,
    duration: raw.duration as AgentDurationBucket,
    steps,
    decisions,
    actions,
  };
}

export function createAgentReplayFixture(outcome: AgentRunOutcome): AgentReplayFixture {
  return {
    schemaVersion: AGENT_REPLAY_SCHEMA,
    caseId: outcome.runId,
    observed: outcome,
    expected: {
      state: outcome.state,
      reason: outcome.reason,
      maxSteps: outcome.steps,
      decisionOperations: outcome.decisions.map((decision) => decision.operation),
      actionOperations: outcome.actions.map((action) => action.operation),
    },
  };
}

/** Compare a new redacted outcome with a reviewed replay expectation. Timing/provider variance is intentionally ignored. */
export function evaluateAgentReplay(fixture: AgentReplayFixture, actual: AgentRunOutcome = fixture.observed): AgentReplayEvaluation {
  const failures: string[] = [];
  if (actual.state !== fixture.expected.state) failures.push(`state:${actual.state}`);
  if (actual.reason !== fixture.expected.reason) failures.push(`reason:${actual.reason}`);
  if (actual.steps > fixture.expected.maxSteps) failures.push(`steps:${actual.steps}>${fixture.expected.maxSteps}`);
  if (!sameOperations(actual.decisions.map((decision) => decision.operation), fixture.expected.decisionOperations)) failures.push("decision-operations");
  if (!sameOperations(actual.actions.map((action) => action.operation), fixture.expected.actionOperations)) failures.push("action-operations");
  return { passed: failures.length === 0, failures };
}

function sanitizeDecision(raw: unknown): AgentOutcomeDecision | null {
  if (!isObject(raw) || !boundedInteger(raw.step, 1, MAX_STEPS) || typeof raw.operation !== "string" || !OPERATIONS.has(raw.operation)) return null;
  if (typeof raw.provider !== "string" || !PROVIDERS.has(raw.provider) || typeof raw.calibrated !== "boolean" || typeof raw.fallback !== "boolean") return null;
  if (typeof raw.confidence !== "string" || !CONFIDENCE.has(raw.confidence) || typeof raw.latency !== "string" || !LATENCY.has(raw.latency)) return null;
  const candidates = sanitizeCandidates(raw.candidates);
  if (!candidates) return null;
  return {
    step: raw.step,
    operation: raw.operation as AgentOperation,
    provider: raw.provider as AgentOutcomeProvider,
    calibrated: raw.calibrated,
    fallback: raw.fallback,
    confidence: raw.confidence as AgentConfidenceBucket,
    latency: raw.latency as AgentLatencyBucket,
    candidates,
  };
}

function sanitizeCandidates(raw: unknown): AgentCandidateSummary | null {
  if (!isObject(raw)) return null;
  const counts = [raw.total, raw.locked, raw.filled, raw.requiredOpen];
  if (!counts.every((value) => boundedInteger(value, 0, MAX_CANDIDATES))) return null;
  if ((raw.locked as number) > (raw.total as number) || (raw.filled as number) > (raw.total as number) || (raw.requiredOpen as number) > (raw.total as number)) return null;
  if (!Array.isArray(raw.availableOperations) || raw.availableOperations.length > EXECUTABLE.size) return null;
  const availableOperations: AgentExecutableOperation[] = [];
  for (const operation of raw.availableOperations) {
    if (typeof operation !== "string" || !EXECUTABLE.has(operation as AgentExecutableOperation) || availableOperations.includes(operation as AgentExecutableOperation)) return null;
    availableOperations.push(operation as AgentExecutableOperation);
  }
  return {
    total: raw.total as number,
    locked: raw.locked as number,
    filled: raw.filled as number,
    requiredOpen: raw.requiredOpen as number,
    availableOperations,
  };
}

function sanitizeAction(raw: unknown): AgentOutcomeAction | null {
  if (!isObject(raw) || typeof raw.operation !== "string" || !OPERATIONS.has(raw.operation) || typeof raw.ok !== "boolean" || typeof raw.changed !== "boolean") return null;
  if (raw.error !== undefined && (typeof raw.error !== "string" || !ACTION_ERRORS.has(raw.error))) return null;
  return {
    operation: raw.operation as AgentOperation,
    ok: raw.ok,
    changed: raw.changed,
    ...(raw.error === undefined ? {} : { error: raw.error as AgentActionError }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function strictlyIncreasing(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0));
}

function sameOperations(left: AgentOperation[], right: AgentOperation[]): boolean {
  return left.length === right.length && left.every((operation, index) => operation === right[index]);
}
