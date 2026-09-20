import { NONE, type Answers, type ChoiceQuestion, type DecisionProvider, type DecisionState, type FactSourceKind, type Questions } from "@ghost/shared";
import { withDeadline } from "../providers/timeout";
import { sourceWords, type ScanProposal } from "./propose";

/**
 * The last step of the pipeline (docs/profile-sources.md section 3): a Jev choice question for GENUINE
 * conflicts only — "which of these three is the user's current employer?" — and nothing else. Two sources
 * that agree are not a conflict, and a key only one source answered is never asked about.
 *
 * All conflicts go in ONE call: Jev answers every question in parallel, so a second conflict costs almost
 * nothing, while a call per conflict would cost a round trip each. Code always has a fallback answer, so a
 * missing, slow or unusable model never loses a proposal.
 */

const CONFLICT_QUESTION = /^conflict\d+$/;
const CHOICE_INDEX = /^c(\d+)$/;
export const CONFLICT_TIMEOUT_MS = 4_000;
/** Enough for "which of these is the employer": more candidates than this means the sources disagree hopelessly. */
const MAX_CANDIDATES = 6;
const MAX_CONFLICTS = 8;
const MAX_VALUE_CHARS = 120;

/** Mirrors the trust order in `shared/src/facts/graph.ts`, which decides the same question inside the graph. */
const SOURCE_TRUST: Record<FactSourceKind, number> = { user: 100, file: 70, github: 65, website: 60, mail: 55, calendar: 50, drive: 45, observed: 40 };

export interface FactConflict {
  key: string;
  label: string;
  candidates: ScanProposal[];
}

export interface ConflictReport {
  key: string;
  candidates: number;
  resolvedBy: "model" | "code";
  /** The model's confidence in its pick; 0 when code resolved it. Uncalibrated unless the provider says otherwise. */
  confidence: number;
}

export interface Resolution {
  proposals: ScanProposal[];
  conflicts: ConflictReport[];
  /** The provider that answered, or "code" when nothing was asked. */
  provider: string;
  latencyMs: number;
  calls: number;
}

function loose(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@]+/g, "");
}

/** Higher first: the most confident proposal, then the most trusted source, then the order it arrived in. */
function strongest(a: ScanProposal, b: ScanProposal): number {
  return b.confidence - a.confidence || SOURCE_TRUST[b.source.kind] - SOURCE_TRUST[a.source.kind];
}

/**
 * Groups proposals by key. Sources that agree collapse to the strongest one; sources that disagree become
 * a conflict, in the order the keys first appeared.
 */
export function findConflicts(proposals: readonly ScanProposal[]): { settled: ScanProposal[]; conflicts: FactConflict[] } {
  const groups = new Map<string, ScanProposal[]>();
  for (const proposal of proposals) {
    const group = groups.get(proposal.key);
    if (group) group.push(proposal);
    else groups.set(proposal.key, [proposal]);
  }
  const settled: ScanProposal[] = [];
  const conflicts: FactConflict[] = [];
  for (const [key, group] of groups) {
    const distinct: ScanProposal[] = [];
    for (const proposal of [...group].sort(strongest)) {
      if (!distinct.some((kept) => loose(kept.value) === loose(proposal.value))) distinct.push(proposal);
    }
    const best = distinct[0];
    if (!best) continue;
    if (distinct.length === 1) {
      settled.push(best);
      continue;
    }
    conflicts.push({ key, label: best.label, candidates: distinct.slice(0, MAX_CANDIDATES) });
  }
  return { settled, conflicts };
}

