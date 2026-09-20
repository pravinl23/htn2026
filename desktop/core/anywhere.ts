// Ghost anywhere on the native side (docs/anywhere.md). The desktop half of the core bridge: turns the
// candidates GHAffordance built from an accessibility tree into ONE ranked proposal, using the SHARED
// affordance layer (`shared/src/affordance/**`) that the extension ranker and the vision adapter also use.
//
// Nothing here may name an app, a bundle id, a host or a brand: every rule reads what the window OFFERS.
// Strings in, strings out, like the rest of desktop/core: the Objective-C side stays thin.
import {
  RoleMemory,
  cartCountFrom,
  classifyAffordance,
  inferPageKind,
  isGlyphOnly,
  lockedForRole,
  predictByRole,
  priorsFor,
} from "@ghost/shared";
import type {
  AffordanceCandidate,
  AffordanceContext,
  AffordanceRole,
  PageKind,
  PriorState,
  RankedAffordance,
  RoleMemorySnapshot,
  RoleOutcome,
} from "@ghost/shared";

/** What the native capture measured about the window, plus the moment's prior state. All of it generic. */
export interface NextActionSignals extends PriorState {
  /** Window "path": a generalized URL path on the web, or a value-free window shape on a native window. */
  pathPattern?: string;
  hasMediaElement?: boolean;
  /** The MAIN region's repeated list, or null for "this window has no main list". Undefined = unknown. */
  mainListSignature?: string | null;
  mainRegionRepeats?: number;
  textDensity?: number;
  /** Grouping key only: never matched against a vendor (docs/anywhere.md section 2). */
  appBundleId?: string;
  /** The role of the action the user took last in this window. */
  previousRole?: AffordanceRole;
  /** The app itself has put the keyboard in an empty box somebody types in. */
  focusedEmptyField?: boolean;
  /** Something on screen is waiting to be read. */
  hasUnreadItem?: boolean;
}

export interface NextActionOptions {
  /** The gate. Defaults to the shared 0.7 when the caller says nothing. */
  threshold?: number;
  /** How many ranked rows to return. The native side only draws the first, the HUD may show more. */
  limit?: number;
}

/** A ranked row plus the one thing the threshold now decides: whether it is shown as a guess. */
export interface NextActionRow extends RankedAffordance {
  /** Below the gate, or a role nothing could name: an ordinary ghost with a "guess" chip (docs/always-propose.md). */
  guess: boolean;
}

export interface NextActionResult {
  pageKind: PageKind;
  pageConfidence: number;
  pageEvidence: string[];
  cartCount: number;
  threshold: number;
  /** Ranked, best first. Never longer than `limit`. */
  proposals: NextActionRow[];
  /** The one Ghost proposes. Null only when the window offers nothing at all to act on. */
  top: NextActionRow | null;
  /** Ids that classified `unknown` with nothing readable on them: what the vision fallback exists for. */
  unnamed: string[];
}

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_LIMIT = 5;
const MAX_CANDIDATES = 200;
const MAX_TEXT = 300;
const MAX_TOKENS = 24;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(json: string | undefined | null, what: string): unknown {
  if (typeof json !== "string" || json.trim() === "") return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    // A broken snapshot is never load-bearing: it reads as "nothing known", exactly like answers.json.
    void what;
    return undefined;
  }
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function ratio(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

function kindOf(value: unknown): AffordanceCandidate["kind"] {
  return value === "button" || value === "link" ? value : "field";
}

/** One candidate as the native side sends it. Anything missing simply carries less evidence. */
function asCandidate(raw: unknown): AffordanceCandidate | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id, 300);
  if (!id) return null;
  const candidate: AffordanceCandidate = {
    id,
    kind: kindOf(raw.kind),
    label: text(raw.label) ?? "",
    locked: raw.locked === true,
  };
  const optional: Array<[keyof AffordanceCandidate, unknown]> = [
    ["context", raw.context],
    ["description", raw.description],
    ["inputType", raw.inputType],
    ["ariaRole", raw.ariaRole],
    ["placeholder", raw.placeholder],
    ["name", raw.name],
    ["identifier", raw.identifier],
  ];
  for (const [key, value] of optional) {
    const clean = text(value);
    if (clean !== undefined) (candidate as unknown as Record<string, unknown>)[key] = clean;
  }
  if (Array.isArray(raw.classTokens)) {
    const tokens = raw.classTokens.filter((t): t is string => typeof t === "string").slice(0, MAX_TOKENS).map((t) => t.slice(0, 64));
    if (tokens.length > 0) candidate.classTokens = tokens;
  }
  if (raw.insideMediaControls === true) candidate.insideMediaControls = true;
  if (raw.nearbyPrice === true) candidate.nearbyPrice = true;
  if (raw.focused === true) candidate.focused = true;
  if (raw.unread === true) candidate.unread = true;
  const badge = count(raw.badgeCount);
  if (badge !== undefined && badge > 0) candidate.badgeCount = badge;
  if (isObject(raw.list)) {
    const signature = text(raw.list.listSignature, 120);
    const index = count(raw.list.index);
    if (signature !== undefined && index !== undefined) candidate.list = { listSignature: signature, index };
  }
  return candidate;
}

