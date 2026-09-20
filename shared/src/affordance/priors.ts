// Priors by place (docs/anywhere.md section 3). What people usually want next HERE, before anything is asked of a
// model and before this user has any history. Deliberately weak (0.55 to 0.7, never above) so one real accept in
// role memory outranks them. A prior alone is enough to propose something on a page Ghost has never seen.
import { classifyAffordance } from "./roles";
import type { AffordanceCandidate, AffordanceContext, AffordanceRole } from "./roles";
import type { PageKind } from "./pageKind";

export interface RolePrior {
  role: AffordanceRole;
  weight: number;
}

/** Everything a prior needs to know about the moment, all of it derivable without naming a site. */
export interface PriorState {
  /** Items in the cart: a badge count, or a quantity the client read. 0 or undefined means empty or unknown. */
  cartCount?: number;
  /** The media element is playing right now. */
  mediaPlaying?: boolean;
  /** The media element is already fullscreen, so proposing fullscreen again would be noise. */
  isFullscreen?: boolean;
  /** The view is scrolled to the end: there is nothing more to load or read. */
  atPageEnd?: boolean;
  /** A search box already holds a query. */
  hasQuery?: boolean;
  /** The main region shows ONE item (a message, a thread) rather than a list of them. */
  readingItem?: boolean;
  /** The role of the thing the user took LAST. What follows it is a prior of its own -- see AFTER. */
  previousRole?: AffordanceRole;
  /** Something on screen is waiting to be read: an unread row, a badge, a notification. */
  hasUnreadItem?: boolean;
  /**
   * The app itself has put the keyboard in an empty box somebody types in.
   *
   * The strongest sequence signal there is, and the only one that needs no history: an app that opens a
   * compose window and drops the cursor in `To` has already said what happens next. Without it Ghost reached
   * for the search box in that moment, which is the guess that makes no sense to a person.
   */
  focusedEmptyField?: boolean;
}

export const PRIOR_MAX = 0.7;
export const PRIOR_MIN = 0.55;

/**
 * The ordered list of roles people usually want next in this kind of place, strongest first.
 *
 * The strongest prior of a place Ghost recognizes is exactly PRIOR_MAX, which is the default gate: on a page it can
 * place, Ghost always has one thing to offer, even the first time it sees that page. Two states deliberately offer
 * nothing above the gate: `app`/`unknown` (a place Ghost cannot read, where a wrong ghost is worse than none, rule 4)
 * and a video that is already playing fullscreen (nagging someone who is watching is the wrong product).
 */
export function priorsFor(kind: PageKind, state: PriorState = {}): RolePrior[] {
  const priors = merge(merge(merge(build(kind, state), after(state.previousRole)), focusedField(state)), unread(state));
  return priors
    .filter((p) => p.weight > 0)
    .map((p) => ({ role: p.role, weight: capped(p) }))
    .sort((a, b) => b.weight - a.weight);
}

/**
 * `search` can never be a confident offer, in any kind of place.
 *
 * Putting a cursor in a search box is only worth a keystroke if Ghost knows what goes in it, and it does
 * not: there is no honest way to guess what somebody is about to look for. It stays available -- role
 * memory can still lift it for a person who really does always search here -- but as a prior it sits at the
 * floor, under the gate, so it is drawn as a guess and never as the answer.
 *
 * This is what "it always picks the search box" really was. A search box is the one control that exists on
 * every page, so any prior that ranks it well makes it the answer everywhere.
 */
function capped(prior: RolePrior): number {
  const ceiling = prior.role === "search" ? PRIOR_MIN : PRIOR_MAX;
  return Math.min(ceiling, Math.max(PRIOR_MIN, prior.weight));
}

