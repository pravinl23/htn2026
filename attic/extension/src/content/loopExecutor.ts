// The loop executor's content half (docs/loops.md 3.5): runs ONE step of one item in a document, either the tab's
// own document (visible mode) or a hidden same-origin frame (background mode), and verifies what it did. It never
// decides what runs next: the background worker hands out every step and stops the run on the first failure.
//
// Frame documents live in another realm, so nothing here uses `instanceof` on page elements.
import { applyTransform, isLockedAction, isSensitive, normalizeUrl } from "@ghost/shared";
import type { Ghost, LoopStep, StepTarget } from "@ghost/shared";
import type { LoopStepOrder } from "../lib/loopMessages";
import { ITEM_URL_VAR, isLockedStep, listUrlOf, rowVar, stepPagePattern } from "../lib/loopRouting";
import { accessibleName, computeSignature, isElementSensitive } from "./capture";
import { itemUrlFromElement } from "./dryRun";
import { executeGhost } from "./execute";
import { cellOf, handledIndexes, listItems } from "./listContext";
import { looksSensitiveValue, resolveLocator } from "./pageFacts";
import { markSynthetic, withSynthetic } from "./trace";

/** What a page is opened for: the iterator's list, the current item, or a constant page such as the sheet. */
export type PageRole = "list" | "item" | "page";

/** Where steps run. Two implementations in loopSurface.ts: the tab itself, and hidden frames next to it. */
export interface LoopSurface {
  /** True when steps run in hidden frames: nothing is clicked only to navigate, and no cursor is shown. */
  readonly framed: boolean;
  /** The surface's document that shows `url` (origin + pathname) right now, or null. */
  documentAt(url: string): Document | null;
  /** Every document of the surface, the most specific first. */
  documents(): Document[];
  /** Shows `url`. False when it cannot. In the real tab a full page load ends this script; the next page takes over. */
  open(url: string, role: PageRole): Promise<boolean>;
  /** Visible mode: the ghost cursor glides onto the target (about 120 ms per step). */
  showTarget?(el: HTMLElement, locked: boolean): Promise<void>;
}

export interface StepResult {
  ok: boolean;
  /** Short code, never page content. */
  error?: string;
  extracted?: { var: string; value: string; confidence: number };
  /** Runs AFTER the outcome was reported: a click that may unload this page, so its result could never be sent. */
  afterReport?: () => void;
}

export type PrepareResult = { ok: true; url: string; pathPattern: string } | { ok: false; error: string };

export interface LoopExecutor {
  /** Brings up the page the step runs on and says where that is: a locked step is armed by asking from there. */
  prepare(order: LoopStepOrder): Promise<PrepareResult>;
  /** `armed`: the order answered a step request sent from the step's own page (see lib/loopRouting.ts). */
  run(order: LoopStepOrder, armed: boolean): Promise<StepResult>;
}

export interface ExecutorOptions {
  /** How long a target, a locator or a list item may take to render. Default 3000. */
  waitMs?: number;
  /** How long to look for the visible effect of a click. Default 400. */
  effectMs?: number;
  pollMs?: number;
}

type ExtractStep = Extract<LoopStep, { op: "extract" }>;
type FillStep = Extract<LoopStep, { op: "fill" }>;
type ClickStep = Extract<LoopStep, { op: "click" }>;
type ValueControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const FIELDS = "input, textarea, select";
const ACTIONS = 'button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"], input[type="reset"], summary';
const GRID = 'table, [role="grid"], [role="table"], [role="treegrid"]';
const HIDDEN = '[hidden], [aria-hidden="true"], [inert]';
const NOT_TEXT_TYPES = new Set(["hidden", "file", "submit", "button", "reset", "image", "password", "checkbox", "radio", "range", "color"]);
const MAX_CANDIDATES = 400;
/** After a reported click that navigates, the next step gives the page this long to arrive before opening it itself. */
const NAVIGATION_GRACE_MS = 1500;

const fail = (error: string): StepResult => ({ ok: false, error });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- places ----------

export function urlOfDocument(doc: Document): string | null {
  try {
    return normalizeUrl(doc.location.href)?.url ?? null;
  } catch {
    return null; // a frame that went cross-origin
  }
}

function patternOfUrl(url: string): string | null {
  return normalizeUrl(url)?.pathPattern ?? null;
}

interface Place {
  /** The exact page, when it is known. */
  url: string | null;
  /** Null: any page will do. */
  pathPattern: string | null;
  role: PageRole;
  locked: boolean;
}

