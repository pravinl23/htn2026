// The knowledge layer on the native side (docs/knowledge.md), the bridge half. The rules are pure and shared
// (`shared/src/knowledge/**`): this file only turns strings into them and back, exactly like ./coldstart.ts.
//
// It is the SAME `rankActions` that scores the benchmark in docs/knowledge.md section 6 and the same one the
// browser ranker calls. A window and a web page reach it through one context key, so a native app gets whatever
// the browser learned on a screen of the same shape, and the other way round.
//
// Nothing here may name an app, a bundle id, a host or a brand: a surface is an opaque grouping key, and every
// rule reads what the window OFFERS. What comes back carries ids, roles, scores and reasons — never a label,
// never a value, never anything the window said.
import {
  bindKnowledge,
  emptyKnowledge,
  emptyColdStartMeta,
  hourBucketOf,
  knowledgeFileText,
  knowledgeFromJSON,
  nativeContext,
  proposalLook,
  readColdStartMeta,
  fileSizeBytes,
  forgetSurface,
} from "@ghost/shared";
import type {
  ActionRole,
  AxCandidate,
  Context,
  HourBucket,
  KnowledgeGraph,
  Outcome,
  RankedAction,
  ScreenKind,
  ScreenSignals,
  ScreenState,
} from "@ghost/shared";

const MAX_CANDIDATES = 200;
const MAX_TEXT = 300;
const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD = 0.7;

const SCREEN_KINDS: ReadonlySet<string> = new Set<ScreenKind>([
  "feed",
  "media",
  "list",
  "reader",
  "commerce",
  "settings",
  "editor",
  "board",
  "form",
  "unknown",
]);

