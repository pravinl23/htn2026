// Shabang Desktop core bridge. Bundled by build-core.mjs into build/shabang-core.js as an IIFE whose global
// is `GhostCore`, and run inside JavaScriptCore by desktop/src/SBCore.m.
//
// Strings in, strings out (JSON): the Objective-C side stays thin and the behaviour stays identical to
// the extension. Nothing here may touch the DOM, Node or chrome.*: JavaScriptCore has none of them
// (build-core.mjs runs the bundle in a bare VM context to prove it).
import {
  DEFAULT_SETTINGS,
  DEMO_PROFILE,
  LearnedAnswerStore,
  answerCounterName,
  classifyQuestion,
  isLockedAction,
  isSensitive,
  recordCorrection as recordAnswerCorrection,
} from "@shabang/shared";
import type {
  AnswerSettings,
  CapturedField,
  CorrectionOptions,
  FieldKind,
  FieldOption,
  GhostSettings,
  GhostSource,
  LearnedAnswersSnapshot,
  LockProbe,
  Profile,
  QuestionField,
  SensitiveProbe,
} from "@shabang/shared";
// ./predict.ts is a port of the pure rules of extension/src/content/predict.ts: threshold gating, skip
// filled fields, placeholder choices, sensitivity re-check, tick-only checkboxes, the lock ghost parked last.
// On top of them it adds the Desktop rules for real forms: upload ghosts from resumePath / coverLetterPath,
// lazy (react-select) choices, no ghost for EEO / demographic questions or another country's work authorization.
import {
  gateForFields,
  planFields,
  proposeForField,
  isFileFact,
  isPlaceholderChoice,
  isProtectedFactKey,
  isProtectedQuestion,
  mapFormForDesktop,
  upgradeGhosts as upgrade,
  walkGhosts,
} from "./predict";
import type { DesktopField, DesktopGhost, PredictDeps, ServedAssignment } from "./predict";

export const version = "1";

const SOURCES: ReadonlySet<string> = new Set<GhostSource>(["offline", "server", "cache", "llm", "loop"]);

function parse<T>(json: string, what: string): T {
  if (typeof json !== "string") throw new TypeError(`GhostCore: ${what} must be a JSON string`);
  return JSON.parse(json) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFields(json: string): DesktopField[] {
  const raw = parse<unknown>(json, "fields");
  if (!Array.isArray(raw)) throw new TypeError("GhostCore: fields must be an array");
  return raw.filter((f): f is DesktopField => isObject(f) && typeof f.signature === "string" && typeof f.kind === "string");
}

function asProfile(json: string): Profile {
  const raw = parse<unknown>(json, "profile");
  const facts: Record<string, string> = {};
  if (isObject(raw) && isObject(raw.facts)) {
    for (const [key, value] of Object.entries(raw.facts)) if (typeof value === "string") facts[key] = value;
  }
  const pastAnswers = isObject(raw) && Array.isArray(raw.pastAnswers) ? (raw.pastAnswers as Profile["pastAnswers"]) : [];
  return { facts, pastAnswers };
}

function asSettings(json: string): GhostSettings {
  const raw = parse<unknown>(json, "settings");
  const merged: GhostSettings = { ...DEFAULT_SETTINGS, ...(isObject(raw) ? (raw as Partial<GhostSettings>) : {}) };
  const t = merged.confidenceThreshold;
  // A broken settings file must never open the gate: fall back to the shared default.
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) merged.confidenceThreshold = DEFAULT_SETTINGS.confidenceThreshold;
  return merged;
}

export function demoProfile(): string {
  return JSON.stringify(DEMO_PROFILE);
}

export function defaultSettings(): string {
  return JSON.stringify(DEFAULT_SETTINGS);
}

/**
 * FieldAssignment[] from the shared keyword heuristic (the offline path, zero network), plus the Desktop rules:
 * resume / cover-letter uploads map to resumePath / coverLetterPath, EEO / demographic questions to `none`.
 */
