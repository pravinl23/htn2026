import { assertConfirmed, report } from "./steps";
import type { ExecutorMode, LoopExecutor } from "./types";

export const MISSING_KEY_REASON: Record<ExecutorMode, string> = {
  parallel: "Add BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID to enable parallel cloud execution",
  api: "Add COMPOSIO_API_KEY to enable API execution",
};

/**
 * Stands in when a key is missing so the mode selector can be demoed end to end.
 * Touches nothing: every item reports ok after a 0 ms delay and the report says `simulated: true`.
 */
export function createStubExecutor(mode: ExecutorMode, now: () => number = Date.now): LoopExecutor {
  return {
    mode,
    available: false,
    reason: MISSING_KEY_REASON[mode],
    async check() {
      // Nothing is reached, so nothing can be unreachable.
    },
    async run(job, { onProgress } = {}) {
      assertConfirmed(job);
      const startedAt = now();
      const steps = job.program.steps.length;
      const results = job.items.map((item, i) => {
        onProgress?.({ index: item.index, ok: true, done: i + 1, total: job.items.length });
        return { index: item.index, ok: true, steps };
      });
      return report(mode, results, startedAt, true, now);
    },
  };
}
