// Safety classes for a loop program (docs/compare-approaches.md §4 "A <- B, #2"). Approach B's catalog grades
// every action read / reversible / high-impact and maps that to a required confirmation mode; approach A had
// only a locked/unlocked bit. These are the same three words, derived from the program rather than declared
// in a catalog, so nothing between the preview and the run can talk a batch down to a cheaper confirmation.
import { isLockedAction } from "../locks";
import type { LoopProgram, LoopStep } from "./types";

/** What a step does to the world. `read` changes nothing, `reversible` can be undone, `high-impact` cannot. */
export type SafetyClass = "read" | "reversible" | "high-impact";

/** What the user must do before it runs. Rule 2: `explicit` is an Enter or a click, never a Tab. */
export type ConfirmationMode = "tab" | "review" | "explicit";

const RANK: Record<SafetyClass, number> = { read: 0, reversible: 1, "high-impact": 2 };
const MODE_RANK: Record<ConfirmationMode, number> = { tab: 0, review: 1, explicit: 2 };

export const CONFIRMATION_FOR: Record<SafetyClass, ConfirmationMode> = {
  read: "tab",
  reversible: "review",
  "high-impact": "explicit",
};

/** The same words approach B prints (`demo/public/workflow/index.html` renders `action.confirmation` + " approval"). */
export const CONFIRMATION_WORDS: Record<ConfirmationMode, string> = {
  tab: "tab approval",
  review: "review approval",
  explicit: "explicit approval",
};

/** True when `mode` is at least as strict as `required`. A weaker answer never satisfies a stronger demand. */
export function meetsConfirmation(mode: ConfirmationMode | undefined, required: ConfirmationMode): boolean {
  return mode !== undefined && MODE_RANK[mode] >= MODE_RANK[required];
}

export function stricterSafety(a: SafetyClass, b: SafetyClass): SafetyClass {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * One step's class. A step is high-impact when the recorder locked it, when the program lists it as an
 * irreversible effect, or when its own label reads irreversible on the live DOM's rules (`isLockedAction`):
 * a program that arrived from a cache, another tab or the server cannot lower its own grade by omitting a flag.
 */
export function classifyStep(step: LoopStep, listedIrreversible = false): SafetyClass {
  if (step.op === "extract" || step.op === "goto" || step.op === "open-item") return "read";
  if (listedIrreversible || step.locked === true) return "high-impact";
  if (isLockedAction({ text: step.target.label })) return "high-impact";
  return "reversible";
}

/** The whole program's class: the strictest of its steps. An empty program reads only. */
export function classifyProgram(program: LoopProgram): SafetyClass {
  const listed = new Set(program.irreversible.map((effect) => effect.stepIndex));
  let worst: SafetyClass = "read";
  program.steps.forEach((step, index) => {
    worst = stricterSafety(worst, classifyStep(step, listed.has(index)));
  });
  return worst;
}

/** The confirmation this program demands. The extension may ask for more, never for less. */
export function requiredConfirmation(program: LoopProgram): ConfirmationMode {
  return CONFIRMATION_FOR[classifyProgram(program)];
}

/** Step indexes that count as irreversible, including ones the recorder did not flag but the label gives away. */
export function highImpactSteps(program: LoopProgram): number[] {
  const listed = new Set(program.irreversible.map((effect) => effect.stepIndex));
  const out: number[] = [];
  program.steps.forEach((step, index) => {
    if (classifyStep(step, listed.has(index)) === "high-impact") out.push(index);
  });
  return out;
}

/** The chip the preview sheet shows, in approach B's vocabulary: "high-impact · explicit approval". */
export function safetyChip(program: LoopProgram): string {
  const safety = classifyProgram(program);
  return `${safety} · ${CONFIRMATION_WORDS[CONFIRMATION_FOR[safety]]}`;
}
