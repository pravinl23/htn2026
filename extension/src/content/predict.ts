// Always propose something (docs/always-propose.md), the rule that outranks every heuristic in this file:
// the confidence threshold decides how a proposal is DRAWN, never whether it exists. The only ways a control
// leaves this module without a ghost are the four named `SkipReason`s, and a page that offers anything at all
// ends with at least one proposal (`lastResort`).
import {
  NEEDS_TEXT, NONE, applyGate, classifyQuestion, gateWalk, ghostTier, isProtectedQuestion, isSensitive, isSkip,
  mapFormHeuristically, profileToGraph, proposeAnswer, resolveFieldValue, skipGhost, staysOnThisMachine,
} from "@ghost/shared";
import type {
  AnswerProposal, CapturedField, FactGraph, FieldAssignment, FormPredictRequest, Ghost, GhostSettings, GhostSource,
  GhostStep, GhostTier, LearnedAnswerStore, Profile, SkipReason, WalkGate,
} from "@ghost/shared";
import { FORM_LIMITS, toWireField } from "../lib/messages";
import type { FormPrediction, ServedAssignment, ServerResult } from "../lib/messages";

export interface PredictDeps {
  profile: Profile;
  /**
   * The fact graph (docs/profile-sources.md). Left out, it is derived from `profile` — the flat profile is
   * the graph's own mirror (`extension/src/lib/storage.ts`), so the same facts come back with the labels
   * and phrasings the shared defs give them. Passing the stored graph keeps a scanned fact's own aliases.
   */
  graph?: FactGraph;
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
  /** Answers the user gave before (docs/answers.md section 4). Local only: never sent anywhere. */
  answers?: LearnedAnswerStore | null;
  /** The company this page is for, stripped from the question signature so an answer carries to the next site. */
  company?: string;
  /** Signatures of ghosts the user has already accepted, so the gate counts them as filled before a rescan. */
  accepted?: Iterable<string>;
}

/** A draft is a suggestion the user reads before accepting: a fixed confidence, above the default threshold. */
export const LLM_CONFIDENCE = 0.8;
/**
 * An uncalibrated "this needs prose" (our heuristic, the llm adapter) must be a real prompt, not just any
 * textarea. Both bars are about what the FIELD IS, not about how sure the answer is, which is why neither
 * moves with the user's confidence threshold.
 */
const UNCALIBRATED_TEXT_BAR = 0.85;
/** The same question of a calibrated provider: "needs_text" said this faintly is not a prose prompt. */
const TEXT_PROMPT_BAR = 0.7;
/** Drafts are only written where Ghost already recognises a form of the user's own details (not a comment or chat box). */
const MIN_FACT_FIELDS = 2;
/**
 * What a guess is worth on a page that does not look like a form about the user. It is still proposed -- a
 * toolbar dropdown gets a dimmed long-shot rather than silence -- it just never looks like a fact.
 */
const STRANGER_FORM_CONFIDENCE = 0.5;
/** The page offered nothing to answer, so Ghost offers the first thing the user could act on at all. */
const LAST_RESORT_CONFIDENCE = 0.4;
const DRAFTABLE_KINDS: ReadonlySet<string> = new Set(["textarea", "text"]);

const PLACEHOLDER_LABEL = /^(select|choose|please|--)/i;
const PRIMARY_ACTION = /submit|send|apply|continue|next|save|finish|complete|sign up|register|place|pay|book|confirm/i;

/** Fact keys that have a value. Keys are all the server ever learns about the profile. */
export function usableFactKeys(profile: Profile): string[] {
  return Object.keys(profile.facts).filter((key) => profile.facts[key]);
}

// One derived graph per profile object: the content script holds a single profile and rescans often.
const derivedGraphs = new WeakMap<Profile, FactGraph>();

/**
 * The graph this pass matches against. Matching goes through the graph for EVERY field now, which is why
 * a shipping form, a support ticket or a conference signup works: the mapper compares what the field calls
 * itself with what each fact calls itself, instead of looking a résumé key up in a table.
 */
export function graphFor(deps: PredictDeps): FactGraph {
  if (deps.graph) return deps.graph;
  const memo = derivedGraphs.get(deps.profile);
  if (memo) return memo;
  const graph = profileToGraph(deps.profile);
  derivedGraphs.set(deps.profile, graph);
  return graph;
}

