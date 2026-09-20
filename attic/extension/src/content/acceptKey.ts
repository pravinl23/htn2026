// The browser half of the dual accept key (docs/accept-key.md). The DECISION lives in shared/src/keys/policy.ts
// and is imported, never re-implemented; what lives here is the part that only a DOM has: recognising a press of
// the Ghost key out of raw keydown/keyup, and watching what a page does with a Tab that Ghost let through.
//
// Two invariants this file exists to keep:
//   1. Ghost never calls preventDefault on Tab until it has EVIDENCE that this origin does not want it. On a
//      brand-new origin the first Tab is a probe: the page gets it, untouched, and Ghost only watches.
//   2. A real modifier use is never swallowed. The Ghost key is a TAP of right Option: down, nothing, up, inside
//      300 ms. One other key in between and it is ⌥e or ⌥→, which belongs to the user and to the page.
import { acceptKeyFor, DEFAULT_GHOST_KEY, ghostKeyHint, TAB_HINT } from "@ghost/shared";
import type { AcceptKeyChoice, AcceptKeyGhost, GhostKeyId, SiteKeyState, TabState } from "@ghost/shared";

/** A down and an up this close together, with nothing in between, is a tap (docs/accept-key.md section 3). */
export const TAP_MAX_MS = 300;
/** The two halves of a ⇧⇧ press. Further apart and the second one starts a new first tap. */
export const DOUBLE_TAP_MS = 400;

/** The user's choice of key, stored under `ghost.keys` (see ../lib/storage.ts). */
export type AcceptKeySetting = "auto" | "tab" | "ghost-key";
export const ACCEPT_KEY_SETTINGS: readonly AcceptKeySetting[] = ["auto", "tab", "ghost-key"];
export const GHOST_KEY_IDS: readonly GhostKeyId[] = ["right-option", "option-space", "cmd-quote", "f19", "double-shift"];
export const DEFAULT_ACCEPT_KEY: AcceptKeySetting = "auto";

export function isAcceptKeySetting(value: unknown): value is AcceptKeySetting {
  return typeof value === "string" && (ACCEPT_KEY_SETTINGS as readonly string[]).includes(value);
}

export function isGhostKeyId(value: unknown): value is GhostKeyId {
  return typeof value === "string" && (GHOST_KEY_IDS as readonly string[]).includes(value);
}

export interface KeyPrefs {
  acceptKey: AcceptKeySetting;
  ghostKey: GhostKeyId;
}

export const DEFAULT_KEY_PREFS: KeyPrefs = { acceptKey: DEFAULT_ACCEPT_KEY, ghostKey: DEFAULT_GHOST_KEY };

/**
 * The settings the shared policy understands. "tab" is its `tabEverywhere`; "ghost-key" it has no input for,
 * so it is applied here, on top of the policy's answer, as an override rather than a second decision.
 */
export function siteStateFor(prefs: KeyPrefs, tab: TabState): SiteKeyState {
  return { tab, ghostKey: prefs.ghostKey, tabEverywhere: prefs.acceptKey === "tab" };
}

export interface ChooseKeyInput {
  prefs: KeyPrefs;
  tab: TabState;
  origin: string;
  ghost: AcceptKeyGhost;
  focusIsOnGhostField: boolean;
}

/**
 * Which key accepts the ghost on screen. Always answers with a key and a chip: whatever the page does with Tab,
 * the Ghost key is named and works (docs/always-propose.md — a proposal nobody can accept is worse than none).
 */
export function chooseKey(input: ChooseKeyInput): AcceptKeyChoice {
  const { prefs } = input;
  const choice = acceptKeyFor({
    origin: input.origin,
    ghost: input.ghost,
    focusIsOnGhostField: input.focusIsOnGhostField,
    siteState: siteStateFor(prefs, input.tab),
  });
  if (prefs.acceptKey !== "ghost-key" || choice.key === "ghost-key") return choice;
  // The user asked for the Ghost key everywhere: Tab goes back to the page, and nothing is probed for it.
  return { ...choice, key: "ghost-key", hint: choice.explicit ? choice.hint : ghostKeyHint(prefs.ghostKey), probeTab: false };
}

/** The keycap a ghost draws. `explicit` (a locked action) already reads "Enter" in the choice. */
export function keycapFor(choice: AcceptKeyChoice): string {
  return choice.hint || TAB_HINT;
}

// ---------- recognising a press of the Ghost key ----------

/** One accept press of the Ghost key. `hold` means it is a repeat of a key being held down, not a fresh press. */
export interface GhostKeyPress {
  hold: boolean;
}

type Shape = "tap" | "double-tap" | "chord" | "plain";

