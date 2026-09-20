// Learning which key a place wants (docs/accept-key.md section 2). Pure and JSON-serializable: no DOM, no AX, no
// storage, no clock. The client watches, this module counts, and `acceptKeyFor` reads the result.
//
// There is no site list anywhere in Ghost and there never will be. A place earns "Tab is free here" by being
// watched, and one piece of contrary evidence takes it away again, because stealing Tab from a page that uses it is
// the expensive mistake and waiting one keypress to learn is the cheap one.
//
// What is kept, per origin or app (docs/storage.md, the `habits` section): counters and one three-state flag. No
// URL beyond the origin string (`siteKey` cuts the path before anything is stored), no titles, no timestamps, no
// event log, at most `KEY_MEMORY_MAX` places with the least recently used evicted first.
import { siteKey, UNKNOWN_SITE } from "./policy";
import type { AcceptKey, SiteId, TabState } from "./policy";

/** docs/storage.md: the habits section holds at most 300 origins. The least recently touched goes first. */
export const KEY_MEMORY_MAX = 300;

/** Three consistent presses by the user flip a place permanently, whatever the watching said (doc section 2 step 4). */
export const FLIP_PRESSES = 3;

/**
 * One probe is enough to mark a place tab-taken; "free" needs two clean ones. The asymmetry is the whole safety
 * argument: a wrong "taken" costs the user one alternative keypress, a wrong "free" breaks their page.
 */
export const FREE_PROBES = 2;

/** Counters are for comparing, not for counting to a million. Past this they stop growing and the file stays small. */
export const COUNTER_CAP = 255;

export interface ProbeCounts {
  /** Tab presses that behaved natively: the page let them through and focus moved on. */
  free: number;
  /** Tab presses the page handled itself: preventDefault, or focus that did not move. */
  taken: number;
}

export interface PressCounts {
  tab: number;
  ghost: number;
}

/** What Ghost remembers about one origin or app. Counters only; nothing here can be read back as a browsing history. */
export interface KeyObservation {
  /** "app://<bundle id>" or "scheme://host". Never a path, a query or a fragment. */
  id: string;
  tab: TabState;
  probes: ProbeCounts;
  /** Accept presses the user made here, per key. */
  presses: PressCounts;
  /** Presses that accepted nothing: the user reached for a key Ghost was not listening to. Shown in the HUD. */
  missed: number;
  /** The current run of identical accept presses. The third one flips the place. */
  run: { key: AcceptKey; count: number } | null;
  /** How many times a user correction has flipped this place. */
  flips: number;
  /** A user correction decided this place: watching no longer overrides it. */
  pinned: boolean;
}

export interface TabProbe extends SiteId {
  /** The page called preventDefault on the Tab keydown. */
  preventedDefault?: boolean;
  /** Focus moved to another control, the way a native Tab would move it. Undefined means the client could not tell. */
  focusMoved?: boolean;
  /** Editors, terminals and password managers: Ghost suggests nothing there, so it watches nothing either. */
  paused?: boolean;
}

/**
 * One accept press by the user. Report a press only when a ghost was on screen and the press was AIMED at it (for
 * Tab, that means focus was in the ghosted field). An ordinary Tab through a form is not a correction and must never
 * be reported here, or Ghost would teach itself to steal the key the user was only tabbing with.
 */
export interface UserPress extends SiteId {
  key: AcceptKey;
  /** True when this press actually accepted a ghost. One that accepted nothing still says which key they reached for. */
  accepted?: boolean;
  paused?: boolean;
}

/** A place nothing is known about yet. Returned, never stored, so reading never grows the file. */
export function unknownObservation(id: string = UNKNOWN_SITE): KeyObservation {
  return { id, tab: "unknown", probes: { free: 0, taken: 0 }, presses: { tab: 0, ghost: 0 }, missed: 0, run: null, flips: 0, pinned: false };
}

function bump(n: number): number {
  return Math.min(COUNTER_CAP, n + 1);
}

function clone(o: KeyObservation): KeyObservation {
  return { ...o, probes: { ...o.probes }, presses: { ...o.presses }, run: o.run ? { ...o.run } : null };
}

/** What one watched Tab press says: taken, free, or nothing at all when the client could not tell. */
export function probeVerdict(probe: TabProbe): "free" | "taken" | "inconclusive" {
  if (probe.preventedDefault === true || probe.focusMoved === false) return "taken";
  if (probe.focusMoved === true) return "free";
  return "inconclusive";
}

/**
 * Fold one watched Tab press into a place's record. Pure: the input is never mutated.
 *
 * A pinned place (the user has corrected it) keeps its flag: watching counts the evidence but does not override a
 * person. "taken" is sticky against later clean probes too - one page that handles Tab is enough to know, and only
 * the user gets to take that back.
 */
export function applyTabProbe(current: KeyObservation, probe: TabProbe): KeyObservation {
  const verdict = probeVerdict(probe);
  if (verdict === "inconclusive") return current;
  const next = clone(current);
  if (verdict === "taken") {
    next.probes.taken = bump(next.probes.taken);
    if (!next.pinned) next.tab = "taken";
    return next;
  }
  next.probes.free = bump(next.probes.free);
  if (!next.pinned && next.tab === "unknown" && next.probes.free >= FREE_PROBES) next.tab = "free";
  return next;
}

/**
 * Fold one accept press by the user into a place's record (doc section 2 step 4). Three consistent presses flip the
 * place permanently and pin it, so a person who keeps reaching for Tab gets Tab, and a person who keeps reaching for
 * the Ghost key stops being offered Tab. A press of the other key starts a new run: "consistent" means in a row.
 */
