import type { CapturedField, Ghost, GhostSettings, LearnedAnswerStore, Profile } from "@ghost/shared";
import { ghostEvents } from "../lib/events";
import type { GhostEmitter, GhostEventMap, PredictionSource } from "../lib/events";
import { factKeysId, formSignature } from "../lib/formCache";
import { TEXT_LIMITS } from "../lib/messages";
import type { ServedAssignment, TextPageContext } from "../lib/messages";
import { captureFields, computeSignature, findElement, isElementSensitive } from "./capture";
import { executeGhost, radioGroup } from "./execute";
import { buildTextRequest } from "./freeText";
import type { DraftChange, DraftScheduler } from "./freeText";
import { focusOnBody, offscreenDirection } from "./jump";
import type { JumpHint } from "./jump";
import type { Overlay, OverlayState } from "./overlay";
import { extractPageContext } from "./pageContext";
import { isPlaceholderChoice, planForm, predictableFields, usableFactKeys } from "./predict";
import type { FormAnswer, PredictForm } from "./predict";
import { pageOwnsTab } from "./tabSurface";
import { isCovered, isRendered, placement } from "./visibility";

export interface ControllerDeps {
  overlay: Overlay;
  getProfile(): Profile;
  getSettings(): GhostSettings;
  /** Synchronous in-memory view of the local answer store; storage hydration happens at content-script boot. */
  getAnswers?(): LearnedAnswerStore | null;
  doc?: Document;
  /**
   * Whether an event came from the user. Defaults to `event.isTrusted`: a page must not be able to
   * script a Tab press and have Ghost pour the profile into its fields. Tests override it.
   */
  isUserEvent?: (event: Event) => boolean;
  /** Cache, then server, once per form. Left out (unit tests, no worker) Ghost simply stays offline. */
  predictForm?: PredictForm;
  /** Defaults to the content script's singleton. */
  events?: GhostEmitter;
  /** Streams free-text drafts through the worker (Stage 3). Left out, essay fields get no ghost. */
  drafts?: DraftScheduler;
}

