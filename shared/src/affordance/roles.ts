// Affordances, not labels (docs/anywhere.md section 2). A candidate stops being "a button whose text is X" and
// becomes "the thing that plays the video" / "the cart" / "the first item of the list". Pure: no DOM, no AX, no
// network. NOTHING here may test a hostname, an app name or a brand: every rule reads what the control OFFERS.
import { isLockedAction } from "../locks";
import type { NextCandidate } from "../memory/episodic";

export type AffordanceRole =
  | "primary-item"   // the first/next item of a feed, grid, list or search result
  | "search"         // a search input or the control that opens one
  | "play" | "pause" | "fullscreen" | "next" | "previous" | "skip" | "mute" | "captions" | "speed"
  | "cart" | "checkout" | "buy" | "quantity" | "wishlist"
  | "compose" | "reply" | "send" | "save" | "download" | "share"
  | "more" | "menu" | "settings" | "close" | "back" | "forward" | "scroll-more"
  | "field" | "submit" | "unknown";

/** Roles whose vocabulary only means what it says inside a media context ("play" on a job form is not a player). */
export const MEDIA_ROLES: readonly AffordanceRole[] = ["play", "pause", "fullscreen", "next", "previous", "skip", "mute", "captions", "speed"];

/** Roles that are irreversible by definition, whatever the control is called. Rule 2: when in doubt, lock. */
export const LOCKED_ROLES: readonly AffordanceRole[] = ["checkout", "buy", "send", "submit"];

/** Why a role was chosen. Codes only: an evidence list never carries a label, a value or any page text. */
export type AffordanceEvidence =
  | "accessible-name"   // the control's own accessible name said it
  | "description"       // aria-describedby / title / AXDescription said it
  | "icon-token"        // an icon-shaped identifier or class token ("play", "expand", "cart")
  | "glyph-only"        // the label was empty or a single glyph, so structure decided
  | "media-cluster"     // the control sits inside a media-controls cluster
  | "search-input"      // type=search, role=search/searchbox, or a search-shaped placeholder/name
  | "list-item"         // the control is a member of a repeated list or grid
  | "price-nearby"      // a price-shaped string is rendered beside it
  | "badge-count"       // a small count is drawn on the icon
  | "path-pattern"      // the URL path pattern agrees with the role
  | "kind";             // the candidate's own kind (a field is a field)

export interface Affordance {
  role: AffordanceRole;
  /** How sure the classification is, NOT how likely the user wants it. Ranking combines this with priors and memory. */
  confidence: number;
  evidence: AffordanceEvidence[];
}

/**
 * A `/v1/predict/next` candidate plus the generic hints a client can collect without naming a site. Every field is
 * optional: with none of them a candidate still classifies from its accessible name alone.
 */
export interface AffordanceCandidate extends NextCandidate {
  /** aria-describedby / title / AXDescription. Used exactly like the name, one notch weaker. */
  description?: string;
  /** input type attribute ("search", "text"...). */
  inputType?: string;
  /** ARIA role or AX subrole, verbatim ("searchbox", "tab", "listitem"). */
  ariaRole?: string;
  placeholder?: string;
  /** name attribute / AXIdentifier-ish name. Never a value. */
  name?: string;
  identifier?: string;
  /** class list or AX identifier tokens. Only ever read for icon words, never matched against a site. */
  classTokens?: readonly string[];
  /** The control sits inside a media-controls cluster: a <video>'s controls, or a group around a media element. */
  insideMediaControls?: boolean;
  /** Membership of a repeated list/grid, from the list detector the loop engine already has. */
  list?: { listSignature: string; index: number };
  /** A price-shaped string is rendered near the control (the client decides, in any currency). */
  nearbyPrice?: boolean;
  /** A small number drawn on the icon: a cart count, an unread count. */
  badgeCount?: number;
}

/** Page-level facts a role sometimes needs. Still nothing that identifies a site. */
export interface AffordanceContext {
  /** Pathname with volatile segments generalized, as the trace records it: /watch/:id, /cart. */
  pathPattern?: string;
  /** The page or window contains a media element. */
  hasMediaElement?: boolean;
  /**
   * The signature of the list the MAIN region repeats, when the client knows it. Set it and only that list's members
   * count as items; pass null for "this page has no main list". Left out, every repeated list counts, which on a real
   * site makes items out of the navigation bar: measured on a live shop, its header `<li>`s all became "the item".
   */
  mainListSignature?: string | null;
  /** Native side only: the frontmost app's bundle id. Used as a grouping key, never matched against a vendor. */
  appBundleId?: string;
}

