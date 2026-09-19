import { NONE, isSensitive, normalize, rankNextCandidates, type Answers, type ChoiceQuestion, type Questions } from "@ghost/shared";

/** One normalized user action. The server never forwards typed values, only what was acted on. */
export interface TraceEvent {
  type: string;
  label?: string;
  kind?: string;
  signature?: string;
  url?: string;
}

/** Episodic memory: in a situation like `summary`, right after `previousAction`, the user did `action`. */
export interface EpisodicPair {
  summary?: string;
  previousAction?: TraceEvent;
  action: TraceEvent;
}

export interface NextCandidate {
  id: string;
  kind: "button" | "link" | "field";
  label: string;
  locked: boolean;
  context?: string;
  group?: string;
}

export interface NextPredictRequest {
  origin: string;
  url: string;
  recentActions: TraceEvent[];
  candidates: NextCandidate[];
  memory?: EpisodicPair[];
}

export interface NextPick {
  candidateId: string;
  confidence: number;
}

/** What the model sees: candidates are aliased to short option names (c0, c1...) and opaque signatures are dropped. */
// A type alias, not an interface: only aliases are assignable to DecisionState's Record<string, unknown>.
export type NextState = {
  page: { origin: string; url: string };
  recentActions: TraceEvent[];
  candidates: NextCandidate[];
  memory: EpisodicPair[];
};

export interface NextDecision {
  state: NextState;
  questions: Questions;
  /** Option name -> the client's candidate id. */
  aliases: Record<string, string>;
}

export const NEXT_QUESTION = "next";
const MEMORY_MATCH_CONFIDENCE = 0.8;
export const BEST_EFFORT_CONFIDENCE = 0.25;

function withoutSignature(event: TraceEvent): TraceEvent {
  const { signature: _signature, ...rest } = event;
  return rest;
}

function memoryForState(pair: EpisodicPair): EpisodicPair {
  return {
    ...(pair.summary ? { summary: pair.summary } : {}),
    ...(pair.previousAction ? { previousAction: withoutSignature(pair.previousAction) } : {}),
    action: withoutSignature(pair.action),
  };
}

function sensitiveEvent(event: TraceEvent | undefined): boolean {
  return event !== undefined && isSensitive({ label: event.label });
}

/**
 * Rule 3 as defense in depth, mirroring isModelCandidate on the form route: a password or card control is never
 * predicted, and neither its label nor any action on it reaches the heuristic or a third-party model.
 */
export function withoutSensitive(req: NextPredictRequest): NextPredictRequest {
  return {
    ...req,
    candidates: req.candidates.filter((c) => !isSensitive({ label: c.label, placeholder: c.kind === "field" ? c.context : undefined })),
    recentActions: req.recentActions.filter((e) => !sensitiveEvent(e)),
    memory: (req.memory ?? []).filter((m) => !sensitiveEvent(m.action) && !sensitiveEvent(m.previousAction)),
  };
}

export function buildNextDecision(req: NextPredictRequest): NextDecision {
  const criteria: ChoiceQuestion["criteria"] = {};
  const aliases: Record<string, string> = {};
  const candidates = req.candidates.map((c, i) => {
    const alias = `c${i}`;
    aliases[alias] = c.id;
    criteria[alias] = `${c.kind}: ${c.label}`;
    // `group` is an opaque structural locator used only by code; like signatures, it never enters a model state.
    const { group: _group, ...visible } = c;
    return { ...visible, id: alias };
  });
  const state: NextState = {
    page: { origin: req.origin, url: req.url },
    recentActions: req.recentActions.map(withoutSignature),
    candidates,
    memory: (req.memory ?? []).map(memoryForState),
  };
  const instructions =
    "Which element in `candidates` (options are candidate `id`s) is the single most likely element the user will act on next, given `recentActions` (oldest first) and similar past situations in `memory`? Always choose the best candidate even when uncertain.";
  return { state, questions: { [NEXT_QUESTION]: { type: "choice", instructions, criteria } }, aliases };
}

function sameAction(a: TraceEvent | undefined, b: TraceEvent | undefined): boolean {
  if (!a || !b || a.type !== b.type) return false;
  if (a.signature && b.signature) return a.signature === b.signature;
  const label = normalize(a.label);
  return label !== "" && label === normalize(b.label);
}

function candidateFor(action: TraceEvent, candidates: NextCandidate[]): NextCandidate | undefined {
  const label = normalize(action.label);
  return candidates.find((c) => c.id === action.signature) ?? (label ? candidates.find((c) => normalize(c.label) === label) : undefined);
}

/** Heuristic memory lookup: the candidate that followed the same previous action, else none. */
export function pickNextFromMemory(state: Pick<NextPredictRequest, "recentActions" | "candidates" | "memory">): NextPick {
  const last = state.recentActions[state.recentActions.length - 1];
  for (const pair of state.memory ?? []) {
    if (!sameAction(pair.previousAction, last)) continue;
    const candidate = candidateFor(pair.action, state.candidates);
    if (candidate) return { candidateId: candidate.id, confidence: MEMORY_MATCH_CONFIDENCE };
  }
  return { candidateId: NONE, confidence: 0.6 };
}

/** A universal, deliberately low-confidence guess when this state has not been learned yet. */
export function pickBestEffort(state: Pick<NextPredictRequest, "recentActions" | "candidates" | "memory">): NextPick {
  const learned = pickNextFromMemory(state);
  if (learned.candidateId !== NONE) return learned;
  // Locked means explicit confirmation, not low likelihood: checkout/submit may be the correct next target.
  const previous = [...state.recentActions].reverse().find((action) => action.label || action.signature);
  const candidate = rankNextCandidates(state.candidates, previous)[0];
  return candidate
    ? { candidateId: candidate.id, confidence: BEST_EFFORT_CONFIDENCE }
    : { candidateId: NONE, confidence: 0.99 };
}

export function readNextAnswer(answers: Answers, aliases: Record<string, string>): NextPick | undefined {
  const answer = answers[NEXT_QUESTION];
  if (answer?.type !== "choice" || !Number.isFinite(answer.confidence)) return undefined;
  const candidateId = answer.choice === NONE ? NONE : Object.hasOwn(aliases, answer.choice) ? aliases[answer.choice] : undefined;
  return candidateId === undefined ? undefined : { candidateId, confidence: Math.min(1, Math.max(0, answer.confidence)) };
}
