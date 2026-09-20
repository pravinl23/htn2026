import { isSensitive } from "@ghost/shared";
import type { TraceCellRef, TraceListRef } from "@ghost/shared";

/**
 * Where a target sits in a repeated structure (docs/loops.md section 1): an item of a list, or a cell of
 * a grid. A cell wins over a list, so a spreadsheet input never also reads as "row 3 of a list": the loop
 * aligner treats every moving list index as the iterator.
 */
export interface ListContext {
  list?: TraceListRef;
  cell?: TraceCellRef;
}

export interface ListLocation {
  container: Element;
  item: Element;
  items: Element[];
  index: number;
}

const SKIPPED_TEXT = "input, textarea, select, button, script, style, noscript, template";
const LIST_ROLES = new Set(["list", "listbox", "feed"]);
const ROW_PARENTS = new Set(["rowgroup", "grid", "table", "treegrid"]);
const NO_ITEM_ROLES = new Set(["presentation", "none", "separator"]);
/** Menus and tab strips are lists in markup only: clicking "Home" then "About" is not an iteration. */
const CHROME = 'nav, [role="navigation"], [role="menubar"], [role="menu"], [role="tablist"], [role="toolbar"]';
const SEMANTIC_CONTAINERS = 'ul, ol, menu, tbody, [role="list"], [role="listbox"], [role="feed"], [role="rowgroup"], [role="grid"], [role="table"]';
const CELL_CONTROLS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const SEMANTIC_DEPTH = 12;
// Modern component trees often wrap a result card in several layout/telemetry layers. Stay bounded, but deep
// enough to reach the repeated card rather than treating the site as one enormous unstructured page.
const GENERIC_DEPTH = 12;
const MIN_SEMANTIC_ITEMS = 2;
const MIN_SIMILAR_ITEMS = 3;
const MAX_KEY = 120;
const MAX_HEADER = 80;
const GENERIC_SCAN_LIMIT = 5000;

// ---------- text helpers (shared with pageFacts.ts) ----------

export function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Text a reader sees: no form controls (typed values never leak), no scripts, nothing hidden from assistive tech. */
export function visibleText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  if (el.matches(SKIPPED_TEXT) || el.matches('[hidden], [aria-hidden="true"]')) return "";
  return Array.from(el.childNodes, visibleText).join(" ");
}

function attr(el: Element, name: string): string {
  return squash(el.getAttribute(name));
}

function labelledBy(el: Element): string {
  const ids = attr(el, "aria-labelledby").split(" ").filter(Boolean);
  return squash(ids.map((id) => visibleText(el.ownerDocument.getElementById(id) ?? el.ownerDocument.createTextNode(""))).join(" "));
}

function ariaName(el: Element): string {
  return labelledBy(el) || attr(el, "aria-label");
}

function roleOf(el: Element): string {
  return attr(el, "role").toLowerCase();
}

function toIndex(text: string | null): number | null {
  if (text === null || !/^\d{1,6}$/.test(text.trim())) return null;
  return Number(text.trim());
}

// ---------- grid cells ----------

function tableCellOf(el: Element): HTMLTableCellElement | null {
  const cell = el.closest("td, th");
  return cell && cell.closest("table") ? (cell as HTMLTableCellElement) : null;
}

function headerRowOf(table: Element): Element | null {
  const head = table.querySelector("thead tr");
  if (head) return head;
  const first = table.querySelector("tr");
  return first && first.querySelector("td") === null ? first : null;
}

/** Column position counting colspans, so a header lines up with the cells below it. */
function columnOf(cell: Element): number {
  let col = 0;
  for (let sib = cell.previousElementSibling; sib; sib = sib.previousElementSibling) col += toIndex(sib.getAttribute("colspan")) || 1;
  return col;
}

function tableHeaderAt(table: Element, col: number): string {
  const row = headerRowOf(table);
  const header = row ? Array.from(row.children).find((c) => columnOf(c) === col) : undefined;
  return header ? squash(visibleText(header)) : "";
}

function ariaHeaderAt(grid: Element, col: number): string {
  const headers = Array.from(grid.querySelectorAll('[role="columnheader"]'));
  const byIndex = headers.find((h) => toIndex(h.getAttribute("aria-colindex")) === col + 1);
  const header = byIndex ?? headers[col];
  return header ? squash(visibleText(header)) : "";
}