interface RolePattern {
  role: AffordanceRole;
  re: RegExp;
  weight: number;
  /** Vocabulary that only means this inside a media context. */
  media?: true;
  /** Vocabulary that means something else inside a media context ("next" is a track, not a form step). */
  notMedia?: true;
}

/**
 * Accessible-name vocabulary. Generic UI English, ordered by nothing: every pattern that matches contributes.
 * Weights: 0.6 unambiguous, 0.45 to 0.5 ordinary, 0.35 weak/overloaded.
 */
const NAME_PATTERNS: readonly RolePattern[] = [
  { role: "play", re: /\bplay\b|\bstart (playing|playback|the video)\b|\bresume playback\b/, weight: 0.6, media: true },
  { role: "pause", re: /\bpause\b|\bstop playing\b/, weight: 0.6, media: true },
  { role: "fullscreen", re: /\bfull ?screen\b|\bmaximi[sz]e\b|\bexpand to full\b|\btheat(er|re) mode\b/, weight: 0.65 },
  // Inside a player, "Expand" enlarges the video; anywhere else it opens more of something (below).
  { role: "fullscreen", re: /\bexpand\b|\benlarge\b/, weight: 0.5, media: true },
  { role: "next", re: /\bnext\b|\bfast ?forward\b|\bskip (forward|ahead)\b/, weight: 0.5, media: true },
  { role: "previous", re: /\b(previous|prev)\b|\brewind\b|\bgo back one\b/, weight: 0.5, media: true },
  { role: "skip", re: /\bskip\b/, weight: 0.45, media: true },
  { role: "mute", re: /\b(un)?mute\b|\bvolume\b|\bsound (on|off)\b/, weight: 0.6, media: true },
  { role: "captions", re: /\bcaptions?\b|\bsubtitles?\b|\bcc\b/, weight: 0.6, media: true },
  { role: "speed", re: /\bplayback (speed|rate)\b|\bspeed\b/, weight: 0.5, media: true },
  { role: "search", re: /\bsearch\b|\blook up\b|\bfind\b/, weight: 0.6 },
  { role: "cart", re: /\bcarts?\b|\bbaskets?\b|\bshopping bag\b|\badd to (the )?(cart|bag|basket)\b/, weight: 0.6 },
  { role: "checkout", re: /\bcheck ?out\b|\bproceed to (checkout|payment)\b/, weight: 0.65 },
  { role: "buy", re: /\bbuy\b|\bpurchase\b|\bplace (the |your |my )?order\b|\bpay (now|for)\b|\border now\b/, weight: 0.65 },
  { role: "quantity", re: /\bquantity\b|\bqty\b|\bhow many\b/, weight: 0.55 },
  { role: "wishlist", re: /\bwish ?list\b|\bsave for later\b|\badd to (a |the |my )?(list|favou?rites)\b|\bfavou?rite\b|\bbookmark\b/, weight: 0.55 },
  { role: "compose", re: /\bcompose\b|\bnew (message|mail|email|note|document|doc|item|post|thread)\b|\bwrite\b|\bcreate new\b/, weight: 0.6 },
  { role: "reply", re: /\breply\b|\brespond\b/, weight: 0.6 },
  { role: "send", re: /\bsend\b/, weight: 0.6 },
  { role: "save", re: /\bsave\b(?! for later)/, weight: 0.5 },
  { role: "download", re: /\bdownload\b|\bexport\b|\bsave as\b/, weight: 0.55 },
  { role: "share", re: /\bshare\b|\bcopy link\b/, weight: 0.55 },
  { role: "more", re: /\bmore actions\b|\bmore options\b|\boverflow\b|\bkebab\b|\bshow options\b/, weight: 0.55 },
  { role: "more", re: /\bexpand\b|\bshow details\b/, weight: 0.45, notMedia: true },
  { role: "menu", re: /\bmenu\b|\bnavigation\b|\bhamburger\b/, weight: 0.55 },
  { role: "settings", re: /\bsettings\b|\bpreferences\b|\bconfigure\b|\boptions\b/, weight: 0.5 },
  { role: "close", re: /\bclose\b|\bdismiss\b|\bexit\b(?! full)/, weight: 0.5 },
  { role: "back", re: /\bback\b(?! ?ground)|\breturn to\b/, weight: 0.5, notMedia: true },
  { role: "forward", re: /\bforward\b/, weight: 0.45, notMedia: true },
  { role: "scroll-more", re: /\b(load|show|see) more\b|\bnext page\b|\b(continue|read) (reading|more)\b|\bshow \d+ more\b|\bolder\b/, weight: 0.6 },
  // "Next" outside a player is the next STEP, which docs/incremental.md treats as terminal: it locks.
  { role: "submit", re: /\bsubmit\b|\bcontinue\b|\bproceed\b|\bconfirm\b|\bfinish\b|\bnext\b(?! (video|track|song|episode|page|item|slide|photo|image|result))/, weight: 0.55, notMedia: true },
];

