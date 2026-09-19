import { NEEDS_TEXT, NONE, isSensitive, mapFormHeuristically, resolveFieldValue } from "@ghost/shared";
import type { CapturedField, FieldAssignment, FormPredictRequest, Ghost, GhostSettings, GhostSource, Profile } from "@ghost/shared";
import { FORM_LIMITS, toWireField } from "../lib/messages";
import type { FormPrediction, ServedAssignment, ServerResult } from "../lib/messages";

export interface PredictDeps {
  profile: Profile;
  settings: GhostSettings;
  /** Keep the parked Submit ghost even when no value ghosts remain (the walk already filled them). */
  keepLock?: boolean;
  /**
   * The button the walk was heading for. With no value ghosts left, `keepLock` keeps this button or
   * nothing: a later view's "Delete all" must never inherit the lock ghost.
   */
  lockSignature?: string;
  /** Streamed free-text drafts by field signature (Stage 3). Left out, essay fields get no ghost. */
  drafts?: { get(signature: string): { text: string; pending: boolean } | undefined };
}

/** A draft is a suggestion the user reads before accepting: a fixed confidence, above the default threshold. */
export const LLM_CONFIDENCE = 0.8;
/** An uncalibrated "this needs prose" (our heuristic, the llm adapter) must be a real prompt, not just any textarea. */
const UNCALIBRATED_TEXT_BAR = 0.85;
/** Drafts are only written where Ghost already recognises a form of the user's own details (not a comment or chat box). */
const MIN_FACT_FIELDS = 2;
const DRAFTABLE_KINDS: ReadonlySet<string> = new Set(["textarea", "text"]);

const PLACEHOLDER_LABEL = /^(select|choose|please|--)/i;
const PRIMARY_ACTION = /submit|send|apply|continue|next|save|finish|complete|sign up|register|place|pay|book|confirm/i;

/** Fact keys that have a value. Keys are all the server ever learns about the profile. */
export function usableFactKeys(profile: Profile): string[] {
  return Object.keys(profile.facts).filter((key) => profile.facts[key]);
}

/** The instant pass: keyword mapping from `@ghost/shared`, no network, 0 ms. */
export function buildGhostsOffline(fields: CapturedField[], deps: PredictDeps): Ghost[] {
  return ghostsFromAssignments(fields, mapFormHeuristically(fields, usableFactKeys(deps.profile)), deps, "offline");
}

/**
 * The offline ghosts, upgraded with what the server (or the per-site cache) said. A field the server
 * did not answer keeps its offline assignment, and an uncalibrated answer (the llm adapter, the
 * server's own heuristic) never replaces an offline ghost that is more confident about another fact.
 */
export function upgradeGhosts(fields: CapturedField[], served: ServedAssignment[], deps: PredictDeps, source: GhostSource): Ghost[] {
  return planForm(fields, served, deps, source).ghosts;
}

export interface FormPlan {
  ghosts: Ghost[];
  /** Empty essay fields worth drafting, in DOM order: the controller starts all of them at once. */
  textFields: CapturedField[];
}

/** One pass over a capture: the ghosts to show, and the free-text fields to start drafting in the background. */
export function planForm(fields: CapturedField[], served: ServedAssignment[], deps: PredictDeps, source: GhostSource): FormPlan {
  const offline = mapFormHeuristically(fields, usableFactKeys(deps.profile));
  // Whether a draft has arrived yet must not decide a merge: an essay field counts as soon as it is draftable.
  const offlineGhosts = new Set([
    ...ghostsFromAssignments(fields, offline, { ...deps, drafts: undefined }, "offline").map((g) => g.signature),
    ...draftableFields(fields, offline, deps).map((f) => f.signature),
  ]);
  const bySignature = new Map(served.map((a) => [a.signature, a]));
  const kept = new Set<string>();
  const merged = offline.map((mine) => {
    const theirs = bySignature.get(mine.signature);
    if (theirs && !outranks(mine, theirs, offlineGhosts.has(mine.signature))) return theirs;
    kept.add(mine.signature);
    return mine;
  });
  const ghosts = ghostsFromAssignments(fields, merged, deps, served.length > 0 ? source : "offline");
  return {
    ghosts: ghosts.map((g) => (kept.has(g.signature) && !g.locked && g.source !== "llm" ? { ...g, source: "offline" } : g)),
    textFields: draftableFields(fields, merged, deps),
  };
}

