import { isSensitive, normalizeUrl } from "@ghost/shared";
import type { FactLocator, PageFact } from "@ghost/shared";
import { LIST_HANDLED_LABEL, LIST_LENGTH_LABEL } from "../lib/loopMessages";
import type { LoopMessageOf } from "../lib/loopMessages";
import { handledIndexes, pageLists, squash, visibleText } from "./listContext";

/**
 * Page facts (docs/loops.md section 1): visible labeled values a user could plausibly copy somewhere else.
 * Extraction and resolution walk the SAME candidate list in the same order, so a locator always resolves
 * to the element its fact was read from. Typed values are never read: form controls carry no text here.
 */

export const MAX_FACTS = 80;
export const MAX_FACT_TEXT = 200;
export const FACTS_DEBOUNCE_MS = 300;
const FACTS_MAX_WAIT_MS = 1500;
const URL_POLL_MS = 500;
const MAX_LABEL = 80;
const LINE_SCAN_LIMIT = 3000;

const GHOST_UI = '#ghost-overlay-host, [data-ghost-ui], [id^="ghost-"][id$="-host"]';
const NOT_A_FACT = 'button, input, select, textarea, option, [role="button"], [contenteditable=""], [contenteditable="true"]';
const HIDDEN = '[hidden], [inert], [aria-hidden="true"]';
const MARKED_SENSITIVE = "[data-ghost-sensitive], [data-sensitive]";
const ATTR_FACTS = "[data-field], [data-testid]";
const LINE_TAGS = "p, li, div, span, td";
const HEADINGS = 'h1, h2, h3, [role="heading"]';
/** A short label, a colon, a value. Sentence punctuation before the colon means prose, not a label. */
const LINE = /^([\p{L}][^:.,!?]{0,39}):\s+(\S.*)$/u;
const MAX_LINE_LABEL_WORDS = 4;
/** Card numbers and US social security numbers, whatever the label next to them says. */
const SENSITIVE_VALUE = /\b(?:\d[ -]?){13,19}\b|\b\d{3}-\d{2}-\d{4}\b/;

type AttrLocator = "data-field" | "testid";

/** One labeled value on the page before it gets a locator. `strip` facts share their element with their label. */
interface Candidate {
  el: Element;
  label: string;
  attr?: { by: AttrLocator; value: string };
  strip?: boolean;
  heading?: boolean;
}

export function looksSensitiveValue(text: string): boolean {
  return SENSITIVE_VALUE.test(text);
}

// ---------- candidates, in priority order ----------

function cleanLabel(text: string): string {
  return squash(text).replace(/\s*[:*]+$/, "").slice(0, MAX_LABEL);
}

function humanize(name: string): string {
  return squash(name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " "));
}

function rendered(el: Element): boolean {
  if (el.closest(HIDDEN) || el.closest(GHOST_UI) || el.closest(MARKED_SENSITIVE)) return false;
  return typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true });
}

function termOf(dd: Element): string {
  for (let sib = dd.previousElementSibling; sib; sib = sib.previousElementSibling) {
    if (sib.tagName === "DT") return cleanLabel(visibleText(sib));
  }
  return "";
}

function labelledByText(el: Element): string {
  const ids = squash(el.getAttribute("aria-labelledby")).split(" ").filter(Boolean);
  return cleanLabel(ids.map((id) => visibleText(el.ownerDocument.getElementById(id) ?? el.ownerDocument.createTextNode(""))).join(" "));
}

/** How often each data-field / data-testid value occurs: a value shared by fifty list rows names nothing. */
function attrCounts(els: Iterable<Element>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const el of els) {
    for (const name of ["data-field", "data-testid"]) {
      const value = el.getAttribute(name);
      if (value !== null) counts.set(`${name}=${value}`, (counts.get(`${name}=${value}`) ?? 0) + 1);
    }
  }
  return counts;
}

/** Leaf-ish elements with a unique data-field or data-testid: the page author already named the value. */
function attrCandidates(root: ParentNode): Candidate[] {
  const out: Candidate[] = [];
  const els = Array.from(root.querySelectorAll(ATTR_FACTS));
  const counts = attrCounts(els);
  for (const el of els) {
    if (el.matches(NOT_A_FACT) || el.querySelector(ATTR_FACTS)) continue;
    const field = el.getAttribute("data-field");
    const name = field === null ? "data-testid" : "data-field";
    const value = el.getAttribute(name) ?? "";
    if (value === "" || counts.get(`${name}=${value}`) !== 1) continue;
    const label = (el.tagName === "DD" ? termOf(el) : "") || labelledByText(el) || cleanLabel(el.getAttribute("aria-label") ?? "") || humanize(value);
    out.push({ el, label, attr: { by: field === null ? "testid" : "data-field", value } });
  }
  return out;
}

