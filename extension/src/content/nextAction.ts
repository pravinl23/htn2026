// Next-action ghosts beyond forms (docs/loops.md section 2, PLAN.md Stage 5). After a user action settles and the
// form walk has nothing to offer, the visible controls near the viewport go to the worker as candidates
// ("ghost:next-candidates"). The best answer becomes a click ghost: the ghost cursor glides onto the
// element, Tab clicks it (a locked one is only focused), Escape dismisses it, and any other user action takes it away.
import { NONE, isSensitive, normalizeUrl } from "@ghost/shared";
import type { FieldKind, Ghost, GhostSettings, NextCandidate, Rect } from "@ghost/shared";
import { TRACE_LIMITS } from "../lib/loopMessages";
import type { LoopMessageOf, NextPredictionReply } from "../lib/loopMessages";
import { captureFields, findElement, isElementLocked, isElementSensitive } from "./capture";
import { executeGhost } from "./execute";
import type { ExecResult } from "./execute";
import { extensionAlive, watchForOrphan } from "./lifecycle";
import { CURSOR_PATH, CURSOR_TIP, OVERLAY_CSS } from "./overlay-style";
import { looksSensitiveValue } from "./pageFacts";
import { hasLayout, isCovered, isRendered, placement } from "./visibility";

export const NEXT_SETTLE_MS = 300;
/** A continuously mutating SPA still gets a prediction instead of postponing forever. */
export const NEXT_SETTLE_CEILING_MS = 1200;
export const NEXT_MAX_CANDIDATES = TRACE_LIMITS.candidates;
/** Same string as background/presence.ts PRESENCE_PING (kept apart so the content bundle never pulls in worker code). */
export const PRESENCE_PING = "ghost:presence";
export const PRESENCE_PING_MS = 30_000;
export const NEXT_HOST_ID = "ghost-next-host";
/** While a ghost is up: how often the gate (form ghosts, loop sheet, on/off) and the target are looked at again. */
const WATCH_MS = 250;
const URL_POLL_MS = 500;
/** Candidates may lie this many viewport heights beyond the edges: "in the viewport or near it". */
const NEAR_VIEWPORT = 0.5;
const LOOP_HOST_ID = "ghost-loop-host";
const GHOST_UI = '#ghost-overlay-host, [data-ghost-ui], [id^="ghost-"][id$="-host"]';
/** Where Tab belongs to what the user is typing into. Buttons, checkboxes and radios are not text entry. */
const EDITABLE = [
  "textarea", "select", '[contenteditable]:not([contenteditable="false"])',
  `input${["button", "submit", "reset", "image", "checkbox", "radio", "file", "range", "color", "hidden"].map((t) => `:not([type="${t}"])`).join("")}`,
].join(", ");
/** What focus can land on by itself. A focused element that is none of these holds focus inside a shadow root we cannot see into. */
const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, summary, audio[controls], video[controls], [tabindex], [contenteditable]:not([contenteditable="false"])';
/** Focus inside another document: Ghost cannot tell whether the user is typing there. */
const FOREIGN_DOCUMENT = "iframe, frame, object, embed";
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "FnLock", "Hyper", "Super", "OS", "AltGraph"]);
const HOST_CSS = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
const SVG_NS = "http://www.w3.org/2000/svg";

// ---------- candidates ----------

export interface CandidateSet {
  candidates: NextCandidate[];
  elements: Map<string, HTMLElement>;
}

function candidateKind(kind: FieldKind): NextCandidate["kind"] | null {
  if (kind === "button" || kind === "link") return kind;
  return kind === "file" || kind === "other" ? null : "field";
}

/**
 * Rule 2 for what isLockedAction's type-attribute check misses: an <input type=image> submits its form, and a
 * <button> whose type is missing OR invalid ("bogus") is a submit button. The type PROPERTY reports both right.
 */
export function submitsForm(el: Element): boolean {
  if (el instanceof HTMLButtonElement) return el.form !== null && (el.type === "submit" || el.type === "reset");
  if (el instanceof HTMLInputElement) return el.form !== null && (el.type === "submit" || el.type === "image" || el.type === "reset");
  return false;
}

/** Locked on the live DOM: data-ghost-lock, an irreversible label, or anything that submits or resets a form. */
export function lockedHere(el: Element): boolean {
  return isElementLocked(el) || submitsForm(el);
}

