/**
 * Who owns Tab on this page (docs/compare-approaches.md, "One owner of Tab per moment").
 *
 * Ghost binds keydown on `window` in the CAPTURE phase and swallows Tab with preventDefault +
 * stopPropagation, so a page that runs its own Tab-driven surface (approach B's workflow page, a command
 * palette, a spreadsheet, an editor) can never win the key by registering first. This module is the page's
 * way to say so, and Ghost's promise to stand down. Two spellings, both read from the document itself:
 *
 *   Opt out for the whole document (static, in the served HTML):
 *     <meta name="ghost-tab" content="off">
 *     <html data-ghost-tab="off">
 *
 *   Yield only while your own surface is up (dynamic, O(1) to read on every key press and every frame):
 *     document.documentElement.dataset.ghostTab = "active";   // Ghost stands down
 *     delete document.documentElement.dataset.ghostTab;       // Ghost comes back
 *
 * `off` means Ghost does nothing here at all: no capture, no ghosts, no overlay, no next-action, no loop
 * sheet. `active` is momentary: Ghost keeps its session but draws nothing and never takes Tab or Escape.
 * Fail-closed by design — a page can only ever make Ghost quieter, never louder.
 */

export const TAB_META_NAME = "ghost-tab";
export const TAB_ATTR = "data-ghost-tab";
/** `content`/attribute values that mean "off". Anything unrecognized is ignored, so a typo never disables Ghost silently. */
const OFF_VALUES = new Set(["off", "none", "false", "0", "disabled"]);
const ACTIVE = "active";

function rootValue(doc: Document): string {
  return (doc.documentElement?.getAttribute(TAB_ATTR) ?? "").trim().toLowerCase();
}

/** The static opt-out: the page owns Tab for its whole life, so Ghost never starts here. */
export function ghostOptedOut(doc: Document = document): boolean {
  if (OFF_VALUES.has(rootValue(doc))) return true;
  // Scoped to <head>, whose child list is short: this is read on every rescan, never over the whole DOM.
  const meta = doc.head?.querySelector(`meta[name="${TAB_META_NAME}"]`)?.getAttribute("content");
  return typeof meta === "string" && OFF_VALUES.has(meta.trim().toLowerCase());
}

/** The page's own Tab surface is up right now (a suggestion, a palette, a picker): yield the key to it. */
export function tabSurfaceActive(doc: Document = document): boolean {
  return rootValue(doc) === ACTIVE;
}

/** Either spelling: while this is true no Ghost component may draw a ghost or take Tab or Escape. */
export function pageOwnsTab(doc: Document = document): boolean {
  return ghostOptedOut(doc) || tabSurfaceActive(doc);
}