/** What a fact key is worth here. A sensitive fact has no value to give: it is the user's to type. */
function factValue(deps: PredictDeps, key: string): string {
  const flat = deps.profile.facts[key];
  if (flat) return flat;
  const fact = deps.graph?.facts[key];
  return fact && !fact.sensitive ? fact.value : "";
}

/** The instant pass: keyword mapping from `@ghost/shared`, no network, 0 ms. */
export function buildGhostsOffline(fields: CapturedField[], deps: PredictDeps): Ghost[] {
  const assignments = mapFormHeuristically(fields, usableFactKeys(deps.profile), graphFor(deps));
  return withLastResort(ghostsFromAssignments(fields, assignments, deps, "offline"), fields, deps, "offline");
}

/**
 * The offline ghosts, upgraded with what the server (or the per-site cache) said. A field the server
 * did not answer keeps its offline assignment, and an uncalibrated answer (the llm adapter, the
 * server's own heuristic) never replaces an offline ghost that is more confident about another fact.
 */
export function upgradeGhosts(fields: CapturedField[], served: ServedAssignment[], deps: PredictDeps, source: GhostSource): Ghost[] {
  return planForm(fields, served, deps, source).ghosts;
}

/** One control that got NO proposal, and which of the four named reasons it was (docs/always-propose.md). */
export interface FieldSkip {
  signature: string;
  reason: SkipReason;
}

export interface FormPlan {
  ghosts: Ghost[];
  /** Empty essay fields worth drafting, in DOM order: the controller starts all of them at once. */
  textFields: CapturedField[];
  /** Why a terminal action is (or is not) proposable right now: docs/incremental.md. */
  gate: WalkGate;
  /**
   * Every control this pass did not propose for, with the reason. Low confidence is NEVER one of them:
   * being unsure produces a guess (docs/always-propose.md). Exposed so a reviewer, a test or the debug HUD
   * can see that nothing was dropped silently.
   */
  skips: FieldSkip[];
  /**
   * The locked button this walk is heading for, whether or not the gate lets it through yet. The controller
   * remembers it so the Submit ghost can still appear once the last required field is answered.
   */
  terminal?: string;
}

/** One pass over a capture: the ghosts to show, and the free-text fields to start drafting in the background. */
export function planForm(fields: CapturedField[], served: ServedAssignment[], deps: PredictDeps, source: GhostSource): FormPlan {
  const offline = mapFormHeuristically(fields, usableFactKeys(deps.profile), graphFor(deps));
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
  const built = planFields(fields, merged, deps, served.length > 0 ? source : "offline");
  // An answer-engine ghost is decided on this machine; only a value that came from a fact assignment is "served".
  const mine = built.ghosts.map((g) => (kept.has(g.signature) && !g.locked && g.source !== "llm" ? { ...g, source: "offline" as GhostSource } : g));
  // Nothing matched? The page still gets a proposal (docs/always-propose.md). Before the gate, so the gate
  // still has the last word on anything terminal.
  const ghosts = withLastResort(mine, fields, deps, served.length > 0 ? source : "offline");
  // Gate last, over the finished list: a terminal action the page would reject is never proposed at all.
  const gate = gateWalk(fields, ghosts, deps.accepted ? { accepted: deps.accepted } : {});
  const terminal = ghosts.find((g) => g.locked)?.signature;
  const plan: FormPlan = { ghosts: applyGate(ghosts, gate), textFields: draftableFields(fields, merged, deps), gate, skips: built.skips };
  if (terminal) plan.terminal = terminal;
  return plan;
}

/**
 * Essay fields a draft may be written for: an empty, non-sensitive, labelled text box whose assignment says
 * `needs_text` firmly enough, in a form where at least two fields map to profile facts.
 */