/** Rule 3 by shape: an SSN or a card number in a label or a signature never leaves the page, whatever the words say. */
function sensitiveText(text: string | undefined): boolean {
  return text !== undefined && (isSensitive({ label: text }) || looksSensitiveValue(text));
}

/** How far a box lies outside the viewport, in px; 0 when any of it is inside. */
function offscreenBy(rect: Rect, width: number, height: number): number {
  const dy = rect.y + rect.height <= 0 ? -(rect.y + rect.height) : rect.y >= height ? rect.y - height : 0;
  const dx = rect.x + rect.width <= 0 ? -(rect.x + rect.width) : rect.x >= width ? rect.x - width : 0;
  return Math.max(dx, dy);
}

/**
 * Visible, enabled, non-sensitive controls in or near the viewport, closest first when there are
 * more than `max`, handed out in DOM order. Ids are capture signatures: the same ones the trace recorder reports,
 * so a remembered action finds its element again. Nothing inside Ghost's own UI, never a value.
 */
export function collectCandidates(doc: Document = document, max: number = NEXT_MAX_CANDIDATES): CandidateSet {
  const view = doc.defaultView;
  const width = view?.innerWidth ?? 0;
  const height = view?.innerHeight ?? 0;
  const measured = hasLayout(doc);
  const pool: Array<{ order: number; distance: number; candidate: NextCandidate; el: HTMLElement }> = [];
  captureFields(doc).forEach((field, order) => {
    const kind = candidateKind(field.kind);
    const label = field.label.trim().slice(0, TRACE_LIMITS.label);
    if (!kind || !label || sensitiveText(label) || looksSensitiveValue(field.signature) || field.signature.length > TRACE_LIMITS.signature) return;
    const el = findElement(field.signature);
    if (!el || el.closest(GHOST_UI)) return;
    const distance = measured ? offscreenBy(field.rect, width, height) : 0;
    if (distance > height * NEAR_VIEWPORT) return;
    const candidate: NextCandidate = { id: field.signature, kind, label, locked: field.locked === true || submitsForm(el) };
    const context = field.context?.trim().slice(0, TRACE_LIMITS.context);
    if (context && !sensitiveText(context)) candidate.context = context;
    pool.push({ order, distance, candidate, el });
  });
  const kept = pool.sort((a, b) => a.distance - b.distance || a.order - b.order).slice(0, Math.max(0, max)).sort((a, b) => a.order - b.order);
  return { candidates: kept.map((k) => k.candidate), elements: new Map(kept.map((k) => [k.candidate.id, k.el])) };
}

// ---------- the ghost ----------

export interface NextGhost {
  candidate: NextCandidate;
  el: HTMLElement;
  confidence: number;
  provider: string;
  locked: boolean;
  /** Tab already focused this locked target: from now on only Enter or a click (the user's own) acts on it. */
  parked: boolean;
  /** Where the cursor glides in from (the user's last click). Used once, on the first paint. */
  from: { x: number; y: number } | null;
}

export type NextMessage = LoopMessageOf<"ghost:next-candidates">;

export interface NextActionDeps {
  /** Live ghosts of the form controller (controller.state.ghosts): while it has any, Tab is its and this stays quiet. */
  formGhosts(): number;
  isEnabled(): boolean;
  getSettings(): Pick<GhostSettings, "confidenceThreshold">;
  /** Default: the loop sheet's host says anything but "hidden". */
  isLoopOpen?(): boolean;
  doc?: Document;
  /** Default: chrome.runtime.sendMessage. */
  send?(message: NextMessage | { type: typeof PRESENCE_PING }): Promise<unknown>;
  /** Default: event.isTrusted. A page must not be able to script a Tab press into a click. */
  isUserEvent?(event: Event): boolean;
  /** Default: execute.ts, so the click is Ghost's (markSynthetic) and locks are re-checked on the DOM. */
  execute?(ghost: Ghost, el: HTMLElement): Promise<ExecResult>;
  /** Default: in the viewport, rendered and not covered. jsdom has no layout, so tests decide. */
  isVisible?(el: HTMLElement): boolean;
  /** Default: window.top === window. Frames never predict: one ghost per tab. */
  topFrame?: boolean;
  settleMs?: number;
  /** 0 switches the presence ping off. */
  presencePingMs?: number;
}