/** Icon words as they appear in class names and identifiers. Decisive only when the control has no readable name. */
const ICON_PATTERNS: readonly { role: AffordanceRole; re: RegExp }[] = [
  { role: "play", re: /\b(play|player start)\b/ },
  { role: "pause", re: /\bpause\b/ },
  { role: "fullscreen", re: /\b(fullscreen|full screen|expand|maximi[sz]e|enlarge)\b/ },
  { role: "next", re: /\b(next|forward|advance|chevron right|arrow right)\b/ },
  { role: "previous", re: /\b(prev|previous|rewind|chevron left)\b/ },
  { role: "skip", re: /\bskip\b/ },
  { role: "mute", re: /\b(mute|volume|speaker|audio)\b/ },
  { role: "captions", re: /\b(cc|caption|captions|subtitle|subtitles)\b/ },
  { role: "speed", re: /\b(speed|rate|playback rate)\b/ },
  { role: "search", re: /\b(search|magnif(y|ier)|magnifying glass|find)\b/ },
  { role: "cart", re: /\b(cart|basket|bag|trolley)\b/ },
  { role: "checkout", re: /\bcheckout\b/ },
  { role: "wishlist", re: /\b(wishlist|heart|favou?rite|bookmark|star)\b/ },
  { role: "compose", re: /\b(compose|pencil|new item|plus|add)\b/ },
  { role: "reply", re: /\breply\b/ },
  { role: "send", re: /\b(send|paper ?plane)\b/ },
  { role: "download", re: /\bdownload\b/ },
  { role: "share", re: /\bshare\b/ },
  { role: "more", re: /\b(more|ellipsis|dots|overflow|kebab|meatball)\b/ },
  { role: "menu", re: /\b(menu|hamburger|bars|nav toggle)\b/ },
  { role: "settings", re: /\b(settings|gear|cog|preferences)\b/ },
  { role: "close", re: /\b(close|dismiss|times|cross)\b/ },
  { role: "back", re: /\b(back|arrow left)\b/ },
];

/** Generic path words. They only reinforce a role the control already suggests; a path alone never names a role. */
const PATH_PATTERNS: readonly { role: AffordanceRole; re: RegExp }[] = [
  { role: "cart", re: /\b(cart|basket|bag)\b/ },
  { role: "checkout", re: /\b(checkout|payment|pay)\b/ },
  { role: "buy", re: /\b(order|orders|buy)\b/ },
  { role: "search", re: /\b(search|results|query|browse|explore)\b/ },
  { role: "play", re: /\b(watch|video|videos|play|episode|stream|listen|track)\b/ },
  { role: "primary-item", re: /\b(feed|home|results|browse|explore|inbox|search)\b/ },
  { role: "compose", re: /\b(compose|new|draft)\b/ },
  { role: "reply", re: /\b(mail|message|messages|thread|conversation)\b/ },
];

