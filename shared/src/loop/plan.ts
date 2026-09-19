import type { LoopProgram } from "./types";

/**
 * Item indexes still to run: from iterator.nextIndex in steps of stride, inside the list,
 * skipping items already handled (by the user, by an earlier run, or showing a handled marker).
 */
export function planRemaining(program: LoopProgram, totalItems: number, handledIndexes: Iterable<number> = []): number[] {
  const { nextIndex, stride } = program.iterator;
  if (stride === 0 || !Number.isFinite(totalItems)) return [];
  const handled = new Set(handledIndexes);
  const out: number[] = [];
  for (let i = nextIndex; i >= 0 && i < totalItems; i += stride) if (!handled.has(i)) out.push(i);
  return out;
}

/** One line per irreversible effect for the single batch confirmation, e.g. "Reply: received x 48". */
export function describeIrreversible(program: LoopProgram, count: number): string[] {
  if (count <= 0) return [];
  return program.irreversible.map((effect) => `${effect.description} x ${count}`);
}