function definitionCandidates(root: ParentNode): Candidate[] {
  return Array.from(root.querySelectorAll("dd"), (el) => ({ el, label: termOf(el) }));
}

function tableRowCandidates(root: ParentNode): Candidate[] {
  const out: Candidate[] = [];
  for (const row of root.querySelectorAll("tr")) {
    const [name, value, ...rest] = Array.from(row.children);
    if (!name || !value || rest.length > 0 || value.tagName !== "TD") continue;
    out.push({ el: value, label: cleanLabel(visibleText(name)) });
  }
  return out;
}

function labelledCandidates(root: ParentNode): Candidate[] {
  const els = Array.from(root.querySelectorAll("[aria-labelledby]")).filter((el) => el.childElementCount === 0 && !el.matches("a[href]"));
  return els.map((el) => ({ el, label: labelledByText(el) }));
}

function hasBlockChild(el: Element): boolean {
  return el.querySelector("p, div, li, ul, ol, table, dl, section, article, h1, h2, h3, h4, h5, h6, br") !== null;
}

/** "Vendor: Acme" written as one line of text, often `<p><strong>Vendor:</strong> Acme</p>`. */
function lineCandidates(root: ParentNode): Candidate[] {
  const out: Candidate[] = [];
  let scanned = 0;
  for (const el of root.querySelectorAll(LINE_TAGS)) {
    if (++scanned > LINE_SCAN_LIMIT) break;
    if (hasBlockChild(el) || el.closest("a[href], dd, dt")) continue;
    const match = LINE.exec(squash(visibleText(el)));
    if (!match || match[2]?.startsWith("//") || (match[1] ?? "").split(" ").length > MAX_LINE_LABEL_WORDS) continue;
    // The innermost element that still holds the whole line wins; its wrappers say the same thing again.
    if (Array.from(el.children).some((c) => LINE.test(squash(visibleText(c))))) continue;
    out.push({ el, label: cleanLabel(match[1] ?? ""), strip: true });
  }
  return out;
}

function headingCandidates(root: ParentNode): Candidate[] {
  return Array.from(root.querySelectorAll(HEADINGS), (el, i) => ({ el, label: i === 0 ? "Page heading" : "Heading", heading: true }));
}

function candidates(root: ParentNode): Candidate[] {
  const all = [
    ...attrCandidates(root), ...definitionCandidates(root), ...tableRowCandidates(root),
    ...labelledCandidates(root), ...lineCandidates(root), ...headingCandidates(root),
  ];
  const seen = new Set<Element>();
  return all.filter((c) => {
    if (seen.has(c.el) || c.label === "" || c.el.matches(NOT_A_FACT) || !rendered(c.el)) return false;
    seen.add(c.el);
    return true;
  });
}

// ---------- text and locators ----------

function textOfCandidate(c: Candidate): string {
  const text = squash(visibleText(c.el));
  return c.strip ? squash(LINE.exec(text)?.[2]) : text;
}

function stableId(el: Element): string {
  return /\d{4,}|^ember\d+|^:r/.test(el.id) ? "" : el.id;
}

function nthOfType(el: Element): number {
  let n = 1;
  for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === el.tagName) n++;
  return n;
}

function cssEscape(id: string): string {
  return id.replace(/[^\w-]/g, (ch) => `\\${ch}`);
}

/** Short structural selector: anchored at the nearest stable id, at most four steps long. */
function cssPath(el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node && node.tagName !== "BODY" && node.tagName !== "HTML" && parts.length < 4; node = node.parentElement) {
    const id = stableId(node);
    parts.unshift(id ? `#${cssEscape(id)}` : `${node.tagName.toLowerCase()}:nth-of-type(${nthOfType(node)})`);
    if (id) break;
  }
  return parts.join(" > ");
}

function labelKey(label: string): string {
  return label.toLowerCase();
}

function locatorKey(locator: FactLocator): string {
  return `${locator.by}=${locator.by === "label" ? labelKey(locator.value) : locator.value}`;
}

/** data-field/testid first, then a stable id, then the label (first holder only), then structure. */
function locatorFor(c: Candidate, taken: ReadonlySet<string>): FactLocator {
  if (c.attr) return c.attr;
  const id = stableId(c.el);
  if (id) return { by: "id", value: id };
  const byLabel: FactLocator = { by: "label", value: c.label };
  return c.heading || taken.has(locatorKey(byLabel)) ? { by: "css", value: cssPath(c.el) } : byLabel;
}