/** The page a step runs on. An item page is only known by url once open-item reported it (ITEM_URL_VAR). */
function placeOf(order: LoopStepOrder): Place {
  const { step, iterator, vars } = order;
  const locked = isLockedStep(step);
  if (step.op === "open-item") return { url: listUrlOf(iterator), pathPattern: iterator.pathPattern, role: "list", locked };
  if (step.op === "goto") return { url: normalizeUrl(step.url)?.url ?? null, pathPattern: step.pathPattern, role: "page", locked };
  const pathPattern = stepPagePattern(step, iterator);
  if (pathPattern === null) return { url: null, pathPattern, role: "page", locked };
  const itemUrl = vars[ITEM_URL_VAR];
  if (itemUrl !== undefined && patternOfUrl(itemUrl) === pathPattern) return { url: itemUrl, pathPattern, role: "item", locked };
  if (pathPattern === iterator.pathPattern) return { url: listUrlOf(iterator), pathPattern, role: "list", locked };
  const origin = step.op === "extract" ? iterator.origin : step.at?.origin ?? iterator.origin;
  return { url: pathPattern.includes(":id") ? null : `${origin}${pathPattern}`, pathPattern, role: "page", locked };
}

// ---------- names, locks, targets (realm independent) ----------

function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function labelKey(text: string): string {
  return squash(text).replace(/[\s*:]+$/, "").toLowerCase();
}

function sameRealm(el: Element): boolean {
  return typeof window !== "undefined" && el.ownerDocument.defaultView === window;
}

function isAction(el: Element): boolean {
  return el.matches(ACTIONS);
}

function referencedText(el: Element, attribute: string): string {
  const ids = (el.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean);
  return squash(ids.map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "").join(" "));
}

function labelTagText(el: Element): string {
  const id = el.getAttribute("id");
  const byFor = id ? Array.from(el.ownerDocument.querySelectorAll("label")).find((label) => label.getAttribute("for") === id) : undefined;
  return squash((byFor ?? el.closest("label"))?.textContent);
}

/** capture.ts names elements of our own realm; this covers frame documents, where its `instanceof` checks cannot work. */
function frameName(el: Element): string {
  const aria = referencedText(el, "aria-labelledby") || squash(el.getAttribute("aria-label"));
  if (aria) return aria;
  if (isAction(el)) return squash(el.textContent) || squash(el.getAttribute("value")) || squash(el.getAttribute("title"));
  return labelTagText(el) || squash(el.getAttribute("placeholder")) || squash(el.getAttribute("title"));
}

export function nameOfTarget(el: Element): string {
  return sameRealm(el) ? accessibleName(el) : frameName(el);
}

/** The DOM is the source of truth right before an activation: a step recorded as unlocked never clicks a locked control. */
export function looksLocked(el: Element): boolean {
  if (el.closest("[data-ghost-lock]")) return true;
  if (!isAction(el)) return false;
  const native = el.tagName === "BUTTON" || el.tagName === "INPUT";
  return isLockedAction({
    text: nameOfTarget(el),
    buttonType: native ? el.getAttribute("type") ?? "" : undefined,
    insideForm: native && el.closest("form") !== null,
  });
}

/** capture.ts plus a realm-independent look at the control's own name and attributes (frames). */
export function isSensitiveTarget(el: Element): boolean {
  const own = (name: string): string | undefined => el.getAttribute(name) ?? undefined;
  const probe = { inputType: own("type"), autocomplete: own("autocomplete"), name: own("name"), id: own("id"), placeholder: own("placeholder") };
  return isElementSensitive(el) || isSensitive({ ...probe, label: nameOfTarget(el), markedSensitive: el.closest("[data-ghost-sensitive], [data-sensitive]") !== null });
}

function isHidden(el: Element): boolean {
  return el.closest(HIDDEN) !== null;
}

function signatureOf(el: Element): string | null {
  if (!sameRealm(el)) return null;
  try {
    return computeSignature(el);
  } catch {
    return null;
  }
}

/** Label first (cheap, works in every realm); the recorded signature settles ties and renamed controls. */
export function findTarget(doc: Document, target: StepTarget): HTMLElement | null {
  const selector = target.kind === "button" || target.kind === "link" ? ACTIONS : FIELDS;
  const all = Array.from(doc.querySelectorAll<HTMLElement>(selector)).filter((el) => !isHidden(el)).slice(0, MAX_CANDIDATES);
  const wanted = labelKey(target.label);
  const named = wanted === "" ? [] : all.filter((el) => labelKey(nameOfTarget(el)) === wanted);
  if (named.length === 1 || (named.length > 1 && !target.signature)) return named[0] ?? null;
  if (!target.signature) return null;
  const bySignature = (named.length > 0 ? named : all).find((el) => signatureOf(el) === target.signature);
  return bySignature ?? named[0] ?? null;
}

