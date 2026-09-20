// Role-keyed memory (docs/anywhere.md sections 3 and 6). The episodic store in ../memory/episodic.ts remembers
// exact repeats on one page, keyed by a state summary. This second key is `(page kind, previous role, role)`, which
// is what makes "I always go fullscreen after starting a video" transfer to a video Shabang has never seen, and
// "I always open the cart after adding something" transfer between shops. Nothing here holds a label or a value.
import { classifyAffordance, lockedForRole } from "./roles";
import type { Affordance, AffordanceCandidate, AffordanceContext, AffordanceEvidence, AffordanceRole } from "./roles";
import type { PageKind } from "./pageKind";
import { priorWeight } from "./priors";
import type { RolePrior } from "./priors";

export type RoleOutcome = "accepted" | "dismissed" | "replaced";
/** "none" is a real key: the first proposal of a page view has no previous role. */
export type PreviousRole = AffordanceRole | "none";

export interface RoleStat {
  accepted: number;
  /** The user pressed Escape, or moved on without taking the ghost. */
  dismissed: number;
  /** The user did something else instead: weaker evidence against than an explicit dismissal, but still against. */
  replaced: number;
}

export interface RoleKeyParts {
  pageKind: PageKind;
  previousRole?: PreviousRole;
  role: AffordanceRole;
}

export interface RoleMemoryEntry extends Required<RoleKeyParts> {
  stat: RoleStat;
}

export interface RoleMemorySnapshot {
  max: number;
  /** Least recently used first, exactly like EpisodicSnapshot. */
  entries: RoleMemoryEntry[];
}

export const ROLE_MEMORY_MAX = 400;
/**
 * One accept lifts a role to the strongest prior band but does not yet reorder the place's own defaults: ties are
 * broken by the prior (see rankRoles). Two accepts is real history and takes the lead.
 */
export const ROLE_MEMORY_ONCE = 0.7;
export const ROLE_MEMORY_REPEATED = 0.88;
/** Each unanswered dismissal takes this much off the prior, so a role the user keeps refusing sinks out of sight. */
export const ROLE_DISMISS_STEP = 0.15;
export const ROLE_MEMORY_FLOOR = 0.2;
/** A role this place has no opinion about: available, but never proposed on its own above the 0.7 gate. */
export const UNLISTED_PRIOR = 0.45;
/**
 * How much the classifier's own certainty may move a score, and the certainty that moves it by nothing.
 * Small on purpose: it separates candidates the place ranks equally, and never reorders the place's bands.
 */
export const EVIDENCE_SPAN = 0.06;
const NEUTRAL_CERTAINTY = 0.55;
/** Worth more than the whole certainty range (0.3 to 0.95 spans 0.024 of it), and still far under one band. */
const BADGE_NUDGE = 0.03;

export function roleMemoryKey(parts: RoleKeyParts): string {
  return `${parts.pageKind}|${parts.previousRole ?? "none"}|${parts.role}`;
}

const ZERO: RoleStat = { accepted: 0, dismissed: 0, replaced: 0 };

function finite(n: unknown, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Pure, JSON-serializable counts per (page kind, previous role, role). Insertion order is recency, like EpisodicStore. */
export class RoleMemory {
  private readonly entries = new Map<string, RoleMemoryEntry>();
  readonly max: number;

  constructor(max: number | null = ROLE_MEMORY_MAX, entries: readonly RoleMemoryEntry[] = []) {
    this.max = typeof max === "number" && Number.isFinite(max) ? Math.max(1, Math.floor(max)) : ROLE_MEMORY_MAX;
    for (const entry of entries.slice(-this.max)) this.entries.set(roleMemoryKey(entry), { ...entry, stat: { ...entry.stat } });
  }

  get size(): number {
    return this.entries.size;
  }

  record(parts: RoleKeyParts, outcome: RoleOutcome): void {
    const key = roleMemoryKey(parts);
    const current = this.entries.get(key);
    const entry: RoleMemoryEntry = current
      ? { ...current, stat: { ...current.stat } }
      : { pageKind: parts.pageKind, previousRole: parts.previousRole ?? "none", role: parts.role, stat: { ...ZERO } };
    entry.stat[outcome] += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(oldest);
    }
  }

  stat(parts: RoleKeyParts): RoleStat {
    const entry = this.entries.get(roleMemoryKey(parts));
    return entry ? { ...entry.stat } : { ...ZERO };
  }

  toJSON(): RoleMemorySnapshot {
    return { max: this.max, entries: [...this.entries.values()].map((e) => ({ ...e, stat: { ...e.stat } })) };
  }

  /** A corrupt or partial snapshot yields an empty store rather than a broken one: memory is never load-bearing. */
  static fromJSON(snapshot: RoleMemorySnapshot | null | undefined): RoleMemory {
    if (!snapshot || !Array.isArray(snapshot.entries)) return new RoleMemory();
    const entries: RoleMemoryEntry[] = [];
    for (const raw of snapshot.entries) {
      if (!raw || typeof raw.pageKind !== "string" || typeof raw.role !== "string") continue;
      entries.push({
        pageKind: raw.pageKind as PageKind,
        previousRole: (typeof raw.previousRole === "string" ? raw.previousRole : "none") as PreviousRole,
        role: raw.role as AffordanceRole,
        stat: { accepted: finite(raw.stat?.accepted), dismissed: finite(raw.stat?.dismissed), replaced: finite(raw.stat?.replaced) },
      });
    }
    return new RoleMemory(snapshot.max, entries);
  }
}

