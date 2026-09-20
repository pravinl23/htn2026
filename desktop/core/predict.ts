// PORT of the pure rules in extension/src/content/predict.ts (ghostsFromAssignments and helpers), plus the
// server-upgrade merge used only by Desktop today. Kept separate because the native bridge runs through
// JavaScriptCore while the extension operates on DOM elements. When a shared rule changes there, change it here: the native test runner
// (desktop/tests/test_core.m) pins every rule below through JavaScriptCore.
//
// Since the answer engine landed, the decision "what does this question get answered with" is NOT made here:
// it is `proposeAnswer` from `@shabang/shared` (docs/answers.md), the same call the extension makes, so both
// clients answer a form identically. What stays here is what only the desktop has:
// - file fields: a resume / cover-letter upload maps to the `resumePath` / `coverLetterPath` fact and yields an
//   `upload` ghost whose value is the absolute path and whose displayText is the file name only;
// - lazy selects (react-select combo boxes, options unknown until opened): the engine is asked with a probe
//   option set that matches the class of the question, and the ghost carries the intended answer as text
//   (`lazy: true`), matched against the real options when it is accepted.
//
// And the gate (docs/incremental.md): a terminal action (Submit / Send / Continue) is only ever proposed when
// every required field before it is filled or already accepted, so the native walk never parks on a Submit the
// page would reject.
import {
  NEEDS_TEXT,
  FACT_CONFIDENCE,
  NONE,
  applyGate,
  classifyQuestion,
  gateWalk,
  ghostTier,
  isSensitive,
  isSkip,
  mapFormHeuristically,
  normalize,
  parseIsoDate,
  proposeAnswer,
  skipGhost,
} from "@shabang/shared";
import type {
  AnswerProposal,
  AnswerSettings,
  CapturedField,
  FieldAssignment,
  FieldOption,
  GateGhost,
  Shabang,
  GhostAction,
  GhostSettings,
  GhostSource,
  GhostTier,
  LearnedAnswerStore,
  Profile,
  SkipReason,
  WalkGate,
} from "@shabang/shared";

export interface PredictDeps {
  profile: Profile;
  settings: GhostSettings;
  /** Keep the parked Submit ghost even when no value ghosts remain (the walk already filled them). */
  keepLock?: boolean;
  /** The button the walk was heading for: with no value ghosts left, keepLock keeps this button or nothing. */
  lockSignature?: string;
  /** Answers the user gave before (~/Library/Application Support/Shabang/answers.json). Never leaves the machine. */
  answers?: LearnedAnswerStore | null;
  /** Opt-outs of the answer policy; the desktop defaults `answerProtectedWithDecline` to on (docs/answers.md). */
  answerSettings?: AnswerSettings;
  /** Signatures of ghosts the user has already accepted in this walk: they meet a required field for the gate. */
  accepted?: readonly string[];
  /** The company, when the page context knows it: stripped from a learned answer's key so it carries to the next site. */
  company?: string;
}

/** One field's answer. `source` and `calibrated` come from the server; the offline mapper sets neither. */
export interface ServedAssignment extends FieldAssignment {
  source?: string;
  calibrated?: boolean;
}

/** What native capture adds to CapturedField (SBField `uploadKind`, `lazyOptions`). */
export interface DesktopField extends CapturedField {
  uploadKind?: string;
  lazyOptions?: boolean;
}

export type DesktopGhostAction = GhostAction | "upload";

/** How a lazy select's answer is matched against the options once the list opens. */
export type LazyMatch = "text" | "decline" | "neutral";

/** A Shabang, plus the Desktop-only `upload` action and the `lazy` marker of a select answered before its options exist. */
export interface DesktopGhost extends Omit<Shabang, "action"> {
  action: DesktopGhostAction;
  lazy?: boolean;
  /** Lazy selects only: "decline" means "whichever option means *prefer not to answer*", not this exact text. */
  lazyMatch?: LazyMatch;
  /** Hold-Tab stops and the HUD says "check this": every guess, and every attestation. */
  needsReview?: boolean;
  /** Why, in words the HUD can show. Never contains a value or a label. */
  reason?: string;
  /** The site-independent key a correction to this question is learned under. */
  questionKey?: string;
}

interface Resolved {
  action: DesktopGhostAction;
  value: string;
  displayText: string;
  confidenceFactor: number;
}

/** One control that got NO proposal, and which of the four named reasons it was (docs/always-propose.md). */
export interface FieldSkip {
  signature: string;
  reason: SkipReason;
}