function asCandidates(json: string): AffordanceCandidate[] {
  const raw = parse(json, "candidates");
  if (!Array.isArray(raw)) return [];
  const out: AffordanceCandidate[] = [];
  for (const item of raw.slice(0, MAX_CANDIDATES)) {
    const candidate = asCandidate(item);
    if (candidate) out.push(candidate);
  }
  return out;
}

const ROLES: ReadonlySet<string> = new Set<AffordanceRole>([
  "primary-item", "search", "play", "pause", "fullscreen", "next", "previous", "skip", "mute", "captions", "speed",
  "cart", "checkout", "buy", "quantity", "wishlist", "compose", "reply", "send", "save", "download", "share",
  "more", "menu", "settings", "close", "back", "forward", "scroll-more", "field", "submit", "unknown",
]);

function asRole(value: unknown): AffordanceRole | undefined {
  return typeof value === "string" && ROLES.has(value) ? (value as AffordanceRole) : undefined;
}

function asSignals(json: string): NextActionSignals {
  const raw = parse(json, "signals");
  if (!isObject(raw)) return {};
  const signals: NextActionSignals = {};
  const path = text(raw.pathPattern, 200);
  if (path !== undefined) signals.pathPattern = path;
  const bundle = text(raw.appBundleId, 200);
  if (bundle !== undefined) signals.appBundleId = bundle;
  // null is a real answer here ("no main list"), so undefined and null must stay apart.
  if (raw.mainListSignature === null) signals.mainListSignature = null;
  else {
    const list = text(raw.mainListSignature, 120);
    if (list !== undefined) signals.mainListSignature = list;
  }
  for (const key of ["hasMediaElement", "mediaPlaying", "isFullscreen", "atPageEnd", "hasQuery", "readingItem", "focusedEmptyField", "hasUnreadItem"] as const) {
    const value = bool(raw[key]);
    if (value !== undefined) signals[key] = value;
  }
  const repeats = count(raw.mainRegionRepeats);
  if (repeats !== undefined) signals.mainRegionRepeats = repeats;
  const density = ratio(raw.textDensity);
  if (density !== undefined) signals.textDensity = density;
  const cart = count(raw.cartCount);
  if (cart !== undefined) signals.cartCount = cart;
  const previous = asRole(raw.previousRole);
  if (previous !== undefined) signals.previousRole = previous;
  return signals;
}

function asOptions(json: string | undefined): Required<NextActionOptions> {
  const raw = parse(json, "options");
  const threshold = isObject(raw) ? ratio(raw.threshold) : undefined;
  const limit = isObject(raw) ? count(raw.limit) : undefined;
  return {
    threshold: threshold === undefined ? DEFAULT_THRESHOLD : threshold,
    limit: limit === undefined || limit === 0 ? DEFAULT_LIMIT : Math.min(40, limit),
  };
}

/** A corrupt or absent memory file is simply no history: memory is never load-bearing (docs/anywhere.md 3). */
export function asRoleMemory(json: string | undefined | null): RoleMemory {
  const raw = parse(json, "memory");
  if (!isObject(raw)) return new RoleMemory();
  return RoleMemory.fromJSON(raw as unknown as RoleMemorySnapshot);
}

/** Nothing readable on the control at all: no name, no description, no identifier words, and no role. */
function looksUnnamed(candidate: AffordanceCandidate): boolean {
  if (!isGlyphOnly(candidate.label)) return false;
  return (candidate.description ?? "").trim() === "" && (candidate.placeholder ?? "").trim() === "";
}

/**
 * The whole native next-action pass: classify, infer the place, take its priors, rank with role memory.
 * Returns JSON; `top` is the one thing Ghost would propose, already gated on the caller's threshold.
 */