export type RoleConfidenceSource = "memory" | "prior" | "affordance";

export interface RoleConfidence {
  confidence: number;
  source: RoleConfidenceSource;
}

/**
 * What this role is worth right now: the place's prior, raised by accepts, lowered by refusals.
 * Accepts only count while they outnumber the refusals, so two accepts and three dismissals is not "learned".
 */
export function roleConfidence(prior: number, stat: RoleStat, listed = true): RoleConfidence {
  const against = stat.dismissed + stat.replaced;
  if (stat.accepted > against) {
    return { confidence: stat.accepted >= 2 ? ROLE_MEMORY_REPEATED : Math.max(prior, ROLE_MEMORY_ONCE), source: "memory" };
  }
  if (against === 0) return { confidence: prior, source: listed ? "prior" : "affordance" };
  return { confidence: Math.max(ROLE_MEMORY_FLOOR, prior - ROLE_DISMISS_STEP * (against - stat.accepted)), source: "memory" };
}

export interface RankedAffordance {
  /** The candidate's id: the capture signature the client can find its element by. */
  id: string;
  role: AffordanceRole;
  confidence: number;
  locked: boolean;
  /** Why, in words the HUD can show. Built from the role and the place only: never page text. */
  reason: string;
  source: RoleConfidenceSource;
  evidence: AffordanceEvidence[];
}

export interface RolePredictionState {
  pageKind: PageKind;
  /** The role of the action the user took last. Missing means this is the first proposal of the page view. */
  previousRole?: AffordanceRole;
  context?: AffordanceContext;
}

/**
 * Rank what the page offers: classify every candidate, score its role by prior + role memory, sort.
 * The caller still gates on its own confidence threshold and never presses a locked one (rules 1, 2 and 4).
 */
export function predictByRole(
  state: RolePredictionState,
  candidates: readonly AffordanceCandidate[],
  memory: RoleMemory | null,
  priors: readonly RolePrior[],
): RankedAffordance[] {
  const ranked = candidates.map((candidate, index) => {
    const affordance = classifyAffordance(candidate, state.context ?? {});
    const prior = priorWeight(priors, affordance.role);
    const stat = memory?.stat({ pageKind: state.pageKind, previousRole: state.previousRole ?? "none", role: affordance.role }) ?? ZERO;
    const scored = roleConfidence(prior > 0 ? prior : UNLISTED_PRIOR, stat, prior > 0);
    return {
      row: {
        id: candidate.id,
        role: affordance.role,
        // Only a prior is nudged. Once role memory has an opinion the number IS the opinion, and the rule that
        // one accept does not yet reorder the place's own defaults (ties broken by the prior) has to survive.
        confidence: round(scored.source === "memory" ? scored.confidence : withEvidence(scored.confidence, affordance, candidate.badgeCount ?? 0)),
        locked: lockedForRole(candidate, affordance.role),
        reason: roleReason(affordance.role, state, scored.source, stat),
        source: scored.source,
        evidence: affordance.evidence,
      } satisfies RankedAffordance,
      prior,
      affordance,
      index,
      listIndex: candidate.list?.index ?? Number.MAX_SAFE_INTEGER,
      badge: candidate.badgeCount ?? 0,
    };
  });
  // Ties: the place's own order first, then the reversible control before the locked one (rule 2: a ghost the user
  // can take with one Tab beats one that needs a deliberate click), then the first item of a list, then a control
  // carrying a live count (a count means a place to go, not an action: opening the cart is the safer half of "cart").
  ranked.sort(
    (a, b) =>
      b.row.confidence - a.row.confidence ||
      b.prior - a.prior ||
      Number(a.row.locked) - Number(b.row.locked) ||
      a.listIndex - b.listIndex ||
      b.badge - a.badge ||
      certainty(b.affordance) - certainty(a.affordance) ||
      a.index - b.index,
  );
  return ranked.map((r) => r.row);
}