/** What the HUD says about where the ghosts on screen came from. */
interface PredictionInfo {
  provider: string;
  cache: "hit" | "miss" | "offline";
  latencyMs: number | null;
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
const OFFLINE: PredictionInfo = { provider: "offline-heuristic", cache: "offline", latencyMs: null };
/** A page that keeps growing new forms (or a hostile one) gets this many server calls per load, no more. */
const MAX_FORMS_PER_PAGE = 6;
/** One lone text box is a search field, not a form: not worth a model call unless offline already sees a fact in it. */
const MIN_FORM_FIELDS = 2;
/** After this long on screen the current ghost is what the user is about to accept: an upgrade leaves it alone. */
const SETTLE_MS = 400;
/** Tab on a draft that is still streaming waits this long for the rest of it, then gives the key back. */
export const DRAFT_WAIT_MS = 4000;
const CONTROLS = 'input, textarea, select, button, [role="button"]';
/** What `user:input` reports on. A chosen file is not something to learn from. */
const EDITABLE = 'input:not([type="file"]), textarea, select';
const OUR_IDS = new Set(["ghost-overlay-host", "ghost-overlay-page-style"]);
// Attributes that can show, hide, enable, rename or reclassify a field. `value` is left out on purpose:
// React mirrors it on every write, and data-ghost-* is our own churn.
const WATCHED_ATTRS = [
  "hidden", "disabled", "readonly", "inert", "open", "class", "style", "type", "name", "id", "for", "tabindex",
  "placeholder", "autocomplete", "aria-hidden", "aria-disabled", "aria-readonly", "aria-label", "aria-labelledby",
  "data-ghost-lock", "data-ghost-sensitive", "data-sensitive",
  // The page taking Tab (or giving it back) is a change Ghost must notice: tabSurface.ts.
  "data-ghost-tab",
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
  /** Fields the user edited since their last commit: a blur without a change event still reports them. */
  private edited = new WeakSet<Element>();
  /** The last capture by signature: what the events hand to subscribers. */
  private fields = new Map<string, CapturedField>();
  /** Form signatures already sent through `predictForm` on this page load: never twice. */
  private readonly asked = new Set<string>();
  private readonly served = new Map<string, ServedAssignment>();
  /** Ghosts the user was on when an upgrade arrived: they keep their offline version. */
  private readonly pinned = new Set<string>();
  private readonly shown = new Set<string>();
  private prediction: PredictionInfo = OFFLINE;
  private factsId = "";
  private epoch = 0;
  private shownAt = 0;
  private finished = false;
  private jumpShown = false;
  private jumpDismissed = false;
  /** The draft a Tab press is waiting on (it shimmers). Escape or typing ends the wait. */
  private awaiting: string | null = null;
  /** Drafts that already triggered their one immediate rescan; later surprises go through the debounce. */
  private readonly draftSeen = new Set<string>();
  /** The Submit the walk reached: Tab pressed there still belongs to the walk when a late draft appears. */
  private parkedOn: HTMLElement | null = null;
  private pageContext: TextPageContext | null = null;
  private readonly events: GhostEmitter;
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
  /** The agent can temporarily own execution while capture, prediction and rendering keep running. */
  private interactive = true;

  constructor(private readonly deps: ControllerDeps) {
    this.doc = deps.doc ?? document;
    this.isUserEvent = deps.isUserEvent ?? ((event) => event.isTrusted);
    this.events = deps.events ?? ghostEvents;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastUrl = this.doc.location?.href ?? "";
    this.listen(true);
    this.deps.drafts?.subscribe(this.onDraftChange);
    this.observe();
    this.urlTimer = setInterval(this.onUrlMaybeChanged, URL_POLL_MS);
    this.rescan();
  }

  setInteractive(interactive: boolean): void {
    this.interactive = interactive;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.listen(false);
    this.deps.drafts?.subscribe(null);
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
    this.forgetPredictions();
    this.epoch++; // an answer still in flight belongs to a Ghost that was switched off
    this.els.clear();
    this.fields.clear();
    this.deps.overlay.destroy();
  }

  /** Capture, predict and render right now. DOM mutations and navigations reach this debounced. */
  rescan(): void {
    if (!this.running) return;
    if (this.busy) {
      this.rescanDeferred = true; // never swap the ghost list under a write that is in flight
      return;
    }
    if (pageOwnsTab(this.doc)) return this.standDown();
    const started = performance.now();
    const keepLock = this.state.accepted > 0 && this.lockSignature !== null;
    const deps = {
      profile: this.deps.getProfile(), settings: this.deps.getSettings(), keepLock,
      lockSignature: this.lockSignature ?? undefined, drafts: this.deps.drafts, answers: this.deps.getAnswers?.(),
    };
    const fields = captureFields(this.doc);
    const factKeys = usableFactKeys(deps.profile);
    this.fields = new Map(fields.map((field) => [field.signature, field]));
    const factsId = factKeysId(factKeys);
    if (factsId !== this.factsId) this.forgetPredictions(factsId);
    const answers = [...this.served.values()].filter((a) => !this.pinned.has(a.signature));
    const plan = planForm(fields, answers, deps, this.source());
    this.lastLatencyMs = performance.now() - started;
    this.adopt(plan.ghosts.filter((g) => !this.state.dismissed.has(g.signature)));
    this.announce();
    this.render();
    this.requestPrediction(fields, factKeys);
    this.requestDrafts(plan.textFields);
  }

  /**
   * The page declared that it owns Tab (tabSurface.ts): every ghost goes, nothing is drawn and no question is
   * sent about a page Ghost may not act on. An ordinary rescan brings the walk back when the page gives Tab up.
   */
  private standDown(): void {
    const had = this.state.ghosts.length > 0;
    this.state.ghosts = [];
    this.state.currentIndex = -1;
    this.els.clear();
    if (had || this.jumpShown) this.render();
  }

  // ---------- free-text drafts, streamed in the background ----------

  /** Every essay field starts drafting as soon as the form is known, while the user is still on the first fields. */
  private requestDrafts(textFields: CapturedField[]): void {
    const drafts = this.deps.drafts;
    if (!drafts) return;
    for (const field of textFields) {
      if (drafts.has(field.signature) || this.state.dismissed.has(field.signature)) continue;
      const el = findElement(field.signature);
      const limit = el ? maxLengthOf(el) : undefined;
      if (!el || isElementSensitive(el) || (limit !== undefined && limit < TEXT_LIMITS.minMaxChars)) continue;
      drafts.want({ signature: field.signature, limit, build: () => buildTextRequest(field, this.deps.getProfile(), this.context(), limit) });
    }
  }

  /** Company, role and posting text, read once per page and only when a draft is really about to be asked for. */
  private context(): TextPageContext {
    return (this.pageContext ??= extractPageContext(this.doc));
  }

  /**
   * A delta grows the ghost in place (no capture per token); the first text of a field needs a rescan so the
   * ghost joins the list in DOM order, and a failed stream takes its half-written ghost away again.
   */
  private readonly onDraftChange = (signature: string, change: DraftChange): void => {
    if (!this.running) return;
    const index = this.indexOfSignature(signature);
    const ghost = this.state.ghosts[index];
    const draft = this.deps.drafts?.get(signature);
    if (change === "failed") return ghost ? this.rescan() : undefined;
    if (!draft) return; // only whitespace so far: nothing to show yet
    if (!ghost) return this.noticeDraft(signature);
    this.state.ghosts[index] = { ...ghost, value: draft.text, displayText: draft.text, pending: draft.pending || undefined };
    if (change === "done") this.render();
    else this.scheduleRender();
  };

  private noticeDraft(signature: string): void {
    if (this.state.dismissed.has(signature)) return;
    if (this.draftSeen.has(signature)) return this.scheduleRescan();
    this.draftSeen.add(signature);
    this.rescan();
  }

  // ---------- cache -> server, in the background ----------

  /** At most once per form signature per page load, and never on a rescan of a form already asked about. */
  private requestPrediction(fields: CapturedField[], factKeys: string[]): void {
    const predict = this.deps.predictForm;
    const wire = predict && factKeys.length > 0 ? predictableFields(fields, this.deps.getAnswers?.()) : [];
    if (!predict || wire.length === 0 || (wire.length < MIN_FORM_FIELDS && !this.hasUnlocked())) return;
    const signature = formSignature(wire);
    if (this.asked.has(signature) || this.asked.size >= MAX_FORMS_PER_PAGE) return;
    this.asked.add(signature);
    const { epoch, factsId } = this;
    const origin = this.doc.location?.origin ?? "";
    const stillWanted = (): boolean => this.running && epoch === this.epoch && factsId === this.factsId;
    // Server down, slow or wrong: the offline ghosts are already on screen and simply stay.
    void predict({ origin, formSignature: signature, fields: wire, factKeys }).then((answer) => {
      if (answer && stillWanted()) this.upgrade(answer);
    }, () => undefined);
  }

  /** New answers never touch the ghost the user is on; everything else is rebuilt by an ordinary rescan. */
  private upgrade(answer: FormAnswer): void {
    const current = this.current();
    if (current && !current.locked && this.userIsOn(current)) this.pinned.add(current.signature);
    for (const assignment of answer.assignments) this.served.set(assignment.signature, assignment);
    this.prediction = { provider: answer.provider, cache: answer.cache, latencyMs: answer.latencyMs };
    this.rescan();
  }

  private userIsOn(ghost: Ghost): boolean {
    const active = deepActive(this.doc);
    const focused = active !== null && sameControl(this.els.get(ghost.signature), active);
    return focused || this.state.accepted > 0 || this.lastLeft !== null || Date.now() - this.shownAt > SETTLE_MS;
  }

  /** Another fact key set is another question; so is a Ghost that was switched off and on again. */
  private forgetPredictions(factsId = ""): void {
    this.factsId = factsId;
    this.asked.clear();
    this.served.clear();
    this.pinned.clear();
    this.prediction = OFFLINE;
  }

  private source(): PredictionSource {
    return this.prediction.cache === "offline" ? "offline" : this.prediction.cache === "hit" ? "cache" : "server";
  }

  /** `ghosts:shown` counts every value ghost once per page, however often the form is rescanned or upgraded. */
  private announce(): void {
    const fresh = this.state.ghosts.filter((g) => !g.locked && !this.shown.has(g.signature));
    if (fresh.length === 0) return;
    if (this.shown.size === 0) this.shownAt = Date.now();
    for (const ghost of fresh) this.shown.add(ghost.signature);
    this.events.emit("ghosts:shown", { count: fresh.length, source: this.source() });
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
    if (this.hasUnlocked()) this.finished = false;
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
    this.edited = new WeakSet();
    this.shown.clear();
    this.shownAt = 0;
    this.finished = this.jumpDismissed = false;
    this.awaiting = this.parkedOn = this.pageContext = null;
    this.draftSeen.clear();
    this.deps.drafts?.reset(); // drafts live for one page load: streams stop, nothing carries over to the next view
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

  private dismiss(signature: string, reason: GhostEventMap["ghost:dismissed"]["reason"]): void {
    const ghost = this.state.ghosts[this.indexOfSignature(signature)];
    this.state.dismissed.add(signature);
    this.deps.drafts?.abort(signature); // typed over, escaped or refused: that field's stream stops for good
    this.remove(signature);
    this.render();
    if (ghost) this.events.emit("ghost:dismissed", { ghost, reason });
    this.checkFinished();
  }

  /** Nothing unlocked is left of a walk that filled something: parked on Submit, or simply done. */
  private checkFinished(): void {
    if (this.finished || this.state.accepted === 0 || this.hasUnlocked()) return;
    this.finished = true;
    this.events.emit("walk:finished");
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
    if (!this.interactive || event.isComposing || event.keyCode === 229 || !this.isUserEvent(event)) return;
    // The page owns Tab right now: both keys stay native, even if a ghost is still on screen from a moment ago.
    if (pageOwnsTab(this.doc)) return;
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
      else this.jump(event);
      return;
    }
    if (!event.repeat && !this.focusInWalk(ghost)) return;
    swallow(event);
    this.walking = true;
    // A held Tab never accepts an unfinished draft or a guess: both need one deliberate fresh press.
    if (event.repeat && (ghost.pending || ghost.answer?.needsReview === true)) this.halted = true;
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
    if (this.busy) return this.cancelAwait(event);
    const ghost = this.visibleCurrent();
    if (!ghost) return this.dismissJump();
    if (!this.focusInWalk(ghost)) return;
    swallow(event);
    this.dismiss(ghost.signature, "escape");
  }

  /** Escape while Tab waits for the rest of a draft: the wait ends and the draft is dismissed. */
  private cancelAwait(event: KeyboardEvent): void {
    if (this.awaiting === null) return;
    swallow(event);
    this.dismiss(this.awaiting, "escape");
  }

  // ---------- jump pill ----------

  /** The pill is offered while the current ghost is entirely off screen and the user has put focus nowhere. */
  private jumpHint(): JumpHint | null {
    const ghost = this.current();
    if (!ghost || ghost.locked || this.jumpDismissed || this.busy || !focusOnBody(this.doc)) return null;
    if (pageOwnsTab(this.doc)) return null; // the pill's whole purpose is to claim Tab, which is not ours here
    const el = this.resolve(ghost);
    const direction = el ? offscreenDirection(landingElement(ghost, el)) : null;
    return direction ? { count: this.state.ghosts.filter((g) => !g.locked).length, direction } : null;
  }

  /**
   * Tab on the pill: scroll to the current ghost and focus it, fill nothing. Only when the pill was really
   * drawn (rule 1: a visible ghost) and still applies. The rest of this hold is swallowed, never accepted.
   */
  private jump(event: KeyboardEvent): void {
    const ghost = this.jumpShown && this.jumpHint() ? this.current() : null;
    const el = ghost ? this.resolve(ghost) : null;
    if (!ghost || !el) return;
    swallow(event);
    this.walking = this.halted = true;
    reveal(landingElement(ghost, el));
    this.render();
  }

  /** Escape puts the pill away for this page. The key still reaches the page: no ghost was dismissed. */
  private dismissJump(): void {
    if (!this.jumpShown || !this.jumpHint()) return;
    this.jumpDismissed = true;
    this.render();
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
    return sameControl(this.els.get(ghost.signature), active) || sameControl(this.lastLeft, active) || sameControl(this.parkedOn, active);
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
    if (hasValue(el)) return this.dismiss(ghost.signature, "refused"); // rule 9: never overwrite what is already there
    if (!canBeSeen(landingElement(ghost, el))) return this.hold(); // queued press, but the field got hidden meanwhile
    if (ghost.pending) return this.acceptDraft(ghost);
    await this.write(ghost, el);
  }

  private async write(ghost: Ghost, el: HTMLElement): Promise<void> {
    const started = performance.now();
    const result = await executeGhost(ghost, el);
    if (!this.running) return;
    if (!result.ok) return this.fail(ghost, result.reason ?? "failed");
    this.state.accepted++;
    this.state.keystrokesSaved += ghost.action === "fill" ? (ghost.value ?? "").length : 1;
    this.state.error = null;
    const field = this.fields.get(ghost.signature);
    this.remove(ghost.signature);
    this.focusCurrent();
    this.render();
    if (field) this.events.emit("ghost:accepted", { ghost, field, ms: performance.now() - started });
    this.checkFinished();
  }

  /**
   * Tab accepts the WHOLE draft: a stream still running gets up to DRAFT_WAIT_MS to finish (the ghost shimmers
   * meanwhile), then the finished text is written. Out of time, failed, typed over or escaped: nothing is
   * written, the queued presses are dropped and the ghost, if it is still there, waits for another Tab.
   */
  private async acceptDraft(pending: Ghost): Promise<void> {
    const { signature } = pending;
    this.awaiting = signature;
    this.render();
    const outcome = await (this.deps.drafts?.settled(signature, DRAFT_WAIT_MS) ?? Promise.resolve("failed" as const));
    this.awaiting = null;
    if (!this.running) return;
    const ghost = this.state.ghosts[this.indexOfSignature(signature)];
    const el = ghost ? this.resolve(ghost) : null;
    const ready = outcome === "done" && ghost && !ghost.pending && el && !hasValue(el) && canBeSeen(el);
    if (ready) return this.write(ghost, el);
    this.pendingTabs = 0;
    this.halted = true;
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
    this.parkedOn = el;
    reveal(landingElement(ghost, el));
    this.render();
  }

  /** Rule 8: stop the walk, keep the rest pending, say why. The message never carries profile values. */
  private fail(ghost: Ghost, reason: string): void {
    this.pendingTabs = 0;
    this.halted = true;
    this.state.error = `Ghost could not fill this field (${reason})`;
    this.dismiss(ghost.signature, "refused");
  }

  private focusCurrent(): void {
    const ghost = this.current();
    const el = ghost ? this.resolve(ghost) : null;
    if (ghost?.locked && el) this.parkedOn = el;
    if (ghost && el) reveal(landingElement(ghost, el));
  }

  // ---------- page events ----------

  private readonly onInput = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.dataset || target.dataset.ghostWriting === "1") return;
    const ghost = this.state.ghosts[this.indexOfElement(target)];
    const byUser = this.isUserEvent(event);
    if (byUser) this.edited.add(target);
    // Rule 5: the user's typing wins for good. A script-made change just needs a fresh look.
    if (ghost && byUser) this.dismiss(ghost.signature, "typed");
    else if (ghost) this.scheduleRescan();
    else if (byUser) this.rememberTouched(target);
  };

  /**
   * `user:input`: what the user committed, once per edit (a trusted change, or a blur after trusted typing),
   * never per keystroke, never Ghost's own writes, and never a field capture left out as sensitive.
   */
  private readonly onCommit = (event: Event): void => {
    if (event.type === "focusout" && this.state.ghosts.length > 0) this.scheduleRender(); // focus may be back on the body: pill
    const el = event.target as HTMLElement | null;
    if (!el?.matches?.(EDITABLE) || el.dataset.ghostWriting === "1") return;
    const committed = event.type === "change" ? this.isUserEvent(event) : this.edited.has(el);
    this.edited.delete(el);
    if (!committed || isElementSensitive(el)) return;
    const field = this.fields.get(computeSignature(el));
    if (field) this.events.emit("user:input", { field, value: committedValue(el), el });
  };

  /** Rule 9 for fields without a ghost yet: a box the user ticked or text they typed is never second-guessed later. */
  private rememberTouched(target: HTMLElement): void {
    if (this.touched.has(target) || !target.matches("input, textarea, select")) return;
    this.touched.add(target);
    const signature = computeSignature(target);
    this.state.dismissed.add(signature);
    this.deps.drafts?.abort(signature); // a draft still on its way for this field is no longer wanted
  }

  private readonly onFocusIn = (event: Event): void => {
    const index = this.indexOfElement(event.target as Element | null);
    if (index < 0 || index === this.state.currentIndex || this.lockedTooEarly(index)) {
      if (this.jumpShown) this.render(); // focus left the body: the pill no longer owns Tab
      return;
    }
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
    bind(view, "change", this.onCommit, passive);
    bind(view, "focusout", this.onCommit, passive);
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
      if (!el) return;
      const entry: OverlayState["ghosts"][number] = { ghost, el, status: index === currentIndex ? "current" : "pending" };
      if (ghost.signature === this.awaiting) entry.waiting = true;
      entries.push(entry);
    });
    const jump = this.jumpHint();
    this.jumpShown = jump !== null;
    this.deps.overlay.render({ ghosts: entries, hud: this.hud(), jump, accepted, error });
  }

  private hud(): OverlayState["hud"] {
    const { ghosts, accepted, error, keystrokesSaved } = this.state;
    const active = ghosts.length > 0 || accepted > 0 || error !== null;
    if (!active || !this.deps.getSettings().showHud) return undefined;
    const { provider, cache, latencyMs } = this.prediction;
    const hud: NonNullable<OverlayState["hud"]> = { provider, cache, latencyMs: latencyMs ?? this.lastLatencyMs, keystrokesSaved };
    const text = this.deps.drafts?.stats();
    if (text) hud.text = text;
    return hud;
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

/** A positive maxlength on a text box; -1 (none) and other elements report nothing. */
function maxLengthOf(el: HTMLElement): number | undefined {
  const max = (el as HTMLTextAreaElement).maxLength;
  return typeof max === "number" && max > 0 ? max : undefined;
}

/** What a field holds after the user's edit: the checked radio's value, "true"/"false" for a box, else the text. */
function committedValue(el: HTMLElement): string {
  const input = el as HTMLInputElement;
  if (isRadio(el)) return radioGroup(el).find((radio) => radio.checked)?.value ?? "";
  return el.tagName === "INPUT" && input.type === "checkbox" ? String(input.checked) : (input.value ?? "");
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