/**
 * What usually follows what.
 *
 * A place tells you what people do THERE; this tells you what people do NEXT, and without it "the last thing
 * you did" changed nothing at all until role memory had learned something. Start a new message and the next
 * thing is the empty field that just appeared, not the search box that was always there. Fill a field and the
 * next thing is the one after it, then the thing that sends it. Open an item and the next thing is answering
 * it.
 *
 * These are roles, not apps, labels or windows: every one of them is a sentence about behaviour that stays
 * true wherever it happens. Nothing here knows what app it is in, and nothing here may ever name one.
 *
 * They are ordinary priors, so they are still weak (0.55 to 0.7) and one real accept in role memory outranks
 * them. Where a place and a transition disagree, the stronger of the two wins.
 */
const AFTER: Partial<Record<AffordanceRole, RolePrior[]>> = {
  // You made a new, empty thing: the next step is saying who it is for, never writing the body. What was
  // wrong here was never the transition, it was PROPOSING compose in the first place -- Ghost does not know
  // who you are writing to, so it must not start that flow. Once somebody starts it themselves, following
  // them to the recipient is exactly right. `compose` therefore sits at the prior floor (see `mail`) while
  // this transition stays.
  compose: [{ role: "field", weight: 0.66 }],
  reply: [{ role: "field", weight: 0.7 }],
  // One field leads to the next, and a filled-in thing leads to the control that sends it.
  field: [{ role: "field", weight: 0.66 }, { role: "send", weight: 0.62 }, { role: "submit", weight: 0.6 }],
  // You searched; now you open a result.
  search: [{ role: "primary-item", weight: 0.7 }],
  // You opened something. Now you act on it, or you go back for the next one.
  "primary-item": [{ role: "reply", weight: 0.62 }, { role: "field", weight: 0.6 }, { role: "back", weight: 0.56 }],
  play: [{ role: "fullscreen", weight: 0.7 }],
  cart: [{ role: "checkout", weight: 0.62 }],
  buy: [{ role: "cart", weight: 0.62 }],
};

function after(previousRole: AffordanceRole | undefined): RolePrior[] {
  return previousRole ? (AFTER[previousRole] ?? []) : [];
}

/** Where the app has put the cursor, filling that box IS the next action, in every kind of place. */
function focusedField(state: PriorState): RolePrior[] {
  return state.focusedEmptyField === true ? [{ role: "field", weight: PRIOR_MAX }] : [];
}

/**
 * Somebody is waiting for an answer. That outranks whatever else the screen offers, in any kind of place:
 * an unread message, an unread mail, a notification badge. It is also the only thing on a messaging screen
 * that Ghost can follow all the way through -- open it, read the thread, draft the reply -- because the one
 * fact it needs, who the conversation is with, is written on the row.
 */
function unread(state: PriorState): RolePrior[] {
  return state.hasUnreadItem === true ? [{ role: "primary-item", weight: PRIOR_MAX }] : [];
}

/** The stronger weight per role wins; neither list silences the other. */
function merge(place: RolePrior[], transitions: RolePrior[]): RolePrior[] {
  if (transitions.length === 0) return place;
  const best = new Map<AffordanceRole, number>();
  for (const prior of [...place, ...transitions]) best.set(prior.role, Math.max(best.get(prior.role) ?? 0, prior.weight));
  return [...best].map(([role, weight]) => ({ role, weight }));
}