/** "Vendor row 1" -> "Vendor": the part of a cell's own name that does not change from row to row. */
function labelPrefix(el: Element): string {
  const name = ariaName(el);
  const cut = name.replace(/[\s,;:-]*\b(row|line|item|#)\s*\d+\s*$/i, "").replace(/[\s,;:-]*\d+\s*$/, "");
  return cut === name ? "" : squash(cut);
}

function columnHeader(el: Element, col: number): string {
  const explicit = attr(el.closest("[data-col-header]") ?? el, "data-col-header");
  const td = tableCellOf(el);
  const table = td?.closest("table") ?? null;
  const grid = el.closest('[role="grid"], [role="table"], [role="treegrid"]');
  const fromTable = td && table ? tableHeaderAt(table, columnOf(td)) : "";
  const header = explicit || fromTable || (grid ? ariaHeaderAt(grid, col) : "") || labelPrefix(el);
  return isSensitive({ label: header }) ? "" : header.slice(0, MAX_HEADER);
}

function dataCell(el: Element): TraceCellRef | null {
  const holder = el.closest("[data-row][data-col]");
  const row = toIndex(holder?.getAttribute("data-row") ?? null);
  const col = toIndex(holder?.getAttribute("data-col") ?? null);
  if (!holder || row === null || col === null) return null;
  return { row, col, colHeader: columnHeader(el, col) };
}

function bodyRowsOf(row: Element): Element[] {
  const scope = row.closest('table, [role="grid"], [role="table"], [role="treegrid"]');
  const rows = scope ? Array.from(scope.querySelectorAll('tr, [role="row"]')) : [row];
  return rows.filter((r) => r.closest("thead") === null && r.querySelector('th[scope="col"], [role="columnheader"]') === null);
}

function ariaCell(el: Element): TraceCellRef | null {
  const cell = el.closest('[role="gridcell"]');
  const row = cell?.closest('[role="row"], tr');
  if (!cell || !row) return null;
  const cells = Array.from(row.querySelectorAll('[role="gridcell"]'));
  const col = (toIndex(cell.getAttribute("aria-colindex")) ?? cells.indexOf(cell) + 1) - 1;
  const rowIndex = bodyRowsOf(row).indexOf(row);
  if (col < 0 || rowIndex < 0) return null;
  return { row: rowIndex, col, colHeader: columnHeader(el, col) };
}

function tableInputCell(el: Element): TraceCellRef | null {
  const td = el.matches(CELL_CONTROLS) ? tableCellOf(el) : null;
  const row = td?.closest("tr");
  if (!td || !row) return null;
  const rowIndex = bodyRowsOf(row).indexOf(row);
  // Counted among data cells only, so a leading row header does not shift the column.
  const col = Array.from(row.children).filter((c) => c.tagName === "TD").indexOf(td);
  if (rowIndex < 0 || col < 0) return null;
  return { row: rowIndex, col, colHeader: columnHeader(el, col) };
}

/** Grid coordinates (zero-based) and the column header for a target inside a table or grid cell. */
export function cellOf(el: Element): TraceCellRef | null {
  return dataCell(el) ?? ariaCell(el) ?? tableInputCell(el);
}

// ---------- repeated lists ----------

function isSemanticItem(node: Element, parent: Element): boolean {
  if (NO_ITEM_ROLES.has(roleOf(node))) return false;
  if (LIST_ROLES.has(roleOf(parent))) return true;
  if (parent.matches("ul, ol, menu")) return node.tagName === "LI" || roleOf(node) === "listitem";
  if (parent.tagName === "TBODY") return node.tagName === "TR";
  return ROW_PARENTS.has(roleOf(parent)) && roleOf(node) === "row" && node.querySelector('[role="columnheader"]') === null;
}

/** tag, first class and first child tag: state classes ("replied", "unread") come later in the list and do not count. */
function similarityKey(el: Element): string {
  const firstClass = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0] ?? "";
  const marker = attr(el, "data-testid") || roleOf(el) || firstClass;
  return `${el.tagName}|${marker}|${el.firstElementChild?.tagName ?? ""}`;
}

function similarChildren(parent: Element, item: Element): Element[] {
  const key = similarityKey(item);
  return Array.from(parent.children).filter((c) => similarityKey(c) === key);
}

/** role=listitem elements that are not direct children of their role=list (wrapper divs in between). */
function looseListItems(node: Element): { container: Element; items: Element[] } | null {
  if (roleOf(node) !== "listitem") return null;
  const container = node.parentElement?.closest('[role="list"]');
  if (!container) return null;
  const items = Array.from(container.querySelectorAll('[role="listitem"]')).filter((i) => i.parentElement?.closest('[role="list"]') === container);
  return { container, items };
}

function located(container: Element, item: Element, items: Element[], min: number): ListLocation | null {
  const index = items.indexOf(item);
  if (index < 0 || items.length < min || container.closest(CHROME) !== null) return null;
  return { container, item, items, index };
}

function semanticLocation(el: Element): ListLocation | null {
  let node: Element | null = el;
  for (let depth = 0; depth < SEMANTIC_DEPTH && node && node.tagName !== "BODY"; depth++, node = node.parentElement) {
    const parent: Element | null = node.parentElement;
    if (!parent) return null;
    const hit = semanticAt(node, parent);
    if (hit) return hit;
  }
  return null;
}

function semanticAt(node: Element, parent: Element): ListLocation | null {
  if (isSemanticItem(node, parent)) {
    const items = Array.from(parent.children).filter((c) => isSemanticItem(c, parent));
    return located(parent, node, items, MIN_SEMANTIC_ITEMS);
  }
  const loose = looseListItems(node);
  return loose ? located(loose.container, node, loose.items, MIN_SEMANTIC_ITEMS) : null;
}

function genericLocation(el: Element): ListLocation | null {
  let node: Element | null = el;
  for (let depth = 0; depth < GENERIC_DEPTH && node && node.tagName !== "BODY"; depth++, node = node.parentElement) {
    const parent: Element | null = node.parentElement;
    // A button group is three look-alike siblings too; a repeated ITEM has some structure of its own.
    if (!parent || parent.tagName === "BODY" || parent.matches('tr, [role="row"]') || node.childElementCount < 2) continue;
    const items = similarChildren(parent, node);
    if (items.length >= MIN_SIMILAR_ITEMS) return located(parent, node, items, MIN_SIMILAR_ITEMS);
  }
  return null;
}

/** Real list markup only (ul/ol, role=list, table rows): for targets that are not controls themselves. */
export function locateSemanticItem(el: Element): ListLocation | null {
  return semanticLocation(el);
}

/** The repeated item around `el`: real list markup first, then three or more look-alike siblings. */
export function locateListItem(el: Element): ListLocation | null {
  return semanticLocation(el) ?? genericLocation(el);
}

function stableId(el: Element): string {
  return /\d{4,}|^ember\d+|^:r/.test(el.id) ? "" : el.id;
}

/** Counts and dates in a label ("Inbox (12)") would make the signature change as the user works. */
function valueFree(label: string): string {
  return label.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim().slice(0, 60);
}

function nthOfType(el: Element): number {
  let n = 1;
  for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === el.tagName) n++;
  return n;
}

