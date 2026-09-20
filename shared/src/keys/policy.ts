// Which key accepts a ghost (docs/accept-key.md sections 1 and 2). Pure: no DOM, no AX, no storage, no timers.
//
// Tab is the right key in exactly one situation: the ghost is a value for the field that currently has focus, on a
// site or app that has never been seen handling Tab itself. There Tab already means "take this and move on", so
// nothing is stolen. Everywhere else - a click ghost, a media control, a cross-app suggestion, a site that runs its
// own Tab surface - the Ghost key accepts, because a helper that steals Tab from a spreadsheet or an editor is a bug.
//
// Two rules outrank everything here:
//   - Ghost always proposes (docs/always-propose.md). This layer therefore never answers "no key": every call names
//     a key and the hint chip to draw with it. A proposal the user cannot accept is worse than no proposal.
//   - Irreversible actions are never accepted by a key at all (CLAUDE.md rule 2). A locked ghost still gets a key
//     that WALKS to it, but its chip says Enter, and `explicit` tells the client that a deliberate press is required.
import type { AnswerClass, GhostAction, GhostTier } from "../types";

/** The two accept keys. Nothing else ever accepts a ghost. */
export type AcceptKey = "tab" | "ghost-key";

/** What observation knows about Tab on one origin or app (see ./observe.ts). */
export type TabState = "unknown" | "free" | "taken";

/** The Ghost key itself, configurable for people who use right Option for accented characters (doc section 3). */
export type GhostKeyId = "right-option" | "option-space" | "cmd-quote" | "f19" | "double-shift";

export const DEFAULT_GHOST_KEY: GhostKeyId = "right-option";

/** The chip text for each binding. Short enough to sit inside a ghost's hint chip. */
export const GHOST_KEY_HINTS: Record<GhostKeyId, string> = {
  "right-option": "⌥ tap",
  "option-space": "⌥Space",
  "cmd-quote": "⌘'",
  f19: "F19",
  "double-shift": "⇧⇧",
};

export const TAB_HINT = "Tab";
/** A locked ghost takes a deliberate Enter or click, whichever key walked to it. */
export const EXPLICIT_HINT = "Enter";

/** A binding read back from storage may be anything; an unknown id falls back to the default rather than throwing. */
export function ghostKeyHint(id?: GhostKeyId | null): string {
  const hint = GHOST_KEY_HINTS[id as GhostKeyId] as string | undefined;
  return hint ?? GHOST_KEY_HINTS[DEFAULT_GHOST_KEY];
}

/** Why this key, in a form the HUD can render and a test can assert on. */
export type AcceptKeyReason =
  | "paused" // Ghost proposes nothing in this app, so the question never arises
  | "ghost-key-chosen" // the user asked for the Ghost key everywhere and Tab to be left alone
  | "tab-everywhere" // the user chose plain Tab everywhere in settings
  | "click-ghost" // the ghost is a click, not a value for a field
  | "focus-elsewhere" // the ghost fills a field that does not have focus
  | "tab-taken" // this site or app was observed handling Tab itself
  | "tab-untested" // no Tab press has been watched here yet: never intercept on the strength of a guess
  | "tab-free"; // watched, free, and the ghost fills the focused field

export const ACCEPT_KEY_REASON_TEXT: Record<AcceptKeyReason, string> = {
  paused: "Ghost is paused here",
  "ghost-key-chosen": "you chose the Ghost key everywhere",
  "tab-everywhere": "you chose Tab everywhere",
  "click-ghost": "this ghost is a click, not a field",
  "focus-elsewhere": "the ghosted field does not have focus",
  "tab-taken": "this site uses Tab itself",
  "tab-untested": "Tab has not been tested here yet",
  "tab-free": "Tab fills the focused field",
};

/**
 * The minimum a ghost has to say for this decision. A full `Ghost` (../types) satisfies it, and so does the native
 * agent's overlay model, so neither client has to build an adapter.
 */
export interface AcceptKeyGhost {
  action: GhostAction;
  locked?: boolean;
  /** Inferred rather than known (docs/answers.md section 3): hold-to-accept always stops here. */
  guess?: boolean;
  /** How it is drawn (docs/always-propose.md). Anything but "confident" is a proposal the user must see first. */
  tier?: GhostTier;
  /** Free text is still streaming in. */
  pending?: boolean;
  answerClass?: AnswerClass;
}

/** Everything about the place that changes the answer. All optional: an empty state means "brand new site". */
export interface SiteKeyState {
  tab?: TabState;
  /** Editors, terminals and password managers (docs/accept-key.md section 2 step 5). */
  paused?: boolean;
  /** The user's chosen Ghost key, for the chip. */
  ghostKey?: GhostKeyId | null;
  /** Settings: plain Tab everywhere, the old behaviour. */
  tabEverywhere?: boolean;
  /** Settings: the Ghost key everywhere, so Tab is never touched at all. Outranks `tabEverywhere`. */
  ghostKeyOnly?: boolean;
}

export interface AcceptKeyInput {
  /** Browser side: the page origin. Reduced to scheme + host before it is ever stored (./observe.ts). */
  origin?: string;
  /** Native side: the frontmost app's bundle id. */
  appId?: string;
  ghost: AcceptKeyGhost;
  /** True when the element with focus is the very field this ghost fills. */
  focusIsOnGhostField: boolean;
  siteState?: SiteKeyState | null;
}