/**
 * Essay fields a draft may be written for: an empty, non-sensitive, labelled text box whose assignment says
 * `needs_text` firmly enough, in a form where at least two fields map to profile facts.
 */
export function draftableFields(fields: CapturedField[], assignments: ServedAssignment[], deps: PredictDeps): CapturedField[] {
  const threshold = deps.settings.confidenceThreshold;
  if (LLM_CONFIDENCE < threshold) return [];
  const facts = assignments.filter((a) => a.factKey !== NONE && a.factKey !== NEEDS_TEXT && a.confidence >= threshold && deps.profile.facts[a.factKey]);
  if (facts.length < MIN_FACT_FIELDS) return [];
  const bySignature = new Map(assignments.map((a) => [a.signature, a]));
  return fields.filter((field) => {
    const assignment = bySignature.get(field.signature);
    if (assignment?.factKey !== NEEDS_TEXT || !DRAFTABLE_KINDS.has(field.kind) || !field.label.trim()) return false;
    const bar = assignment.calibrated === true ? threshold : Math.max(threshold, UNCALIBRATED_TEXT_BAR);
    return assignment.confidence >= bar && !looksSensitive(field) && !fieldHasValue(field);
  });
}

function outranks(mine: FieldAssignment, theirs: ServedAssignment, hasOfflineGhost: boolean): boolean {
  return theirs.calibrated !== true && hasOfflineGhost && mine.factKey !== theirs.factKey && mine.confidence > theirs.confidence;
}

/** What may leave the page for a prediction: value-capable, non-sensitive fields, without their current value. */
export function predictableFields(fields: CapturedField[]): CapturedField[] {
  return fields.map(toWireField).filter((field): field is CapturedField => field !== null).slice(0, FORM_LIMITS.fields);
}

/** Value ghosts in DOM order, then at most one locked click ghost so the walk ends parked on Submit. */
export function ghostsFromAssignments(
  fields: CapturedField[],
  assignments: FieldAssignment[],
  deps: PredictDeps,
  source: GhostSource,
): Ghost[] {
  const bySignature = new Map(assignments.map((a) => [a.signature, a]));
  const drafted = new Set(deps.drafts ? draftableFields(fields, assignments, deps).map((f) => f.signature) : []);
  const ghosts: Ghost[] = [];
  let lastGhostAt = -1;
  fields.forEach((field, index) => {
    const assignment = bySignature.get(field.signature);
    const ghost = drafted.has(field.signature) ? draftGhost(field, deps) : assignment ? valueGhost(field, assignment, deps, source) : null;
    if (!ghost) return;
    ghosts.push(ghost);
    lastGhostAt = index;
  });
  if (ghosts.length === 0 && !deps.keepLock) return ghosts;
  const lock = ghosts.length === 0 && deps.lockSignature !== undefined
    ? lockedButtons(fields).find((f) => f.signature === deps.lockSignature)
    : pickLockedButton(fields, lastGhostAt);
  if (lock) ghosts.push(lockGhost(lock, source));
  return ghosts;
}

/** True for the "Select an option" style entries that stand for "nothing chosen yet". */
export function isPlaceholderChoice(value: string, label: string): boolean {
  return value === "" || PLACEHOLDER_LABEL.test(label.trim());
}

function valueGhost(field: CapturedField, assignment: FieldAssignment, deps: PredictDeps, source: GhostSource): Ghost | null {
  if (assignment.factKey === NONE || assignment.factKey === NEEDS_TEXT) return null;
  if (looksSensitive(field) || fieldHasValue(field)) return null;
  const fact = deps.profile.facts[assignment.factKey];
  const resolved = fact ? resolveFieldValue(field, assignment.factKey, fact) : null;
  if (!resolved || resolved.value === field.value) return null;
  // Only ever offer to tick a box. Unticking one would undo a choice the page or the user made (rule 9).
  if (resolved.action === "check" && resolved.value === "false") return null;
  const confidence = assignment.confidence * resolved.confidenceFactor;
  if (confidence < deps.settings.confidenceThreshold) return null;
  return {
    signature: field.signature,
    action: resolved.action,
    value: resolved.value,
    displayText: resolved.displayText,
    confidence,
    locked: false,
    source,
  };
}