/** One rung of the fallback chain: a proposal, a named skip, or null meaning "try the next one". */
type DesktopStep = DesktopGhost | { readonly skip: SkipReason } | null;

/**
 * The tier this ghost is drawn at, in place. The confidence threshold decides HOW a proposal looks and
 * nothing else: under it, a ghost is a dimmed long shot carrying its reason, never a ghost that vanished.
 * Mirrors `tiered` in extension/src/content/predict.ts, so both clients look the same on the same form.
 */
function tier(ghost: DesktopGhost, deps: PredictDeps): DesktopGhost {
  const drawn: GhostTier = ghostTier(ghost.confidence, deps.settings.confidenceThreshold, ghost.guess === true);
  ghost.tier = drawn;
  if (drawn === "confident") return ghost;
  ghost.guess = true;
  // Everything the user must look at before taking it: the same flag the native HUD already reads.
  ghost.needsReview = true;
  return ghost;
}

/** The page offered nothing to answer, so Shabang offers the first thing the user could act on at all. */
const LAST_RESORT_CONFIDENCE = 0.4;

/** Controls the last resort may land on: focusing or opening one commits nothing. */
const FOCUSABLE_KINDS: ReadonlySet<string> = new Set([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "button", "link",
]);

/**
 * Silence is only correct when there is nothing on screen to act on (docs/always-propose.md). With nothing
 * answered and no terminal action to park on, Shabang proposes the first control the user could act on at all,
 * as a long shot that focuses it -- exactly where the next Tab would have gone anyway.
 */
export function lastResort(fields: DesktopField[], deps: PredictDeps, source: GhostSource): DesktopGhost | null {
  const target = fields.find(
    (f) => f.locked !== true && FOCUSABLE_KINDS.has(f.kind) && !looksSensitive(f) && !fieldHasValue(f),
  );
  if (!target) return null;
  return tier({
    signature: target.signature,
    action: "click",
    displayText: target.label.trim() || "Start here",
    confidence: LAST_RESORT_CONFIDENCE,
    locked: false,
    source,
    guess: true,
    needsReview: true,
    reason: "nothing on this screen matches what Shabang knows yet: this is where it would start",
  }, deps);
}

