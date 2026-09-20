// The context key every prediction asks with (docs/knowledge.md section 2).
//
// One key, whether the screen is a web page or a native window: an opaque surface id, the KIND of screen it is,
// what the user did just before, a four-hour bucket, and what is on screen right now with a role guess each.
// The surface id is never parsed for meaning here — it is a grouping key and nothing else, which is exactly why
// the layer cannot be overfitted to any one site or app.
//
// Two builders, one code path: `webContext` takes the candidate list a DOM walker produces, `nativeContext` takes
// the one an accessibility walker produces. Both end in the same `Context`, so the browser ranker and the native
// agent share a brain instead of each having their own.
import { classifyAffordance, lockedForRole } from "../affordance/roles";
import type { AffordanceCandidate, AffordanceContext, AffordanceRole } from "../affordance/roles";
import type { Rect } from "../types";
import { inferScreenKind, screenKindFromSignals } from "./screenKind";
import type { ScreenKind, ScreenNode, ScreenSignals } from "./screenKind";

/**
 * What a control offers. The affordance vocabulary plus the two things only structure can say: a control that
 * carries a boolean state, and one cell of a grid of equal cells.
 */
export type ActionRole = AffordanceRole | "toggle" | "cell";

/** The first proposal of a screen has no previous action, and "none" is a real key the habits store learns on. */
export const PREVIOUS_NONE = "none";

/** Four-hour buckets: "morning mail" is learnable without the file ever holding a timestamp. */
export type HourBucket = 0 | 1 | 2 | 3 | 4 | 5;

export const HOUR_BUCKETS: readonly HourBucket[] = [0, 1, 2, 3, 4, 5];

/** One thing on screen. No label, no value, no text: the id is the client's own handle for the element. */
export interface ActionRef {
  id: string;
  role: ActionRole;
  /** How sure the role guess is, NOT how likely the user wants it. Ranking decides that. */
  roleConfidence: number;
  /** Irreversible (submit, send, pay, delete). Proposable, never pressed without a deliberate human press. */
  locked: boolean;
  /** Position in the repeated list or grid this control belongs to, when it belongs to one. */
  index?: number;
}

/**
 * What the screen is doing right now, as far as structure can tell. Every field is optional and every one of them
 * is a state a client can read without knowing what site it is on.
 */
export interface ScreenState {
  mediaPlaying?: boolean;
  isFullscreen?: boolean;
  /** Scrolled to the end: there is nothing more to load or read. */
  atEnd?: boolean;
  /** A search box already holds something. */
  hasQuery?: boolean;
  /** Items waiting in a basket, from a badge count or a count inside a control's own name. */
  cartCount?: number;
  /** The main region shows ONE item rather than a list of them. */
  readingItem?: boolean;
}

/** The context key. The five documented fields are the key; the last two are hints a builder already computed. */
export interface Context {
  /** An opaque id. A bare origin, or an app id. Never parsed, never matched against a list, never logged. */
  surface: string;
  screenKind: ScreenKind;
  /** The role of the action taken just before, here or on the screen before this one. */
  previousAction?: ActionRole;
  hourBucket: HourBucket;
  candidates: ActionRef[];
  /** How well the screen's shape fit its kind. */
  screenConfidence?: number;
  state?: ScreenState;
}

/** A DOM candidate plus the two structural flags the affordance vocabulary cannot express. */
export interface SurfaceCandidate extends AffordanceCandidate {
  /** The control carries a boolean state: a checkbox, a switch, an AXCheckBox. Structure, not wording. */
  toggle?: boolean;
  /** One cell of a grid of small equal cells. */
  cell?: boolean;
}

/** A candidate as an accessibility walk reports it. Roles are the AX vocabulary; nothing names an app. */
export interface AxCandidate {
  id: string;
  /** Verbatim AX role ("AXButton", "AXCheckBox", "AXTextArea"). A role vocabulary, never a vendor. */
  axRole: string;
  axSubrole?: string;
  label: string;
  description?: string;
  identifier?: string;
  locked?: boolean;
  rect?: Rect;
  /** Members of one repeated row or grid share this opaque key. */
  repeatKey?: string;
  index?: number;
  insideMediaControls?: boolean;
  toggle?: boolean;
  cell?: boolean;
  /** A currency-shaped value renders beside it. */
  nearbyPrice?: boolean;
  badgeCount?: number;
}

/** What both builders take. `screen` is the tree; a client that already measured one can pass `signals` instead. */
interface ScreenInput {
  surface: string;
  screen?: ScreenNode;
  signals?: ScreenSignals;
  /** Already known (the client kept the last inference): skips the walk entirely. */
  screenKind?: ScreenKind;
  screenConfidence?: number;
  previousAction?: ActionRole;
  /** The moment, for the hour bucket. A number, a Date, or nothing for "now". */
  at?: Date | number;
  state?: ScreenState;
  /** The page or window holds a media node, when the caller knows it without walking a tree. */
  hasMediaElement?: boolean;
  /** The signature of the list the main region repeats; null says the screen has no main list. */
  mainListSignature?: string | null;
}

export interface WebContextInput extends ScreenInput {
  candidates: readonly SurfaceCandidate[];
}

export interface NativeContextInput extends ScreenInput {
  candidates: readonly AxCandidate[];
}