function structuralPath(el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node && node.tagName !== "BODY" && parts.length < 5; node = node.parentElement) {
    const id = stableId(node);
    parts.unshift(id ? `${node.tagName.toLowerCase()}#${id}` : `${node.tagName.toLowerCase()}:${nthOfType(node)}`);
    if (id) break;
  }
  return parts.join(">");
}

/** Named by the table when the rows' own tbody carries nothing. */
function namingElement(container: Element): Element {
  return container.tagName === "TBODY" ? container.closest("table") ?? container : container;
}

/** Stable and value-free: role, test id, id and label of the container, or its structural path when it has none. */
export function listSignatureOf(container: Element): string {
  const named = namingElement(container);
  const names = [attr(named, "data-testid"), stableId(named), valueFree(ariaName(named))];
  const where = names.some(Boolean) ? "" : structuralPath(container);
  return ["list", container.tagName.toLowerCase(), roleOf(container), ...names, where].join("|");
}

function keyCandidates(item: Element): string[] {
  const actions = item.querySelectorAll('a[href], button, [role="button"], [role="link"]');
  const only = actions.length === 1 ? actions[0] : undefined;
  const heading = item.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], th[scope="row"], [role="rowheader"]');
  // A button's own text: visibleText skips controls so that typed values never ride along.
  const actionText = only ? ariaName(only) || squash(Array.from(only.childNodes, visibleText).join(" ")) : "";
  return [ariaName(item), heading ? squash(visibleText(heading)) : "", actionText, squash(visibleText(item))];
}