export function draftableFields(fields: CapturedField[], assignments: ServedAssignment[], deps: PredictDeps): CapturedField[] {
  // The user's confidence threshold has no say here: it styles a proposal, it never cancels one. What is
  // left is what a draft COSTS (a server round trip) and what the field IS (a prose prompt, not any textarea).
  const facts = assignments.filter((a) => a.factKey !== NONE && a.factKey !== NEEDS_TEXT && factValue(deps, a.factKey));
  if (facts.length < MIN_FACT_FIELDS) return [];
  const bySignature = new Map(assignments.map((a) => [a.signature, a]));
  return fields.filter((field) => {
    const assignment = bySignature.get(field.signature);
    if (assignment?.factKey !== NEEDS_TEXT || !DRAFTABLE_KINDS.has(field.kind) || !field.label.trim()) return false;
    // A protected or declaration prompt is never drafted by a server: asking for the draft sends the question
    // and the page around it (docs/answers.md section 7). The user writes those themselves.
    if (staysOnThisMachine(field)) return false;
    const bar = assignment.calibrated === true ? TEXT_PROMPT_BAR : UNCALIBRATED_TEXT_BAR;
    return assignment.confidence >= bar && !looksSensitive(field) && !fieldHasValue(field);
  });
}

function outranks(mine: FieldAssignment, theirs: ServedAssignment, hasOfflineGhost: boolean): boolean {
  return theirs.calibrated !== true && hasOfflineGhost && mine.factKey !== theirs.factKey && mine.confidence > theirs.confidence;
}

/**
 * What may leave the page for a prediction: value-capable, non-sensitive fields, without their current value,
 * and never a protected question. `isSensitive` knows passwords, cards and government IDs; it has no
 * protected vocabulary, so an EEO block used to go on the wire in full -- label, section heading and every
 * option ("Decline To Self Identify" included) -- and was then cached against the site. The desktop client
 * has refused this since it shipped (`desktop/core/predict.ts`); both clients now refuse the same questions.
 * Ghost still ANSWERS them, locally, from the form's own decline option.
 */
export function predictableFields(fields: CapturedField[]): CapturedField[] {
  return fields
    .filter((field) => !isProtectedQuestion(field))
    .map(toWireField)
    .filter((field): field is CapturedField => field !== null)
    .slice(0, FORM_LIMITS.fields);
}

/** Value ghosts in DOM order, then at most one locked click ghost so the walk ends parked on Submit. */
export function ghostsFromAssignments(
  fields: CapturedField[],
  assignments: FieldAssignment[],
  deps: PredictDeps,
  source: GhostSource,
): Ghost[] {
  return planFields(fields, assignments, deps, source).ghosts;
}

/** The same pass, keeping the named reason for every control it did not propose for. */
export function planFields(
  fields: CapturedField[],
  assignments: FieldAssignment[],
  deps: PredictDeps,
  source: GhostSource,
): { ghosts: Ghost[]; skips: FieldSkip[] } {
  const bySignature = new Map(assignments.map((a) => [a.signature, a]));
  const drafted = new Set(deps.drafts ? draftableFields(fields, assignments, deps).map((f) => f.signature) : []);
  const ownForm = looksLikeOwnForm(assignments, deps);
  const ghosts: Ghost[] = [];
  const skips: FieldSkip[] = [];
  let lastGhostAt = -1;
  fields.forEach((field, index) => {
    const step = stepForField(field, bySignature.get(field.signature), deps, source, drafted.has(field.signature), ownForm);
    if (step === null || isSkip(step)) {
      // A rung of the chain returning null means "nothing left to try", which is the no-candidate case.
      skips.push({ signature: field.signature, reason: step === null ? "no-candidate" : step.skip });
      return;
    }
    ghosts.push(step);
    lastGhostAt = index;
  });
  if (ghosts.length === 0 && !deps.keepLock) return { ghosts, skips };
  const lock = ghosts.length === 0 && deps.lockSignature !== undefined
    ? lockedButtons(fields).find((f) => f.signature === deps.lockSignature)
    : pickLockedButton(fields, lastGhostAt);
  if (lock) ghosts.push(lockGhost(lock, source));
  return { ghosts, skips };
}

/**
 * One field's proposal, through the whole fallback chain: a streamed draft or the fact mapper first, then the
 * answer engine (docs/answers.md). A `null` from any rung means "try the next one", never "show nothing"; the
 * pass ends without a proposal only when a rung names a `SkipReason`, or when every rung has been tried.
 */