export interface NextActionHandle {
  /** The ghost on screen (or waiting for focus to come back), if any. */
  readonly ghost: NextGhost | null;
  /** Asks right away instead of after the settle delay; resolves once the answer was applied. */
  predictNow(): Promise<void>;
  stop(): void;
}

function runtimeSend(message: unknown): Promise<unknown> {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") return Promise.resolve(undefined);
  try {
    return Promise.resolve(chrome.runtime.sendMessage(message));
  } catch {
    return Promise.resolve(undefined); // extension context invalidated
  }
}

function isTopFrame(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNextReply(raw: unknown): Extract<NextPredictionReply, { ok: true }> | null {
  if (!isObject(raw) || raw.ok !== true || typeof raw.candidateId !== "string") return null;
  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) return null;
  return {
    ok: true,
    candidateId: raw.candidateId,
    confidence: raw.confidence,
    provider: typeof raw.provider === "string" ? raw.provider : "unknown",
    calibrated: raw.calibrated === true,
    latencyMs: typeof raw.latencyMs === "number" ? raw.latencyMs : null,
  };
}

interface ClosedRootAccess {
  /** Chrome content scripts: chrome.dom.openOrClosedShadowRoot. */
  dom?: { openOrClosedShadowRoot?(element: HTMLElement): ShadowRoot | null };
}

/** Open roots directly; closed ones through the extension-only APIs (Chrome's chrome.dom, Firefox's openOrClosedShadowRoot). */
function shadowRootOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  try {
    const dom = typeof chrome === "undefined" ? undefined : (chrome as unknown as ClosedRootAccess).dom;
    if (typeof dom?.openOrClosedShadowRoot === "function" && el instanceof HTMLElement) return dom.openOrClosedShadowRoot(el) ?? null;
    const firefox = (el as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot;
    return firefox ?? null;
  } catch {
    return null;
  }
}

/** Focus inside shadow roots, closed ones too where the browser lets an extension look. */
function deepActive(doc: Document): Element | null {
  let active = doc.activeElement;
  for (let inner = active ? shadowRootOf(active)?.activeElement : null; inner; inner = shadowRootOf(inner)?.activeElement) active = inner;
  return active;
}

/** designMode or a contenteditable body/html: the whole page is a text box and focus sits on the body. */
function documentEditable(doc: Document): boolean {
  if ((doc.designMode ?? "").toLowerCase() === "on") return true;
  return [doc.body, doc.documentElement].some((el) => el !== null && (el.isContentEditable === true || el.matches('[contenteditable]:not([contenteditable="false"])')));
}

/**
 * Where Tab belongs to what the user types into: a field or editor, an editable page, another document (a frame),
 * or an element that cannot hold focus itself, which means focus is inside a shadow root Ghost cannot see into.
 */
function focusInTextEntry(doc: Document, active: Element | null): boolean {
  if (documentEditable(doc)) return true;
  if (!active || active === doc.body || active === doc.documentElement) return false;
  return active.matches(EDITABLE) || active.matches(FOREIGN_DOCUMENT) || !active.matches(FOCUSABLE);
}

function hasFocus(doc: Document, el: Element): boolean {
  const active = deepActive(doc);
  return active !== null && (active === el || el.contains(active));
}

function canBeSeen(el: HTMLElement): boolean {
  return placement(el) !== "outside" && isRendered(el) && !isCovered(el);
}

function loopSheetOpen(doc: Document): boolean {
  const state = doc.getElementById(LOOP_HOST_ID)?.getAttribute("data-loop-state");
  return state !== undefined && state !== null && state !== "hidden";
}

