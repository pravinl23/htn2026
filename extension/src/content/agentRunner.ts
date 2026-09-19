import type {
  AgentCandidate,
  AgentDecisionRequest,
  AgentDecisionResponse,
  AgentExecutableOperation,
  AgentHistoryEntry,
  AgentPageState,
} from "@ghost/shared";

export interface AgentExecutionResult {
  ok: boolean;
  error?: string;
}

export interface AgentObservation {
  page: AgentPageState;
  candidates: AgentCandidate[];
  /** Value-free hash of URL, labels, supported operations and filled/locked state. */
  fingerprint: string;
  execute(operation: AgentExecutableOperation, targetId: string): Promise<AgentExecutionResult>;
}

export type AgentRunState = "running" | "done" | "blocked" | "cancelled";

export interface AgentRunUpdate {
  state: AgentRunState;
  step: number;
  goal: string;
  decision?: AgentDecisionResponse;
  history: AgentHistoryEntry[];
  reason?: string;
}

export interface AgentRunnerDeps {
  observe(): AgentObservation;
  decide(request: AgentDecisionRequest): Promise<AgentDecisionResponse | null>;
  confidenceThreshold(): number;
  wait?(ms: number): Promise<void>;
  onUpdate?(update: AgentRunUpdate): void;
  maxSteps?: number;
  waitMs?: number;
}

const EXECUTABLE = new Set<AgentExecutableOperation>(["FILL", "SELECT", "CHECK", "CLICK"]);
const MAX_NO_CHANGE = 3;

/**
 * Provider-independent observe -> choose -> freshness-check -> act -> observe loop. The adapter owns DOM/AX
 * details; this core never receives profile values and never executes an operation outside the closed vocabulary.
 */
export class AgentRunner {
  private generation = 0;
  private running = false;

  constructor(private readonly deps: AgentRunnerDeps) {}

  get active(): boolean {
    return this.running;
  }

  cancel(): void {
    this.generation++;
    this.running = false;
  }

  async run(goal: string): Promise<AgentRunUpdate> {
    const trimmed = goal.trim();
    if (!trimmed) return this.finish("blocked", 0, goal, [], "empty-goal");
    if (this.running) this.cancel();
    const generation = ++this.generation;
    this.running = true;
    const history: AgentHistoryEntry[] = [];
    const maxSteps = this.deps.maxSteps ?? 40;
    let noChange = 0;
    this.emit({ state: "running", step: 0, goal: trimmed, history: [] });

    for (let step = 1; step <= maxSteps; step++) {
      if (!this.current(generation)) return this.finish("cancelled", step - 1, trimmed, history, "cancelled");
      const observed = this.deps.observe();
      const decision = await this.deps.decide({
        goal: trimmed,
        page: observed.page,
        candidates: observed.candidates,
        recentActions: history.slice(-10),
      }).catch(() => null);
      if (!this.current(generation)) return this.finish("cancelled", step - 1, trimmed, history, "cancelled");
      if (!decision) return this.finish("blocked", step, trimmed, history, "decision-unavailable");
      this.emit({ state: "running", step, goal: trimmed, decision, history: [...history] });

      if (decision.operation === "DONE") return this.finish("done", step, trimmed, history, undefined, decision);
      if (decision.operation === "BLOCKED") return this.finish("blocked", step, trimmed, history, "model-blocked", decision);

      if (decision.operation === "WAIT") {
        await (this.deps.wait ?? delay)(this.deps.waitMs ?? 180);
        const after = this.deps.observe();
        const changed = after.fingerprint !== observed.fingerprint;
        history.push({ operation: "WAIT", ok: true, changed });
        noChange = changed ? 0 : noChange + 1;
        if (noChange >= MAX_NO_CHANGE) return this.finish("blocked", step, trimmed, history, "no-progress", decision);
        continue;
      }

      const threshold = Math.max(0, Math.min(1, this.deps.confidenceThreshold()));
      // FILL/SELECT/CHECK do not carry a model-authored value: a calibrated model can only permit the
      // one local frontier Ghost, and the executor verifies it. CLICK can change navigation or app state,
      // so it keeps a strict calibrated floor. Uncalibrated mutations keep the user's full threshold.
      const localValue = decision.operation === "FILL" || decision.operation === "SELECT" || decision.operation === "CHECK";
      const effectiveThreshold = decision.calibrated && localValue
        ? 0
        : decision.calibrated ? Math.max(0.55, threshold * 0.78) : threshold;
      if (decision.confidence < effectiveThreshold) return this.finish("blocked", step, trimmed, history, "low-confidence", decision);

      if (!EXECUTABLE.has(decision.operation) || !decision.targetId) {
        return this.finish("blocked", step, trimmed, history, "invalid-decision", decision);
      }

      // The model chose against `observed`; execute only if a fresh read is byte-for-byte the same structural state.
      const fresh = this.deps.observe();
      if (fresh.fingerprint !== observed.fingerprint) {
        history.push({ operation: decision.operation, targetId: decision.targetId, ok: false, changed: true, error: "stale" });
        noChange = 0;
        continue;
      }
      const target = fresh.candidates.find((candidate) => candidate.id === decision.targetId);
      if (!target || target.locked || target.filled || !target.operations.includes(decision.operation)) {
        return this.finish("blocked", step, trimmed, history, "target-invalid", decision);
      }

      const result = await fresh.execute(decision.operation, decision.targetId).catch(() => ({ ok: false, error: "execute-failed" }));
      const after = this.deps.observe();
      const changed = after.fingerprint !== fresh.fingerprint;
      history.push({
        operation: decision.operation,
        targetId: decision.targetId,
        targetLabel: target.label,
        ok: result.ok,
        changed,
        ...(result.error ? { error: result.error } : {}),
      });
      if (!result.ok) return this.finish("blocked", step, trimmed, history, result.error ?? "execute-failed", decision);
      noChange = changed ? 0 : noChange + 1;
      if (noChange >= MAX_NO_CHANGE) return this.finish("blocked", step, trimmed, history, "no-progress", decision);
    }
    return this.finish("blocked", maxSteps, trimmed, history, "step-budget");
  }

  private current(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private emit(update: AgentRunUpdate): void {
    this.deps.onUpdate?.(update);
  }

  private finish(
    state: AgentRunState,
    step: number,
    goal: string,
    history: AgentHistoryEntry[],
    reason?: string,
    decision?: AgentDecisionResponse,
  ): AgentRunUpdate {
    if (state !== "cancelled") this.running = false;
    const update: AgentRunUpdate = { state, step, goal, history: [...history], ...(decision ? { decision } : {}), ...(reason ? { reason } : {}) };
    this.emit(update);
    return update;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
