// PORT of the pure rules in extension/src/content/predict.ts (ghostsFromAssignments and helpers), plus the
// server-upgrade merge used only by Desktop today. Kept separate because the native bridge runs through
// JavaScriptCore while the extension operates on DOM elements. When a shared rule changes there, change it here: the native test runner
// (desktop/tests/test_core.m) pins every rule below through JavaScriptCore.
import { NEEDS_TEXT, NONE, isSensitive, mapFormHeuristically, resolveFieldValue } from "@ghost/shared";
import type { CapturedField, FieldAssignment, Ghost, GhostSettings, GhostSource, Profile } from "@ghost/shared";

export interface PredictDeps {
  profile: Profile;
  settings: GhostSettings;
  /** Keep the parked Submit ghost even when no value ghosts remain (the walk already filled them). */
  keepLock?: boolean;
  /** The button the walk was heading for: with no value ghosts left, keepLock keeps this button or nothing. */
  lockSignature?: string;
}

/** One field's answer. `source` and `calibrated` come from the server; the offline mapper sets neither. */
export interface ServedAssignment extends FieldAssignment {
  source?: string;
  calibrated?: boolean;
}

const PLACEHOLDER_LABEL = /^(select|choose|please|--)/i;
const PRIMARY_ACTION = /submit|send|apply|continue|next|save|finish|complete|sign up|register|place|pay|book|confirm/i;

/** Fact keys that have a value. Keys are all the server ever learns about the profile. */
export function usableFactKeys(profile: Profile): string[] {
  return Object.keys(profile.facts).filter((key) => profile.facts[key]);
}

/** The instant pass: keyword mapping from `@ghost/shared`, no network. */
export function buildGhostsOffline(fields: CapturedField[], deps: PredictDeps): Ghost[] {
  return ghostsFromAssignments(fields, mapFormHeuristically(fields, usableFactKeys(deps.profile)), deps, "offline");
}

/**
 * The offline ghosts, upgraded with what the server (or the per-window cache) said. A field the server
 * did not answer keeps its offline assignment, and an uncalibrated answer never replaces an offline
 * ghost that is more confident about another fact.
 */
export function upgradeGhosts(fields: CapturedField[], served: ServedAssignment[], deps: PredictDeps, source: GhostSource): Ghost[] {
  const offline = mapFormHeuristically(fields, usableFactKeys(deps.profile));
  const offlineGhosts = new Set(ghostsFromAssignments(fields, offline, deps, "offline").map((g) => g.signature));
  const bySignature = new Map(served.map((a) => [a.signature, a]));
  const kept = new Set<string>();
  const merged = offline.map((mine) => {
    const theirs = bySignature.get(mine.signature);
    if (theirs && !outranks(mine, theirs, offlineGhosts.has(mine.signature))) return theirs;
    kept.add(mine.signature);
    return mine;
  });
  const ghosts = ghostsFromAssignments(fields, merged, deps, source);
  return ghosts.map((g) => (kept.has(g.signature) && !g.locked ? { ...g, source: "offline" as GhostSource } : g));
}

function outranks(mine: FieldAssignment, theirs: ServedAssignment, hasOfflineGhost: boolean): boolean {
  return theirs.calibrated !== true && hasOfflineGhost && mine.factKey !== theirs.factKey && mine.confidence > theirs.confidence;
}

/** Value ghosts in field order, then at most one locked click ghost so the walk ends parked on Submit. */
export function ghostsFromAssignments(
  fields: CapturedField[],
  assignments: FieldAssignment[],
  deps: PredictDeps,
  source: GhostSource,
): Ghost[] {
  const bySignature = new Map(assignments.map((a) => [a.signature, a]));
  const ghosts: Ghost[] = [];
  let lastGhostAt = -1;
  fields.forEach((field, index) => {
    const assignment = bySignature.get(field.signature);
    const ghost = assignment ? valueGhost(field, assignment, deps, source) : null;
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
  // Only ever offer to tick a box. Unticking one would undo a choice the app or the user made.
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

/** Capture already drops sensitive fields; assignments may come from a server or a cache, so check again. */
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
  // Whitespace counts as a value, so nothing the user typed is ever overwritten.
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