export interface AcceptKeyChoice {
  key: AcceptKey;
  /** What the ghost's hint chip shows: "Tab", the Ghost key's chip, or "Enter" for a locked action. */
  hint: string;
  reason: AcceptKeyReason;
  /**
   * Do not intercept Tab here; watch the next press and report it with `recordTabProbe`. Set on a site whose Tab
   * has never been watched, which is why an unknown site can never steal Tab on its first ghost.
   */
  probeTab: boolean;
  /** Rule 2: no key accepts this ghost. The key above only walks to it; taking it needs Enter or a click. */
  explicit: boolean;
  /** The stable key this decision was made for ("app://<id>" or an origin), for the HUD and the observation store. */
  site: string;
}

const VALUE_ACTIONS: readonly GhostAction[] = ["fill", "select", "check"];

/** A ghost that writes into a field, as opposed to one that presses something. Only these can ever use Tab. */
export function isFieldGhost(ghost: AcceptKeyGhost): boolean {
  return VALUE_ACTIONS.includes(ghost.action);
}

/**
 * The one question this module answers. Never returns "nothing": on a paused app, on a site that owns Tab, on a
 * brand-new site, on a locked action, there is always a key named and a chip to draw (docs/always-propose.md).
 */
export function acceptKeyFor(input: AcceptKeyInput): AcceptKeyChoice {
  const state = input.siteState ?? {};
  const site = siteKey(input);
  const ghostHint = ghostKeyHint(state.ghostKey);
  const decided = decide(input, state);
  const key = decided.key;
  const locked = input.ghost.locked === true;
  return {
    key,
    hint: locked ? EXPLICIT_HINT : key === "tab" ? TAB_HINT : ghostHint,
    reason: decided.reason,
    probeTab: decided.probeTab,
    explicit: locked,
    site,
  };
}

interface Decision {
  key: AcceptKey;
  reason: AcceptKeyReason;
  probeTab: boolean;
}

/** The safe answer, and the common one: the key no page binds. */
function useGhostKey(reason: AcceptKeyReason, probeTab = false): Decision {
  return { key: "ghost-key", reason, probeTab };
}

function decide(input: AcceptKeyInput, state: SiteKeyState): Decision {
  // Paused: Ghost suggests nothing here, so it asks nothing of Tab either and never probes (doc section 2 step 5).
  if (state.paused === true) return useGhostKey("paused");
  // The user's own settings win over every observation, and neither of them needs anything watched afterwards.
  if (state.ghostKeyOnly === true) return useGhostKey("ghost-key-chosen");
  if (state.tabEverywhere === true) return { key: "tab", reason: "tab-everywhere", probeTab: false };
  if (!isFieldGhost(input.ghost)) return useGhostKey("click-ghost");
  if (!input.focusIsOnGhostField) return useGhostKey("focus-elsewhere");
  const tab = state.tab ?? "unknown";
  if (tab === "taken") return useGhostKey("tab-taken");
  // Never seen a Tab press here: use the Ghost key and WATCH this one. Assuming Tab is free is the expensive
  // mistake, so an unknown site never gets to steal it on the strength of a first ghost.
  if (tab !== "free") return useGhostKey("tab-untested", true);
  return { key: "tab", reason: "tab-free", probeTab: false };
}

/** How a place is named. One of the two, never both; the app id wins when a caller has both. */
export interface SiteId {
  origin?: string;
  appId?: string;
}

/** A site with no name at all. Observation refuses to store anything under it. */
export const UNKNOWN_SITE = "unknown";

/**
 * The single string this whole module keys on: "app://<bundle id>" natively, "scheme://host" in the browser.
 * Everything past the host is cut here, before anything is counted or stored, so a path, a query or a fragment
 * can never reach the brain on disk (docs/storage.md section 2: counters only, no URLs beyond the origin).
 */
export function siteKey(id: SiteId): string {
  const app = (id.appId ?? "").trim().toLowerCase();
  if (app !== "") return `app://${app}`;
  const raw = (id.origin ?? "").trim().toLowerCase();
  if (raw === "") return UNKNOWN_SITE;
  const scheme = raw.indexOf("://");
  if (scheme < 0) return cutAt(raw, "/");
  const rest = cutAt(raw.slice(scheme + 3), "/");
  return rest === "" ? UNKNOWN_SITE : `${raw.slice(0, scheme)}://${rest}`;
}

/** Drops everything from the first separator on, including a query or a fragment that skipped the slash. */
function cutAt(value: string, separator: string): string {
  let end = value.length;
  for (const mark of [separator, "?", "#"]) {
    const at = value.indexOf(mark);
    if (at >= 0 && at < end) end = at;
  }
  return value.slice(0, end);
}

/** Why a hold stopped here, or null when the hold may take this ghost and move on. */
export type HoldStop = "locked" | "pending" | "guess" | "long-shot" | "declaration";

/**
 * Hold-to-accept, for either key: it walks consecutive ghosts and stops at every one the user must actually look at.
 * The existing rules, unchanged - a lock needs a deliberate press (CLAUDE.md rule 2), a draft that is still being
 * written is not an answer yet, and a guess, a long-shot or a declaration is seen before it is taken
 * (docs/answers.md section 3, docs/always-propose.md). Stopping is not silence: the ghost is drawn either way,
 * the hold just hands the last press back to the user.
 */
export function holdStopReason(ghost: AcceptKeyGhost): HoldStop | null {
  if (ghost.locked === true) return "locked";
  if (ghost.pending === true) return "pending";
  if (ghost.tier === "long-shot") return "long-shot";
  if (ghost.guess === true || ghost.tier === "guess") return "guess";
  if (ghost.answerClass === "declaration") return "declaration";
  return null;
}

export function canHoldToAccept(ghost: AcceptKeyGhost): boolean {
  return holdStopReason(ghost) === null;
}