function stepForField(
  field: CapturedField,
  assignment: FieldAssignment | undefined,
  deps: PredictDeps,
  source: GhostSource,
  drafted: boolean,
  ownForm: boolean,
): GhostStep {
  // Privacy first, and it is not a confidence rule: a password, a card or a government ID is never captured,
  // never proposed and never filled, however sure Ghost is (CLAUDE.md rule 3).
  if (looksSensitive(field)) return skipGhost("sensitive");
  // Rule 9: what the page or the user already put there is never overwritten.
  if (fieldHasValue(field)) return skipGhost("already-answered");
  const fromFacts = drafted ? draftGhost(field, deps) : assignment ? valueGhost(field, assignment, deps, source) : null;
  // docs/answers.md section 1: never give up on a field, and never let a server answer a protected question.
  const answered = answerGhost(field, fromFacts, deps, ownForm);
  return answered === "keep" ? fromFacts : answered;
}

/** True for the "Select an option" style entries that stand for "nothing chosen yet". */
export function isPlaceholderChoice(value: string, label: string): boolean {
  return value === "" || PLACEHOLDER_LABEL.test(label.trim());
}

/**
 * The same proposal, dressed for how sure it is (docs/always-propose.md). The threshold picks the tier and
 * nothing more: under it a proposal is a dimmed long-shot carrying its reason, never a proposal that vanished.
 */
function tiered(ghost: Ghost, deps: PredictDeps, reason?: string): Ghost {
  const tier: GhostTier = ghostTier(ghost.confidence, deps.settings.confidenceThreshold, ghost.guess === true);
  const out: Ghost = { ...ghost, tier };
  if (tier === "confident") return out;
  out.guess = true;
  const why = reason ?? ghost.reason;
  if (why) out.reason = why;
  return out;
}

function valueGhost(field: CapturedField, assignment: FieldAssignment, deps: PredictDeps, source: GhostSource): Ghost | null {
  if (assignment.factKey === NONE || assignment.factKey === NEEDS_TEXT) return null; // the mapper has nothing: fall back
  const fact = factValue(deps, assignment.factKey);
  const resolved = fact ? resolveFieldValue(field, assignment.factKey, fact) : null;
  if (!resolved || resolved.value === field.value) return null;
  // Only ever offer to tick a box. Unticking one would undo a choice the page or the user made (rule 9).
  if (resolved.action === "check" && resolved.value === "false") return null;
  return tiered({
    signature: field.signature,
    action: resolved.action,
    value: resolved.value,
    displayText: resolved.displayText,
    confidence: assignment.confidence * resolved.confidenceFactor,
    locked: false,
    source,
  }, deps, "the closest match Ghost could make to what it knows about you");
}

// ---------- the answer engine (docs/answers.md) ----------

/**
 * What the answer engine says about a field: "keep" leaves the fact/draft ghost alone, a Ghost replaces it,
 * and null means "nothing more to try here" (for a protected or declaration question it also drops the served
 * one, because a model's assignment must never answer a question about the applicant themselves).
 */
type AnswerVerdict = GhostStep | "keep";

/**
 * Whether this looks like a form about the USER: the same two-fact signal the draft path uses. It no longer
 * decides WHETHER an ordinary question is guessed at -- everything gets a proposal (docs/always-propose.md) --
 * only how sure that guess is allowed to look: a dropdown in a site's toolbar gets a dimmed long-shot.
 */
function looksLikeOwnForm(assignments: FieldAssignment[], deps: PredictDeps): boolean {
  const facts = assignments.filter((a) => a.factKey !== NONE && a.factKey !== NEEDS_TEXT && factValue(deps, a.factKey));
  return facts.length >= MIN_FACT_FIELDS;
}

function answerGhost(field: CapturedField, existing: Ghost | null, deps: PredictDeps, ownForm: boolean): AnswerVerdict {
  if (field.kind === "button" || field.kind === "link" || field.kind === "file") return "keep";
  if (existing?.pending || existing?.source === "llm") return "keep"; // a draft is the answer for that field
  const classification = classifyQuestion(field);
  const ordinary = classification.class === "ordinary";
  const learnable = (deps.answers?.size ?? 0) > 0;
  // An ordinary question the fact path already answered (or already decided against) is not the engine's to
  // reopen, unless there is a correction on file: the user is the authority for their own answer.
  if (ordinary && existing !== null && !learnable) return "keep";

  const proposal = proposeAnswer(field, {
    profile: deps.profile,
    answers: deps.answers ?? null,
    settings: { answerProtectedWithDecline: deps.settings.answerProtectedWithDecline },
    ...(deps.company ? { company: deps.company } : {}),
  });
  if (ordinary) {
    // Facts on an ordinary field belong to the heuristic and the server, which have already weighed this
    // one against the threshold and the field's own options. Only a correction or a guess is new information.
    if (proposal.source === "fact" || (existing !== null && proposal.source !== "learned")) return "keep";
    return ghostFromProposal(field, proposal, deps, ownForm) ?? "keep";
  }
  // A protected or declaration question is the answer engine's alone: with nothing to propose, nothing shows,
  // and a model's assignment never gets to answer it instead.
  return ghostFromProposal(field, proposal, deps, ownForm);
}

