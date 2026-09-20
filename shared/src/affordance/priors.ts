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
  const priors = build(kind, state);
  return priors
    .filter((p) => p.weight > 0)
    .map((p) => ({ role: p.role, weight: Math.min(PRIOR_MAX, Math.max(PRIOR_MIN, p.weight)) }))
    .sort((a, b) => b.weight - a.weight);
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
        : [{ role: "primary-item", weight: 0.7 }, { role: "compose", weight: 0.62 }, { role: "search", weight: 0.57 }];
    case "form":
      // Terminal actions stay low here AND are withheld entirely by the walk gate until the form is ready
      // (docs/incremental.md section 2): the prior must never be what puts a cursor on Submit.
      return [{ role: "field", weight: 0.7 }, { role: "submit", weight: 0.58 }];
    case "app":
      return [{ role: "search", weight: 0.66 }, { role: "primary-item", weight: 0.62 }, { role: "more", weight: 0.58 }];
    case "unknown":
      return [{ role: "search", weight: 0.6 }, { role: "primary-item", weight: 0.58 }, { role: "more", weight: 0.55 }];
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
  // An empty cart: the shopper is still looking, and the thing they reach for is the search box.
  return [
    { role: "search", weight: 0.7 },
    { role: "primary-item", weight: 0.62 },
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