/**
 * How sure the classifier is that this control plays the role, folded into the score as a small nudge.
 *
 * Without it the score was the place's prior VERBATIM, so every candidate sharing a role came back at exactly
 * the same number and the order was decided by the tie-break chain -- ultimately by capture order. Measured on
 * a real page: eight proposals, all 0.70, all with the same reason. That is not a ranking, it is a list.
 *
 * The nudge is deliberately smaller than the gap between prior bands (0.55 to 0.7), so it can reorder rows
 * that the place ranks equally and can never promote a role the place ranks below another.
 */
function withEvidence(base: number, a: Affordance, badge: number): number {
  // A live count drawn on a control is evidence about the USER, not about the classifier: two things in the
  // cart, four unread messages. It outranks how sure the classifier happened to be, so it is worth more than
  // the whole certainty range.
  return base + (badge > 0 ? BADGE_NUDGE : 0) + (a.confidence - NEUTRAL_CERTAINTY) * EVIDENCE_SPAN;
}

function certainty(a: Affordance): number {
  return a.confidence;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Base-form phrase per role, used as "you usually <verb>" / "most people <verb>" / "you can <verb>". */
const VERB: Record<AffordanceRole, string> = {
  "primary-item": "open the first item",
  search: "search",
  play: "start playing",
  pause: "pause",
  fullscreen: "go fullscreen",
  next: "skip to the next one",
  previous: "go back one",
  skip: "skip ahead",
  mute: "change the sound",
  captions: "turn captions on",
  speed: "change the speed",
  cart: "open the cart",
  checkout: "check out",
  buy: "buy this",
  quantity: "change the quantity",
  wishlist: "save this for later",
  compose: "start a new message",
  reply: "reply",
  send: "send this",
  save: "save",
  download: "download this",
  share: "share this",
  more: "open more actions",
  menu: "open the menu",
  settings: "open settings",
  close: "close this",
  back: "go back",
  forward: "go forward",
  "scroll-more": "load more",
  section: "jump to this group",
  field: "fill this in",
  submit: "submit",
  unknown: "use this",
};

/** Gerund phrase per role, used as "after <phrase>". */
const AFTER: Record<AffordanceRole, string> = {
  "primary-item": "opening an item",
  search: "searching",
  play: "starting playback",
  pause: "pausing",
  fullscreen: "going fullscreen",
  next: "skipping ahead",
  previous: "going back one",
  skip: "skipping ahead",
  mute: "changing the sound",
  captions: "turning captions on",
  speed: "changing the speed",
  cart: "opening the cart",
  checkout: "checking out",
  buy: "buying something",
  quantity: "changing the quantity",
  wishlist: "saving something for later",
  compose: "starting a message",
  reply: "replying",
  send: "sending",
  save: "saving",
  download: "downloading",
  share: "sharing",
  more: "opening more actions",
  menu: "opening the menu",
  settings: "opening settings",
  close: "closing that",
  back: "going back",
  forward: "going forward",
  "scroll-more": "loading more",
  section: "jumping to a group",
  field: "filling a field",
  submit: "submitting",
  unknown: "that",
};

const PLACE: Record<PageKind, string> = {
  media: "on a video page",
  feed: "in a feed",
  commerce: "on a shop page",
  reader: "while reading",
  mail: "in a mailbox",
  form: "on a form",
  app: "in an app",
  unknown: "here",
};

/** "starting playback" is right anywhere; on a media page the user thinks "a video". */
function afterPhrase(role: AffordanceRole, kind: PageKind): string {
  if (kind !== "media") return AFTER[role];
  if (role === "play") return "starting a video";
  if (role === "primary-item") return "opening a video";
  return AFTER[role];
}

/** Why this is being proposed, in one clause. Roles and places only: a reason can never leak what a page says. */
export function roleReason(role: AffordanceRole, state: RolePredictionState, source: RoleConfidenceSource, stat: RoleStat = ZERO): string {
  if (source === "memory" && stat.accepted > stat.dismissed + stat.replaced) {
    return state.previousRole
      ? `you usually ${VERB[role]} after ${afterPhrase(state.previousRole, state.pageKind)}`
      : `you usually ${VERB[role]} ${PLACE[state.pageKind]}`;
  }
  if (source === "memory") return `you passed on this before`;
  if (source === "prior") return `most people ${VERB[role]} ${PLACE[state.pageKind]}`;
  return `you can ${VERB[role]} here`;
}