// ---------- grid cells ----------

function isTextControl(el: Element): el is ValueControl {
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !NOT_TEXT_TYPES.has((el.getAttribute("type") ?? "text").toLowerCase());
}

interface GridCell {
  el: ValueControl;
  row: number;
  colHeader: string;
}

function gridCells(doc: Document, colHeader: string): GridCell[] {
  const wanted = labelKey(colHeader);
  const byGrid = new Map<Element, GridCell[]>();
  for (const el of doc.querySelectorAll<HTMLElement>(FIELDS)) {
    const cell = isTextControl(el) && !isHidden(el) ? cellOf(el) : null;
    if (!cell) continue;
    const grid = el.closest(GRID) ?? doc.body;
    const cells = byGrid.get(grid) ?? [];
    cells.push({ el: el as ValueControl, row: cell.row, colHeader: cell.colHeader });
    byGrid.set(grid, cells);
  }
  // The first grid that has the column at all.
  for (const cells of byGrid.values()) if (cells.some((c) => labelKey(c.colHeader) === wanted)) return cells;
  return [];
}

/** A sensitive cell is never read: its row simply does not count as free. */
function isBlank(cell: GridCell): boolean {
  return !isElementSensitive(cell.el) && cell.el.value.trim() === "";
}

/**
 * "next-empty": the first row whose cells are all empty. Later fills of the same item reuse the row it picked.
 * `value` makes a repeated first fill land where it landed before: a page that died between writing the cell and
 * reporting it must not leave a half row behind and start another one.
 */
export function findCell(doc: Document, colHeader: string, rowHint: number | null, value?: string): { el: HTMLElement; row: number } | null {
  const cells = gridCells(doc, colHeader);
  const wanted = labelKey(colHeader);
  const inRow = (r: number): GridCell[] => cells.filter((c) => c.row === r);
  const rows = [...new Set(cells.map((c) => c.row))].sort((a, b) => a - b);
  const isOurs = (c: GridCell): boolean => labelKey(c.colHeader) === wanted && !isElementSensitive(c.el) && c.el.value === value;
  const interrupted = value ? rows.find((r) => inRow(r).some(isOurs) && inRow(r).every((c) => isOurs(c) || isBlank(c))) : undefined;
  const row = rowHint ?? interrupted ?? rows.find((r) => inRow(r).every(isBlank));
  if (row === undefined) return null;
  const hit = inRow(row).find((c) => labelKey(c.colHeader) === wanted);
  return hit ? { el: hit.el, row } : null;
}

// ---------- the executor ----------