/** The walk, or -- if this pass proposed nothing at all -- the one proposal a screen with anything on it gets. */
function withLastResort(ghosts: DesktopGhost[], fields: DesktopField[], deps: PredictDeps, source: GhostSource): DesktopGhost[] {
  if (ghosts.length > 0) return ghosts;
  const fallback = lastResort(fields, deps, source);
  return fallback ? [fallback] : ghosts;
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

// ---------- what the server is never asked about ----------
//
// Shabang ANSWERS protected questions now (with the form's own "prefer not to answer"), but it still never
// mentions them to a server and never offers a demographic fact as a possible answer: the decision is local.

/**
 * A profile fact that answers a demographic question (gender, veteranStatus, dateOfBirth...): never offered to
 * a server as a possible answer. The key is read as the question it would answer, so "veteranStatus" and
 * "veteran_status" are the same thing to the shared classifier.
 */
export function isProtectedFactKey(factKey: string): boolean {
  if (typeof factKey !== "string") return false;
  const asQuestion = factKey.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ");
  return classifyQuestion({ label: asQuestion, kind: "text" }).class === "protected";
}

// Option text that only ever appears in a demographic answer set. The shared classifier calls a question
// protected when such options sit next to a DECLINE option (an EEO scale); this is the belt for the set that
// has no decline option at all ("How do you identify?" -> Man / Woman / Non-binary). It does not change what
// Shabang answers -- the shared engine decides that -- only what Shabang is willing to mention to a server.
const DEMOGRAPHIC_OPTION_WORDS =
  /\b(hispanic|latin[oax]|non ?binary|genderqueer|genderfluid|agender|transgender|cisgender|veterans?|disabilit\w*|pacific islander|alaska native|american indian|african american|two or more races|heterosexual|bisexual|gay|lesbian|pronouns?)\b/;
const DEMOGRAPHIC_OPTION_EXACT: ReadonlySet<string> = new Set([
  "male", "female", "man", "woman", "men", "women", "white", "asian", "black", "she her", "he him", "they them",
]);

function isDemographicOption(label: unknown): boolean {
  if (typeof label !== "string") return false;
  const text = normalize(label).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return text !== "" && (DEMOGRAPHIC_OPTION_WORDS.test(text) || DEMOGRAPHIC_OPTION_EXACT.has(text));
}

/**
 * True for EEO / demographic questions: the shared classifier (label, section, EEO answer scale), plus any
 * question whose options are demographic even without a decline option. Used ONLY to keep such questions out
 * of `/v1/predict/form` and out of the fact mapping: answering them is the answer engine's decision.
 */
export function isProtectedQuestion(field: CapturedField): boolean {
  if (field.kind === "button" || field.kind === "link") return false;
  if (classifyQuestion(field).class === "protected") return true;
  return Array.isArray(field.options) && field.options.some((o) => isDemographicOption(o?.label) || isDemographicOption(o?.value));
}

// ---------- mapping ----------

/** Fact keys that have a value. Keys are all the server ever learns about the profile. */
export function usableFactKeys(profile: Profile): string[] {
  return Object.keys(profile.facts).filter((key) => profile.facts[key]);
}

/**
 * The shared keyword mapping, plus the Desktop rules: uploads map to the file facts, EEO / demographic
 * questions are `none` (the answer engine, not a fact key, answers those).
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
    if (isProtectedQuestion(field) || isProtectedFactKey(assignment.factKey)) {
      return { signature: assignment.signature, factKey: NONE, confidence: 0.99 };
    }
    return assignment;
  });
}

/** The instant pass: keyword mapping from `@shabang/shared`, no network. */
export function buildGhostsOffline(fields: DesktopField[], deps: PredictDeps): DesktopGhost[] {
  const assignments = mapFormForDesktop(fields, usableFactKeys(deps.profile));
  return withLastResort(ghostsFromAssignments(fields, assignments, deps, "offline"), fields, deps, "offline");
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
  const mine = ghosts.map((g) => (kept.has(g.signature) && !g.locked ? { ...g, source: "offline" as GhostSource } : g));
  return withLastResort(mine, fields, deps, source);
}

function outranks(mine: FieldAssignment, theirs: ServedAssignment, hasOfflineGhost: boolean): boolean {
  return theirs.calibrated !== true && hasOfflineGhost && mine.factKey !== theirs.factKey && mine.confidence > theirs.confidence;
}

/**
 * Value ghosts in field order, then at most one locked click ghost so the walk ends parked on Submit -- and
 * only when the gate allows that Submit at all (docs/incremental.md).
 */
export function ghostsFromAssignments(
  fields: DesktopField[],
  assignments: FieldAssignment[],
  deps: PredictDeps,
  source: GhostSource,
): DesktopGhost[] {
  return planFields(fields, assignments, deps, source).ghosts;
}

/** The same pass, keeping the named reason for every control it did not propose for. */
export function planFields(
  fields: DesktopField[],
  assignments: FieldAssignment[],
  deps: PredictDeps,
  source: GhostSource,
): { ghosts: DesktopGhost[]; skips: FieldSkip[] } {
  const bySignature = new Map(assignments.map((a) => [a.signature, a]));
  const ghosts: DesktopGhost[] = [];
  const skips: FieldSkip[] = [];
  let lastGhostAt = -1;
  fields.forEach((field, index) => {
    const step = valueGhost(field, bySignature.get(field.signature), deps, source);
    if (step === null || isSkip(step)) {
      skips.push({ signature: field.signature, reason: step === null ? "no-candidate" : step.skip });
      return;
    }
    ghosts.push(step);
    lastGhostAt = index;
  });
  if (ghosts.length > 0 || deps.keepLock) {
    const lock = ghosts.length === 0 && deps.lockSignature !== undefined
      ? lockedButtons(fields).find((f) => f.signature === deps.lockSignature)
      : pickLockedButton(fields, lastGhostAt);
    if (lock) ghosts.push(lockGhost(lock, source));
  }
  // The gate has the last word: a terminal action with a required field still empty before it is not proposed.
  // `upload` is a desktop action the shared Shabang union does not know; the gate only ever reads `signature`.
  const gated = applyGate(ghosts as unknown as Shabang[], gateForFields(fields, ghosts, deps.accepted)) as unknown as DesktopGhost[];
  return { ghosts: gated, skips };
}

/**
 * What a native walk actually shows: the ghosts for these assignments, and -- when they come to nothing --
 * the page-level fallback, so a screen with anything on it is never answered with silence
 * (docs/always-propose.md). The extension's `planForm` does exactly this.
 */
export function walkGhosts(
  fields: DesktopField[],
  assignments: FieldAssignment[],
  deps: PredictDeps,
  source: GhostSource,
): DesktopGhost[] {
  return withLastResort(ghostsFromAssignments(fields, assignments, deps, source), fields, deps, source);
}

/** The gate for this page: what is still unmet, and which terminal actions may be proposed. For the HUD. */
export function gateForFields(fields: readonly CapturedField[], ghosts: readonly DesktopGhost[], accepted?: readonly string[]): WalkGate {
  return gateWalk(fields, ghosts as readonly GateGhost[], accepted ? { accepted } : undefined);
}

/** True for the "Select an option" style entries that stand for "nothing chosen yet". */
export function isPlaceholderChoice(value: string, label: string): boolean {
  return value === "" || PLACEHOLDER_LABEL.test(label.trim());
}

// ---------- one field ----------

const LAZY_FACTOR = 0.9; // the answer is only matched against the real options when the list opens
const MAX_LAZY_ANSWER = 200;
const YES = /^(y|yes|true|1)$/i;
const NO = /^(n|no|false|0)$/i;

// Probe options for a select whose real options do not exist yet. They only tell the answer engine what SHAPE
// of answer this question can take; the ghost carries the answer as text and the combo-box driver matches it
// against the real options at accept time.
const DECLINE_PROBE: FieldOption[] = [{ value: "I don't wish to answer", label: "I don't wish to answer" }];
const YES_NO_PROBE: FieldOption[] = [
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" },
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * What the answer engine proposes for one captured field, asked the way the DESKTOP has to ask it: a select
 * whose options do not exist yet is probed in the shape its class can answer (docs/answers.md). Exposed so the
 * options page, the harness and the tests see exactly what the walk sees.
 */
export function proposeForField(field: DesktopField, deps: PredictDeps, factKey?: string): AnswerProposal {
  return proposeAnswer(isLazySelect(field) ? lazyProbe(field) : field, {
    profile: deps.profile,
    answers: deps.answers ?? null,
    ...(deps.answerSettings ? { settings: deps.answerSettings } : {}),
    ...(factKey && factKey !== NONE ? { factKey } : {}),
    ...(deps.company ? { company: deps.company } : {}),
  });
}

function valueGhost(field: DesktopField, assignment: FieldAssignment | undefined, deps: PredictDeps, source: GhostSource): DesktopStep {
  // Privacy first, and never a confidence question (CLAUDE.md rule 3).
  if (looksSensitive(field)) return skipGhost("sensitive");
  // A path only ever goes to an upload, and an upload only ever takes the path it asks for.
  if (assignment && isFileFact(assignment.factKey) !== (field.kind === "file")) return null;
  // Rule 9: what the app or the user already put there is never overwritten.
  if (fieldHasValue(field)) return skipGhost("already-answered");
  if (field.kind === "file") return uploadGhost(field, assignment, deps, source);
  if (assignment?.factKey === NEEDS_TEXT) return null; // the draft path answers it

  const lazy = isLazySelect(field);
  const proposal = proposeForField(field, deps, assignment?.factKey);
  if (proposal.source === "none") return null; // nothing to say here; the page-level fallback still applies

  const resolved = lazy ? resolveLazy(proposal, deps) : resolveProposal(field, proposal);
  if (!resolved || resolved.value === "" || resolved.value === field.value) return null;
  // Only ever offer to tick a box. Unticking one would undo a choice the app or the user made.
  if (resolved.action === "check" && resolved.value === "false") return null;

  // docs/always-propose.md: the threshold picks the tier. It never removes the proposal.
  const confidence = ghostConfidence(proposal, assignment, resolved.confidenceFactor);

  const ghost: DesktopGhost = {
    signature: field.signature,
    action: resolved.action,
    value: resolved.value,
    displayText: resolved.displayText,
    confidence,
    locked: false,
    source,
    answerSource: proposal.source,
    answerClass: proposal.class,
    needsReview: proposal.needsReview,
    reason: proposal.reason,
    questionKey: proposal.signature,
  };
  if (proposal.source === "guess") ghost.guess = true;
  tier(ghost, deps);
  if (lazy) {
    ghost.lazy = true;
    // A decline is the same answer in anyone's wording: match the MEANING, not this exact text. An ORDINARY
    // question whose answer turns out not to be on the list falls back to whatever the list itself calls the
    // neutral choice ("Other"), which is what docs/answers.md section 3 asks for; a declaration never does,
    // because a Yes/No question has no neutral side to fall back to.
    ghost.lazyMatch =
      proposal.class === "protected" && proposal.optionLabel === DECLINE_PROBE[0]?.label
        ? "decline"
        : proposal.class === "ordinary"
          ? "neutral"
          : "text";
  }
  return ghost;
}

/**
 * How sure the ghost is. When the answer is the very fact the caller's assignment named, the CALLER's
 * confidence is the one that counts (a server that is unsure must not become certain by going through the
 * engine), scaled by how well the engine could say it in this field's own terms -- a fuzzy option match costs
 * a tenth, exactly as it did before the engine existed. Anything the engine decided for itself (a learned
 * answer, a guess, a declaration) carries its own confidence, which is the floor its class is worth.
 */
function ghostConfidence(proposal: AnswerProposal, assignment: FieldAssignment | undefined, factor: number): number {
  const usedTheAssignment = proposal.source === "fact" && assignment !== undefined && proposal.factKey === assignment.factKey;
  const base = usedTheAssignment && assignment
    ? assignment.confidence * Math.min(1, proposal.confidence / FACT_CONFIDENCE)
    : proposal.confidence;
  return round2(base * factor);
}

function isLazySelect(field: DesktopField): boolean {
  return field.kind === "select" && field.lazyOptions === true && !(field.options && field.options.length > 0);
}

/**
 * A select whose options are not known yet, asked in a shape the engine can answer: a protected question is
 * offered a decline, a declaration a yes/no, and anything else is asked as free text so a profile fact answers
 * it in its own words.
 */
function lazyProbe(field: DesktopField): DesktopField {
  const classification = classifyQuestion(field);
  if (classification.class === "protected") return { ...field, options: DECLINE_PROBE };
  if (classification.class === "declaration") return { ...field, options: YES_NO_PROBE };
  const probe: DesktopField = { ...field, kind: "text" };
  delete probe.options;
  return probe;
}

/** The intended answer of a lazy select, as text. Dates and numbers come in option formats nobody can see yet. */
function resolveLazy(proposal: AnswerProposal, deps: PredictDeps): Resolved | null {
  const raw = (proposal.optionLabel ?? proposal.value).trim();
  if (parseIsoDate(raw) !== null || /^\d+$/.test(raw)) return null;
  // "2028-04" reaches a text field as "April 2028"; a list of graduation dates may word it any other way.
  const fact = proposal.factKey ? deps.profile.facts[proposal.factKey] : undefined;
  if (fact && parseIsoDate(fact) !== null) return null;
  const text = YES.test(raw) ? "Yes" : NO.test(raw) ? "No" : raw;
  if (text === "" || text.length > MAX_LAZY_ANSWER || CONTROL.test(text)) return null;
  // A guess is already priced at the floor of its class; only a fact or a learned answer pays for the
  // options nobody has seen yet.
  return { action: "select", value: text, displayText: text, confidenceFactor: proposal.source === "guess" ? 1 : LAZY_FACTOR };
}

/** The proposal as something the writer can perform on this field. */
function resolveProposal(field: DesktopField, proposal: AnswerProposal): Resolved | null {
  const action = proposal.action ?? "fill";
  if (action === "click") return null;
  const display = proposal.optionLabel ?? (action === "check" ? (proposal.value === "true" ? "✓" : "☐") : proposal.value);
  return { action, value: proposal.value, displayText: display, confidenceFactor: 1 };
}

function uploadGhost(field: DesktopField, assignment: FieldAssignment | undefined, deps: PredictDeps, source: GhostSource): DesktopGhost | null {
  const key = assignment?.factKey ?? uploadFactKey(field);
  if (!key || !isFileFact(key) || uploadFactKey(field) !== key) return null;
  const path = usablePath(deps.profile.facts[key] ?? "");
  if (!path) return null;
  // As everywhere else, a low number dims this upload rather than hiding it (docs/always-propose.md).
  const ghost: DesktopGhost = {
    signature: field.signature,
    action: "upload",
    value: path,
    displayText: fileName(path),
    confidence: round2(Math.min(assignment?.confidence ?? FILE_CONFIDENCE, FILE_CONFIDENCE)),
    locked: false,
    source,
    answerSource: "fact",
    answerClass: "ordinary",
    needsReview: false,
    reason: "the file your profile names for this upload",
  };
  return tier(ghost, deps);
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