/** Local hour to bucket. Pure: the caller decides what "now" and what "local" mean. */
export function hourBucketOf(at: Date | number = new Date()): HourBucket {
  const date = typeof at === "number" ? new Date(at) : at;
  const hour = Number.isNaN(date.getTime()) ? 0 : date.getHours();
  const bucket = Math.floor(Math.min(23, Math.max(0, hour)) / 4);
  return (bucket < 0 || bucket > 5 ? 0 : bucket) as HourBucket;
}

const AX_LINK = /^AXLink$/i;
const AX_FIELD = /^AX(TextField|TextArea|SearchField|ComboBox|Slider|Stepper|Incrementor|DateField|TimeField|PopUpButton)$/i;
const AX_TOGGLE = /^AX(CheckBox|Switch|Toggle|DisclosureTriangle)$/i;

function axKind(candidate: AxCandidate): AffordanceCandidate["kind"] {
  if (AX_LINK.test(candidate.axRole)) return "link";
  if (AX_FIELD.test(candidate.axRole)) return "field";
  return "button";
}

/** An AX candidate, expressed in the one candidate shape the classifier already reads. */
export function candidateFromAx(candidate: AxCandidate): SurfaceCandidate {
  const searchField = /^AXSearchField$/i.test(candidate.axRole);
  const out: SurfaceCandidate = {
    id: candidate.id,
    kind: axKind(candidate),
    label: candidate.label,
    locked: candidate.locked === true,
    ariaRole: candidate.axSubrole ?? candidate.axRole,
    toggle: candidate.toggle === true || AX_TOGGLE.test(candidate.axRole),
    cell: candidate.cell === true || /^AXCell$/i.test(candidate.axRole),
  };
  if (candidate.description !== undefined) out.description = candidate.description;
  if (candidate.identifier !== undefined) out.identifier = candidate.identifier;
  if (searchField) out.inputType = "search";
  if (candidate.insideMediaControls === true) out.insideMediaControls = true;
  if (candidate.nearbyPrice === true) out.nearbyPrice = true;
  if (candidate.badgeCount !== undefined) out.badgeCount = candidate.badgeCount;
  if (candidate.repeatKey !== undefined) out.list = { listSignature: candidate.repeatKey, index: candidate.index ?? 0 };
  return out;
}

/**
 * The role of one control: what it offers, plus the two structural overrides. A control with a boolean state is a
 * toggle whenever nothing more specific was recognized, and a cell of an equal grid is a cell.
 */
export function actionRefOf(candidate: SurfaceCandidate, context: AffordanceContext = {}): ActionRef {
  const affordance = classifyAffordance(candidate, context);
  let role: ActionRole = affordance.role;
  let confidence = affordance.confidence;
  const generic = affordance.role === "unknown" || affordance.role === "field" || affordance.role === "primary-item";
  if (candidate.toggle === true && generic) {
    role = "toggle";
    confidence = Math.max(confidence, 0.6);
  } else if (candidate.cell === true && (affordance.role === "unknown" || affordance.role === "primary-item")) {
    role = "cell";
    confidence = Math.max(confidence, 0.6);
  }
  const ref: ActionRef = {
    id: candidate.id,
    role,
    roleConfidence: Math.round(confidence * 1000) / 1000,
    locked: lockedForRole(candidate, affordance.role),
  };
  const index = candidate.list?.index;
  if (typeof index === "number") ref.index = index;
  return ref;
}

function screenOf(input: ScreenInput): { kind: ScreenKind; confidence: number } {
  if (input.screenKind) return { kind: input.screenKind, confidence: input.screenConfidence ?? 0.6 };
  if (input.signals) {
    const guess = screenKindFromSignals(input.signals);
    return { kind: guess.kind, confidence: guess.confidence };
  }
  if (input.screen) {
    const guess = inferScreenKind(input.screen);
    return { kind: guess.kind, confidence: guess.confidence };
  }
  return { kind: "unknown", confidence: 0.3 };
}

function buildContext(input: ScreenInput, candidates: readonly SurfaceCandidate[]): Context {
  const screen = screenOf(input);
  const affordanceContext: AffordanceContext = {};
  if (input.hasMediaElement !== undefined) affordanceContext.hasMediaElement = input.hasMediaElement;
  else if (input.signals || input.screen) affordanceContext.hasMediaElement = screen.kind === "media";
  if (input.mainListSignature !== undefined) affordanceContext.mainListSignature = input.mainListSignature;

  const context: Context = {
    surface: input.surface,
    screenKind: screen.kind,
    hourBucket: hourBucketOf(input.at),
    candidates: candidates.map((candidate) => actionRefOf(candidate, affordanceContext)),
    screenConfidence: Math.round(screen.confidence * 1000) / 1000,
  };
  if (input.previousAction !== undefined) context.previousAction = input.previousAction;
  if (input.state !== undefined) context.state = input.state;
  return context;
}

/** The browser client's entry point: what the DOM walker saw becomes the one context key. */
export function webContext(input: WebContextInput): Context {
  return buildContext(input, input.candidates);
}

/** The native client's entry point: an accessibility walk becomes the same context key, by the same rules. */
export function nativeContext(input: NativeContextInput): Context {
  return buildContext(input, input.candidates.map(candidateFromAx));
}

/** The habit key's previous-action slot: an action role, or the "none" that opens a screen. */
export function previousActionOf(context: Pick<Context, "previousAction">): string {
  return context.previousAction ?? PREVIOUS_NONE;
}