export function mapForm(fieldsJson: string, factKeysJson: string): string {
  const keys = parse<unknown>(factKeysJson, "factKeys");
  const factKeys = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
  return JSON.stringify(mapFormForDesktop(asFields(fieldsJson), factKeys));
}

/**
 * Answers the user gave before, read back from ~/Library/Application Support/Shabang/answers.json.
 * A file that is missing, empty, corrupt or not the right shape is simply an empty store: a broken file
 * must never stop Shabang from proposing anything. Nothing in here ever leaves the machine.
 */
function asAnswers(json: string | undefined | null): LearnedAnswerStore {
  if (typeof json !== "string" || json.trim() === "") return new LearnedAnswerStore();
  try {
    const raw = JSON.parse(json) as unknown;
    if (!isObject(raw)) return new LearnedAnswerStore();
    return LearnedAnswerStore.fromJSON(raw as unknown as LearnedAnswersSnapshot);
  } catch {
    return new LearnedAnswerStore();
  }
}

/**
 * The answer policy knobs, from settings.json. Protected questions are answered with the form's OWN
 * "prefer not to answer" option unless `answerProtectedWithDecline: false` turns that off, which is the
 * shared default (docs/answers.md section 1).
 */
function asAnswerSettings(settingsJson: string): AnswerSettings {
  const raw = parse<unknown>(settingsJson, "settings");
  const given = isObject(raw) ? raw.answerProtectedWithDecline : undefined;
  return { answerProtectedWithDecline: typeof given === "boolean" ? given : DEFAULT_SETTINGS.answerProtectedWithDecline };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asDeps(profileJson: string, settingsJson: string, optionsJson?: string): PredictDeps {
  const options = optionsJson ? parse<unknown>(optionsJson, "options") : {};
  const keepLock = isObject(options) && options.keepLock === true;
  const lockSignature = isObject(options) && typeof options.lockSignature === "string" ? options.lockSignature : undefined;
  const deps: PredictDeps = {
    profile: asProfile(profileJson),
    settings: asSettings(settingsJson),
    keepLock,
    lockSignature,
    answerSettings: asAnswerSettings(settingsJson),
  };
  if (isObject(options)) {
    if (typeof options.answers === "string") deps.answers = asAnswers(options.answers);
    else if (isObject(options.answers)) deps.answers = LearnedAnswerStore.fromJSON(options.answers as unknown as LearnedAnswersSnapshot);
    const accepted = stringList(options.accepted);
    if (accepted.length > 0) deps.accepted = accepted;
    if (typeof options.company === "string" && options.company.trim() !== "") deps.company = options.company.trim();
  }
  return deps;
}

function asSource(source: string): GhostSource {
  return (SOURCES.has(source) ? source : "offline") as GhostSource;
}

/**
 * Shabang[] in field order with the lock ghost last -- and no lock ghost at all while a required field before it
 * is still empty (docs/incremental.md). `optionsJson` is optional:
 * `{ keepLock?, lockSignature?, answers?, accepted?, company? }`. `answers` is the answers.json snapshot (a
 * string or the object itself), `accepted` the signatures the user has already taken in this walk.
 */
export function ghostsFor(
  fieldsJson: string,
  assignmentsJson: string,
  profileJson: string,
  settingsJson: string,
  source: string,
  optionsJson?: string,
): string {
  const assignments = cleanAssignmentList(parse<unknown>(assignmentsJson, "assignments"));
  return JSON.stringify(walkGhosts(asFields(fieldsJson), assignments, asDeps(profileJson, settingsJson, optionsJson), asSource(source)));
}

/**
 * Why a control got NO ghost, in field order: `[{ signature, reason }]`, where reason is one of "sensitive",
 * "already-answered", "no-candidate" or "paused" (docs/always-propose.md). Low confidence is never one of
 * them. For the native HUD and for anyone auditing that nothing was dropped quietly.
 */
export function walkSkips(
  fieldsJson: string,
  assignmentsJson: string,
  profileJson: string,
  settingsJson: string,
  source: string,
  optionsJson?: string,
): string {
  const assignments = cleanAssignmentList(parse<unknown>(assignmentsJson, "assignments"));
  const plan = planFields(asFields(fieldsJson), assignments, asDeps(profileJson, settingsJson, optionsJson), asSource(source));
  return JSON.stringify(plan.skips);
}

/**
 * The offline ghosts upgraded with a server (or cache) answer. An uncalibrated answer never replaces an
 * offline ghost that is more confident about another fact; fields the server skipped stay offline.
 */
export function upgradeGhosts(
  fieldsJson: string,
  servedJson: string,
  profileJson: string,
  settingsJson: string,
  source: string,
  optionsJson?: string,
): string {
  const served = cleanAssignmentList(parse<unknown>(servedJson, "served"));
  return JSON.stringify(upgrade(asFields(fieldsJson), served, asDeps(profileJson, settingsJson, optionsJson), asSource(source)));
}

export function isSensitiveProbe(probeJson: string): boolean {
  const probe = parse<unknown>(probeJson, "probe");
  // When in doubt, treat as sensitive.
  if (!isObject(probe)) return true;
  return isSensitive(probe as SensitiveProbe);
}

export function isLockedActionProbe(probeJson: string): boolean {
  const probe = parse<unknown>(probeJson, "probe");
  // When in doubt, lock.
  if (!isObject(probe) || typeof probe.text !== "string") return true;
  return isLockedAction(probe as unknown as LockProbe);
}

// ---------- /v1/shabang-text facts ----------
// Desktop-only client allowlist for `/v1/shabang-text`. The Chrome extension has no server/text client yet;
// when it gains one, move this policy into shared code instead of copying it again.
// Contact details, LinkedIn, work authorization and sponsorship never leave the machine for a draft.
const TEXT_FACT_KEYS: readonly string[] = [
  "fullName", "firstName", "lastName", "school", "degree", "major", "graduationDate", "location", "github", "website",
];
const TEXT_FACT_VALUE_MAX = 500;
const CONTACT_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+|(?:\+?\d[\s().-]?){9,}/;

export function textFacts(profileJson: string): string {
  const facts = asProfile(profileJson).facts;
  const out: Record<string, string> = {};
  for (const key of TEXT_FACT_KEYS) {
    const value = facts[key];
    if (typeof value !== "string" || !value.trim() || CONTACT_VALUE.test(value)) continue;
    out[key] = value.trim().slice(0, TEXT_FACT_VALUE_MAX);
  }
  return JSON.stringify(out);
}

// ---------- /v1/shabang-text past answers ----------
// The same filter as the extension's similarPastAnswers (extension/src/content/freeText.ts): only answers to
// questions that resemble this one, closest first, at most three, never a sensitive question and never an answer
// that carries an e-mail address or a phone number. Desktop also drops EEO / demographic questions and anything
// about work authorization, sponsorship or immigration: those facts are excluded from drafts on purpose.
const PAST_ANSWERS_MAX = 3;
const PAST_QUESTION_MAX = 300;
const PAST_ANSWER_MAX = 2000;
const PAST_MIN_SIMILARITY = 0.25;
const PAST_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "you", "your", "our", "for", "with", "that", "this", "are", "have", "does", "about", "from", "will", "would", "want",
]);
const WORK_STATUS = /\b(authori[sz]\w*|sponsor\w*|visas?|citizen\w*|work permit|immigration|right to work|residen(cy|t)|clearance)\b/i;

function pastTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(words.filter((word) => !PAST_STOPWORDS.has(word)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

export function textPastAnswers(profileJson: string, label: string): string {
  const wanted = pastTokens(typeof label === "string" ? label : "");
  const scored: Array<{ question: string; answer: string; score: number }> = [];
  for (const past of asProfile(profileJson).pastAnswers) {
    if (!isObject(past)) continue;
    const question = typeof past.question === "string" ? past.question.trim() : "";
    const answer = typeof past.answer === "string" ? past.answer.trim() : "";
    if (!question || !answer) continue;
    if (isSensitive({ label: question }) || CONTACT_VALUE.test(answer)) continue;
    if (isProtectedQuestion({ signature: "", kind: "textarea", label: question } as CapturedField) || WORK_STATUS.test(question)) continue;
    const score = jaccard(wanted, pastTokens(question));
    if (score >= PAST_MIN_SIMILARITY) scored.push({ question, answer, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return JSON.stringify(
    scored.slice(0, PAST_ANSWERS_MAX).map(({ question, answer }) => ({ question: question.slice(0, PAST_QUESTION_MAX), answer: answer.slice(0, PAST_ANSWER_MAX) })),
  );
}

// ---------- /v1/predict/form request (fact KEYS only, value-free fields) ----------
// Desktop-only request sanitization. The Chrome extension has no `/v1/predict/form` client yet; keep a
// future implementation aligned with these limits and preferably extract the policy into shared code.
const FORM_LIMITS = { fields: 100, factKeys: 64, options: 50, id: 300, label: 500, name: 200, hint: 100, placeholder: 300 } as const;
const FACT_KEY = /^[A-Za-z][\w.-]{0,63}$/;
const WIRE_KINDS: ReadonlySet<string> = new Set<FieldKind>([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox",
]);

function clip(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, max) || undefined : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= FORM_LIMITS.id ? value : undefined;
}

function wireOptions(raw: unknown): FieldOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, FORM_LIMITS.options).filter(isObject).map((option) => ({
    value: typeof option.value === "string" ? option.value.slice(0, FORM_LIMITS.name) : "",
    label: typeof option.label === "string" ? option.label.slice(0, FORM_LIMITS.name) : "",
  }));
}

/** A field as the server may see it: what it is, never what is in it, and never a sensitive one. */
function toWireField(raw: unknown): CapturedField | null {
  if (!isObject(raw) || typeof raw.kind !== "string" || !WIRE_KINDS.has(raw.kind)) return null;
  const signature = identifier(raw.signature);
  if (!signature) return null;
  const field: CapturedField = {
    signature,
    label: clip(raw.label, FORM_LIMITS.label) ?? "",
    kind: raw.kind as FieldKind,
    rect: { x: 0, y: 0, width: 0, height: 0 },
  };
  const hints = {
    inputType: clip(raw.inputType, 40),
    name: clip(raw.name, FORM_LIMITS.name),
    id: clip(raw.id, FORM_LIMITS.name),
    autocomplete: clip(raw.autocomplete, FORM_LIMITS.hint),
    placeholder: clip(raw.placeholder, FORM_LIMITS.placeholder),
    context: clip(raw.context, FORM_LIMITS.label),
  };
  if (isSensitive({ ...hints, label: field.label })) return null;
  for (const [key, value] of Object.entries(hints)) if (value !== undefined) (field as unknown as Record<string, unknown>)[key] = value;
  const options = wireOptions(raw.options);
  if (options) field.options = options;
  if (typeof raw.required === "boolean") field.required = raw.required;
  return field;
}

/**
 * The JSON body for POST /v1/predict/form, or "null" when there is nothing worth asking. EEO / demographic
 * questions are not asked about at all (Shabang never answers them), and file-path facts are local only.
 */
export function formRequest(fieldsJson: string, factKeysJson: string, origin: string, formSignature: string): string {
  const rawFields = parse<unknown>(fieldsJson, "fields");
  const rawKeys = parse<unknown>(factKeysJson, "factKeys");
  const fields = (Array.isArray(rawFields) ? rawFields : [])
    .map(toWireField)
    .filter((f): f is CapturedField => f !== null && !isProtectedQuestion(f));
  // Demographic facts (gender, veteranStatus, dateOfBirth...) are never offered to the server as possible answers.
  const keys = (Array.isArray(rawKeys) ? rawKeys : []).filter(
    (k): k is string => typeof k === "string" && FACT_KEY.test(k) && !isFileFact(k) && !isProtectedFactKey(k),
  );
  const factKeys = [...new Set(keys)].slice(0, FORM_LIMITS.factKeys);
  const cleanOrigin = identifier(origin);
  const cleanSignature = identifier(formSignature);
  if (!cleanOrigin || !cleanSignature || fields.length === 0 || factKeys.length === 0) return "null";
  return JSON.stringify({ origin: cleanOrigin, formSignature: cleanSignature, fields: fields.slice(0, FORM_LIMITS.fields), factKeys });
}

function cleanAssignmentList(raw: unknown): ServedAssignment[] {
  if (!Array.isArray(raw)) return [];
  const out: ServedAssignment[] = [];
  for (const item of raw.slice(0, FORM_LIMITS.fields)) {
    if (!isObject(item) || typeof item.confidence !== "number" || !Number.isFinite(item.confidence)) continue;
    const signature = identifier(item.signature);
    if (!signature || typeof item.factKey !== "string" || !FACT_KEY.test(item.factKey)) continue;
    const assignment: ServedAssignment = { signature, factKey: item.factKey, confidence: Math.min(1, Math.max(0, item.confidence)) };
    if (typeof item.source === "string") assignment.source = item.source.slice(0, 40);
    if (typeof item.calibrated === "boolean") assignment.calibrated = item.calibrated;
    out.push(assignment);
  }
  return out;
}

/** Keeps what is well formed of a server reply (or of something read back from the on-disk cache). */
export function cleanAssignments(assignmentsJson: string): string {
  return JSON.stringify(cleanAssignmentList(parse<unknown>(assignmentsJson, "assignments")));
}

/** True for "Select an option" style entries. The native controller uses it for its pre-write check. */
export function isPlaceholder(value: string, label: string): boolean {
  return isPlaceholderChoice(String(value ?? ""), String(label ?? ""));
}

// ---------- the answer engine (docs/answers.md) and the gate (docs/incremental.md) ----------

const MAX_CORRECTION_CHARS = 4000;

/** One captured field as a question. Anything malformed is a question with no label, which is never learned. */
function asQuestion(json: string): QuestionField {
  const raw = parse<unknown>(json, "field");
  const object = isObject(raw) ? raw : {};
  const field: QuestionField = {
    label: typeof object.label === "string" ? object.label : "",
    kind: (typeof object.kind === "string" ? object.kind : "text") as FieldKind,
  };
  for (const key of ["context", "name", "id", "placeholder", "autocomplete", "inputType"] as const) {
    const value = object[key];
    if (typeof value === "string" && value !== "") field[key] = value;
  }
  const options = wireOptions(object.options);
  if (options && options.length > 0) field.options = options;
  return field;
}

/**
 * What Shabang proposes for every field, in field order: `{ signature, value, optionLabel?, confidence, source,
 * class, reason, needsReview, signature: questionKey }`. Exposed for the options page, the harness and tests;
 * the walk itself gets the same answers through `ghostsFor` / `upgradeGhosts`.
 * `answersJson` is the answers.json snapshot; a missing or corrupt one is simply no learned answers.
 */
export function proposeAnswers(fieldsJson: string, profileJson: string, answersJson: string, settingsJson: string): string {
  const deps: PredictDeps = {
    profile: asProfile(profileJson),
    settings: asSettings(settingsJson),
    answers: asAnswers(answersJson),
    answerSettings: asAnswerSettings(settingsJson),
  };
  const out = asFields(fieldsJson).map((field) => {
    const proposal = proposeForField(field, deps);
    return { ...proposal, signature: field.signature, questionKey: proposal.signature };
  });
  return JSON.stringify(out);
}

/**
 * The user answered a question themselves (or changed what Shabang filled): keep it, keyed by the question
 * rather than by the site. Returns `{ answers, counter, changed, refusal? }`, where `answers` is the new
 * snapshot to write back to answers.json and `counter` is the value-free telemetry counter name.
 * Nothing here ever leaves the machine, and a value that looks like a secret is refused.
 */
export function recordCorrection(fieldJson: string, value: string, answersJson: string, nowIso?: string): string {
  const store = asAnswers(answersJson);
  const field = asQuestion(fieldJson);
  const text = typeof value === "string" ? value.slice(0, MAX_CORRECTION_CHARS) : "";
  const parsedNow = typeof nowIso === "string" && nowIso !== "" ? Date.parse(nowIso) : NaN;
  const options: CorrectionOptions = Number.isFinite(parsedNow) ? { now: parsedNow } : {};
  const result = recordAnswerCorrection(field, text, store, options);
  const out: Record<string, unknown> = {
    answers: store.toJSON(),
    counter: answerCounterName(result.event),
    changed: result.changed,
    class: classifyQuestion(field).class,
  };
  if (result.refusal) out.refusal = result.refusal;
  if (result.learned) out.questionKey = result.learned.signature;
  return JSON.stringify(out);
}

/**
 * The walk gate for a captured page: `{ unmetRequired, terminalAllowed, reason?, firstUnmetLabel?,
 * blockedTerminals, allowedTerminals }`. The HUD shows `reason` and `firstUnmetLabel` when the Submit ghost
 * is withheld. `optionsJson` may carry `accepted`: signatures the user has already taken in this walk.
 */
export function gateFor(fieldsJson: string, ghostsJson: string, optionsJson?: string): string {
  const rawGhosts = parse<unknown>(ghostsJson, "ghosts");
  const ghosts = (Array.isArray(rawGhosts) ? rawGhosts : []).filter(isObject) as unknown as DesktopGhost[];
  const options = optionsJson ? parse<unknown>(optionsJson, "options") : {};
  const accepted = isObject(options) ? stringList(options.accepted) : [];
  return JSON.stringify(gateForFields(asFields(fieldsJson), ghosts, accepted));
}

// The names docs/desktop.md promises. `isSensitive` and `isLockedAction` take a JSON probe.
export { isSensitiveProbe as isSensitive, isLockedActionProbe as isLockedAction };

// ---------- Shabang anywhere (docs/anywhere.md) ----------
// The next-action pass for a window that is not a form: affordances, the kind of place, priors and role memory.
// Everything it needs comes from the capture the native side already makes; nothing here names an app or a site.
export { nextAction, recordRoleOutcome, emptyRoleMemory, lockedForCandidate } from "./anywhere";

// ---------- the knowledge layer (docs/knowledge.md) ----------
// One model of one person, on any surface: the SAME `rankActions` the browser ranker calls and the same one the
// benchmark in docs/knowledge.md section 6 scores. Strings in, strings out; the file itself belongs to the native
// side, which reads it, passes the text in, and writes back what comes out.
export { rankWindow, recordWindowOutcome, forgetKnowledgeSurface } from "./knowledge";

// ---------- cold start (docs/cold-start.md) ----------
// The one-time local pass that turns what is already on the machine into facts and habit priors. The rules are
// pure (shared/src/coldstart); every file, database and permission belongs to the native side, which hands the
// text in here. Nothing scanned ever leaves the machine.
export {
  coldStartPlan,
  coldStartPlanSummary,
  coldStartClassify,
  coldStartVCard,
  coldStartResumeText,
  coldStartGitRemote,
  coldStartPackageAuthor,
  coldStartMerge,
  coldStartHabits,
  coldStartSurfaces,
  coldStartGraphApply,
  coldStartGraphDescribe,
  coldStartGraphForget,
  coldStartGraphEmpty,
} from "./coldstart";