/** The streamed draft as it stands: the text grows with every delta, and `pending` clears when the stream is done. */
function draftGhost(field: CapturedField, deps: PredictDeps): Ghost | null {
  const draft = deps.drafts?.get(field.signature);
  if (!draft?.text) return null;
  const ghost: Ghost = {
    signature: field.signature, action: "fill", value: draft.text, displayText: draft.text,
    confidence: LLM_CONFIDENCE, locked: false, source: "llm",
  };
  if (draft.pending) ghost.pending = true;
  return ghost;
}

/** Capture already drops sensitive fields; assignments may come from a server, so check again. */
function looksSensitive(field: CapturedField): boolean {
  return isSensitive({
    inputType: field.inputType,
    autocomplete: field.autocomplete,
    name: field.name,
    id: field.id,
    label: field.label,
    placeholder: field.placeholder,
  });
}

function fieldHasValue(field: CapturedField): boolean {
  const value = field.value ?? "";
  if (field.kind === "checkbox") return false; // "true"/"false" is state; an already-correct box resolves to no ghost
  // Same test as the controller's pre-write check: whitespace counts as a value, so nothing is ever overwritten.
  if (field.kind !== "select") return value !== "";
  const chosen = field.options?.find((o) => o.value === value);
  return !isPlaceholderChoice(value, chosen?.label ?? "");
}

/** The form's own submit: a locked button after the last ghost, preferring a primary-looking label. */
function pickLockedButton(fields: CapturedField[], lastGhostAt: number): CapturedField | null {
  const locked = lockedButtons(fields);
  const after = locked.filter((field) => fields.indexOf(field) > lastGhostAt);
  const pool = after.length > 0 ? after : locked;
  return pool.filter((f) => PRIMARY_ACTION.test(f.label)).at(-1) ?? pool.at(-1) ?? null;
}

function lockedButtons(fields: CapturedField[]): CapturedField[] {
  return fields.filter((field) => field.kind === "button" && field.locked === true);
}

function lockGhost(field: CapturedField, source: GhostSource): Ghost {
  return { signature: field.signature, action: "click", displayText: field.label, confidence: 1, locked: true, source };
}

// ---------- cache -> server, once per form ----------

export interface FormAnswer {
  assignments: ServedAssignment[];
  provider: string;
  cache: "hit" | "miss";
  /** What the user waited: the cache read, or the whole round trip through the worker. */
  latencyMs: number;
}

/** Null means "stay offline": no cache entry and no usable server answer. It never rejects. */
export type PredictForm = (request: FormPredictRequest) => Promise<FormAnswer | null>;

export interface FormPredictorDeps {
  readCache(origin: string, signature: string, factKeys: string[]): Promise<{ assignments: ServedAssignment[]; provider: string } | null>;
  saveCache(origin: string, signature: string, factKeys: string[], answer: { assignments: ServedAssignment[]; provider: string }): Promise<void>;
  askServer(request: FormPredictRequest): Promise<ServerResult<FormPrediction>>;
}

/** A cache hit never reaches the server, so a repeat visit makes zero calls. */
export function createFormPredictor(deps: FormPredictorDeps): PredictForm {
  return async (request) => {
    const started = performance.now();
    const { origin, formSignature, factKeys } = request;
    const cached = await deps.readCache(origin, formSignature, factKeys).catch(() => null);
    if (cached) return { assignments: cached.assignments, provider: cached.provider, cache: "hit", latencyMs: performance.now() - started };
    const reply = await deps.askServer(request).catch(() => null);
    if (!reply?.ok || reply.data.assignments.length === 0) return null;
    const { assignments, provider, fallbackFrom } = reply.data;
    // The server's fallback after a provider failure is the same heuristic we already ran: not worth pinning to the site.
    if (!fallbackFrom) void deps.saveCache(origin, formSignature, factKeys, { assignments, provider }).catch(() => undefined);
    return { assignments, provider, cache: "miss", latencyMs: performance.now() - started };
  };
}
