// PORT of the pure rules in extension/src/content/predict.ts (ghostsFromAssignments and helpers), plus the
// server-upgrade merge used only by Desktop today. Kept separate because the native bridge runs through
// JavaScriptCore while the extension operates on DOM elements. When a shared rule changes there, change it here: the native test runner
// (desktop/tests/test_core.m) pins every rule below through JavaScriptCore.
//
// Desktop-only additions (real forms, desktop/tests/fixtures/greenhouse-safari-viam.json):
// - file fields: a resume / cover-letter upload maps to the `resumePath` / `coverLetterPath` fact and yields an
//   `upload` ghost whose value is the absolute path and whose displayText is the file name only;
// - lazy selects (react-select combo boxes, options unknown until opened): the ghost carries the intended answer
//   (`lazy: true`), matched against the real options when it is accepted;
// - EEO / demographic questions never get a ghost, whatever an assignment says;
// - work authorization / sponsorship questions about a country the profile does not cover never get a ghost.
import { NEEDS_TEXT, NONE, isSensitive, mapFormHeuristically, normalize, parseIsoDate, resolveFieldValue } from "@ghost/shared";
import type { CapturedField, FieldAssignment, Ghost, GhostAction, GhostSettings, GhostSource, Profile } from "@ghost/shared";

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

/** What native capture adds to CapturedField (GHField `uploadKind`, `lazyOptions`). */
export interface DesktopField extends CapturedField {
  uploadKind?: string;
  lazyOptions?: boolean;
}

export type DesktopGhostAction = GhostAction | "upload";

/** A Ghost, plus the Desktop-only `upload` action and the `lazy` marker of a select answered before its options exist. */
export interface DesktopGhost extends Omit<Ghost, "action"> {
  action: DesktopGhostAction;
  lazy?: boolean;
}

interface Resolved {
  action: DesktopGhostAction;
  value: string;
  displayText: string;
  confidenceFactor: number;
  lazy?: boolean;
}

const PLACEHOLDER_LABEL = /^(select|choose|please|--)/i;
const PRIMARY_ACTION = /submit|send|apply|continue|next|save|finish|complete|sign up|register|place|pay|book|confirm/i;

// ---------- file facts ----------

export const RESUME_PATH = "resumePath";
export const COVER_LETTER_PATH = "coverLetterPath";
const FILE_FACTS: ReadonlySet<string> = new Set([RESUME_PATH, COVER_LETTER_PATH]);
const FILE_CONFIDENCE = 0.9;
const COVER_LETTER = /\bcover ?letters?\b|\bmotivation(al)? letter\b/;
const RESUME = /\br[eé]sum[eé]s?\b|\bcv\b|\bcurriculum vitae\b/;
const UPLOADABLE = /\.(pdf|docx?|rtf|txt|odt|pages)$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_PATH = 1024;

/** Fact keys that hold a local file path. They only ever land on file fields, and never leave the machine. */
export function isFileFact(key: string): boolean {
  return FILE_FACTS.has(key);
}

/** resumePath / coverLetterPath for an upload field, or null when it is neither (or ambiguous). */
export function uploadFactKey(field: DesktopField): string | null {
  if (field.kind !== "file") return null;
  if (field.uploadKind === "resume") return RESUME_PATH;
  if (field.uploadKind === "coverLetter") return COVER_LETTER_PATH;
  if (field.uploadKind !== undefined) return null;
  const text = normalize([field.label, field.id, field.name].filter(Boolean).join(" "));
  const cover = COVER_LETTER.test(text);
  if (cover === RESUME.test(text)) return null; // neither, or "resume or cover letter": which file is a guess
  return cover ? COVER_LETTER_PATH : RESUME_PATH;
}

