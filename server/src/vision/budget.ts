export const DEFAULT_VISION_BUDGET = 200;
const MAX_VISION_BUDGET = 100_000;

/** Counts billed vision requests (retries included) for the life of the process. Numbers only. */
export class VisionBudget {
  private used = 0;

  constructor(readonly limit: number) {}

  /** Takes one unit, or returns false when the budget is spent. */
  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }

  remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  snapshot(): { limit: number; used: number; remaining: number } {
    return { limit: this.limit, used: this.used, remaining: this.remaining() };
  }
}

/** GHOST_VISION_BUDGET: a whole number of calls, 0 switches vision off. Anything unreadable keeps the default. */
export function budgetLimitFrom(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(n) || n < 0) return DEFAULT_VISION_BUDGET;
  return Math.min(n, MAX_VISION_BUDGET);
}

let processBudget: VisionBudget | undefined;

/** One budget per process, however many apps register the routes: the guard is about money, not about an app. */
export function processVisionBudget(limit: number): VisionBudget {
  processBudget ??= new VisionBudget(limit);
  return processBudget;
}
