import { isSensitive, normalizeUrl, type FactLocator, type FactsByUrl, type LoopCandidate, type TraceEvent, type UnresolvedStep } from "@shabang/shared";
import { looksSecret } from "./secrets";
import { TRANSFORM_ORDER, reproduces, type LoopTransform } from "./transforms";

/** One locator that showed different text for run A's item and run B's item. What the model sees is exactly what gets verified. */
export interface FactCandidate {
  pathPattern: string;
  locator: FactLocator;
  label: string;
  textA: string;
  textB: string;
}

/** Steps that saw the same pages share one candidate list, so the prompt carries each list once. */
export interface CandidateSet {
  id: string;
  candidates: FactCandidate[];
}

export interface OpenStep {
  /** Name of the step in the prompt and in the model's answer: s0, s1, ... */
  key: string;
  step: UnresolvedStep;
  setId: string;
}

export interface OpenQuestion {
  sets: CandidateSet[];
  steps: OpenStep[];
}

export interface Mapping {
  pathPattern: string;
  locator: FactLocator;
  transform?: LoopTransform;
}

const MAX_STEPS = 20;
const MAX_CANDIDATES_PER_SET = 40;

function listMoved(a: TraceEvent, b: TraceEvent): boolean {
  const la = a.target?.list;
  const lb = b.target?.list;
  return a.type === "click" && la !== undefined && lb !== undefined && la.listSignature === lb.listSignature && la.index !== lb.index;
}