/** An absolute path to a document, nothing that could smuggle a key press into the open panel. */
function usablePath(value: string): string | null {
  if (CONTROL.test(value)) return null; // not even a trailing newline: it would be a Return in the go-to sheet
  const path = value.trim();
  if (!path.startsWith("/") || path.length > MAX_PATH || !UPLOADABLE.test(path)) return null;
  if (path.split("/").some((part) => part === "..")) return null;
  return path;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// ---------- questions Ghost never answers ----------

// EEO / demographic (self-identification) questions: the applicant answers them, or nobody does.
const PROTECTED =
  /\b(gender|sex|sexual orientation|race|racial|ethnic\w*|hispanic|latin[oax]|veteran|military (status|service)|disabilit\w*|disabled|pronouns?|lgbtq?\w*|transgender|marital( status)?|religio\w*|age|age (range|group)|date of birth|birth ?date|dob|indigenous|aboriginal|first nations|visible minority|caste)\b/;
const PROTECTED_SECTION =
  /\bself ?identif\w*|\bequal (employment )?opportunit\w*|\beeoc?\b|\bdemographics?\b|\bdiversity (survey|questions?|information|data)\b|\bvoluntary disclosure\b/;

// Answers only a demographic question offers ("How do you identify?" with Man / Woman / Non-binary). Specific words
// anywhere in an option, or a whole option that is exactly one of the short demographic answers. "Isle of Man" in a
// country list is neither.
const PROTECTED_OPTION_WORDS =
  /\b(hispanic|latin[oax]|non ?binary|genderqueer|genderfluid|agender|transgender|cisgender|veteran|disabilit\w*|pacific islander|alaska native|american indian|african american|two or more races|heterosexual|bisexual|asexual|gay|lesbian|pronouns?)\b/;
const PROTECTED_OPTION_EXACT: ReadonlySet<string> = new Set([
  "male", "female", "man", "woman", "men", "women", "white", "asian", "black", "she her", "he him", "they them",
]);

function isProtectedOption(label: unknown): boolean {
  if (typeof label !== "string") return false;
  const text = normalize(label).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return text !== "" && (PROTECTED_OPTION_WORDS.test(text) || PROTECTED_OPTION_EXACT.has(text));
}

/** A profile fact that answers a demographic question (gender, veteranStatus, dateOfBirth...): never offered. */
export function isProtectedFactKey(factKey: string): boolean {
  return typeof factKey === "string" && PROTECTED.test(normalize(factKey));
}

/**
 * True for EEO / demographic questions: by label, identifiers, placeholder, the section they sit in (legend and
 * heading), or by the answers they offer.
 */
export function isProtectedQuestion(field: CapturedField): boolean {
  if (field.kind === "button" || field.kind === "link") return false;
  const own = [field.label, field.id, field.name, field.placeholder].map(normalize);
  if (own.some((text) => PROTECTED.test(text))) return true;
  const context = normalize(field.context);
  if (PROTECTED.test(context) || PROTECTED_SECTION.test(context)) return true;
  return Array.isArray(field.options) && field.options.some((option) => isProtectedOption(option?.label) || isProtectedOption(option?.value));
}

// Work authorization is a fact about ONE country. The profile's yes/no speaks for its own country only.
const JURISDICTION_FACTS: ReadonlySet<string> = new Set(["workAuthorization", "requiresSponsorship"]);
const PLACES: ReadonlyArray<readonly [string, RegExp]> = [
  ["united states", /\bunited states\b|\busa\b/],
  ["canada", /\bcanada\b/],
  ["united kingdom", /\bunited kingdom\b|\bgreat britain\b|\bbritain\b|\bengland\b|\bscotland\b|\bwales\b|\bnorthern ireland\b/],
  ["european union", /\beuropean union\b|\beea\b/],
  ["ireland", /\b(republic of )?ireland\b/],
  ["australia", /\baustralia\b/],
  ["new zealand", /\bnew zealand\b/],
  ["germany", /\bgermany\b/],
  ["france", /\bfrance\b/],
  ["netherlands", /\bnetherlands\b|\bholland\b/],
  ["switzerland", /\bswitzerland\b/],
  ["sweden", /\bsweden\b/],
  ["spain", /\bspain\b/],
  ["italy", /\bitaly\b/],
  ["poland", /\bpoland\b/],
  ["india", /\bindia\b/],
  ["singapore", /\bsingapore\b/],
  ["japan", /\bjapan\b/],
  ["china", /\bchina\b/],
  ["hong kong", /\bhong kong\b/],
  ["south korea", /\b(south )?korea\b/],
  ["israel", /\bisrael\b/],
  ["mexico", /\bmexico\b/],
  ["brazil", /\bbrazil\b/],
];
// Case-sensitive on the raw text: "US" is a country, "us" is a pronoun.
const ABBREVIATIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["united states", /(^|[^A-Za-z])U\.?S\.?(A\.?)?([^A-Za-z]|$)/],
  ["united kingdom", /(^|[^A-Za-z])U\.?K\.?([^A-Za-z]|$)/],
  ["european union", /(^|[^A-Za-z])E\.?U\.?([^A-Za-z]|$)/],
];