function shapeOf(id: GhostKeyId): Shape {
  switch (id) {
    case "right-option":
      return "tap";
    case "double-shift":
      return "double-tap";
    case "option-space":
    case "cmd-quote":
      return "chord";
    case "f19":
      return "plain";
  }
}

/** The modifier a tap key taps. */
function tapModifier(id: GhostKeyId): "Alt" | "Shift" | null {
  if (id === "right-option") return "Alt";
  if (id === "double-shift") return "Shift";
  return null;
}

/**
 * Right where the event says so, either side where it does not. `location` is 2 for a right-hand key and `code`
 * ends in "Right"; a synthetic event in a test or an engine that reports neither still gets to accept, because
 * refusing there would leave a ghost with no working key.
 */
function rightHanded(event: KeyboardEvent): boolean {
  if (event.location === 2) return true;
  if (typeof event.code === "string" && event.code !== "") return event.code.endsWith("Right");
  return event.location === 0 || event.location === undefined;
}

/**
 * Turns raw key events into Ghost key presses. The controller feeds it every keydown and keyup it sees (in the
 * capture phase, so a page that stops propagation cannot hide the user's press from Ghost) plus `interrupt()`
 * for anything else that means the modifier is being USED - a pointer press, the window losing focus.
 */
export class GhostKeyWatcher {
  private down = false;
  private downAt = 0;
  private interrupted = false;
  private taps = 0;
  private lastTapAt = 0;

  constructor(private readonly keyId: () => GhostKeyId) {}

  /** A press that is complete on keydown (a chord, or F19). Null for everything else. */
  keydown(event: KeyboardEvent, now: number): GhostKeyPress | null {
    const id = this.keyId();
    const shape = shapeOf(id);
    if (shape === "chord" || shape === "plain") {
      this.reset();
      return matchesChord(id, event) ? { hold: event.repeat } : null;
    }
    const modifier = tapModifier(id);
    if (event.key !== modifier || !rightHanded(event)) {
      // Any other key while the modifier is down is the user modifying with it. It is theirs, not Ghost's.
      if (this.down) this.interrupted = true;
      return null;
    }
    if (this.down) {
      // The modifier is being HELD (auto-repeat): hold-to-accept, and no tap can come out of it any more.
      this.interrupted = true;
      return event.repeat ? { hold: true } : null;
    }
    if (otherModifier(event, modifier)) return null; // ⌘⌥, ⌃⌥: a combination, never a tap
    if (this.taps > 0 && now - this.lastTapAt > DOUBLE_TAP_MS) this.taps = 0;
    this.down = true;
    this.interrupted = false;
    this.downAt = now;
    return null;
  }

  /** A press that completes on keyup: the tap. */
  keyup(event: KeyboardEvent, now: number): GhostKeyPress | null {
    const id = this.keyId();
    const modifier = tapModifier(id);
    if (modifier === null) return null;
    if (event.key !== modifier) return null;
    const clean = this.down && !this.interrupted && now - this.downAt <= TAP_MAX_MS;
    this.down = false;
    this.interrupted = false;
    if (!clean) {
      this.taps = 0;
      return null;
    }
    if (this.taps > 0 && now - this.lastTapAt > DOUBLE_TAP_MS) this.taps = 0;
    this.taps++;
    this.lastTapAt = now;
    const needed = shapeOf(id) === "double-tap" ? 2 : 1;
    if (this.taps < needed) return null;
    this.taps = 0;
    return { hold: false };
  }

  /** Something that is not a key happened while the modifier was down (a click, a drag, the window blurring). */
  interrupt(): void {
    if (this.down) this.interrupted = true;
    this.taps = 0;
  }

  reset(): void {
    this.down = false;
    this.interrupted = false;
    this.taps = 0;
    this.downAt = this.lastTapAt = 0;
  }
}

function otherModifier(event: KeyboardEvent, own: "Alt" | "Shift"): boolean {
  if (event.ctrlKey || event.metaKey) return true;
  return own === "Alt" ? event.shiftKey : event.altKey;
}

function matchesChord(id: GhostKeyId, event: KeyboardEvent): boolean {
  if (id === "f19") return event.key === "F19";
  if (id === "option-space") return event.altKey && !event.ctrlKey && !event.metaKey && (event.code === "Space" || event.key === " ");
  if (id === "cmd-quote") return event.metaKey && !event.ctrlKey && (event.code === "Quote" || event.key === "'");
  return false;
}

/** Scheme + host, which is all that is ever stored about a page (docs/storage.md: no URLs). */
export function originOf(doc: Document): string {
  const href = doc.location?.href ?? "";
  try {
    const url = new URL(href);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "unknown";
  }
}
