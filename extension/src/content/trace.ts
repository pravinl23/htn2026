import { isSensitive, MASKED_VALUE, normalizeUrl } from "@ghost/shared";
import type { FieldKind, NormalizedUrl, TraceEventType, TraceTarget } from "@ghost/shared";
import type { ContentTraceEvent, LoopMessageOf } from "../lib/loopMessages";
import { accessibleName, computeSignature, isElementLocked, isElementSensitive } from "./capture";
import { cellOf, itemKeyOf, listSignatureOf, locateListItem, locateSemanticItem } from "./listContext";
import type { ListLocation } from "./listContext";
import { looksSensitiveValue, PageFactsWatcher } from "./pageFacts";

/**
 * Action trace recorder (docs/loops.md section 1). Watches the user's clicks, committed field edits, selects,
 * toggles, submits and navigations, and reports each as ONE value-light TraceEvent to the background worker.
 * Sensitive elements are never recorded at all, not even the fact that something happened on them.
 */

export type TraceMessage = LoopMessageOf<"ghost:trace-event">;
export type TraceSender = (message: TraceMessage) => void;

/** How long after markSynthetic() events still count as Ghost's own (a click and the navigation it causes). */
export const SYNTHETIC_WINDOW_MS = 250;
const URL_POLL_MS = 500;
const GHOST_UI = '#ghost-overlay-host, [data-ghost-ui], [id^="ghost-"][id$="-host"]';
const ACTIONABLE =
  'a[href], button, summary, [onclick], [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], ' +
  '[role="menuitemradio"], [role="tab"], [role="option"], [role="treeitem"], [role="switch"], [role="checkbox"], [role="radio"], ' +
  'input[type="submit"], input[type="button"], input[type="reset"], input[type="image"]';
const FORM_PARTS = "input, textarea, select, option, label";
const MARKED_SENSITIVE = "[data-ghost-sensitive], [data-sensitive]";
const NOT_TEXT_TYPES = new Set(["file", "hidden", "checkbox", "radio", "submit", "button", "reset", "image", "range", "color", "password"]);
const INPUT_KINDS: Record<string, FieldKind> = {
  text: "text", search: "text", email: "email", tel: "tel", url: "url", number: "number", date: "date", month: "month",
  radio: "radio", checkbox: "checkbox", file: "file", submit: "button", button: "button", reset: "button", image: "button",
};

// ---------- the synthetic window (set by Ghost's executors) ----------

let syntheticUntil = 0;
let syntheticDepth = 0;

/** Call right before a programmatic click or navigation: what follows within `ms` is tagged synthetic. */
export function markSynthetic(ms: number = SYNTHETIC_WINDOW_MS): void {
  syntheticUntil = Math.max(syntheticUntil, Date.now() + ms);
}

/** Everything recorded while `work` runs (and for a short tail after it) is tagged synthetic. */
export async function withSynthetic<T>(work: () => T | Promise<T>): Promise<T> {
  syntheticDepth++;
  try {
    return await work();
  } finally {
    syntheticDepth--;
    markSynthetic();
  }
}

export function isSyntheticNow(): boolean {
  return syntheticDepth > 0 || Date.now() < syntheticUntil;
}

/** Test seam. */
export function resetSynthetic(): void {
  syntheticUntil = 0;
  syntheticDepth = 0;
}

// ---------- targets ----------

type TextControl = HTMLInputElement | HTMLTextAreaElement;

function kindOf(el: Element): FieldKind {
  if (el.tagName === "INPUT") return INPUT_KINDS[(el as HTMLInputElement).type] ?? "other";
  if (el.tagName === "TEXTAREA") return "textarea";
  if (el.tagName === "SELECT") return "select";
  const role = el.getAttribute("role")?.toLowerCase() ?? "";
  if (el.tagName === "A" || role === "link") return "link";
  if (el.tagName === "BUTTON" || el.tagName === "SUMMARY" || el.hasAttribute("onclick") || ["button", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "treeitem", "switch", "checkbox", "radio"].includes(role)) return "button";
  return "other";
}

function isTextControl(el: Element): el is TextControl {
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !NOT_TEXT_TYPES.has((el as HTMLInputElement).type);
}

function isToggle(el: Element): el is HTMLInputElement {
  return el.tagName === "INPUT" && ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio");
}

function ghostWriting(el: Element): boolean {
  return el.closest("[data-ghost-writing]") !== null;
}

export interface DescribedTarget {
  target: TraceTarget;
  /** The repeated list the target sits in, when there is one. */
  list: ListLocation | null;
}

/** Null for sensitive elements: they are never described, recorded or sent. */
export function describeTarget(el: Element): DescribedTarget | null {
  if (isElementSensitive(el)) return null;
  const target: TraceTarget = { signature: computeSignature(el), label: accessibleName(el), kind: kindOf(el), locked: isElementLocked(el) };
  const cell = cellOf(el);
  const list = cell ? null : locateListItem(el);
  if (cell) target.cell = cell;
  if (list) target.list = { listSignature: listSignatureOf(list.container), index: list.index, itemKey: itemKeyOf(list.item) };
  return { target, list };
}

