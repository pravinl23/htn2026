import type { Ghost, GhostSettings, Profile } from "@ghost/shared";
import { captureFields, computeSignature, findElement } from "./capture";
import { executeGhost, radioGroup } from "./execute";
import type { Overlay, OverlayState } from "./overlay";
import { buildGhostsOffline, isPlaceholderChoice } from "./predict";
import { isCovered, isRendered, placement } from "./visibility";

export interface ControllerDeps {
  overlay: Overlay;
  getProfile(): Profile;
  getSettings(): GhostSettings;
  doc?: Document;
  /**
   * Whether an event came from the user. Defaults to `event.isTrusted`: a page must not be able to
   * script a Tab press and have Ghost pour the profile into its fields. Tests override it.
   */
  isUserEvent?: (event: Event) => boolean;
}

export interface ControllerState {
  /** Live ghosts only: accepted and dismissed ones leave the list. */
  ghosts: Ghost[];
  currentIndex: number;
  accepted: number;
  dismissed: Set<string>;
  keystrokesSaved: number;
  error: string | null;
}

const RESCAN_DEBOUNCE_MS = 150;
const RESCAN_MAX_WAIT_MS = 600;
const URL_POLL_MS = 500;
const PROVIDER = "offline-heuristic";
const CONTROLS = 'input, textarea, select, button, [role="button"]';
const OUR_IDS = new Set(["ghost-overlay-host", "ghost-overlay-page-style"]);
// Attributes that can show, hide, enable, rename or reclassify a field. `value` is left out on purpose:
// React mirrors it on every write, and data-ghost-* is our own churn.
const WATCHED_ATTRS = [
  "hidden", "disabled", "readonly", "inert", "open", "class", "style", "type", "name", "id", "for", "tabindex",
  "placeholder", "autocomplete", "aria-hidden", "aria-disabled", "aria-readonly", "aria-label", "aria-labelledby",
  "data-ghost-lock", "data-ghost-sensitive", "data-sensitive",
];
/** Animations rewrite these every frame; they only matter on something that is or holds a control. */
const NOISY_ATTRS = new Set(["class", "style"]);

export class GhostController {
  readonly state: ControllerState = {
    ghosts: [], currentIndex: -1, accepted: 0, dismissed: new Set(), keystrokesSaved: 0, error: null,
  };

  private readonly doc: Document;
  private readonly isUserEvent: (event: Event) => boolean;
  private readonly els = new Map<string, HTMLElement>();
  /** The field the walk just left (accepted, dismissed or typed over): Tab pressed there still belongs to the walk. */
  private lastLeft: HTMLElement | null = null;
  /** The Submit this walk is heading for. No other locked button is ever kept alive on its own. */
  private lockSignature: string | null = null;
  private touched = new WeakSet<Element>();
  private running = false;
  private busy = false;
  private pendingTabs = 0;
  /** A held Tab only keeps accepting when the hold began with a press Ghost intercepted. */
  private walking = false;
  private halted = false;
  private rescanDeferred = false;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private rescanWaitingSince = 0;
  private renderQueued = false;
  private urlTimer: ReturnType<typeof setInterval> | null = null;
  private lastUrl = "";
  private lastLatencyMs: number | null = null;
  private observer: MutationObserver | null = null;

  constructor(private readonly deps: ControllerDeps) {
    this.doc = deps.doc ?? document;
    this.isUserEvent = deps.isUserEvent ?? ((event) => event.isTrusted);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastUrl = this.doc.location?.href ?? "";
    this.listen(true);
    this.observe();
    this.urlTimer = setInterval(this.onUrlMaybeChanged, URL_POLL_MS);
    this.rescan();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.listen(false);
    this.observer?.disconnect();
    this.observer = null;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    if (this.urlTimer) clearInterval(this.urlTimer);
    this.rescanTimer = this.urlTimer = null;
    this.pendingTabs = 0;
    this.walking = this.halted = this.rescanDeferred = false;
    this.state.ghosts = [];
    this.state.currentIndex = -1;
    this.state.keystrokesSaved = 0;
    this.forgetWalk();
    this.els.clear();
    this.deps.overlay.destroy();
  }