function isSafeFact(label: string, text: string): boolean {
  if (text === "" || text.length > MAX_FACT_TEXT) return false;
  return !isSensitive({ label }) && !looksSensitiveValue(text);
}

/** Visible labeled values of the page, best sources first. Never reads a form control's value. */
export function extractPageFacts(root: ParentNode = document): PageFact[] {
  const facts: PageFact[] = [];
  const taken = new Set<string>();
  for (const c of candidates(root)) {
    if (facts.length >= MAX_FACTS) break;
    const text = textOfCandidate(c);
    const locator = locatorFor(c, taken);
    if (locator.value === "" || taken.has(locatorKey(locator))) continue;
    // Claimed even when the text is unusable: resolveLocator goes by position, not by what the value looks like.
    taken.add(locatorKey(locator));
    if (isSafeFact(c.label, text)) facts.push({ locator, label: c.label, text });
  }
  return facts;
}

/** Cut at a comma: half an index would name another item. */
function joinIndexes(indexes: readonly number[]): string {
  let text = "";
  for (const index of indexes) {
    const next = text === "" ? String(index) : `${text},${index}`;
    if (next.length > MAX_FACT_TEXT) break;
    text = next;
  }
  return text;
}

/**
 * How long each repeated list is and which items already show a handled marker, in the shape the worker's
 * trace store expects. `extra` are containers the user clicked in that markup alone would not reveal.
 */
export function extractListFacts(root: ParentNode = document, extra: Iterable<Element> = []): PageFact[] {
  const facts: PageFact[] = [];
  for (const list of pageLists(root, extra)) {
    const locator: FactLocator = { by: "css", value: list.listSignature };
    const handled = joinIndexes(handledIndexes(list.items));
    facts.push({ locator, label: LIST_LENGTH_LABEL, text: String(list.items.length) });
    if (handled !== "") facts.push({ locator, label: LIST_HANDLED_LABEL, text: handled });
  }
  return facts;
}

function byAttribute(root: ParentNode, name: string, value: string): Element | null {
  for (const el of root.querySelectorAll(`[${name}]`)) if (el.getAttribute(name) === value) return el;
  return null;
}

function byCss(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null; // a selector from storage or another version that this engine rejects
  }
}

function labelCandidate(root: ParentNode, label: string): Candidate | null {
  const wanted = labelKey(label);
  return candidates(root).find((c) => !c.attr && !c.heading && stableId(c.el) === "" && labelKey(c.label) === wanted) ?? null;
}

/** The element a locator names on this page, or null. Dry runs and the executor use it on pages never seen before. */
export function resolveLocator(root: ParentNode, locator: FactLocator): Element | null {
  let el: Element | null;
  if (locator.by === "data-field") el = byAttribute(root, "data-field", locator.value);
  else if (locator.by === "testid") el = byAttribute(root, "data-testid", locator.value);
  else if (locator.by === "id") el = byAttribute(root, "id", locator.value);
  else if (locator.by === "css") el = byCss(root, locator.value);
  else el = labelCandidate(root, locator.value)?.el ?? null;
  return el && rendered(el) && !el.matches(NOT_A_FACT) ? el : null;
}

/** The text extractPageFacts would report for this locator right now; null when missing, too long or sensitive. */
export function readLocator(root: ParentNode, locator: FactLocator): string | null {
  const el = resolveLocator(root, locator);
  if (!el) return null;
  const fallback: Candidate = { el, label: locator.by === "css" ? "" : humanize(locator.value) };
  const found = candidates(root).find((c) => c.el === el) ?? fallback;
  const text = textOfCandidate(found);
  return isSafeFact(found.label, text) ? text : null;
}

// ---------- sending ----------

function isOurNode(node: Node): boolean {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return el !== null && el.closest(GHOST_UI) !== null;
}

/** Ghost mounting or redrawing its own hosts says nothing about the page. */
function isOurMutation(record: MutationRecord): boolean {
  if (isOurNode(record.target)) return true;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return record.type === "childList" && changed.length > 0 && changed.every(isOurNode);
}

export type PageFactsMessage = LoopMessageOf<"ghost:page-facts">;
export type PageFactsSender = (message: PageFactsMessage) => void;

function runtimeSend(message: PageFactsMessage): void {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") return;
  try {
    // Nobody answers this message; a sleeping or reloaded worker must not surface as an unhandled rejection.
    void Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined);
  } catch {
    // extension context invalidated
  }
}