function build(kind: PageKind, state: PriorState): RolePrior[] {
  switch (kind) {
    case "media":
      return media(state);
    case "feed":
      return [
        { role: "primary-item", weight: 0.7 },
        { role: "search", weight: state.hasQuery === true ? 0.66 : 0.6 },
        { role: "scroll-more", weight: state.atPageEnd === true ? 0.66 : 0.57 },
      ];
    case "commerce":
      return commerce(state);
    case "reader":
      return state.atPageEnd === true
        ? [{ role: "back", weight: 0.7 }, { role: "share", weight: 0.58 }, { role: "search", weight: 0.55 }]
        : [{ role: "scroll-more", weight: 0.7 }, { role: "back", weight: 0.6 }, { role: "share", weight: 0.55 }];
    case "mail":
      return state.readingItem === true
        ? [{ role: "reply", weight: 0.7 }, { role: "back", weight: 0.6 }, { role: "compose", weight: 0.55 }]
        // `compose` sits at the floor on purpose: starting a new message is only useful to somebody who
        // already knows who it is for, which is exactly what Ghost does not know. Reading the one that came
        // in is the thing it can actually help with, so the item leads by a wide margin.
        : [{ role: "primary-item", weight: 0.7 }, { role: "search", weight: 0.57 }, { role: "compose", weight: PRIOR_MIN }];
    case "form":
      // Terminal actions stay low here AND are withheld entirely by the walk gate until the form is ready
      // (docs/incremental.md section 2): the prior must never be what puts a cursor on Submit.
      return [{ role: "field", weight: 0.7 }, { role: "submit", weight: 0.58 }];
    // `app` is where almost every native window lands, so its first prior is the default answer for most of the
    // desktop. It used to be `search`, and "it always guesses a search box" was the result. Reaching for search
    // is what you do when you do not know what is on the screen; opening the thing in front of you is what
    // people actually do, so the item leads and search sits behind it.
    case "app":
      return [{ role: "primary-item", weight: 0.66 }, { role: "search", weight: 0.6 }, { role: "more", weight: 0.58 }];
    case "unknown":
      return [{ role: "primary-item", weight: 0.6 }, { role: "search", weight: 0.56 }, { role: "more", weight: 0.55 }];
  }
}

function media(state: PriorState): RolePrior[] {
  const priors: RolePrior[] = [];
  if (state.mediaPlaying !== true) priors.push({ role: "play", weight: 0.7 });
  // Playing: fullscreen is THE next step (docs/anywhere.md section 5). Already fullscreen: proposing it again is
  // the classic wrong ghost, and nothing else here reaches the gate, so a watching user is left alone.
  if (state.isFullscreen !== true) priors.push({ role: "fullscreen", weight: state.mediaPlaying === true ? 0.7 : 0.62 });
  priors.push({ role: "next", weight: 0.58 });
  if (state.mediaPlaying === true) priors.push({ role: "pause", weight: 0.56 });
  priors.push({ role: "captions", weight: 0.55 });
  return priors;
}

function commerce(state: PriorState): RolePrior[] {
  if ((state.cartCount ?? 0) > 0) {
    return [
      { role: "cart", weight: 0.7 },
      { role: "checkout", weight: 0.62 },
      { role: "search", weight: state.hasQuery === true ? 0.66 : 0.58 },
      { role: "primary-item", weight: 0.55 },
    ];
  }
  // An empty cart: the shopper is still looking, so the thing in front of them is a product. This used to
  // lead with the search box, which is what "it always goes to search on shopping sites" actually was --
  // and a search box is no use to Ghost, because it cannot know what anyone is about to look for.
  return [
    { role: "primary-item", weight: 0.7 },
    { role: "search", weight: 0.6 },
    { role: "cart", weight: 0.55 },
  ];
}

/** The weight a prior gives this role, or 0 when the place has no opinion about it. */
export function priorWeight(priors: readonly RolePrior[], role: AffordanceRole): number {
  return priors.find((p) => p.role === role)?.weight ?? 0;
}

/** "0 items in cart", "3 items", "2" — a count a cart control carries in its own accessible name. */
const COUNT_IN_NAME = /(?:^|\s)(\d{1,3})(?:\s|$|\s*items?\b)/;

function countInName(label: string): number {
  const found = COUNT_IN_NAME.exec(label);
  const n = found?.[1] === undefined ? Number.NaN : Number(found[1]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * How full the cart looks, from the only generic evidence there is: a count on something that classifies as a cart,
 * either as a badge the client read or as a number inside the control's own name (a real shop writes both).
 * Zero when nothing says otherwise, which is the conservative answer: no checkout prior.
 */
export function cartCountFrom(candidates: readonly AffordanceCandidate[], context: AffordanceContext = {}): number {
  let count = 0;
  for (const candidate of candidates) {
    const hint = Math.max(candidate.badgeCount ?? 0, countInName(candidate.label));
    if (hint <= 0) continue;
    if (classifyAffordance(candidate, context).role === "cart") count = Math.max(count, hint);
  }
  return count;
}