  /** Capture, predict and render right now. DOM mutations and navigations reach this debounced. */
  rescan(): void {
    if (!this.running) return;
    if (this.busy) {
      this.rescanDeferred = true; // never swap the ghost list under a write that is in flight
      return;
    }
    const started = performance.now();
    const keepLock = this.state.accepted > 0 && this.lockSignature !== null;
    const deps = { profile: this.deps.getProfile(), settings: this.deps.getSettings(), keepLock, lockSignature: this.lockSignature ?? undefined };
    const ghosts = buildGhostsOffline(captureFields(this.doc), deps);
    this.lastLatencyMs = performance.now() - started;
    this.adopt(ghosts.filter((g) => !this.state.dismissed.has(g.signature)));
    this.render();
  }

  // ---------- state ----------

  private adopt(ghosts: Ghost[]): void {
    const previous = this.current()?.signature;
    this.els.clear();
    this.state.ghosts = ghosts.filter((ghost) => {
      const el = findElement(ghost.signature);
      if (el) this.els.set(ghost.signature, el);
      return el !== null;
    });
    this.trackLock();
    this.prune();
    const candidates = [this.indexOfSignature(previous), this.indexOfElement(deepActive(this.doc))];
    this.state.currentIndex = candidates.find((index) => index >= 0 && !this.lockedTooEarly(index)) ?? this.nextFrom(0);
  }

  /** Remembers the walk's Submit while value ghosts are around; afterwards any other lone lock ghost is a stranger. */
  private trackLock(): void {
    const { ghosts } = this.state;
    const lock = ghosts.find((g) => g.locked);
    if (ghosts.some((g) => !g.locked)) this.lockSignature = lock?.signature ?? null;
    else if (lock && lock.signature !== this.lockSignature) this.state.ghosts = [];
  }

  /** A lone Submit ghost is only worth showing once this walk has filled something. */
  private prune(): void {
    if (this.state.ghosts.length > 0 && (this.state.accepted > 0 || this.hasUnlocked())) return;
    this.state.ghosts = [];
    this.els.clear();
  }

  private hasUnlocked(): boolean {
    return this.state.ghosts.some((g) => !g.locked);
  }

  /** Rule 2: the lock ghost only becomes current once no unlocked ghost is left, however focus got to the button. */
  private lockedTooEarly(index: number): boolean {
    return this.state.ghosts[index]?.locked === true && this.hasUnlocked();
  }

  /** A new page (or a stopped Ghost) starts a new walk: nothing accepted, nothing dismissed, no Submit to keep. */
  private forgetWalk(): void {
    this.state.accepted = 0;
    this.state.dismissed.clear();
    this.state.error = null;
    this.lastLeft = null;
    this.lockSignature = null;
    this.touched = new WeakSet();
  }

  private current(): Ghost | null {
    return this.state.ghosts[this.state.currentIndex] ?? null;
  }

  private indexOfSignature(signature: string | undefined): number {
    return signature === undefined ? -1 : this.state.ghosts.findIndex((g) => g.signature === signature);
  }

  private indexOfElement(target: Element | null): number {
    if (!target) return -1;
    return this.state.ghosts.findIndex((g) => {
      const el = this.els.get(g.signature);
      return el === target || (el !== undefined && isRadio(el) && isRadio(target) && radioGroup(el).includes(target));
    });
  }

  /** Next unlocked ghost at or after `from`, wrapping around; the locked one only when nothing else is left. */
  private nextFrom(from: number): number {
    const { ghosts } = this.state;
    for (let step = 0; step < ghosts.length; step++) {
      const index = (from + step) % ghosts.length;
      if (!ghosts[index]?.locked) return index;
    }
    return ghosts.length > 0 ? 0 : -1;
  }

  /** Drops a ghost. A different current ghost (the user moved focus mid-write) stays current. */
  private remove(signature: string): void {
    const index = this.indexOfSignature(signature);
    if (index < 0) return;
    const current = this.current()?.signature;
    this.lastLeft = this.els.get(signature) ?? this.lastLeft;
    this.state.ghosts.splice(index, 1);
    this.els.delete(signature);
    this.prune();
    this.state.currentIndex = current !== undefined && current !== signature ? this.indexOfSignature(current) : this.nextFrom(index);
  }