function ghostFromProposal(field: CapturedField, proposal: AnswerProposal, deps: PredictDeps, ownForm: boolean): Ghost | null {
  if (proposal.source === "none" || !proposal.action || proposal.value === "") return null; // nothing to say: the caller falls back
  // Rule 9 again: only ever offer to tick a box, never to clear one, and never to rewrite what is there.
  if (proposal.action === "check" && proposal.value !== "true") return null;
  if (proposal.value === field.value) return null;
  // A guess at an ordinary question on a page that is not a form about the user is still proposed; it is
  // just capped so it can never look as sure as an answer to the user's own application.
  const stranger = proposal.source === "guess" && proposal.class === "ordinary" && !ownForm;
  const ghost: Ghost = {
    signature: field.signature,
    action: proposal.action,
    value: proposal.value,
    displayText: displayTextFor(proposal),
    confidence: stranger ? Math.min(proposal.confidence, STRANGER_FORM_CONFIDENCE) : proposal.confidence,
    locked: false,
    // Learned answers, conservative inferences and neutral defaults are all decided on this machine.
    source: "offline",
    answerClass: proposal.class,
    answerSource: proposal.source,
  };
  if (proposal.source === "guess") ghost.guess = true;
  const reason = stranger ? `${proposal.reason} (this page does not look like a form about you)` : proposal.reason;
  return tiered(ghost, deps, reason);
}

function displayTextFor(proposal: AnswerProposal): string {
  if (proposal.action === "select") return proposal.optionLabel ?? proposal.value;
  if (proposal.action === "check") return proposal.value === "true" ? "✓" : "☐";
  return proposal.value;
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
  return tiered(ghost, deps, "a draft written for you: read it before you take it");
}

// ---------- the last resort (docs/always-propose.md) ----------

/** Controls the last resort may land on. Clicking any of them focuses or opens it; none of them commits anything. */
const FOCUSABLE_KINDS: ReadonlySet<string> = new Set([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "button", "link",
]);

/**
 * Silence is only correct when there is nothing on screen to act on. With no field answered and no terminal
 * action to park on, Ghost still proposes: the first control the user could act on at all, as a long-shot
 * that focuses it. A checkbox, a radio group and a file input are left out, because activating one of those
 * would answer a question rather than move to it -- the answer engine has already had its say on them.
 *
 * It is deliberately the least intrusive proposal there is: the first focusable control in reading order is
 * exactly where a native Tab would have gone, so taking this one costs the user nothing they did not expect.
 */
export function lastResort(fields: CapturedField[], deps: PredictDeps, source: GhostSource): Ghost | null {
  const target = fields.find(
    (f) => f.locked !== true && FOCUSABLE_KINDS.has(f.kind) && !looksSensitive(f) && !fieldHasValue(f),
  );
  // Nothing but an irreversible action left: a lone Submit ghost is not worth showing until this walk has
  // filled something (the same rule the controller's `prune` keeps), so this is one of the honest silences.
  if (!target) return null;
  return tiered({
    signature: target.signature,
    action: "click",
    displayText: target.label.trim() || "Start here",
    confidence: LAST_RESORT_CONFIDENCE,
    locked: false,
    source,
    guess: true,
  }, deps, "nothing on this page matches what Ghost knows yet: this is where it would start");
}

/** The walk, or -- if this pass proposed nothing at all -- the one proposal a page with anything on it always gets. */
function withLastResort(ghosts: Ghost[], fields: CapturedField[], deps: PredictDeps, source: GhostSource): Ghost[] {
  if (ghosts.length > 0) return ghosts;
  const fallback = lastResort(fields, deps, source);
  return fallback ? [fallback] : ghosts;
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
