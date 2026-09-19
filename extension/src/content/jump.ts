// The jump pill: ghosts are ready but the current one is off screen and focus is nowhere. The pill is
// the visible ghost that makes the first Tab Ghost's; that Tab only scrolls and focuses, it fills nothing.
import { isRendered, measurable } from "./visibility";

export type JumpDirection = "up" | "down";

export interface JumpHint {
  /** Unlocked ghosts waiting. The locked Submit is not something Tab can do. */
  count: number;
  direction: JumpDirection;
}

/**
 * Which way the element lies when none of it is in the viewport. Null when any part is on screen, or
 * when it has no box (display:none, or jsdom): there is nothing to jump to.
 */
export function offscreenDirection(el: HTMLElement): JumpDirection | null {
  const view = el.ownerDocument.defaultView;
  const rect = measurable(el).getBoundingClientRect();
  if (!view || (rect.width === 0 && rect.height === 0)) return null;
  const above = rect.bottom <= 0 || rect.right <= 0;
  const below = rect.top >= view.innerHeight || rect.left >= view.innerWidth;
  if (!above && !below) return null; // the common case on every scroll frame: no style lookup needed
  return isRendered(el) ? (above ? "up" : "down") : null;
}

/** True when the user has not put focus anywhere: the only state in which the pill may claim Tab. */
export function focusOnBody(doc: Document): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || active === doc.documentElement;
}

export function jumpLabel(hint: JumpHint): string {
  return `${hint.count} ${hint.count === 1 ? "ghost" : "ghosts"} ready`;
}
