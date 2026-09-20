// Deterministic, synthetic replays for the part production telemetry cannot contain: question wording and
// answer values. A human maps a redacted Sentry failure to one of these reviewed fixtures; CI then runs the
// real answer policy and local store across site variants. No model, network or browser is involved.
import { proposeAnswer, recordCorrection } from "./answers/propose";
import { LearnedAnswerStore } from "./answers/store";
import type { QuestionField } from "./answers/classify";
import type { FieldKind, FieldOption, Profile } from "./types";

export const GHOST_LEARNING_REPLAY_SCHEMA = "ghost.learning-replay.v1" as const;

export interface LearningReplayField {
  label: string;
  kind: FieldKind;
  options?: FieldOption[];
  context?: string;
}

export interface GhostLearningReplayFixture {
  schemaVersion: typeof GHOST_LEARNING_REPLAY_SCHEMA;
  caseId: string;
  profile: Profile;
  correction: { surface: string; field: LearningReplayField; value: string; optionLabel?: string };
  targets: Array<{
    surface: string;
    field: LearningReplayField;
    expected: { source: "learned"; optionLabel?: string; value?: string; needsReview: false };
  }>;
}

export interface GhostLearningReplayEvaluation {
  passed: boolean;
  failures: string[];
  elapsedMs: number;
}

const CASE_ID = /^[a-z0-9][a-z0-9._-]{2,79}$/;
const KINDS = new Set<FieldKind>([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox",
  "file", "button", "link", "other",
]);

export function evaluateGhostLearningReplay(fixture: GhostLearningReplayFixture): GhostLearningReplayEvaluation {
  const started = performance.now();
  const failures: string[] = [];
  const store = new LearnedAnswerStore();
  const first = proposeAnswer(fixture.correction.field as QuestionField, { profile: fixture.profile });
  const learned = recordCorrection(fixture.correction.field as QuestionField, fixture.correction.value, store, {
    optionLabel: fixture.correction.optionLabel,
    origin: `https://${fixture.correction.surface}.example`,
    previous: first,
    now: 0,
  });
  if (!learned.learned) failures.push("correction:not-learned");
  fixture.targets.forEach((target, index) => {
    const proposal = proposeAnswer(target.field as QuestionField, { profile: fixture.profile, answers: store });
    if (proposal.source !== target.expected.source) failures.push(`target:${index}:source:${proposal.source}`);
    if (target.expected.optionLabel !== undefined && proposal.optionLabel !== target.expected.optionLabel) {
      failures.push(`target:${index}:option:${proposal.optionLabel ?? "none"}`);
    }
    if (target.expected.value !== undefined && proposal.value !== target.expected.value) failures.push(`target:${index}:value`);
    if (proposal.needsReview !== target.expected.needsReview) failures.push(`target:${index}:review:${proposal.needsReview}`);
  });
  return { passed: failures.length === 0, failures, elapsedMs: performance.now() - started };
}

/** Checked-in fixtures are data too: rebuild only the bounded fields the evaluator understands. */
export function sanitizeGhostLearningReplayFixture(raw: unknown): GhostLearningReplayFixture | null {
  if (!record(raw) || raw.schemaVersion !== GHOST_LEARNING_REPLAY_SCHEMA || typeof raw.caseId !== "string" || !CASE_ID.test(raw.caseId)) return null;
  const profile = cleanProfile(raw.profile);
  const correction = cleanCorrection(raw.correction);
  if (!profile || !correction || !Array.isArray(raw.targets) || raw.targets.length === 0 || raw.targets.length > 20) return null;
  const targets = raw.targets.map(cleanTarget);
  if (targets.some((target) => target === null)) return null;
  return { schemaVersion: GHOST_LEARNING_REPLAY_SCHEMA, caseId: raw.caseId, profile, correction, targets: targets as GhostLearningReplayFixture["targets"] };
}

function cleanProfile(raw: unknown): Profile | null {
  if (!record(raw) || !record(raw.facts)) return null;
  const facts: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.facts).slice(0, 100)) {
    if (key.length <= 80 && typeof value === "string" && value.length <= 500) facts[key] = value;
  }
  return { facts, pastAnswers: [] };
}

function cleanCorrection(raw: unknown): GhostLearningReplayFixture["correction"] | null {
  if (!record(raw) || typeof raw.surface !== "string" || typeof raw.value !== "string") return null;
  const field = cleanField(raw.field);
  if (!field || raw.surface.length > 80 || raw.value.length > 2_000) return null;
  const correction: GhostLearningReplayFixture["correction"] = { surface: raw.surface, field, value: raw.value };
  if (typeof raw.optionLabel === "string" && raw.optionLabel.length <= 500) correction.optionLabel = raw.optionLabel;
  return correction;
}

function cleanTarget(raw: unknown): GhostLearningReplayFixture["targets"][number] | null {
  if (!record(raw) || typeof raw.surface !== "string" || !record(raw.expected)) return null;
  const field = cleanField(raw.field);
  if (!field || raw.surface.length > 80 || raw.expected.source !== "learned" || raw.expected.needsReview !== false) return null;
  const expected: GhostLearningReplayFixture["targets"][number]["expected"] = { source: "learned", needsReview: false };
  if (raw.expected.optionLabel !== undefined) {
    if (typeof raw.expected.optionLabel !== "string" || raw.expected.optionLabel.length > 500) return null;
    expected.optionLabel = raw.expected.optionLabel;
  }
  if (raw.expected.value !== undefined) {
    if (typeof raw.expected.value !== "string" || raw.expected.value.length > 2_000) return null;
    expected.value = raw.expected.value;
  }
  return { surface: raw.surface, field, expected };
}

function cleanField(raw: unknown): LearningReplayField | null {
  if (!record(raw) || typeof raw.label !== "string" || raw.label.length < 3 || raw.label.length > 500) return null;
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind as FieldKind)) return null;
  const field: LearningReplayField = { label: raw.label, kind: raw.kind as FieldKind };
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options) || raw.options.length > 50) return null;
    const options: FieldOption[] = [];
    for (const option of raw.options) {
      if (!record(option) || typeof option.value !== "string" || typeof option.label !== "string") return null;
      if (option.value.length > 500 || option.label.length > 500) return null;
      options.push({ value: option.value, label: option.label });
    }
    field.options = options;
  }
  if (typeof raw.context === "string" && raw.context.length <= 500) field.context = raw.context;
  return field;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