export function nextAction(candidatesJson: string, signalsJson: string, memoryJson?: string, optionsJson?: string): string {
  const candidates = asCandidates(candidatesJson);
  const signals = asSignals(signalsJson);
  const { threshold, limit } = asOptions(optionsJson);
  const memory = asRoleMemory(memoryJson);

  const context: AffordanceContext = {};
  if (signals.pathPattern !== undefined) context.pathPattern = signals.pathPattern;
  if (signals.hasMediaElement !== undefined) context.hasMediaElement = signals.hasMediaElement;
  if (signals.mainListSignature !== undefined) context.mainListSignature = signals.mainListSignature;
  if (signals.appBundleId !== undefined) context.appBundleId = signals.appBundleId;

  const classified = candidates.map((candidate) => ({ candidate, affordance: classifyAffordance(candidate, context) }));
  const page = inferPageKind({
    classified,
    candidates,
    ...(signals.hasMediaElement !== undefined ? { hasMediaElement: signals.hasMediaElement } : {}),
    ...(signals.mainRegionRepeats !== undefined ? { mainRegionRepeats: signals.mainRegionRepeats } : {}),
    ...(signals.textDensity !== undefined ? { textDensity: signals.textDensity } : {}),
    ...(signals.pathPattern !== undefined ? { pathPattern: signals.pathPattern } : {}),
    ...(signals.appBundleId !== undefined ? { appBundleId: signals.appBundleId } : {}),
  });

  // The cart count the client read wins; otherwise the only generic evidence there is (a badge, a count in a name).
  const cartCount = signals.cartCount ?? cartCountFrom(candidates, context);
  // `previousRole` reaches the priors as well as the memory key: what you did last is evidence in its own
  // right, and without this it changed nothing at all until role memory had learned something.
  const priorState: PriorState = { ...signals, cartCount, mediaPlaying: signals.mediaPlaying ?? playingFrom(page.kind, classified) };
  const priors = priorsFor(page.kind, priorState);
  const ranked = predictByRole(
    { pageKind: page.kind, context, ...(signals.previousRole !== undefined ? { previousRole: signals.previousRole } : {}) },
    candidates,
    memory,
    priors,
  );

  // docs/always-propose.md: the threshold no longer silences anything. It decides how a proposal is DRAWN --
  // an ordinary ghost, or a dimmer one with a "guess" chip -- never whether one exists. Rule 2 is untouched:
  // `locked` travels with the row and the native side never presses one.
  const rows: NextActionRow[] = ranked.map((row) => ({ ...row, guess: row.confidence < threshold || row.role === "unknown" }));
  // A named role first, because "the first item of this grid" is a better guess than "this button, whatever it is";
  // but a window where nothing classified still gets the best row rather than silence.
  //
  // A heading is named and is still not an answer: it labels the rows under it and pressing it does nothing. It
  // already sorts under every ordinary row on confidence alone, so this only decides a window that holds nothing
  // BUT headings and unnamed controls -- and there, an unnamed control the user can actually press wins.
  const top = rows.find((row) => row.role !== "unknown" && row.role !== "section") ?? rows[0] ?? null;
  const result: NextActionResult = {
    pageKind: page.kind,
    pageConfidence: page.confidence,
    pageEvidence: [...page.evidence],
    cartCount,
    threshold,
    proposals: rows.slice(0, limit),
    top,
    unnamed: classified.filter((c) => c.affordance.role === "unknown" && looksUnnamed(c.candidate)).map((c) => c.candidate.id),
  };
  return JSON.stringify(result);
}

/**
 * Whether the media is playing right now, when the client could not say. A player draws Pause while it plays and
 * Play while it does not: that toggle is the only generic evidence there is, and neither the DOM nor the
 * accessibility tree exposes playback state. Unknown outside a media page, so nothing else is affected.
 */
function playingFrom(kind: PageKind, classified: ReadonlyArray<{ affordance: { role: AffordanceRole } }>): boolean | undefined {
  if (kind !== "media") return undefined;
  const roles = classified.map((c) => c.affordance.role);
  if (roles.includes("pause")) return true;
  if (roles.includes("play")) return false;
  return undefined;
}

const OUTCOMES: ReadonlySet<string> = new Set<RoleOutcome>(["accepted", "dismissed", "replaced"]);
const KINDS: ReadonlySet<string> = new Set<PageKind>(["feed", "media", "commerce", "reader", "mail", "form", "app", "unknown"]);

/**
 * One accept / dismissal / replacement, folded into the role memory snapshot (docs/anywhere.md section 6).
 * Returns the NEW snapshot JSON to write back to memory.json, unchanged when the parts make no sense.
 */
export function recordRoleOutcome(memoryJson: string, partsJson: string, outcome: string): string {
  const memory = asRoleMemory(memoryJson);
  const raw = parse(partsJson, "parts");
  const role = isObject(raw) ? asRole(raw.role) : undefined;
  const kind = isObject(raw) && typeof raw.pageKind === "string" && KINDS.has(raw.pageKind) ? (raw.pageKind as PageKind) : undefined;
  if (role === undefined || kind === undefined || !OUTCOMES.has(outcome)) return JSON.stringify(memory.toJSON());
  const previous = isObject(raw) ? asRole(raw.previousRole) : undefined;
  memory.record({ pageKind: kind, role, ...(previous !== undefined ? { previousRole: previous } : {}) }, outcome as RoleOutcome);
  return JSON.stringify(memory.toJSON());
}

/** An empty, well-formed memory snapshot: what a first run writes to memory.json. */
export function emptyRoleMemory(): string {
  return JSON.stringify(new RoleMemory().toJSON());
}

/**
 * Rule 2 for a proposal the native side built from a vision label rather than from the tree: the client's own
 * flag, the role, and the one lock test both clients already share. Exposed so a vision upgrade re-locks in code.
 */
export function lockedForCandidate(candidateJson: string, role: string): boolean {
  const candidate = asCandidate(parse(candidateJson, "candidate"));
  if (!candidate) return true; // when in doubt, lock
  return lockedForRole(candidate, asRole(role) ?? "unknown");
}