export function createLoopExecutor(surface: LoopSurface, opts: ExecutorOptions = {}): LoopExecutor {
  const waitMs = opts.waitMs ?? 3000;
  const effectMs = opts.effectMs ?? 400;
  const pollMs = opts.pollMs ?? 25;
  /** Set when a reported click is about to navigate the tab: the next step waits for that page first. */
  let navigatingUntil = 0;

  async function waitFor<T>(probe: () => T | null | undefined, ms: number): Promise<T | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = probe();
      if (found !== null && found !== undefined) return found;
      if (Date.now() >= deadline) return null;
      await sleep(pollMs);
    }
  }

  function lookUp(place: Place): Document | null {
    if (place.url !== null) return surface.documentAt(place.url);
    const docs = surface.documents();
    if (place.pathPattern === null) return docs[docs.length - 1] ?? null; // recorded without a page: the tab's own document
    // Without the item's url only the pattern is left. Good enough to read or type in the tab the user watches; never
    // for a frame (it may still hold the previous item) and never for a locked step.
    if (surface.framed || place.locked) return null;
    return docs.find((doc) => patternOfUrl(urlOfDocument(doc) ?? "") === place.pathPattern) ?? null;
  }

  async function pageFor(place: Place): Promise<Document | null> {
    const grace = Math.max(0, navigatingUntil - Date.now());
    const shown = grace > 0 ? await waitFor(() => lookUp(place), grace) : lookUp(place);
    navigatingUntil = 0;
    if (shown || place.url === null) return shown;
    return (await surface.open(place.url, place.role)) ? lookUp(place) : null;
  }

  function clickLater(el: HTMLElement): () => void {
    return () => {
      navigatingUntil = Date.now() + NAVIGATION_GRACE_MS;
      markSynthetic(NAVIGATION_GRACE_MS); // the recorder tags the click and the navigation it causes as Ghost's own
      el.click();
    };
  }

  // ----- open-item -----

  function itemUrl(item: Element, origin: string): string | null {
    const href = itemUrlFromElement(item);
    const where = href ? normalizeUrl(href) : null;
    return where && where.origin === origin.toLowerCase() ? where.url : null;
  }

  async function openItem(order: LoopStepOrder, listDoc: Document): Promise<StepResult> {
    const { iterator } = order;
    const item = await waitFor(() => listItems(listDoc, iterator.listSignature)[order.item], waitMs);
    if (!item) return fail("item-missing");
    // An item that already shows a handled marker is never done again (the list of handled indexes can be cut short).
    if (handledIndexes([item]).length > 0) return fail("item-handled");
    const url = itemUrl(item, iterator.origin);
    const opened = url ? { var: ITEM_URL_VAR, value: url, confidence: 1 } : undefined;
    if (surface.framed) {
      const href = url ? itemUrlFromElement(item) : null;
      if (!url || !href || !opened) return fail("item-link-missing");
      return (await surface.open(href, "item")) && surface.documentAt(url) ? { ok: true, extracted: opened } : fail("navigation-failed");
    }
    const link = (item.closest("a[href]") ?? item.querySelector("a[href]") ?? item) as HTMLElement;
    if (looksLocked(link)) return fail("locked-target");
    await surface.showTarget?.(link, false);
    return opened ? { ok: true, extracted: opened, afterReport: clickLater(link) } : { ok: true, afterReport: clickLater(link) };
  }

  // ----- extract -----

  /** A locator that names something sensitive is never resolved, whatever the page puts there (same rule as the dry run). */
  function namesSensitive(step: ExtractStep): boolean {
    const { locator } = step.from;
    return isSensitive(locator.by === "label" ? { label: locator.value } : { name: locator.value, label: step.var });
  }

  function readOnce(doc: Document, step: ExtractStep): string | null {
    const el = resolveLocator(doc, step.from.locator);
    if (!el || isElementSensitive(el)) return null;
    const text = squash(el.textContent); // never a form control's value
    return text === "" || looksSensitiveValue(text) ? null : text;
  }

  async function extract(order: LoopStepOrder, step: ExtractStep, doc: Document): Promise<StepResult> {
    if (namesSensitive(step)) return fail("sensitive");
    const text = await waitFor(() => readOnce(doc, step), waitMs);
    if (text === null) return fail("extract-missing");
    const value = applyTransform(text, step.from.transform);
    if (value === null || value.trim() === "") return fail("extract-untransformable");
    return { ok: true, extracted: { var: step.var, value, confidence: 1 } };
  }

  // ----- fill -----

  function ghostFor(step: FillStep, value: string): Ghost {
    const kind = step.target.kind;
    const action = kind === "checkbox" ? "check" : kind === "select" ? "select" : "fill";
    return { signature: step.target.signature ?? "ghost-loop-step", action, value, displayText: value, confidence: 1, locked: false, source: "loop" };
  }

  async function fill(order: LoopStepOrder, step: FillStep, doc: Document, armed: boolean): Promise<StepResult> {
    if (isLockedStep(step) && !(order.confirmed === true && armed)) return fail("locked-unconfirmed");
    const value = "const" in step.value ? step.value.const : order.vars[step.value.var];
    if (value === undefined || ("var" in step.value && value.trim() === "")) return fail("value-missing");
    const cell = step.target.cell;
    const rowName = rowVar(step.at?.pathPattern ?? patternOfUrl(urlOfDocument(doc) ?? "") ?? "/");
    const known = order.vars[rowName];
    const rowHint = known !== undefined && /^\d+$/.test(known) ? Number(known) : null;
    const found = await waitFor(() => (cell ? findCell(doc, cell.colHeader, rowHint, value) : wrap(findTarget(doc, step.target))), waitMs);
    if (!found) return fail(cell ? "row-missing" : "target-missing");
    if (isSensitiveTarget(found.el)) return fail("sensitive"); // never typed into, whatever the program says
    if (!isLockedStep(step) && looksLocked(found.el)) return fail("locked-target");
    await surface.showTarget?.(found.el, isLockedStep(step));
    const written = await executeGhost(ghostFor(step, value), found.el); // refuses sensitive fields, verifies the value stuck
    returnFocus(found.el);
    if (!written.ok) return fail(written.reason === "sensitive" ? "sensitive" : "value-mismatch");
    const picked = cell && rowHint === null && found.row !== null;
    return picked ? { ok: true, extracted: { var: rowName, value: String(found.row), confidence: 1 } } : { ok: true };
  }

  /** Writing focuses the field. Inside a hidden frame that would take the keyboard away from the tab, and Esc could no longer cancel. */
  function returnFocus(el: HTMLElement): void {
    if (sameRealm(el) || typeof document === "undefined") return;
    const holder = document.activeElement;
    // Focus inside a frame shows up here as the frame itself, or as the closed shadow host the frames live in.
    if (holder?.tagName !== "IFRAME" && holder?.id !== "ghost-dryrun-host") return;
    el.blur();
    window.focus();
  }

  function wrap(el: HTMLElement | null): { el: HTMLElement; row: number | null } | null {
    return el ? { el, row: null } : null;
  }

  // ----- click -----

  interface Snapshot {
    connected: boolean;
    disabled: boolean;
    text: string;
    pressed: string | null;
    url: string | null;
    alerts: number;
  }

  function alertCount(doc: Document): number {
    return Array.from(doc.querySelectorAll('[role="alert"]')).filter((el) => squash(el.textContent) !== "").length;
  }

  function snapshot(el: HTMLElement, doc: Document): Snapshot {
    return {
      connected: el.isConnected, disabled: el.matches(":disabled, [aria-disabled='true']"), text: squash(el.textContent),
      pressed: el.getAttribute("aria-pressed"), url: urlOfDocument(doc), alerts: alertCount(doc),
    };
  }

  function changed(a: Snapshot, b: Snapshot): boolean {
    return a.connected !== b.connected || a.disabled !== b.disabled || a.text !== b.text || a.pressed !== b.pressed || a.url !== b.url;
  }

  /** Same-origin link to another page: clicking it only navigates. */
  function navigationLink(el: HTMLElement, doc: Document): boolean {
    const href = el.tagName === "A" ? itemUrlFromElement(el) : null;
    const where = href ? normalizeUrl(href) : null;
    return where !== null && where.url !== urlOfDocument(doc);
  }

  async function click(order: LoopStepOrder, step: ClickStep, doc: Document, armed: boolean): Promise<StepResult> {
    const locked = isLockedStep(step);
    // Locked steps run ONLY after the single batch confirmation, and only from an armed order (never twice).
    if (locked && !(order.confirmed === true && armed)) return fail("locked-unconfirmed");
    const el = await waitFor(() => findTarget(doc, step.target), waitMs);
    if (!el) return fail("target-missing");
    if (!locked && looksLocked(el)) return fail("locked-target");
    if (isSensitiveTarget(el)) return fail("sensitive");
    if (el.matches(":disabled, [aria-disabled='true']")) return fail("not-editable");
    if (!locked && navigationLink(el, doc)) {
      if (surface.framed) return { ok: true }; // frames are loaded by url: a link that only navigates has nothing to do
      await surface.showTarget?.(el, false);
      return { ok: true, afterReport: clickLater(el) };
    }
    await surface.showTarget?.(el, locked);
    const before = snapshot(el, doc);
    markSynthetic();
    el.click();
    const after = (await waitFor(() => (changed(before, snapshot(el, doc)) ? snapshot(el, doc) : null), effectMs)) ?? snapshot(el, doc);
    // The one detectable refusal: the page answered with a new alert ("Write a reply before sending").
    return after.alerts > before.alerts ? fail("action-rejected") : { ok: true };
  }

  // ----- goto -----

  async function goTo(step: Extract<LoopStep, { op: "goto" }>, place: Place): Promise<StepResult> {
    if (place.url === null || !/^https?:\/\//i.test(step.url)) return fail("navigation-failed");
    return (await pageFor(place)) ? { ok: true } : fail("navigation-failed");
  }

  async function runStep(order: LoopStepOrder, armed: boolean): Promise<StepResult> {
    const { step } = order;
    const place = placeOf(order);
    if (step.op === "goto") return goTo(step, place);
    const doc = await pageFor(place);
    if (!doc) return fail(place.url === null ? "page-mismatch" : "navigation-failed");
    if (step.op === "open-item") return openItem(order, doc);
    if (step.op === "extract") return extract(order, step, doc);
    return step.op === "fill" ? fill(order, step, doc, armed) : click(order, step, doc, armed);
  }

  return {
    async prepare(order) {
      const place = placeOf(order);
      const doc = await pageFor(place);
      const url = doc ? urlOfDocument(doc) : null;
      const pathPattern = url ? patternOfUrl(url) : null;
      return url && pathPattern ? { ok: true, url, pathPattern } : { ok: false, error: place.url === null ? "page-mismatch" : "navigation-failed" };
    },
    // Everything the recorder sees while a step runs is Ghost's own action, not the user's.
    run: (order, armed) => withSynthetic(() => runStep(order, armed)).catch(() => fail("executor-error")),
  };
}