export function buildTarget(el: Element): TraceTarget | null {
  return describeTarget(el)?.target ?? null;
}

/** A click on a row that is itself the control (no link or button inside): the item is the target. */
function describeItem(raw: Element): DescribedTarget | null {
  const list = locateSemanticItem(raw);
  if (!list || list.item.closest(MARKED_SENSITIVE)) return null;
  const clickable = list.item.querySelector(ACTIONABLE) === null || list.item.hasAttribute("tabindex") || list.item.hasAttribute("onclick");
  const itemKey = itemKeyOf(list.item);
  if (!clickable || itemKey === "") return null;
  const listSignature = listSignatureOf(list.container);
  const target: TraceTarget = {
    signature: `item|${listSignature}`, label: itemKey, kind: "other", locked: isElementLocked(list.item),
    list: { listSignature, index: list.index, itemKey },
  };
  return { target, list };
}

// ---------- the recorder ----------

export interface TraceRecorderOptions {
  doc?: Document;
  /** Default: chrome.runtime.sendMessage, silently skipped where chrome is missing. */
  send?: TraceSender;
  now?: () => number;
  /** Default: event.isTrusted. Tests dispatch untrusted events. */
  isTrusted?: (event: Event) => boolean;
  /** Told about every list the user acts in, and flushed before a click that may leave the page. */
  facts?: Pick<PageFactsWatcher, "noteList" | "flush">;
}

interface Pending {
  target: TraceTarget;
  synthetic: boolean;
  /** Where the edit happened: by the time it is committed an SPA may already show another route. */
  place: NormalizedUrl;
}

function runtimeSend(message: TraceMessage): void {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") return;
  try {
    // Nobody answers a trace event; a sleeping or reloaded worker must not surface as an unhandled rejection.
    void Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined);
  } catch {
    // extension context invalidated
  }
}

function elementOf(event: Event): Element | null {
  const node = event.target as Node | null;
  if (!node || typeof node.nodeType !== "number") return null;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return el && !el.closest(GHOST_UI) ? el : null;
}

export class TraceRecorder {
  private readonly doc: Document;
  private readonly send: TraceSender;
  private readonly now: () => number;
  private readonly isTrusted: (event: Event) => boolean;
  private readonly facts: TraceRecorderOptions["facts"];
  private readonly pending = new Map<TextControl, Pending>();
  private urlTimer: ReturnType<typeof setInterval> | null = null;
  private lastUrl = "";
  private running = false;

  constructor(opts: TraceRecorderOptions = {}) {
    this.doc = opts.doc ?? document;
    this.send = opts.send ?? runtimeSend;
    this.now = opts.now ?? Date.now;
    this.isTrusted = opts.isTrusted ?? ((event) => event.isTrusted);
    this.facts = opts.facts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.listen(true);
    this.urlTimer = setInterval(this.onUrlMaybeChanged, URL_POLL_MS);
    // A full page load starts a fresh content script: arriving here IS the navigation.
    this.lastUrl = this.place()?.url ?? "";
    if (this.lastUrl) this.emit("navigate", this.place(), undefined, undefined, isSyntheticNow());
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.listen(false);
    if (this.urlTimer) clearInterval(this.urlTimer);
    this.urlTimer = null;
    this.pending.clear();
  }

  /** Reports every edit still waiting for its blur (before a navigation, a submit, or the page going away). */
  flush(): void {
    for (const el of [...this.pending.keys()]) this.commit(el);
  }

  // ---------- handlers ----------

  private readonly onClick = (event: Event): void => {
    const raw = elementOf(event);
    if (!raw) return;
    const el = raw.closest(ACTIONABLE);
    if (!el && raw.closest(FORM_PARTS)) return; // focusing a field is not an action; its edit is
    const synthetic = this.syntheticFor(event, el ?? raw);
    if (synthetic === null || el?.getAttribute("aria-disabled") === "true") return;
    const found = el ? describeTarget(el) : describeItem(raw);
    if (!found) return;
    if (found.list) this.facts?.noteList(found.list.container);
    this.facts?.flush();
    this.emit("click", this.place(), found.target, undefined, synthetic);
  };

  private readonly onInput = (event: Event): void => {
    const el = elementOf(event);
    if (!el || !isTextControl(el)) return;
    const synthetic = this.syntheticFor(event, el);
    if (synthetic === null) return;
    const entry = this.pending.get(el) ?? this.open(el);
    if (entry) entry.synthetic = synthetic; // whoever touched the field last owns the final value
  };

  private readonly onChange = (event: Event): void => {
    const el = elementOf(event);
    if (!el) return;
    if (isTextControl(el)) this.commit(el, event);
    else if (el.tagName === "SELECT") this.report("select", el, (el as HTMLSelectElement).value, event);
    else if (isToggle(el)) this.report("check", el, el.type === "checkbox" ? String(el.checked) : el.value, event);
  };

  private readonly onFocusOut = (event: Event): void => {
    const el = elementOf(event);
    if (el && isTextControl(el) && this.pending.has(el)) this.commit(el);
  };