function swallow(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

class NextAction implements NextActionHandle {
  private current: NextGhost | null = null;
  private readonly doc: Document;
  private readonly view: NextView;
  private readonly isUserEvent: (event: Event) => boolean;
  private readonly isVisible: (el: HTMLElement) => boolean;
  private readonly send: NonNullable<NextActionDeps["send"]>;
  private readonly top: boolean;
  /** Bumped by every action and navigation: an answer to an older question is dropped. */
  private epoch = 0;
  private running = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private settleStartedAt: number | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private urlTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopOrphanWatch: () => void = () => undefined;
  private lastUrl = "";
  /** What the user just clicked or edited: Tab pressed there still counts as "focus nowhere" (the form walk's lastLeft). */
  private lastActed: Element | null = null;
  private pointer: { x: number; y: number } | null = null;
  /** A held Tab that began by accepting stays swallowed until the key is released. */
  private holding = false;
  /** Escaped on this page: not offered again until the next navigation. */
  private readonly dismissed = new Set<string>();
  private frameQueued = false;
  private mutations: MutationObserver | null = null;

  constructor(private readonly deps: NextActionDeps) {
    this.doc = deps.doc ?? document;
    this.view = new NextView(this.doc);
    this.isUserEvent = deps.isUserEvent ?? ((event) => event.isTrusted);
    this.isVisible = deps.isVisible ?? canBeSeen;
    this.send = deps.send ?? runtimeSend;
    this.top = deps.topFrame ?? isTopFrame();
  }

  get ghost(): NextGhost | null {
    return this.current;
  }

  start(): void {
    if (this.running || !this.top) return;
    this.running = true;
    this.lastUrl = this.pageKey();
    this.listen(true);
    this.watchMutations();
    this.urlTimer = setInterval(this.poll, URL_POLL_MS);
    const pingMs = this.deps.presencePingMs ?? PRESENCE_PING_MS;
    if (pingMs > 0) this.pingTimer = setInterval(this.ping, pingMs);
    if (extensionAlive()) this.stopOrphanWatch = watchForOrphan(() => this.stop());
    this.schedule(); // arriving on a page is an action too
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.epoch++;
    this.listen(false);
    this.mutations?.disconnect();
    this.mutations = null;
    for (const timer of [this.urlTimer, this.pingTimer]) if (timer) clearInterval(timer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.urlTimer = this.pingTimer = this.settleTimer = null;
    this.settleStartedAt = null;
    this.stopOrphanWatch();
    this.clear();
    this.view.destroy();
  }

  async predictNow(): Promise<void> {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    await this.predict();
  }

  // ---------- asking ----------

  private schedule(): void {
    if (!this.running) return;
    const now = Date.now();
    this.settleStartedAt ??= now;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    const wait = Math.min(this.deps.settleMs ?? NEXT_SETTLE_MS, Math.max(0, NEXT_SETTLE_CEILING_MS - (now - this.settleStartedAt)));
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.settleStartedAt = null;
      void this.predict();
    }, wait);
  }

  /** Hydrating SPAs replace controls after document_idle. Re-ask once their DOM settles, bounded by the ceiling. */
  private watchMutations(): void {
    const Observer = this.doc.defaultView?.MutationObserver;
    const root = this.doc.documentElement;
    if (!Observer || !root) return;
    this.mutations = new Observer((records) => {
      const relevant = records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest(GHOST_UI)) return false;
        if (record.type !== "childList") return true;
        return [...record.addedNodes, ...record.removedNodes].some((node) => !(node instanceof Element) || !node.matches(GHOST_UI));
      });
      if (!relevant) return;
      if (this.current && !this.current.el.isConnected) this.clear();
      if (!this.current) this.schedule();
    });
    this.mutations.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "disabled", "aria-disabled", "aria-label", "role", "href", "tabindex"],
    });
  }

  /** The form walk, the loop sheet and the on/off switch all outrank a next-action ghost. */
  private gateOpen(): boolean {
    if (!this.running || !this.deps.isEnabled() || this.deps.formGhosts() > 0) return false;
    if ((this.deps.isLoopOpen ?? (() => loopSheetOpen(this.doc)))()) return false;
    return this.doc.visibilityState !== "hidden";
  }

  private async predict(): Promise<void> {
    if (!this.gateOpen() || this.typing()) return;
    const place = normalizeUrl(this.doc.location?.href ?? "");
    if (!place) return;
    const { candidates: all, elements } = collectCandidates(this.doc);
    const candidates = all.filter((c) => !this.dismissed.has(c.id));
    if (candidates.length === 0) return;
    const asked = ++this.epoch;
    const focusAtAsk = deepActive(this.doc);
    const message: NextMessage = { type: "ghost:next-candidates", url: place.url, pathPattern: place.pathPattern, candidates };
    const reply = parseNextReply(await this.send(message).catch(() => null));
    // Something happened meanwhile (an action, a native Tab, focus moved by anyone): the answer is about another moment.
    if (asked !== this.epoch || deepActive(this.doc) !== focusAtAsk || !reply || reply.candidateId === NONE) return;
    // Confidence describes how exploratory the suggestion is; it no longer suppresses a safe best guess.
    if (!this.gateOpen()) return;
    const candidate = candidates.find((c) => c.id === reply.candidateId);
    const known = candidate ? elements.get(candidate.id) : undefined;
    const el = candidate ? (known?.isConnected ? known : findElement(candidate.id)) : null;
    if (!candidate || !el || isElementSensitive(el)) return;
    this.current = {
      candidate, el, confidence: reply.confidence, provider: reply.provider,
      locked: candidate.locked || lockedHere(el), parked: false, from: this.pointer,
    };
    this.watchTimer ??= setInterval(this.render, WATCH_MS);
    this.render();
  }

  // ---------- drawing ----------

  /** Only drawn while Tab would accept it: gate open, target seen, focus on the body, the target or what was just used. */
  private readonly render = (): void => {
    const ghost = this.current;
    if (!ghost) return this.view.hide();
    if (!this.gateOpen() || !ghost.el.isConnected) return this.clear();
    if (!this.acceptable(ghost)) return this.view.hide();
    this.view.paint(ghost);
    ghost.from = null;
  };

  private acceptable(ghost: NextGhost): boolean {
    if (!this.isVisible(ghost.el)) return false;
    if (ghost.parked) return true;
    if (!this.focusOk(ghost.el)) return false;
    // Tab would only move focus there (a field, a locked action), and focus already is there: nothing to accept.
    const onlyFocuses = ghost.candidate.kind === "field" || ghost.locked || lockedHere(ghost.el);
    return !(onlyFocuses && hasFocus(this.doc, ghost.el));
  }

  /** Focus in a text box, an editor, an editable page or somewhere Ghost cannot see: Tab belongs there. No question is sent. */
  private typing(): boolean {
    return focusInTextEntry(this.doc, deepActive(this.doc));
  }

  private focusOk(el: HTMLElement): boolean {
    if (this.typing()) return false;
    const active = deepActive(this.doc);
    if (!active || active === this.doc.body || active === this.doc.documentElement) return true;
    if (active === el || el.contains(active)) return true;
    return active === this.lastActed;
  }

  private clear(): void {
    this.current = null;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.view.hide();
  }

  private scheduleRender(): void {
    if (this.frameQueued || !this.current) return;
    this.frameQueued = true;
    const run = (): void => {
      this.frameQueued = false;
      this.render();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  // ---------- keys ----------

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229 || !this.isUserEvent(event)) return;
    if (event.key === "Tab") return this.onTab(event);
    if (event.key === "Escape") return this.onEscape(event);
    if (!MODIFIERS.has(event.key)) this.userAction(null); // typing, arrows, Enter: the user moved on
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === "Tab") this.holding = false;
  };

  private onTab(event: KeyboardEvent): void {
    if (event.repeat && this.holding) return swallow(event); // the hold that accepted must not race focus off natively
    const ghost = this.current;
    const modified = event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented;
    // Parked: the user tabs on from the locked target they were shown, natively.
    if (modified || event.repeat || !ghost || ghost.parked || !this.gateOpen() || !ghost.el.isConnected || !this.acceptable(ghost)) {
      return this.tabbedAway();
    }
    swallow(event);
    this.holding = true;
    void this.accept(ghost);
  }

  /**
   * A Tab that stays native moves focus: the ghost goes, and an answer still on its way, or a question not yet asked,
   * is about the moment before. Otherwise a late answer naming the element the user just tabbed onto would turn the
   * keyboard user's next Tab into a click. Keyboard navigation itself never asks.
   */
  private tabbedAway(): void {
    this.epoch++;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.clear();
  }

  private onEscape(event: KeyboardEvent): void {
    const ghost = this.current;
    if (!ghost || event.defaultPrevented || !this.gateOpen() || !ghost.el.isConnected || !this.acceptable(ghost)) return;
    swallow(event);
    this.dismissed.add(ghost.candidate.id);
    this.epoch++;
    this.clear();
  }

  /**
   * Rule 2: a locked target is never activated by Tab; it gets focus (and keeps its lock badge) so an explicit
   * Enter or click can confirm. A field is focused, never filled (Jev picks, it does not write). Anything else is
   * clicked through execute.ts, which re-checks the lock on the live DOM and marks the click as Ghost's own.
   */
  private async accept(ghost: NextGhost): Promise<void> {
    this.epoch++;
    const { el, candidate } = ghost;
    if (ghost.locked || lockedHere(el)) {
      ghost.locked = ghost.parked = true;
      reveal(el);
      this.render();
      return;
    }
    this.clear();
    if (candidate.kind === "field") return reveal(el);
    const click: Ghost = { signature: candidate.id, action: "click", displayText: candidate.label, confidence: ghost.confidence, locked: false, source: "server" };
    await (this.deps.execute ?? executeGhost)(click, el).catch(() => undefined);
    this.schedule(); // what the click did is the next state to predict from
  }

  // ---------- page events ----------

  private userAction(target: Element | null): void {
    if (target) this.lastActed = target;
    this.epoch++;
    this.clear();
    this.schedule();
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (!this.isUserEvent(event)) return;
    if (event.clientX !== 0 || event.clientY !== 0) this.pointer = { x: event.clientX, y: event.clientY };
    this.userAction(deepActive(this.doc)); // mousedown already moved focus to what was clicked
  };

  private readonly onEdit = (event: Event): void => {
    if (this.isUserEvent(event)) this.userAction(event.target instanceof Element ? event.target : null);
  };

  private readonly onFocusChange = (): void => this.scheduleRender();

  private readonly onViewportChange = (): void => this.scheduleRender();

  /** SPA navigations the Navigation API missed, and a Ghost switched off: then nothing of ours stays on the page. */
  private readonly poll = (): void => {
    this.onUrlMaybeChanged();
    if (this.deps.isEnabled()) return;
    if (this.current) this.clear();
    this.view.destroy();
  };

  private readonly onUrlMaybeChanged = (): void => {
    const key = this.pageKey();
    if (key === this.lastUrl) return;
    this.lastUrl = key;
    this.dismissed.clear();
    this.userAction(null);
  };

  private readonly ping = (): void => {
    if (this.deps.isEnabled() && this.doc.visibilityState === "visible") void this.send({ type: PRESENCE_PING }).catch(() => undefined);
  };

  /**
   * Back in view (tab shown, window focused): beat now instead of at the next 30 s tick, because after 90 s out of
   * sight the heartbeat went stale and Ghost Desktop would treat this browser as unowned. The worker throttles.
   */
  private readonly onBackInView = (event: Event): void => {
    if ((this.deps.presencePingMs ?? PRESENCE_PING_MS) <= 0) return;
    if (event.type === "focus" && event.target instanceof Node) return; // an element's focus, not the window's
    this.ping();
  };

  /** Origin and path: an anchor jump or a query tweak is still the same page. */
  private pageKey(): string {
    const place = normalizeUrl(this.doc.location?.href ?? "");
    return place ? place.url : "";
  }

  private listen(on: boolean): void {
    const view = this.doc.defaultView;
    if (!view) return;
    const bind = (target: EventTarget, type: string, handler: (e: never) => void, options: AddEventListenerOptions): void => {
      const listener = handler as EventListener;
      if (on) target.addEventListener(type, listener, options);
      else target.removeEventListener(type, listener, options);
    };
    const capture = { capture: true };
    const passive = { capture: true, passive: true };
    bind(view, "keydown", this.onKeyDown, capture);
    bind(view, "keyup", this.onKeyUp, passive);
    bind(view, "click", this.onClick, passive);
    bind(view, "input", this.onEdit, passive);
    bind(view, "change", this.onEdit, passive);
    bind(view, "focusin", this.onFocusChange, passive);
    bind(view, "focusout", this.onFocusChange, passive);
    bind(view, "scroll", this.onViewportChange, passive);
    bind(view, "resize", this.onViewportChange, passive);
    bind(view, "popstate", this.onUrlMaybeChanged, passive);
    bind(view, "hashchange", this.onUrlMaybeChanged, passive);
    bind(this.doc, "visibilitychange", this.onBackInView, passive);
    bind(view, "focus", this.onBackInView, { passive: true });
    // The page's pushState cannot be patched from the isolated world; the Navigation API reports it.
    const navigation = (view as unknown as { navigation?: EventTarget }).navigation;
    if (navigation?.addEventListener) bind(navigation, "currententrychange", this.onUrlMaybeChanged, {});
  }
}