function clip(text: string): string {
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/** One choice question per conflict, `c0..cN` plus `none`, exactly as every other Jev question in this repo. */
export function buildConflictDecision(conflicts: readonly FactConflict[]): { state: DecisionState; questions: Questions } {
  const asked = conflicts.slice(0, MAX_CONFLICTS);
  const state = {
    conflicts: asked.map((conflict) => ({
      key: conflict.key,
      question: conflict.label,
      candidates: conflict.candidates.map((candidate, index) => ({
        option: `c${index}`,
        value: clip(candidate.value),
        from: sourceWords(candidate.source),
        ...(candidate.evidence ? { evidence: clip(candidate.evidence) } : {}),
      })),
    })),
  };
  const questions: Questions = {};
  asked.forEach((conflict, index) => {
    const criteria: Record<string, string | null> = {};
    conflict.candidates.forEach((candidate, option) => {
      criteria[`c${option}`] = `${clip(candidate.value)} — found in ${sourceWords(candidate.source)}`;
    });
    criteria[NONE] = `none of these is the user's ${conflict.label}`;
    const question: ChoiceQuestion = {
      type: "choice",
      instructions: `The user's sources disagree about their ${conflict.label}. Which candidate in \`conflicts[${index}].candidates\` is the user's current ${conflict.label}? Prefer the most specific, most recent one that is really about the user. Answer ${NONE} if none of them is.`,
      criteria,
    };
    questions[`conflict${index}`] = question;
  });
  return { state, questions };
}

/**
 * Resolves every conflict. With a usable provider that is ONE call for all of them; without one (or when
 * it fails, times out or answers `none`) code picks the strongest candidate, which is what the graph would
 * have done anyway. The losing candidates are dropped: the review list shows one proposal per key.
 */
export async function resolveConflicts(
  proposals: readonly ScanProposal[],
  provider: DecisionProvider | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<Resolution> {
  const { settled, conflicts } = findConflicts(proposals);
  const order = [...new Set(proposals.map((proposal) => proposal.key))];
  const byKey = new Map<string, ScanProposal>(settled.map((proposal) => [proposal.key, proposal]));
  const reports: ConflictReport[] = [];
  let answered: Record<string, { option: string; confidence: number }> = {};
  let name = "code";
  let latencyMs = 0;
  let calls = 0;

  if (conflicts.length > 0 && provider && provider.name !== "heuristic") {
    const { state, questions } = buildConflictDecision(conflicts);
    const started = performance.now();
    try {
      const result = await withDeadline(opts.timeoutMs ?? CONFLICT_TIMEOUT_MS, () => provider.decide(state, questions));
      calls = 1;
      name = result.provider;
      latencyMs = result.latencyMs || Math.round(performance.now() - started);
      answered = readAnswers(result.answers);
    } catch {
      calls = 1;
      name = provider.name;
      latencyMs = Math.round(performance.now() - started);
    }
  }

  conflicts.forEach((conflict, index) => {
    const answer = answered[`conflict${index}`];
    const picked = answer ? conflict.candidates[Number(CHOICE_INDEX.exec(answer.option)?.[1] ?? -1)] : undefined;
    const winner = picked ?? conflict.candidates[0];
    if (!winner) return;
    byKey.set(conflict.key, winner);
    reports.push({ key: conflict.key, candidates: conflict.candidates.length, resolvedBy: picked ? "model" : "code", confidence: picked ? answer?.confidence ?? 0 : 0 });
  });

  const out = order.flatMap((key) => {
    const proposal = byKey.get(key);
    return proposal ? [proposal] : [];
  });
  return { proposals: out, conflicts: reports, provider: name, latencyMs, calls };
}

/** Only a choice answer to a `conflict<i>` question counts, and only when it named an option rather than `none`. */
function readAnswers(answers: Answers): Record<string, { option: string; confidence: number }> {
  const out: Record<string, { option: string; confidence: number }> = {};
  for (const [key, answer] of Object.entries(answers)) {
    if (!CONFLICT_QUESTION.test(key) || answer.type !== "choice" || !CHOICE_INDEX.test(answer.choice)) continue;
    out[key] = { option: answer.choice, confidence: Number.isFinite(answer.confidence) ? answer.confidence : 0 };
  }
  return out;
}