const SEARCH_NAME = /\bsearch\b|\bquery\b|^q$/;
/** What a native tree or ARIA calls one entry of a list, a table, an outline or a listbox. */
const LIST_ENTRY_ROLE = /^(listitem|row|cell|treeitem|option|gridcell)$/;
const MAX_CONFIDENCE = 0.95;
/** A name-derived role at or above this owns the control: a repeated item's own buttons are not "the item". */
const ACTION_FLOOR = 0.45;
/**
 * Below this a role has corroboration but no decision behind it, and the control stays `unknown` so the vision
 * fallback (or the user) can settle it. Measured against a real player and a real shop: a single 0.12 icon hint,
 * promoted by a page-wide media context, was enough to call an advert's button "next" without it.
 */
const DECISION_FLOOR = 0.4;
const UNKNOWN_CONFIDENCE = 0.3;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** "addToCart" and "cart_count" both read as words, so one word list covers a name, an id and a label. */
export function normalizeAffordanceText(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .join(" ")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim();
}

/**
 * Class lists are a design system's vocabulary, not the author's: a framework token like "uiButtonShapeNextHost"
 * contains the word "next" and means nothing by it. So a class token is only ever read as its `-`/`_`/space
 * delimited segments, never split at camel case, and an icon word has to BE a segment ("player-play-button" -> play).
 */