function placesNamed(raw: string): Set<string> {
  const text = normalize(raw);
  const named = new Set<string>();
  for (const [place, pattern] of PLACES) if (pattern.test(text)) named.add(place);
  for (const [place, pattern] of ABBREVIATIONS) if (pattern.test(raw)) named.add(place);
  // "Northern Ireland" is the United Kingdom, not Ireland.
  if (/\bnorthern ireland\b/.test(text) && !/\b(republic of ireland|ireland and|and ireland)\b/.test(text)) named.delete("ireland");
  return named;
}

/**
 * True when the question names a country that is not (only) the profile's own country. A profile without a
 * country fact keeps the shared behaviour (its yes/no answers every such question), as the extension does.
 */
function asksAboutAnotherCountry(field: CapturedField, factKey: string, profile: Profile): boolean {
  if (!JURISDICTION_FACTS.has(factKey)) return false;
  const country = (profile.facts.country ?? "").trim();
  if (country === "") return false;
  const named = placesNamed([field.label, field.placeholder].filter(Boolean).join(" "));
  if (named.size === 0) return false;
  const home = placesNamed(country);
  if (home.size !== 1 || named.size !== 1) return true;
  return !named.has([...home][0]!);
}

// ---------- mapping ----------

/** Fact keys that have a value. Keys are all the server ever learns about the profile. */
export function usableFactKeys(profile: Profile): string[] {
  return Object.keys(profile.facts).filter((key) => profile.facts[key]);
}

/**
 * The shared keyword mapping, plus the Desktop rules: uploads map to the file facts, EEO / demographic
 * questions are a confident `none`.
 */
export function mapFormForDesktop(fields: DesktopField[], factKeys: string[]): FieldAssignment[] {
  const shared = mapFormHeuristically(fields, factKeys.filter((key) => !isFileFact(key)));
  return shared.map((assignment, index) => {
    const field = fields[index];
    if (!field) return assignment;
    if (field.kind === "file") {
      const key = uploadFactKey(field);
      return key && factKeys.includes(key)
        ? { signature: assignment.signature, factKey: key, confidence: FILE_CONFIDENCE }
        : { signature: assignment.signature, factKey: NONE, confidence: 0.99 };
    }
    if (isProtectedQuestion(field) || isProtectedFactKey(assignment.factKey)) return { signature: assignment.signature, factKey: NONE, confidence: 0.99 };
    return assignment;
  });
}

/** The instant pass: keyword mapping from `@ghost/shared`, no network. */
export function buildGhostsOffline(fields: DesktopField[], deps: PredictDeps): DesktopGhost[] {
  return ghostsFromAssignments(fields, mapFormForDesktop(fields, usableFactKeys(deps.profile)), deps, "offline");
}