/** Focus the element, then centre it when it was not comfortably on screen. */
function reveal(el: HTMLElement): void {
  if (el.ownerDocument.activeElement !== el) el.focus({ preventScroll: false });
  const where = placement(el);
  if (where === "inside" || where === "unknown" || typeof el.scrollIntoView !== "function") return;
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
}

// ---------- the view: its own closed shadow host, styled like the form walk's overlay ----------

const SANS = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const NEXT_CSS = `
.next-key {
  position: absolute; left: 0; top: 0; display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px 4px 5px; border-radius: 999px; white-space: nowrap; opacity: 0;
  font: 600 11px/1 ${SANS}; color: rgba(255,255,255,.94); background: rgba(16,14,26,.88);
  border: 1px solid rgb(var(--accent) / .55); box-shadow: 0 8px 22px -8px rgb(var(--accent) / .6);
  transition: transform 180ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease;
}
.next-key kbd {
  font: 700 10px/1 ${SANS}; padding: 3px 6px 2px; border-radius: 5px;
  color: rgba(74,58,150,.95); background: linear-gradient(#ffffff, #e9e4fb); border-bottom: 2px solid rgb(var(--accent) / .55);
}
.next-key[data-visible="true"] { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .next-key { transition: none !important; } }
`;

interface ViewParts {
  host: HTMLDivElement;
  ring: HTMLDivElement;
  cursor: HTMLDivElement;
  lock: HTMLDivElement;
  key: HTMLDivElement;
  keyText: HTMLSpanElement;
}