export function classTokenText(tokens: readonly string[] | undefined): string {
  return (tokens ?? [])
    .join(" ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim();
}

/** Empty, or one glyph (an icon font character, an emoji, a "×"). Then structure and icon words decide. */
export function isGlyphOnly(label: string | undefined): boolean {
  const text = (label ?? "").trim();
  return text === "" || [...text].length === 1;
}

/** Unknown main list: every repeated list counts. Known: only that one. Null: none does. */
function inMainList(listSignature: string, context: AffordanceContext): boolean {
  return context.mainListSignature === undefined || context.mainListSignature === listSignature;
}

class Scores {
  private readonly score = new Map<AffordanceRole, number>();
  private readonly evidence = new Map<AffordanceRole, Set<AffordanceEvidence>>();

  add(role: AffordanceRole, weight: number, evidence: AffordanceEvidence): void {
    this.score.set(role, (this.score.get(role) ?? 0) + weight);
    const seen = this.evidence.get(role) ?? new Set<AffordanceEvidence>();
    seen.add(evidence);
    this.evidence.set(role, seen);
  }

  of(role: AffordanceRole): number {
    return this.score.get(role) ?? 0;
  }

  /** Highest score wins; a tie goes to the role declared first in NAME_PATTERNS order, which Map preserves. */
  best(): { role: AffordanceRole; score: number; evidence: AffordanceEvidence[] } | null {
    let best: { role: AffordanceRole; score: number } | null = null;
    for (const [role, score] of this.score) if (!best || score > best.score) best = { role, score };
    if (!best) return null;
    return { ...best, evidence: [...(this.evidence.get(best.role) ?? [])] };
  }

  max(): number {
    let max = 0;
    for (const score of this.score.values()) max = Math.max(max, score);
    return max;
  }
}

/**
 * What this control offers, from generic evidence only. A control with a readable name is classified by the name;
 * an icon-only control by its icon word, its cluster and its place in the page; anything else stays `unknown`.
 */
export function classifyAffordance(candidate: AffordanceCandidate, context: AffordanceContext = {}): Affordance {
  const scores = new Scores();
  const nameText = normalizeAffordanceText([candidate.label]);
  const descriptionText = normalizeAffordanceText([candidate.description, candidate.context]);
  const identText = `${normalizeAffordanceText([candidate.name, candidate.identifier])} ${classTokenText(candidate.classTokens)}`;
  const inMedia = candidate.insideMediaControls === true || context.hasMediaElement === true;
  const glyph = isGlyphOnly(candidate.label);

  for (const p of NAME_PATTERNS) {
    if (p.media && !inMedia) {
      // Media words outside a player are usually about something else ("Play squash", "Next step"): keep them, weakly.
      if (p.re.test(nameText)) scores.add(p.role, p.weight * 0.45, "accessible-name");
      continue;
    }
    if (p.notMedia && inMedia) continue;
    if (p.re.test(nameText)) scores.add(p.role, p.weight, "accessible-name");
    else if (p.re.test(descriptionText)) scores.add(p.role, p.weight * 0.8, "description");
  }

  for (const p of ICON_PATTERNS) {
    // An icon word for a player control means nothing outside a player: "play" in a class name on a form is noise.
    if (MEDIA_ROLES.includes(p.role) && !inMedia) continue;
    if (p.re.test(identText)) scores.add(p.role, glyph ? 0.5 : 0.12, "icon-token");
  }

  // The cluster confirms a role the control already claims; it must never promote a bare corroboration into one.
  if (inMedia) {
    for (const role of MEDIA_ROLES) if (scores.of(role) >= UNKNOWN_CONFIDENCE) scores.add(role, 0.2, "media-cluster");
  }

  const searchy =
    (candidate.inputType ?? "").toLowerCase() === "search" ||
    /^(search|searchbox)$/.test((candidate.ariaRole ?? "").trim().toLowerCase()) ||
    (candidate.kind === "field" && SEARCH_NAME.test(normalizeAffordanceText([candidate.placeholder, candidate.name, candidate.identifier])));
  if (searchy) scores.add("search", 0.8, "search-input");

  const actionClaimed = scores.max() >= ACTION_FLOOR;
  // An irreversible control inside a list is that action, never "the item": a row's Sign in is not a row.
  const itemLike = !actionClaimed && candidate.kind !== "field" && !isLockedAction({ text: candidate.label });
  // A repeated item is "the item" only when nothing inside it claimed a verb: a row's own Reply button stays a reply.
  if (itemLike && candidate.list && inMainList(candidate.list.listSignature, context)) {
    scores.add("primary-item", candidate.list.index === 0 ? 0.62 : 0.5, "list-item");
  }
  // A native row says so itself. The list detector needs repeated SHAPES and never fires on an AXOutline whose
  // rows differ, so a Messages conversation or a Finder file would otherwise score as nothing at all.
  if (itemLike && LIST_ENTRY_ROLE.test((candidate.ariaRole ?? "").trim().toLowerCase())) {
    scores.add("primary-item", 0.6, "list-item");
  }
  // A price beside a link is a product tile even where the list detector found no list (a single featured item).
  if (itemLike && candidate.nearbyPrice === true) {
    scores.add("primary-item", 0.45, "price-nearby");
  }
  if (candidate.nearbyPrice === true) {
    for (const role of ["cart", "buy", "checkout"] as const) if (scores.of(role) > 0) scores.add(role, 0.1, "price-nearby");
  }
  if ((candidate.badgeCount ?? 0) > 0 && scores.of("cart") > 0) scores.add("cart", 0.15, "badge-count");

  const path = normalizeAffordanceText([context.pathPattern]);
  if (path !== "") {
    for (const p of PATH_PATTERNS) if (scores.of(p.role) > 0 && p.re.test(path)) scores.add(p.role, 0.08, "path-pattern");
  }

  // A field whose label says nothing else is simply a field to fill; a "Quantity" select stays a quantity.
  if (candidate.kind === "field" && scores.max() < ACTION_FLOOR) scores.add("field", 0.55, "kind");

  const best = scores.best();
  if (!best || best.score < DECISION_FLOOR) return { role: "unknown", confidence: UNKNOWN_CONFIDENCE, evidence: glyph ? ["glyph-only"] : [] };
  const evidence = glyph && !best.evidence.includes("glyph-only") ? [...best.evidence, "glyph-only" as const] : best.evidence;
  return { role: best.role, confidence: clamp(best.score, UNKNOWN_CONFIDENCE, MAX_CONFIDENCE), evidence };
}

export interface ClassifiedCandidate {
  candidate: AffordanceCandidate;
  affordance: Affordance;
}

export function classifyAll(candidates: readonly AffordanceCandidate[], context: AffordanceContext = {}): ClassifiedCandidate[] {
  return candidates.map((candidate) => ({ candidate, affordance: classifyAffordance(candidate, context) }));
}

/**
 * Rule 2 on top of the client's own flag: an irreversible role is locked even when the control is called something
 * harmless, and the label still goes through the one lock test both clients already use.
 */
export function lockedForRole(candidate: AffordanceCandidate, role: AffordanceRole): boolean {
  if (candidate.locked) return true;
  if (LOCKED_ROLES.includes(role)) return true;
  return isLockedAction({ text: [candidate.label, candidate.description].filter((t) => typeof t === "string" && t !== "").join(" ") });
}