  private dismiss(signature: string): void {
    this.state.dismissed.add(signature);
    this.remove(signature);
    this.render();
  }

  /** The element behind a ghost, re-resolved when a re-render replaced the node. */
  private resolve(ghost: Ghost): HTMLElement | null {
    const known = this.els.get(ghost.signature);
    if (known?.isConnected) return known;
    const found = findElement(ghost.signature);
    if (found) this.els.set(ghost.signature, found);
    else this.els.delete(ghost.signature);
    return found;
  }

  // ---------- keys ----------

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229 || !this.isUserEvent(event)) return;
    if (event.key === "Tab") this.onTab(event);
    else if (event.key === "Escape") this.onEscape(event);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === "Tab") this.walking = this.halted = false;
  };

  private onTab(event: KeyboardEvent): void {
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (this.busy) return this.onTabMidWrite(event);
    if (!event.repeat) this.walking = this.halted = false;
    else if (!this.walking) return; // a hold that started as native Tab stays native
    if (this.lockedTooEarly(this.state.currentIndex)) this.state.currentIndex = this.nextFrom(0);
    const ghost = this.visibleCurrent();
    if (!ghost) {
      if (event.repeat) swallow(event); // the walk ran out mid-hold: do not let focus race off natively
      return;
    }
    if (!event.repeat && !this.focusInWalk(ghost)) return;
    swallow(event);
    this.walking = true;
    if (event.repeat && this.halted) return;
    this.pendingTabs++;
    void this.drain();
  }

  /** A press during a write is Ghost's: a fresh one is queued (and owns the hold that follows), a repeat is dropped. */
  private onTabMidWrite(event: KeyboardEvent): void {
    swallow(event);
    if (event.repeat) return;
    this.walking = true;
    this.halted = false;
    this.pendingTabs = Math.min(this.pendingTabs + 1, this.state.ghosts.length);
  }

  /** Same gate as Tab: an Escape meant for the page's own modal or menu is never Ghost's to eat. */
  private onEscape(event: KeyboardEvent): void {
    if (this.busy) return;
    const ghost = this.visibleCurrent();
    if (!ghost || !this.focusInWalk(ghost)) return;
    swallow(event);
    this.dismiss(ghost.signature);
  }

  /** Rule 1: Tab is only ours while the current ghost can actually be seen. */
  private visibleCurrent(): Ghost | null {
    const ghost = this.current();
    const el = ghost ? this.resolve(ghost) : null;
    return ghost && el && canBeSeen(landingElement(ghost, el)) ? ghost : null;
  }

  /**
   * Tab and Escape only belong to the walk while the user is in it: focus nowhere, on the current ghost's
   * element, or on the field the walk just left. In a search box, an essay answer, a code editor or a
   * dialog the key stays native; landing on a ghosted field makes that ghost current (rule 7) anyway.
   */
  private focusInWalk(ghost: Ghost): boolean {
    const active = deepActive(this.doc);
    if (!active || active === this.doc.body || active === this.doc.documentElement) return true;
    return sameControl(this.els.get(ghost.signature), active) || sameControl(this.lastLeft, active);
  }

  // ---------- accepting ----------

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.pendingTabs > 0 && this.running) {
        this.pendingTabs--;
        await this.acceptCurrent();
      }
    } finally {
      this.busy = false;
      this.pendingTabs = 0;
      if (this.rescanDeferred) this.scheduleRescan();
      this.rescanDeferred = false;
    }
  }

  private async acceptCurrent(): Promise<void> {
    const ghost = this.current();
    if (!ghost) return;
    const el = this.resolve(ghost);
    if (!el) return this.skip(ghost);
    if (ghost.locked) return this.park(ghost, el);
    if (hasValue(el)) return this.dismiss(ghost.signature); // rule 9: never overwrite what is already there
    if (!canBeSeen(landingElement(ghost, el))) return this.hold(); // queued press, but the field got hidden meanwhile
    const result = await executeGhost(ghost, el);
    if (!this.running) return;
    if (!result.ok) return this.fail(ghost, result.reason ?? "failed");
    this.state.accepted++;
    this.state.keystrokesSaved += ghost.action === "fill" ? (ghost.value ?? "").length : 1;
    this.state.error = null;
    this.remove(ghost.signature);
    this.focusCurrent();
    this.render();
  }

  private skip(ghost: Ghost): void {
    this.remove(ghost.signature);
    this.rescanDeferred = true;
    this.render();
  }

  /** No write the user cannot see: drop the queued presses and let a rescan decide what is left. */
  private hold(): void {
    this.pendingTabs = 0;
    this.rescanDeferred = true;
  }

  /** Rule 3: a locked ghost is never activated. Focus lands on it so Enter or a click can confirm. */
  private park(ghost: Ghost, el: HTMLElement): void {
    this.pendingTabs = 0;
    reveal(landingElement(ghost, el));
    this.render();
  }

  /** Rule 8: stop the walk, keep the rest pending, say why. The message never carries profile values. */
  private fail(ghost: Ghost, reason: string): void {
    this.pendingTabs = 0;
    this.halted = true;
    this.state.error = `Ghost could not fill this field (${reason})`;
    this.dismiss(ghost.signature);
  }

  private focusCurrent(): void {
    const ghost = this.current();
    const el = ghost ? this.resolve(ghost) : null;
    if (ghost && el) reveal(landingElement(ghost, el));
  }

  // ---------- page events ----------

  private readonly onInput = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.dataset || target.dataset.ghostWriting === "1") return;
    const ghost = this.state.ghosts[this.indexOfElement(target)];
    const byUser = this.isUserEvent(event);
    // Rule 5: the user's typing wins for good. A script-made change just needs a fresh look.
    if (ghost && byUser) this.dismiss(ghost.signature);
    else if (ghost) this.scheduleRescan();
    else if (byUser) this.rememberTouched(target);
  };

  /** Rule 9 for fields without a ghost yet: a box the user ticked or text they typed is never second-guessed later. */
  private rememberTouched(target: HTMLElement): void {
    if (this.touched.has(target) || !target.matches("input, textarea, select")) return;
    this.touched.add(target);
    this.state.dismissed.add(computeSignature(target));
  }

  private readonly onFocusIn = (event: Event): void => {
    const index = this.indexOfElement(event.target as Element | null);
    if (index < 0 || index === this.state.currentIndex || this.lockedTooEarly(index)) return;
    this.state.currentIndex = index;
    this.render();
  };

  private readonly onViewportChange = (): void => this.scheduleRender();

  private readonly onUrlMaybeChanged = (): void => {
    const href = this.doc.location?.href ?? "";
    if (href === this.lastUrl) return;
    // An anchor jump or a query tweak is still the same page: dismissals and the walk survive it.
    if (pageKey(href) !== pageKey(this.lastUrl)) this.forgetWalk();
    this.lastUrl = href;
    this.scheduleRescan();
  };

  private readonly onMutations = (records: MutationRecord[]): void => {
    const changes = records.filter(isPageMutation);
    if (changes.length === 0) return;
    if (this.state.ghosts.length > 0) this.scheduleRender();
    if (changes.some(touchesControls)) this.scheduleRescan();
  };

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
    bind(view, "input", this.onInput, passive);
    bind(view, "focusin", this.onFocusIn, passive);
    bind(view, "scroll", this.onViewportChange, passive);
    bind(view, "resize", this.onViewportChange, passive);
    bind(view, "popstate", this.onUrlMaybeChanged, passive);
    bind(view, "hashchange", this.onUrlMaybeChanged, passive);
    // The page's pushState cannot be patched from the isolated world; the Navigation API reports it.
    const navigation = (view as unknown as { navigation?: EventTarget }).navigation;
    if (navigation?.addEventListener) bind(navigation, "currententrychange", this.onUrlMaybeChanged, {});
  }

  private observe(): void {
    const Observer = this.doc.defaultView?.MutationObserver;
    if (!Observer) return;
    this.observer = new Observer(this.onMutations);
    this.observer.observe(this.doc.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRS,
    });
  }

  // ---------- scheduling and drawing ----------

  /** Trailing debounce with a ceiling, so a page that never stops mutating still gets rescanned. */
  private scheduleRescan(): void {
    if (!this.running) return;
    const now = Date.now();
    if (this.rescanTimer === null) this.rescanWaitingSince = now;
    else if (now - this.rescanWaitingSince >= RESCAN_MAX_WAIT_MS) return;
    else clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  private scheduleRender(): void {
    if (this.renderQueued || !this.running) return;
    this.renderQueued = true;
    nextFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    if (!this.running) return;
    const { ghosts, currentIndex, accepted, error } = this.state;
    const entries: OverlayState["ghosts"] = [];
    ghosts.forEach((ghost, index) => {
      const el = this.els.get(ghost.signature);
      if (el) entries.push({ ghost, el, status: index === currentIndex ? "current" : "pending" });
    });
    this.deps.overlay.render({ ghosts: entries, hud: this.hud(), accepted, error });
  }

  private hud(): OverlayState["hud"] {
    const { ghosts, accepted, error, keystrokesSaved } = this.state;
    const active = ghosts.length > 0 || accepted > 0 || error !== null;
    if (!active || !this.deps.getSettings().showHud) return undefined;
    return { provider: PROVIDER, latencyMs: this.lastLatencyMs, cache: "offline", keystrokesSaved };
  }
}