/** Most recent first, like the shared heuristic's evidence. */
function urlsOf(events: TraceEvent[]): string[] {
  const urls: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const url = events[i]?.url;
    if (url !== undefined && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Pages the user had seen for the item each typed value belongs to. Steps before the item click belong to the item
 * opened in the PREVIOUS run, so run B's value is explained by run A's later pages, and run A's only by what run A itself
 * shows before the step. Unlike the heuristic, a model-picked mapping always needs BOTH values explained.
 */
function evidenceUrls(c: LoopCandidate, iteratorAt: number, position: number): { urlsA: string[]; urlsB: string[] } {
  if (position >= iteratorAt) {
    return { urlsA: urlsOf(c.runA.slice(iteratorAt, position + 1)), urlsB: urlsOf(c.runB.slice(iteratorAt, position + 1)) };
  }
  return { urlsA: urlsOf(c.runA.slice(0, position + 1)), urlsB: urlsOf([...c.runA.slice(iteratorAt), ...c.runB.slice(0, position + 1)]) };
}

function sameLocator(x: FactLocator, y: FactLocator): boolean {
  return x.by === y.by && x.value === y.value;
}

function buildCandidates(facts: FactsByUrl, patternOf: (url: string) => string | undefined, urlsA: string[], urlsB: string[]): FactCandidate[] {
  const out: FactCandidate[] = [];
  for (const urlA of urlsA) {
    const pathPattern = patternOf(urlA);
    if (pathPattern === undefined) continue;
    for (const factA of facts[urlA] ?? []) {
      if (out.some((c) => c.pathPattern === pathPattern && sameLocator(c.locator, factA.locator))) continue;
      const pageB = urlsB.find((u) => u !== urlA && patternOf(u) === pathPattern && (facts[u] ?? []).some((f) => sameLocator(f.locator, factA.locator)));
      const factB = pageB === undefined ? undefined : (facts[pageB] ?? []).find((f) => sameLocator(f.locator, factA.locator));
      // Text that is the same for both items cannot explain two different typed values.
      if (!factB || factB.text === factA.text) continue;
      // Every candidate is prompt material (and part of the cache key): ID- or card-shaped page text is dropped here, whatever its label says.
      if (looksSecret(factA.text) || looksSecret(factB.text)) continue;
      out.push({ pathPattern, locator: factA.locator, label: factA.label || factB.label, textA: factA.text, textB: factB.text });
    }
  }
  return out;
}

/** The weakest transform under which this candidate reproduces BOTH typed values, trying the model's suggestion right after "copy as is". */
export function verifyCandidate(candidate: FactCandidate, step: UnresolvedStep, suggested?: LoopTransform): Mapping | null {
  const order = suggested === undefined ? TRANSFORM_ORDER : [undefined, suggested, ...TRANSFORM_ORDER];
  for (const transform of order) {
    if (!reproduces(step.valueA, candidate.textA, transform) || !reproduces(step.valueB, candidate.textB, transform)) continue;
    const mapping: Mapping = { pathPattern: candidate.pathPattern, locator: candidate.locator };
    if (transform !== undefined) mapping.transform = transform;
    return mapping;
  }
  return null;
}

function mayAsk(step: UnresolvedStep): boolean {
  if (isSensitive({ label: step.label })) return false;
  // SSN, SIN and card-number shapes: such a typed value never reaches a prompt, whatever its field is called.
  return !looksSecret(step.valueA) && !looksSecret(step.valueB);
}

function isFill(e: TraceEvent | undefined): boolean {
  return e !== undefined && e.target !== undefined && (e.type === "input" || e.type === "select" || e.type === "check");
}

/** Run positions of the unresolved fills, matched in order by their two typed values. */
function positionsOf(c: LoopCandidate, unresolved: UnresolvedStep[], iteratorAt: number): Map<UnresolvedStep, number> {
  const order = [...c.runA.keys()].slice(iteratorAt).concat([...c.runA.keys()].slice(0, iteratorAt));
  const used = new Set<number>();
  const out = new Map<UnresolvedStep, number>();
  for (const step of unresolved) {
    const at = order.find((i) => !used.has(i) && isFill(c.runA[i]) && (c.runA[i]?.value ?? "") === step.valueA && (c.runB[i]?.value ?? "") === step.valueB);
    if (at === undefined) continue;
    used.add(at);
    out.set(step, at);
  }
  return out;
}

/** Keeps every candidate code could verify for some step, then fills up with the rest, all in page order. */
function capCandidates(all: FactCandidate[], steps: UnresolvedStep[]): FactCandidate[] {
  if (all.length <= MAX_CANDIDATES_PER_SET) return all;
  const keep = new Set(all.filter((c) => steps.some((s) => verifyCandidate(c, s) !== null)));
  for (const c of all) if (keep.size < MAX_CANDIDATES_PER_SET) keep.add(c);
  return all.filter((c) => keep.has(c));
}

/**
 * What the model may be asked: only steps for which code already found at least one candidate that verifies
 * (nothing the model says about the others could survive verification, so they never cost a call).
 */
export function buildOpenQuestion(candidate: LoopCandidate, facts: FactsByUrl, unresolved: UnresolvedStep[]): OpenQuestion {
  const iteratorAt = candidate.runA.findIndex((a, i) => {
    const b = candidate.runB[i];
    return b !== undefined && listMoved(a, b);
  });
  if (iteratorAt < 0) return { sets: [], steps: [] };
  const patterns = new Map<string, string>();
  for (const e of [...candidate.runA, ...candidate.runB]) patterns.set(e.url, e.pathPattern);
  const patternOf = (url: string): string | undefined => patterns.get(url) ?? normalizeUrl(url)?.pathPattern;
  const positions = positionsOf(candidate, unresolved, iteratorAt);

  const grouped = new Map<string, { all: FactCandidate[]; steps: UnresolvedStep[] }>();
  for (const step of unresolved) {
    const position = positions.get(step);
    if (position === undefined || !mayAsk(step)) continue;
    const { urlsA, urlsB } = evidenceUrls(candidate, iteratorAt, position);
    const groupKey = `${urlsA.join(" ")}|${urlsB.join(" ")}`;
    const group = grouped.get(groupKey) ?? { all: buildCandidates(facts, patternOf, urlsA, urlsB), steps: [] };
    grouped.set(groupKey, group);
    if (group.all.some((c) => verifyCandidate(c, step) !== null)) group.steps.push(step);
  }

  const question: OpenQuestion = { sets: [], steps: [] };
  for (const group of grouped.values()) {
    if (group.steps.length === 0) continue;
    const set: CandidateSet = { id: `g${question.sets.length}`, candidates: capCandidates(group.all, group.steps) };
    question.sets.push(set);
    for (const step of group.steps) {
      if (question.steps.length < MAX_STEPS) question.steps.push({ key: `s${question.steps.length}`, step, setId: set.id });
    }
  }
  return question;
}