/** Short visible text that names one item: its own name, its heading or row header, its only link. Empty when it reads as sensitive. */
export function itemKeyOf(item: Element): string {
  const key = keyCandidates(item).find((text) => text !== "") ?? "";
  return isSensitive({ label: key }) ? "" : key.slice(0, MAX_KEY);
}

export function listRefOf(el: Element): TraceListRef | null {
  const found = locateListItem(el);
  if (!found) return null;
  return { listSignature: listSignatureOf(found.container), index: found.index, itemKey: itemKeyOf(found.item) };
}

export function listContextOf(el: Element): ListContext {
  const cell = cellOf(el);
  if (cell) return { cell };
  const list = listRefOf(el);
  return list ? { list } : {};
}

// ---------- resolving a signature again (dry runs and the executor) ----------

function itemsOfContainer(container: Element): Element[] {
  const semantic = Array.from(container.children).filter((c) => isSemanticItem(c, container));
  if (semantic.length > 0) return semantic;
  const loose = Array.from(container.querySelectorAll('[role="listitem"]')).filter((i) => i.parentElement?.closest('[role="list"]') === container);
  if (loose.length > 0) return loose;
  const first = Array.from(container.children).find((c) => similarChildren(container, c).length >= MIN_SIMILAR_ITEMS);
  return first ? similarChildren(container, first) : [];
}

/** The container a listSignature was taken from, or null when this page does not show that list. */
export function findList(root: ParentNode, listSignature: string): Element | null {
  for (const container of root.querySelectorAll(SEMANTIC_CONTAINERS)) {
    if (listSignatureOf(container) === listSignature) return container;
  }
  let scanned = 0;
  for (const el of root.querySelectorAll("body *")) {
    if (++scanned > GENERIC_SCAN_LIMIT) break;
    if (el.childElementCount >= MIN_SIMILAR_ITEMS && listSignatureOf(el) === listSignature && itemsOfContainer(el).length > 0) return el;
  }
  return null;
}

/** Items of a list in document order, the same way indexes were counted when the trace was recorded. */
export function listItems(root: ParentNode, listSignature: string): Element[] {
  const container = findList(root, listSignature);
  return container ? itemsOfContainer(container) : [];
}

// ---------- what the page says about its lists (reported next to the page facts) ----------

export interface PageList {
  listSignature: string;
  container: Element;
  items: Element[];
}

const MAX_PAGE_LISTS = 5;
/** State an item shows once it was dealt with: a class token, or a data attribute set to "true". */
const HANDLED_WORD = /^(is-)?(replied|logged|done|completed?|handled|processed|archived|resolved|sent|paid|approved|checked)$/i;

function showsHandled(item: Element): boolean {
  if (Array.from(item.classList).some((token) => HANDLED_WORD.test(token))) return true;
  return Array.from(item.attributes).some((a) => a.name.startsWith("data-") && a.value === "true" && HANDLED_WORD.test(a.name.slice(5)));
}

/** Indexes of items that already show a handled marker, so a run never does them again. */
export function handledIndexes(items: readonly Element[]): number[] {
  return items.flatMap((item, index) => (showsHandled(item) ? [index] : []));
}

/**
 * The biggest real lists of the page plus `extra` containers the user already acted in (look-alike sibling
 * lists cannot be found by markup alone). Lists inside menus and toolbars do not count.
 */
export function pageLists(root: ParentNode, extra: Iterable<Element> = [], max = MAX_PAGE_LISTS): PageList[] {
  const seen = new Set<string>();
  const out: PageList[] = [];
  for (const container of [...extra, ...root.querySelectorAll(SEMANTIC_CONTAINERS)]) {
    const items = container.isConnected && container.closest(CHROME) === null ? itemsOfContainer(container) : [];
    const listSignature = listSignatureOf(container);
    if (items.length < MIN_SEMANTIC_ITEMS || seen.has(listSignature)) continue;
    seen.add(listSignature);
    out.push({ listSignature, container, items });
  }
  const pinned = new Set<Element>(extra);
  const rank = (list: PageList): number => (pinned.has(list.container) ? Number.MAX_SAFE_INTEGER : list.items.length);
  return out.sort((a, b) => rank(b) - rank(a)).slice(0, max);
}