/**
 * Extracts and sends the facts of `doc` (list sizes first, so the cap never drops them) unless they equal `lastSent`.
 * Returns the fingerprint of what the worker now has.
 */
export function sendPageFacts(doc: Document = document, send: PageFactsSender = runtimeSend, lastSent = "", lists: Iterable<Element> = []): string {
  const place = normalizeUrl(doc.location?.href ?? "");
  if (!place) return lastSent;
  const facts = [...extractListFacts(doc, lists), ...extractPageFacts(doc)].slice(0, MAX_FACTS);
  const fingerprint = JSON.stringify([place.url, facts]);
  if (fingerprint === lastSent) return lastSent;
  send({ type: "ghost:page-facts", url: place.url, pathPattern: place.pathPattern, facts });
  return fingerprint;
}

export interface PageFactsWatcherOptions {
  doc?: Document;
  send?: PageFactsSender;
  debounceMs?: number;
}

/** Sends facts when the page settles and again whenever they changed (DOM mutations, SPA navigations). */
export class PageFactsWatcher {
  private readonly doc: Document;
  private readonly send: PageFactsSender;
  private readonly debounceMs: number;
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private urlTimer: ReturnType<typeof setInterval> | null = null;
  private waitingSince = 0;
  private lastUrl = "";
  private lastSent = "";
  private running = false;
  /** Look-alike sibling lists the user acted in; real list markup is found without help. */
  private readonly lists = new Set<Element>();

  constructor(opts: PageFactsWatcherOptions = {}) {
    this.doc = opts.doc ?? document;
    this.send = opts.send ?? runtimeSend;
    this.debounceMs = opts.debounceMs ?? FACTS_DEBOUNCE_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastUrl = this.doc.location?.href ?? "";
    this.observe();
    this.listen(true);
    this.urlTimer = setInterval(this.onUrlMaybeChanged, URL_POLL_MS);
    this.rescan();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    this.listen(false);
    if (this.timer) clearTimeout(this.timer);
    if (this.urlTimer) clearInterval(this.urlTimer);
    this.timer = this.urlTimer = null;
    this.lastSent = "";
    this.lists.clear();
  }

  /** The trace recorder saw an action inside this list: report its length with the next facts. */
  noteList(container: Element): void {
    if (!this.running || this.lists.has(container)) return;
    this.lists.add(container);
    this.rescan();
  }

  /** Trailing debounce with a ceiling, so a page that never stops mutating still reports its facts. */
  rescan(): void {
    if (!this.running) return;
    const now = Date.now();
    if (this.timer === null) this.waitingSince = now;
    else if (now - this.waitingSince >= FACTS_MAX_WAIT_MS) return;
    else clearTimeout(this.timer);
    this.timer = setTimeout(this.fire, this.debounceMs);
  }

  /** Sends a pending rescan right now: called before an action that may leave the page. */
  flush(): void {
    if (!this.running || this.timer === null) return;
    clearTimeout(this.timer);
    this.fire();
  }

  private readonly fire = (): void => {
    this.timer = null;
    if (!this.running) return;
    try {
      for (const list of this.lists) if (!list.isConnected) this.lists.delete(list);
      this.lastSent = sendPageFacts(this.doc, this.send, this.lastSent, this.lists);
    } catch (error) {
      console.debug("[ghost] page facts skipped", error); // a hostile DOM must not break the page or the recorder
    }
  };

  private readonly onUrlMaybeChanged = (): void => {
    const href = this.doc.location?.href ?? "";
    if (href === this.lastUrl) return;
    this.lastUrl = href;
    this.rescan();
  };

  private readonly onMutations = (records: MutationRecord[]): void => {
    if (records.some((r) => !isOurMutation(r))) this.rescan();
  };

  private observe(): void {
    const Observer = this.doc.defaultView?.MutationObserver;
    if (!Observer) return;
    this.observer = new Observer(this.onMutations);
    this.observer.observe(this.doc.documentElement, { childList: true, subtree: true, characterData: true });
  }

  private listen(on: boolean): void {
    const view = this.doc.defaultView;
    if (!view) return;
    const navigation = (view as unknown as { navigation?: EventTarget }).navigation;
    const bind = (target: EventTarget, type: string): void => {
      if (on) target.addEventListener(type, this.onUrlMaybeChanged);
      else target.removeEventListener(type, this.onUrlMaybeChanged);
    };
    bind(view, "popstate");
    bind(view, "hashchange");
    // The page's pushState cannot be patched from the isolated world; the Navigation API reports it.
    if (navigation?.addEventListener) bind(navigation, "currententrychange");
  }
}