class NextView {
  private parts: ViewParts | null = null;
  private painted = "";

  constructor(private readonly doc: Document) {}

  paint(ghost: NextGhost): void {
    const parts = this.mount();
    const r = ghost.el.getBoundingClientRect();
    const tip = { x: r.left + r.width / 2, y: r.top + r.height * 0.55 };
    const fresh = this.painted !== ghost.candidate.id;
    this.painted = ghost.candidate.id;
    const { ring, cursor, lock, key } = parts;
    for (const el of [ring, lock, key]) el.classList.add("still"); // they appear in place; only the cursor travels
    ring.style.cssText = `width:${px(r.width + 6)};height:${px(r.height + 6)};border-radius:8px;transform:${translate(r.left - 3, r.top - 3)};`;
    if (fresh && ghost.from) {
      // Glide in from where the user last clicked.
      cursor.classList.add("still");
      cursor.style.transform = translate(ghost.from.x - CURSOR_TIP.x, ghost.from.y - CURSOR_TIP.y);
      void cursor.getBoundingClientRect(); // commits the starting point so the transition runs from it
      cursor.classList.remove("still");
    } else if (fresh && this.visible(cursor)) {
      cursor.classList.remove("still"); // straight from the previous ghost to this one
    } else {
      cursor.classList.add("still"); // first appearance fades in place; a repaint on scroll tracks exactly
    }
    cursor.style.transform = translate(tip.x - CURSOR_TIP.x, tip.y - CURSOR_TIP.y);
    lock.style.transform = translate(tip.x + 14, tip.y + 22);
    key.style.transform = translate(tip.x + 18, tip.y + 20);
    parts.keyText.textContent = ghost.candidate.kind === "field" ? "to focus" : "to click";
    const locked = String(ghost.locked);
    for (const el of [ring, cursor]) {
      setAttr(el, "data-visible", "true");
      setAttr(el, "data-locked", locked);
    }
    setAttr(lock, "data-visible", locked);
    setAttr(key, "data-visible", String(!ghost.locked && !ghost.parked));
    const host = parts.host;
    setAttr(host, "data-ghost-next", "visible");
    setAttr(host, "data-ghost-next-target", ghost.candidate.id);
    setAttr(host, "data-ghost-next-locked", locked);
    setAttr(host, "data-ghost-next-parked", String(ghost.parked));
    // The root is closed, so e2e tests read where the pointer rests from the host. Coordinates only.
    setAttr(host, "data-ghost-next-cursor", `${Math.round(tip.x)},${Math.round(tip.y)}`);
  }