const OUTCOMES: ReadonlySet<string> = new Set<Outcome>(["taken", "ignored", "replaced"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(json: string | undefined | null): unknown {
  if (typeof json !== "string" || json.trim() === "") return undefined;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    // A broken snapshot is never load-bearing: it reads as "nothing known", like every other store on this side.
    return undefined;
  }
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function ratio(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

/** One control as the accessibility walk reports it. An id and a role are the only things it must have. */
function asAxCandidate(raw: unknown): AxCandidate | null {
  if (!isObject(raw)) return null;
  const id = text(raw.id, 300);
  if (!id) return null;
  const candidate: AxCandidate = { id, axRole: text(raw.axRole, 64) ?? "AXUnknown", label: text(raw.label) ?? "" };
  for (const key of ["axSubrole", "description", "identifier", "repeatKey"] as const) {
    const clean = text(raw[key], key === "repeatKey" ? 120 : MAX_TEXT);
    if (clean !== undefined) candidate[key] = clean;
  }
  if (raw.locked === true) candidate.locked = true;
  if (raw.toggle === true) candidate.toggle = true;
  if (raw.cell === true) candidate.cell = true;
  if (raw.insideMediaControls === true) candidate.insideMediaControls = true;
  if (raw.nearbyPrice === true) candidate.nearbyPrice = true;
  const index = count(raw.index);
  if (index !== undefined) candidate.index = index;
  const badge = count(raw.badgeCount);
  if (badge !== undefined && badge > 0) candidate.badgeCount = badge;
  return candidate;
}

function asCandidates(json: string): AxCandidate[] {
  const raw = parse(json);
  if (!Array.isArray(raw)) return [];
  const out: AxCandidate[] = [];
  for (const item of raw.slice(0, MAX_CANDIDATES)) {
    const candidate = asAxCandidate(item);
    if (candidate) out.push(candidate);
  }
  return out;
}

function asRole(value: unknown): ActionRole | undefined {
  const role = text(value, 32);
  return role === undefined ? undefined : (role as ActionRole);
}

function asScreenKind(value: unknown): ScreenKind | undefined {
  return typeof value === "string" && SCREEN_KINDS.has(value) ? (value as ScreenKind) : undefined;
}

function asHourBucket(value: unknown): HourBucket | undefined {
  const bucket = count(value);
  return bucket !== undefined && bucket <= 5 ? (bucket as HourBucket) : undefined;
}

function asState(raw: unknown): ScreenState | undefined {
  if (!isObject(raw)) return undefined;
  const state: ScreenState = {};
  for (const key of ["mediaPlaying", "isFullscreen", "atEnd", "hasQuery", "readingItem"] as const) {
    if (typeof raw[key] === "boolean") state[key] = raw[key];
  }
  const cart = count(raw.cartCount);
  if (cart !== undefined) state.cartCount = cart;
  return Object.keys(state).length > 0 ? state : undefined;
}

/**
 * What the window measured, when the native side walked its accessibility tree once and counted. Every field is a
 * number or a flag: no node in this shape can carry a title, a path or anything the window says.
 */
function asSignals(raw: unknown): ScreenSignals | undefined {
  if (!isObject(raw)) return undefined;
  const numbers = [
    "nodes",
    "controls",
    "fields",
    "media",
    "headings",
    "images",
    "textChars",
    "maxTextNode",
    "priceNodes",
    "repeatCount",
    "repeatWithPrice",
    "repeatWithText",
    "repeatRows",
    "repeatColumns",
    "cellGrid",
    "toggleRows",
    "toggleRowsLabelled",
    "editableNodes",
  ] as const;
  const signals = {} as Record<string, unknown>;
  for (const key of numbers) signals[key] = count(raw[key]) ?? 0;
  signals.repeatMemberShare = ratio(raw.repeatMemberShare) ?? 0;
  signals.editorShare = ratio(raw.editorShare) ?? 0;
  for (const key of ["mediaPlaying", "mediaControlCluster", "cellGridEqual", "twoPanes", "detailPane"] as const) {
    signals[key] = raw[key] === true;
  }
  return signals as unknown as ScreenSignals;
}

interface WindowOptions {
  limit: number;
  threshold: number;
  now?: string;
}

function asOptions(json: string | undefined): WindowOptions {
  const raw = parse(json);
  const limit = isObject(raw) ? count(raw.limit) : undefined;
  const threshold = isObject(raw) ? ratio(raw.threshold) : undefined;
  const now = isObject(raw) ? text(raw.now, 40) : undefined;
  return {
    limit: limit === undefined || limit === 0 ? DEFAULT_LIMIT : Math.min(40, limit),
    threshold: threshold === undefined ? DEFAULT_THRESHOLD : threshold,
    ...(now !== undefined ? { now } : {}),
  };
}

/** The graph as the file holds it. A missing, empty or corrupt file is simply a brain that has learned nothing. */
function asGraph(json: string | undefined | null): KnowledgeGraph {
  if (typeof json !== "string" || json.trim() === "") return emptyKnowledge();
  return knowledgeFromJSON(json);
}

/** Rewrite the file around a graph, keeping the provenance section a scan wrote (docs/storage.md section 4). */
function fileFrom(graph: KnowledgeGraph, previous: string | undefined | null): string {
  const meta = typeof previous === "string" && previous.trim() !== "" ? readColdStartMeta(previous) : emptyColdStartMeta();
  return knowledgeFileText(graph, meta);
}

function contextFor(candidatesJson: string, signalsJson: string): Context {
  const raw = parse(signalsJson);
  const window = isObject(raw) ? raw : {};
  const surface = text(window.surface, 200) ?? "";
  const at = text(window.at, 40);
  const parsedAt = at === undefined ? undefined : Date.parse(at);
  return nativeContext({
    surface,
    candidates: asCandidates(candidatesJson),
    ...(asScreenKind(window.screenKind) !== undefined ? { screenKind: asScreenKind(window.screenKind) as ScreenKind } : {}),
    ...(ratio(window.screenConfidence) !== undefined ? { screenConfidence: ratio(window.screenConfidence) as number } : {}),
    ...(asSignals(window.signals) !== undefined ? { signals: asSignals(window.signals) as ScreenSignals } : {}),
    ...(asRole(window.previousAction) !== undefined ? { previousAction: asRole(window.previousAction) as ActionRole } : {}),
    ...(asState(window.state) !== undefined ? { state: asState(window.state) as ScreenState } : {}),
    ...(parsedAt !== undefined && Number.isFinite(parsedAt) ? { at: parsedAt } : {}),
    ...(typeof window.hasMediaElement === "boolean" ? { hasMediaElement: window.hasMediaElement } : {}),
    ...(window.mainListSignature === null
      ? { mainListSignature: null }
      : text(window.mainListSignature, 120) !== undefined
        ? { mainListSignature: text(window.mainListSignature, 120) as string }
        : {}),
  });
}

/** A ranked row plus how docs/always-propose.md says to draw it. Ids, roles and counts only. */
interface WindowProposal extends RankedAction {
  look: ReturnType<typeof proposalLook>;
}

export interface RankWindowResult {
  surface: string;
  screenKind: ScreenKind;
  screenConfidence: number;
  hourBucket: HourBucket;
  previousAction?: ActionRole;
  threshold: number;
  proposals: WindowProposal[];
  /** The one Ghost would propose. Null only when the window offers nothing at all to act on. */
  top: WindowProposal | null;
}

/**
 * Rank what this window offers, for this person, right now. `graphJson` is the text of the one small file
 * (~/Library/Application Support/Ghost/graph.json); an empty string is a first run and still produces a ranking,
 * because a shape is enough to propose something (docs/always-propose.md).
 */
export function rankWindow(candidatesJson: string, signalsJson: string, graphJson?: string, optionsJson?: string): string {
  const context = contextFor(candidatesJson, signalsJson);
  const graph = asGraph(graphJson);
  const options = asOptions(optionsJson);
  const knowledge = bindKnowledge(graph);
  const ranked = knowledge.rankActions(context, { ...(options.now !== undefined ? { now: options.now } : {}) });
  const proposals: WindowProposal[] = ranked.slice(0, options.limit).map((row) => ({ ...row, look: proposalLook(row.score) }));
  const result: RankWindowResult = {
    surface: context.surface,
    screenKind: context.screenKind,
    screenConfidence: context.screenConfidence ?? 0,
    hourBucket: context.hourBucket,
    ...(context.previousAction !== undefined ? { previousAction: context.previousAction } : {}),
    threshold: options.threshold,
    proposals,
    top: proposals[0] ?? null,
  };
  return JSON.stringify(result);
}

/**
 * One outcome, folded into the file: `taken`, `ignored`, or `replaced` with the role the person chose instead,
 * which is the strongest signal the layer has. The moment is the part of the context key the ranker already
 * handed back, so the native side never has to rebuild a window to record what happened in it.
 *
 * Returns the new file text for the native side to write atomically at mode 0600, and the counts it now holds.
 */
export function recordWindowOutcome(graphJson: string, momentJson: string, outcome: string): string {
  const raw = parse(momentJson);
  const moment = isObject(raw) ? raw : {};
  const surface = text(moment.surface, 200);
  const screenKind = asScreenKind(moment.screenKind) ?? "unknown";
  const role = asRole(moment.role);
  const instead = asRole(moment.instead);
  const graph = asGraph(graphJson);
  const hourBucket = asHourBucket(moment.hourBucket) ?? hourBucketOf();
  const at = text(moment.at, 40);

  const unchanged = (): string => JSON.stringify({ file: fileFrom(graph, graphJson), changed: false, habits: graph.habits.size });
  if (!surface || !role || !OUTCOMES.has(outcome)) return unchanged();

  const context: Context = {
    surface,
    screenKind,
    hourBucket,
    candidates: [],
    ...(asRole(moment.previousAction) !== undefined ? { previousAction: asRole(moment.previousAction) as ActionRole } : {}),
  };
  const knowledge = bindKnowledge(graph);
  if (outcome === "replaced" && instead !== undefined) knowledge.recordReplacement(context, { role }, { role: instead });
  else knowledge.recordOutcome(context, { role }, outcome as Outcome);
  if (moment.visit === true) knowledge.recordVisit(context);

  const file = fileFrom(graph, graphJson);
  return JSON.stringify({ file, changed: true, habits: graph.habits.size, bytes: fileSizeBytes(file), at: at ?? null });
}

/** "Forget this place": every habit learned on one surface goes, and nothing else moves. */
export function forgetKnowledgeSurface(graphJson: string, surface: string): string {
  const graph = asGraph(graphJson);
  const removed = forgetSurface(graph, typeof surface === "string" ? surface : "");
  const file = fileFrom(graph, graphJson);
  return JSON.stringify({ file, removed, habits: graph.habits.size, bytes: fileSizeBytes(file) });
}