function swallow(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function nextFrame(run: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function isRadio(el: Element): el is HTMLInputElement {
  return el.tagName === "INPUT" && (el as HTMLInputElement).type === "radio";
}

/** Where focus and the cursor land: the radio carrying the ghost's value, otherwise the element itself. */
function landingElement(ghost: Ghost, el: HTMLElement): HTMLElement {
  if (!isRadio(el)) return el;
  return radioGroup(el).find((radio) => radio.value === ghost.value) ?? el;
}

/** True when the field already holds something: a ghost must never replace it. */
function hasValue(el: HTMLElement): boolean {
  if (isRadio(el)) return radioGroup(el).some((radio) => radio.checked);
  if (el.tagName === "SELECT") {
    const select = el as HTMLSelectElement;
    const chosen = select.selectedOptions[0];
    return !isPlaceholderChoice(select.value, chosen?.label || chosen?.text || "");
  }
  if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "checkbox") return false; // state, not a value
  return ((el as HTMLInputElement).value ?? "") !== "";
}

function ourNode(node: Node): boolean {
  return OUR_IDS.has((node as Element).id ?? "");
}

/** A carousel or progress bar animating through class/style cannot change any field unless it is or holds one. */
function touchesControls(record: MutationRecord): boolean {
  if (record.type !== "attributes" || !NOISY_ATTRS.has(record.attributeName ?? "")) return true;
  const target = record.target as Element;
  return target.matches(CONTROLS) || target.querySelector(CONTROLS) !== null;
}

/** Origin, path and a hash that is a route ("#/inbox", "#!/x"). Plain anchors and the query string are the same page. */
function pageKey(href: string): string {
  try {
    const url = new URL(href);
    return url.origin + url.pathname + (/^#[!/]/.test(url.hash) ? url.hash : "");
  } catch {
    return href;
  }
}

/** Focus inside open shadow roots; a closed root reports its host, which is never part of the walk. */
function deepActive(doc: Document): Element | null {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function sameControl(el: HTMLElement | null | undefined, active: Element): boolean {
  if (!el) return false;
  return el === active || (isRadio(el) && isRadio(active) && radioGroup(el).includes(active));
}

/** In the viewport, rendered (CSS-only hiding included) and not under a sticky header, a modal or a scroll edge. */
function canBeSeen(el: HTMLElement): boolean {
  return placement(el) !== "outside" && isRendered(el) && !isCovered(el);
}

/** Only element-level changes to the page itself count; our own host, style and text churn do not. */
function isPageMutation(record: MutationRecord): boolean {
  if (ourNode(record.target)) return false;
  if (record.type === "attributes") return true;
  const changed = [...record.addedNodes, ...record.removedNodes];
  return changed.some((node) => node.nodeType === 1 && !ourNode(node));
}

/** Focus the element, then centre it when it was not comfortably on screen. */
function reveal(el: HTMLElement): void {
  const before = placement(el);
  if (el.ownerDocument.activeElement !== el) el.focus({ preventScroll: false });
  if (before === "inside" || before === "unknown" || typeof el.scrollIntoView !== "function") return;
  // "instant": a smooth scroll would leave the next ghost off screen for the next held-Tab repeat.
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
}