  hide(): void {
    this.painted = "";
    const parts = this.parts;
    if (!parts) return;
    for (const el of [parts.ring, parts.cursor, parts.lock, parts.key]) setAttr(el, "data-visible", "false");
    setAttr(parts.host, "data-ghost-next", "hidden");
    for (const name of ["data-ghost-next-target", "data-ghost-next-locked", "data-ghost-next-parked", "data-ghost-next-cursor"]) setAttr(parts.host, name, null);
  }

  destroy(): void {
    this.parts?.host.remove();
    this.parts = null;
    this.painted = "";
  }

  private visible(el: Element): boolean {
    return el.getAttribute("data-visible") === "true";
  }

  /** Lazy, and again after a page dropped our host. One host for the page's lifetime: no mutation churn per ghost. */
  private mount(): ViewParts {
    if (this.parts?.host.isConnected) return this.parts;
    this.parts?.host.remove();
    this.doc.getElementById(NEXT_HOST_ID)?.remove();
    const parts = buildView(this.doc);
    this.doc.documentElement.appendChild(parts.host);
    this.parts = parts;
    return parts;
  }
}

function buildView(doc: Document): ViewParts {
  const host = make(doc, "div");
  host.id = NEXT_HOST_ID;
  host.setAttribute("data-ghost-ui", "");
  host.setAttribute("data-ghost-next", "hidden");
  host.style.cssText = HOST_CSS;
  const shadow = host.attachShadow({ mode: "closed" });
  adoptStyles(doc, shadow, `${OVERLAY_CSS}\n${NEXT_CSS}`);
  const layer = make(doc, "div", "layer");
  const ring = make(doc, "div", "ring still");
  const lock = buildLock(doc);
  const key = make(doc, "div", "next-key still");
  const keyText = make(doc, "span", undefined, "to click");
  key.append(make(doc, "kbd", undefined, "Tab"), keyText);
  const cursor = buildCursor(doc);
  layer.append(ring, lock, key, cursor);
  shadow.appendChild(layer);
  return { host, ring, cursor, lock, key, keyText };
}

