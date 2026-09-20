/** What the user can actually see right now. Shared by the controller (whose Tab is it?) and the overlay (what to draw). */

export type Placement = "inside" | "partial" | "outside" | "unknown";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function hasLayout(doc: Document): boolean {
  const r = doc.documentElement.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

export function clipsOverflow(style: CSSStyleDeclaration): boolean {
  return [style.overflow, style.overflowX, style.overflowY].some((value) => Boolean(value) && value !== "visible");
}

/** Custom radios and checkboxes park the real input off-page and style the label instead. */
export function measurable(el: HTMLElement): HTMLElement {
  const rect = el.getBoundingClientRect();
  const label = (el as HTMLInputElement).labels?.[0];
  return rect.width < 2 && rect.height < 2 && label ? label : el;
}

export function placement(el: HTMLElement): Placement {
  const view = el.ownerDocument.defaultView;
  const rect = measurable(el).getBoundingClientRect();
  if (!view) return "unknown";
  // No box at all: jsdom cannot measure anything, a real browser is saying display:none or collapsed.
  if (rect.width === 0 && rect.height === 0) return hasLayout(el.ownerDocument) ? "outside" : "unknown";
  const { innerWidth: width, innerHeight: height } = view;
  if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= height || rect.left >= width) return "outside";
  const inside = rect.top >= 0 && rect.left >= 0 && rect.bottom <= height && rect.right <= width;
  return inside ? "inside" : "partial";
}

/** Ancestors that cut their content off: scroll containers, overflow:hidden cards, modal bodies. */
export function clippingAncestors(el: Element): HTMLElement[] {
  const view = el.ownerDocument.defaultView;
  const out: HTMLElement[] = [];
  if (!view) return out;
  for (let n = el.parentElement; n && n !== el.ownerDocument.body && n !== el.ownerDocument.documentElement; n = n.parentElement) {
    if (clipsOverflow(view.getComputedStyle(n))) out.push(n);
  }
  return out;
}

export function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function belongsTo(el: HTMLElement, hit: Element): boolean {
  if (hit === el || el.contains(hit)) return true;
  const labels = Array.from((el as HTMLInputElement).labels ?? []);
  return labels.some((label) => label === hit || label.contains(hit));
}

/**
 * True when something else is painted over the middle of the element's visible part: a sticky header,
 * a modal, the edge of a scroll container. Engines without hit testing (jsdom) never report cover.
 */
export function isCovered(el: HTMLElement): boolean {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  if (!view || typeof doc.elementFromPoint !== "function") return false;
  const r = measurable(el).getBoundingClientRect();
  const seen = intersect({ x: r.left, y: r.top, width: r.width, height: r.height }, { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight });
  if (seen.width === 0 || seen.height === 0) return false; // off screen is placement()'s call, not cover
  const hit = doc.elementFromPoint(seen.x + seen.width / 2, seen.y + seen.height / 2);
  return hit !== null && !belongsTo(el, hit);
}

/** checkVisibility sees CSS-only hiding (:checked ~ .panel, closed popovers) that no mutation reports. */
export function isRendered(el: HTMLElement): boolean {
  const target = measurable(el);
  if (typeof target.checkVisibility !== "function") return true;
  return target.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
}