  private readonly onSubmit = (event: Event): void => {
    const form = elementOf(event);
    const synthetic = form ? this.syntheticFor(event, form) : null;
    if (!form || synthetic === null) return;
    for (const el of [...this.pending.keys()]) if (form.contains(el)) this.commit(el);
    const submitter = (event as SubmitEvent).submitter ?? null;
    const target = submitter ? buildTarget(submitter) : formTarget(form);
    if (target) this.emit("submit", this.place(), { ...target, locked: true }, undefined, synthetic);
  };

  private readonly onUrlMaybeChanged = (): void => {
    const place = this.place();
    if (!place || place.url === this.lastUrl) return; // a query or an anchor change is still the same page
    this.lastUrl = place.url;
    this.flush();
    this.emit("navigate", place, undefined, undefined, isSyntheticNow());
  };

  private readonly onPageHide = (): void => this.flush();

  // ---------- helpers ----------

  /** false: the user did it. true: Ghost did it. null: a page script did it, which is nobody's action. */
  private syntheticFor(event: Event, el: Element): boolean | null {
    if (isSyntheticNow() || ghostWriting(el)) return true;
    return this.isTrusted(event) ? false : null;
  }

  private open(el: TextControl): Pending | null {
    const target = buildTarget(el);
    const place = this.place();
    if (!target || !place) return null;
    const entry: Pending = { target, place, synthetic: false };
    this.pending.set(el, entry);
    return entry;
  }

  /** One event per field edit, with the final value. A change without any input (autofill, pickers) counts too. */
  private commit(el: TextControl, event?: Event): void {
    let entry = this.pending.get(el) ?? null;
    this.pending.delete(el);
    if (!entry && event) {
      const synthetic = this.syntheticFor(event, el);
      entry = synthetic === null ? null : this.open(el);
      this.pending.delete(el);
      if (entry) entry.synthetic = synthetic === true;
    }
    if (!entry) return;
    // The field turned sensitive while it was being edited (a text box switched to a password box).
    const masked = isElementSensitive(el) || looksSensitiveValue(el.value);
    this.emit("input", entry.place, entry.target, masked ? MASKED_VALUE : el.value, entry.synthetic);
  }

  private report(type: TraceEventType, el: Element, value: string, event: Event): void {
    const synthetic = this.syntheticFor(event, el);
    const target = synthetic === null ? null : buildTarget(el);
    if (target) this.emit(type, this.place(), target, value, synthetic === true);
  }

  private place(): NormalizedUrl | null {
    return normalizeUrl(this.doc.location?.href ?? "");
  }

  private emit(type: TraceEventType, place: NormalizedUrl | null, target: TraceTarget | undefined, value: string | undefined, synthetic: boolean): void {
    if (!this.running || !place) return;
    const event: ContentTraceEvent = { t: this.now(), type, origin: place.origin, pathPattern: place.pathPattern, url: place.url };
    if (target) event.target = target;
    if (value !== undefined) event.value = value;
    if (synthetic) event.synthetic = true;
    this.send({ type: "ghost:trace-event", event });
  }

  private listen(on: boolean): void {
    const view = this.doc.defaultView;
    if (!view) return;
    const bind = (target: EventTarget, type: string, handler: (e: Event) => void, capture = true): void => {
      if (on) target.addEventListener(type, handler, { capture, passive: true });
      else target.removeEventListener(type, handler, { capture });
    };
    bind(view, "click", this.onClick);
    bind(view, "input", this.onInput);
    bind(view, "change", this.onChange);
    bind(view, "focusout", this.onFocusOut);
    bind(view, "submit", this.onSubmit);
    bind(view, "pagehide", this.onPageHide);
    bind(view, "popstate", this.onUrlMaybeChanged);
    bind(view, "hashchange", this.onUrlMaybeChanged);
    // The page's pushState cannot be patched from the isolated world; the Navigation API reports it.
    const navigation = (view as unknown as { navigation?: EventTarget }).navigation;
    if (navigation?.addEventListener) bind(navigation, "currententrychange", this.onUrlMaybeChanged, false);
  }
}

function formTarget(form: Element): TraceTarget | null {
  const name = form.getAttribute("aria-label") ?? form.getAttribute("name") ?? "";
  if (form.closest(MARKED_SENSITIVE) || isSensitive({ label: name })) return null;
  return { signature: `form|${form.getAttribute("name") ?? ""}|${form.id}`, label: name.trim().slice(0, 160) || "Form", kind: "other", locked: true };
}

// ---------- wiring ----------

let active: { recorder: TraceRecorder; facts: PageFactsWatcher } | null = null;

/** The content entry's one call: records and reports page facts while Ghost is enabled, and leaves no listener behind when it is not. */
export function syncLoopCapture(enabled: boolean, doc: Document = document): void {
  if (enabled && !active) {
    const facts = new PageFactsWatcher({ doc });
    active = { facts, recorder: new TraceRecorder({ doc, facts }) };
    facts.start();
    active.recorder.start();
  } else if (!enabled && active) {
    active.recorder.stop();
    active.facts.stop();
    active = null;
  }
}