export function applyUserPress(current: KeyObservation, press: UserPress): KeyObservation {
  const next = clone(current);
  if (press.key === "tab") next.presses.tab = bump(next.presses.tab);
  else next.presses.ghost = bump(next.presses.ghost);
  if (press.accepted !== true) next.missed = bump(next.missed);
  const run = next.run && next.run.key === press.key ? { key: press.key, count: next.run.count + 1 } : { key: press.key, count: 1 };
  next.run = run;
  if (run.count < FLIP_PRESSES) return next;
  const wanted: TabState = press.key === "tab" ? "free" : "taken";
  if (next.tab !== wanted) {
    next.tab = wanted;
    next.flips = bump(next.flips);
  }
  // Pinned either way: three deliberate presses are the user telling Ghost which key this place uses.
  next.pinned = true;
  next.run = null;
  return next;
}

export interface KeyMemorySnapshot {
  max: number;
  /** Least recently used first, exactly like RoleMemorySnapshot and EpisodicSnapshot. */
  entries: KeyObservation[];
}

/**
 * The per-place store. Insertion order is recency: every write moves its place to the end and the oldest is dropped
 * once the cap is reached, so an hour of browsing cannot grow the brain past `KEY_MEMORY_MAX` places.
 */
export class KeyMemory {
  private readonly entries = new Map<string, KeyObservation>();
  readonly max: number;

  constructor(max: number | null = KEY_MEMORY_MAX, entries: readonly KeyObservation[] = []) {
    this.max = typeof max === "number" && Number.isFinite(max) ? Math.max(1, Math.floor(max)) : KEY_MEMORY_MAX;
    for (const entry of entries.slice(-this.max)) this.entries.set(entry.id, clone(entry));
  }

  get size(): number {
    return this.entries.size;
  }

  /** Every place currently held, least recently used first. */
  get ids(): string[] {
    return [...this.entries.keys()];
  }

  /** What is known about a place. Reading never stores anything, so an unknown place stays unknown. */
  get(id: SiteId): KeyObservation {
    const key = siteKey(id);
    const found = this.entries.get(key);
    return found ? clone(found) : unknownObservation(key);
  }

  /** What `acceptKeyFor` needs: the flag alone. */
  tabState(id: SiteId): TabState {
    return this.get(id).tab;
  }

  /** The client watched a Tab press here. Returns the place's record after the update. */
  recordTabProbe(probe: TabProbe): KeyObservation {
    return this.write(probe, (current) => applyTabProbe(current, probe));
  }

  /** The user pressed an accept key here. Returns the place's record after the update. */
  recordUserPress(press: UserPress): KeyObservation {
    return this.write(press, (current) => applyUserPress(current, press));
  }

  /** The user (or a reset) takes a place back to "nothing is known". */
  forget(id: SiteId): void {
    this.entries.delete(siteKey(id));
  }

  toJSON(): KeyMemorySnapshot {
    return { max: this.max, entries: [...this.entries.values()].map(clone) };
  }

  /** A corrupt or partial snapshot yields an empty store rather than a broken one: this memory is never load-bearing. */
  static fromJSON(snapshot: KeyMemorySnapshot | null | undefined): KeyMemory {
    if (!snapshot || !Array.isArray(snapshot.entries)) return new KeyMemory();
    const entries: KeyObservation[] = [];
    for (const raw of snapshot.entries) {
      if (!raw || typeof raw.id !== "string" || raw.id === "") continue;
      entries.push(sanitize(raw));
    }
    return new KeyMemory(snapshot.max, entries);
  }

  private write(id: SiteId & { paused?: boolean }, update: (current: KeyObservation) => KeyObservation): KeyObservation {
    const key = siteKey(id);
    // Paused apps never ask the question, and a place with no name cannot be keyed: neither is ever stored.
    if (id.paused === true || key === UNKNOWN_SITE) return unknownObservation(key);
    const next = update(this.entries.get(key) ?? unknownObservation(key));
    this.entries.delete(key);
    this.entries.set(key, next);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      this.entries.delete(oldest);
    }
    return clone(next);
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(COUNTER_CAP, Math.floor(value)) : 0;
}

const TAB_STATES: readonly TabState[] = ["unknown", "free", "taken"];

function sanitize(raw: KeyObservation): KeyObservation {
  const runKey = raw.run?.key;
  return {
    id: raw.id,
    tab: TAB_STATES.includes(raw.tab) ? raw.tab : "unknown",
    probes: { free: count(raw.probes?.free), taken: count(raw.probes?.taken) },
    presses: { tab: count(raw.presses?.tab), ghost: count(raw.presses?.ghost) },
    missed: count(raw.missed),
    run: runKey === "tab" || runKey === "ghost-key" ? { key: runKey, count: Math.max(1, count(raw.run?.count)) } : null,
    flips: count(raw.flips),
    pinned: raw.pinned === true,
  };
}

/**
 * A pause list, matched generically: exact ids plus family prefixes (every build of one password manager, every
 * flavour of one terminal). Nothing in shared/ names an app; the list is data the client owns and passes in.
 */
export interface PauseList {
  ids?: readonly string[];
  prefixes?: readonly string[];
}

export function isPausedApp(appId: string | undefined | null, list: PauseList): boolean {
  const id = (appId ?? "").trim().toLowerCase();
  if (id === "") return false;
  if ((list.ids ?? []).some((known) => known.trim().toLowerCase() === id)) return true;
  return (list.prefixes ?? []).some((prefix) => prefix !== "" && id.startsWith(prefix.trim().toLowerCase()));
}
