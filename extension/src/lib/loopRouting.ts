// Rules the loop runner (background) and the loop executor (content) must agree on: which page a step runs on,
// which steps need the batch confirmation, and the reserved variables the executor hands back through
// `LoopStepOutcome.extracted`. Pure: no DOM, no chrome.*.
import { normalizeUrl } from "@ghost/shared";
import type { LoopIterator, LoopStep } from "@ghost/shared";

/** Reserved variable: the page the current item opened into (origin + pathname). Never shown, never sent to a server. */
export const ITEM_URL_VAR = "@itemUrl";
const ROW_VAR_PREFIX = "@row|";

/** Reserved variable: the grid row picked by the item's first "next-empty" fill on a page; its later cells reuse it. */
export function rowVar(pathPattern: string): string {
  return `${ROW_VAR_PREFIX}${pathPattern}`;
}

export function isReservedVar(name: string): boolean {
  return name === ITEM_URL_VAR || name.startsWith(ROW_VAR_PREFIX);
}

/** A reserved variable is only accepted with a value of its own shape: a same-origin page url, or a row index. */
export function isValidReserved(name: string, value: string, origin: string): boolean {
  if (name === ITEM_URL_VAR) return normalizeUrl(value)?.origin === origin.toLowerCase() && !/[?#]/.test(value);
  return name.startsWith(ROW_VAR_PREFIX) && name.length <= 300 && /^\d{1,5}$/.test(value);
}

/** Locked clicks and locked fills: they run only after the batch confirmation, armed, and never twice. */
export function isLockedStep(step: LoopStep): boolean {
  return (step.op === "click" || step.op === "fill") && step.locked === true;
}

/** The path pattern of the page a step must run on; null when any page will do (goto, or a step recorded without a page). */
export function stepPagePattern(step: LoopStep, iterator: LoopIterator): string | null {
  if (step.op === "open-item") return iterator.pathPattern;
  if (step.op === "extract") return step.from.pathPattern;
  if (step.op === "goto") return null;
  return step.at?.pathPattern ?? null;
}

/**
 * The commit point of a locked step. The worker arms it only when the order answers a "ghost:loop-step-request"
 * sent from the page the step runs on, and the executor runs it only when it asked from there. Both sides call this.
 */
export function armsLockedStep(step: LoopStep, iterator: LoopIterator, askedFromPattern: string | null): boolean {
  if (!isLockedStep(step) || askedFromPattern === null) return false;
  const pattern = stepPagePattern(step, iterator);
  return pattern === null || pattern === askedFromPattern;
}

/** The list page's url, when its path has no id segment to guess. */
export function listUrlOf(iterator: LoopIterator): string | null {
  return iterator.pathPattern.includes(":id") ? null : `${iterator.origin}${iterator.pathPattern}`;
}
