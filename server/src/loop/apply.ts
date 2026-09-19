import type { Mapping } from "./candidates";
import type { ServerExtractStep, ServerLoopProgram, ServerLoopStep } from "./transforms";

export interface VerifiedMapping extends Mapping {
  /** The unresolved fill's variable. */
  var: string;
}

/** The shared heuristic multiplies confidence by this for every unresolved fill (PENALTY.unresolved in shared/src/loop/synthesize.ts). */
const UNRESOLVED_PENALTY = 0.5;
/** A model-picked source, verified in code against both runs: better than an open hole, weaker than a heuristic match. */
const MODEL_RESOLVED_PENALTY = 0.85;

function sameSource(step: ServerLoopStep, m: Mapping): step is ServerExtractStep {
  return (
    step.op === "extract" && step.from.pathPattern === m.pathPattern && step.from.locator.by === m.locator.by &&
    step.from.locator.value === m.locator.value && step.from.transform === m.transform
  );
}

/** Page pattern on screen once `step` has run, given what was on screen before it. */
function pageAfter(step: ServerLoopStep, before: string | undefined, program: ServerLoopProgram): string | undefined {
  if (step.op === "open-item") return program.iterator.itemPathPattern;
  if (step.op === "goto") return step.pathPattern;
  if (step.op === "fill" || step.op === "click") return step.at?.pathPattern ?? before;
  return before;
}

/** Extracts sit where their page first comes on screen (the shared synthesizer hoists them the same way), never after the fill. */
function insertionIndex(steps: ServerLoopStep[], program: ServerLoopProgram, pathPattern: string, fillIndex: number): number {
  for (let i = fillIndex - 1; i >= 0; i--) {
    const sibling = steps[i];
    if (sibling?.op === "extract" && sibling.from.pathPattern === pathPattern) return i + 1;
  }
  let page: string | undefined = program.iterator.pathPattern;
  for (let i = 0; i < fillIndex; i++) {
    if (page === pathPattern) return i;
    const step = steps[i];
    if (step) page = pageAfter(step, page, program);
  }
  return fillIndex;
}

function reindex<T extends { stepIndex: number }>(entries: T[], before: ServerLoopStep[], after: ServerLoopStep[], moved: Map<ServerLoopStep, ServerLoopStep>): T[] {
  return entries.flatMap((entry) => {
    const old = before[entry.stepIndex];
    const stepIndex = old === undefined ? -1 : after.indexOf(moved.get(old) ?? old);
    return stepIndex < 0 ? [] : [{ ...entry, stepIndex }];
  });
}

/** Turns verified mappings into extract steps. Never mutates the input program. */
export function applyMappings(program: ServerLoopProgram, mappings: VerifiedMapping[]): ServerLoopProgram {
  const steps = [...program.steps];
  const replaced = new Map<ServerLoopStep, ServerLoopStep>();
  const resolved = new Set<string>();
  for (const m of mappings) {
    const fillIndex = steps.findIndex((s) => s.op === "fill" && "var" in s.value && s.value.var === m.var);
    const fill = steps[fillIndex];
    if (!fill || fill.op !== "fill" || resolved.has(m.var)) continue;
    resolved.add(m.var);
    const existing = steps.find((s, i): s is ServerExtractStep => i < fillIndex && sameSource(s, m));
    if (existing) {
      const rewired: ServerLoopStep = { ...fill, value: { var: existing.var } };
      steps[fillIndex] = rewired;
      replaced.set(fill, rewired);
      continue;
    }
    const from: ServerExtractStep["from"] = { pathPattern: m.pathPattern, locator: m.locator };
    if (m.transform !== undefined) from.transform = m.transform;
    steps.splice(insertionIndex(steps, program, m.pathPattern, fillIndex), 0, { op: "extract", var: m.var, from });
  }
  const confidence = Math.min(1, Math.round(program.confidence * (MODEL_RESOLVED_PENALTY / UNRESOLVED_PENALTY) ** resolved.size * 100) / 100);
  return {
    ...program,
    steps,
    confidence,
    irreversible: reindex(program.irreversible, program.steps, steps, replaced),
    unresolved: reindex((program.unresolved ?? []).filter((u) => !resolved.has(u.var)), program.steps, steps, replaced),
  };
}