function adoptStyles(doc: Document, shadow: ShadowRoot, css: string): void {
  try {
    const Sheet = doc.defaultView?.CSSStyleSheet;
    if (Sheet && "replaceSync" in Sheet.prototype && "adoptedStyleSheets" in shadow) {
      const sheet = new Sheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      return;
    }
  } catch {
    // fall through to the <style> element
  }
  shadow.appendChild(make(doc, "style", undefined, css));
}

function buildCursor(doc: Document): HTMLDivElement {
  const cursor = make(doc, "div", "cursor still");
  const svg = svgEl(doc, "svg", { width: "28", height: "28", viewBox: "0 0 28 28", fill: "none", "aria-hidden": "true" });
  const gradient = svgEl(doc, "linearGradient", { id: "ghost-next-fill", x1: "4", y1: "3", x2: "19", y2: "25", gradientUnits: "userSpaceOnUse" });
  gradient.append(
    svgEl(doc, "stop", { "stop-color": "#ffffff", "stop-opacity": "0.92" }),
    svgEl(doc, "stop", { offset: "1", "stop-color": "#cdc2ff", "stop-opacity": "0.5" }),
  );
  const defs = svgEl(doc, "defs", {});
  defs.appendChild(gradient);
  svg.append(defs, svgEl(doc, "path", { class: "body", d: CURSOR_PATH, fill: "url(#ghost-next-fill)", "stroke-width": "1.5", "stroke-linejoin": "round" }));
  cursor.append(make(doc, "div", "halo"), svg);
  return cursor;
}

function buildLock(doc: Document): HTMLDivElement {
  const lock = make(doc, "div", "lock still");
  const svg = svgEl(doc, "svg", { width: "13", height: "13", viewBox: "0 0 16 16", "aria-hidden": "true" });
  svg.append(
    svgEl(doc, "rect", { x: "3", y: "7", width: "10", height: "7.5", rx: "2", fill: "currentColor" }),
    svgEl(doc, "path", { d: "M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" }),
  );
  const text = make(doc, "span", "lock-text");
  text.append(make(doc, "kbd", undefined, "Enter"), " to confirm");
  lock.append(svg, text);
  return lock;
}

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function svgEl(doc: Document, tag: string, attrs: Record<string, string>): SVGElement {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

function setAttr(el: Element, name: string, value: string | null): void {
  if (el.getAttribute(name) === value) return;
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`;
}

function translate(x: number, y: number): string {
  return `translate(${px(x)},${px(y)})`;
}

/** The content entry's one call. Runs in the top frame only; returns a handle whose stop() removes everything. */
export function startNextAction(deps: NextActionDeps): NextActionHandle {
  const next = new NextAction(deps);
  next.start();
  return next;
}