/**
 * The offline ghosts, upgraded with what the server (or the per-window cache) said. A field the server
 * did not answer keeps its offline assignment, and an uncalibrated answer never replaces an offline
 * ghost that is more confident about another fact.
 */
export function upgradeGhosts(fields: DesktopField[], served: ServedAssignment[], deps: PredictDeps, source: GhostSource): DesktopGhost[] {
  const offline = mapFormForDesktop(fields, usableFactKeys(deps.profile));
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
  fields: DesktopField[],
  assignments: FieldAssignment[],
  deps: PredictDeps,
  source: GhostSource,
): DesktopGhost[] {
  const bySignature = new Map(assignments.map((a) => [a.signature, a]));
  const ghosts: DesktopGhost[] = [];
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

function valueGhost(field: DesktopField, assignment: FieldAssignment, deps: PredictDeps, source: GhostSource): DesktopGhost | null {
  if (assignment.factKey === NONE || assignment.factKey === NEEDS_TEXT) return null;
  // Whatever the question looks like: a demographic fact is never an answer (a server may assign `gender` to
  // "How do you identify?").
  if (looksSensitive(field) || isProtectedQuestion(field) || isProtectedFactKey(assignment.factKey)) return null;
  // A path only ever goes to an upload, and an upload only ever takes the path it asks for.
  if (isFileFact(assignment.factKey) !== (field.kind === "file")) return null;
  if (fieldHasValue(field)) return null;
  const fact = deps.profile.facts[assignment.factKey];
  if (!fact || asksAboutAnotherCountry(field, assignment.factKey, deps.profile)) return null;
  const resolved = resolveForDesktop(field, assignment.factKey, fact);
  if (!resolved || resolved.value === field.value) return null;
  // Only ever offer to tick a box. Unticking one would undo a choice the app or the user made.
  if (resolved.action === "check" && resolved.value === "false") return null;
  const confidence = assignment.confidence * resolved.confidenceFactor;
  if (confidence < deps.settings.confidenceThreshold) return null;
  const ghost: DesktopGhost = {
    signature: field.signature,
    action: resolved.action,
    value: resolved.value,
    displayText: resolved.displayText,
    confidence,
    locked: false,
    source,
  };
  if (resolved.lazy) ghost.lazy = true;
  return ghost;
}

const YES = /^(y|yes|true|1)$/i;
const NO = /^(n|no|false|0)$/i;
const LAZY_FACTOR = 0.9; // the answer is only matched against the real options when the list opens
const MAX_LAZY_ANSWER = 200;

function resolveForDesktop(field: DesktopField, factKey: string, fact: string): Resolved | null {
  if (field.kind === "file") {
    if (uploadFactKey(field) !== factKey) return null;
    const path = usablePath(fact);
    return path ? { action: "upload", value: path, displayText: fileName(path), confidenceFactor: 1 } : null;
  }
  if (field.kind === "select" && field.lazyOptions === true && !(field.options && field.options.length > 0)) {
    return resolveLazyChoice(fact);
  }
  return resolveFieldValue(field, factKey, fact);
}

/** The intended answer of a select whose options are not known yet: the fact itself, "Yes"/"No" for yes/no facts. */
function resolveLazyChoice(fact: string): Resolved | null {
  const trimmed = fact.trim();
  // Dates and numbers come in option formats nobody can see yet: never guessed.
  if (parseIsoDate(trimmed) !== null || /^\d+$/.test(trimmed)) return null;
  const text = YES.test(trimmed) ? "Yes" : NO.test(trimmed) ? "No" : trimmed;
  if (text === "" || text.length > MAX_LAZY_ANSWER || CONTROL.test(text)) return null;
  return { action: "select", value: text, displayText: text, confidenceFactor: LAZY_FACTOR, lazy: true };
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

function lockGhost(field: CapturedField, source: GhostSource): DesktopGhost {
  return { signature: field.signature, action: "click", displayText: field.label, confidence: 1, locked: true, source };
}
