import { NEEDS_TEXT, NONE, isSensitive, mapFormHeuristically, resolveFieldValue } from "@ghost/shared";
import type { CapturedField, FieldAssignment, Ghost, GhostSettings, GhostSource, Profile } from "@ghost/shared";

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
}

const PLACEHOLDER_LABEL = /^(select|choose|please|--)/i;
const PRIMARY_ACTION = /submit|send|apply|continue|next|save|finish|complete|sign up|register|place|pay|book|confirm/i;

/** Stage 1 prediction: keyword mapping from `@ghost/shared`, no network. */
export function buildGhostsOffline(fields: CapturedField[], deps: PredictDeps): Ghost[] {
  const factKeys = Object.keys(deps.profile.facts).filter((key) => deps.profile.facts[key]);
  return ghostsFromAssignments(fields, mapFormHeuristically(fields, factKeys), deps, "offline");
}

/** Value ghosts in DOM order, then at most one locked click ghost so the walk ends parked on Submit. */
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
