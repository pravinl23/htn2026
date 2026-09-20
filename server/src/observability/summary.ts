/**
 * Turns a route's own answer into the value-free story of what the user will see.
 *
 * Everything here reads COUNTS out of a response and throws the response away. It never reads a label, a value, a
 * signature, a command, a URL or a draft; the types are deliberately `unknown` so nothing can be passed through by
 * accident. What comes out is the line a judge reads in Sentry: "answered 12 of 14, 2 guesses, 2 without a fact".
 */
import { confidenceBucket, type ConfidenceBucket } from "./names";
import type { Attrs } from "./sentry";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  // Only ever used for provider names, model ids and cache verdicts, all of which are short closed vocabularies.
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export interface Summary {
  /** The one-line outcome, for the structured log. */
  message: string;
  /** Span and log attributes. Counts, names, buckets and booleans only. */
  attributes: Attrs;
  /** True when the answer did not come from the provider that was supposed to answer it. */
  degraded: boolean;
}

const EMPTY: Summary = { message: "no answer", attributes: {}, degraded: false };

/** Counts per bucket, so a trace shows how many ghosts were confident and how many were guesses. */
function bucketCounts(confidences: number[]): Record<ConfidenceBucket, number> {
  const counts: Record<ConfidenceBucket, number> = { high: 0, guess: 0, weak: 0, none: 0 };
  for (const c of confidences) counts[confidenceBucket(c)] += 1;
  return counts;
}

/**
 * `/v1/predict/form`. The headline route: one call maps a whole form to profile fact KEYS (never values), and this is
 * where "why was a ghost shown or not" is decided.
 */
export function summarizeForm(body: unknown): Summary {
  const response = record(body);
  if (!response) return EMPTY;
  const assignments = list(response.assignments).map(record);
  const fields = assignments.length;
  const answeredConfidences: number[] = [];
  let none = 0;
  let fromModel = 0;
  const provider = text(response.provider);
  for (const assignment of assignments) {
    if (!assignment) continue;
    const factKey = assignment.factKey;
    // "none" is the only factKey ever read, and only to tell "has a fact" from "has none".
    if (factKey === "none" || factKey === undefined) {
      none += 1;
      continue;
    }
    answeredConfidences.push(num(assignment.confidence) ?? 0);
    if (text(assignment.source) !== "heuristic") fromModel += 1;
  }
  const buckets = bucketCounts(answeredConfidences);
  const answered = answeredConfidences.length;
  const guesses = buckets.guess + buckets.weak + buckets.none;
  const fallbackFrom = text(response.fallbackFrom);
  return {
    message: `answered ${answered} of ${fields}, ${guesses} guess${guesses === 1 ? "" : "es"}, ${none} without a fact`,
    degraded: fallbackFrom !== undefined,
    attributes: {
      "ghost.fields": fields,
      "ghost.answered": answered,
      "ghost.without_fact": none,
      "ghost.guesses": guesses,
      "ghost.confidence.high": buckets.high,
      "ghost.confidence.guess": buckets.guess,
      "ghost.confidence.weak": buckets.weak,
      "ghost.from_model": fromModel,
      "ghost.from_heuristic": answered - fromModel,
      "ghost.provider": provider,
      "ghost.calibrated": bool(response.calibrated),
      "ghost.cache": text(response.cache),
      "ghost.fast_path": bool(response.fastPath) ?? false,
      "ghost.fallback_from": fallbackFrom,
      "ghost.latency_ms": num(response.latencyMs),
    },
  };
}

/** `/v1/predict/form` request: the two numbers that explain the size of the model call. Nothing else is read. */
export function summarizeFormRequest(body: unknown): Attrs {
  const request = record(body);
  if (!request) return {};
  return { "ghost.request.fields": list(request.fields).length, "ghost.request.fact_keys": list(request.factKeys).length };
}

/** `/v1/predict/next`: one candidate or none. */
export function summarizeNext(body: unknown): Summary {
  const response = record(body);
  if (!response) return EMPTY;
  const chosen = response.candidateId !== "none" && response.candidateId !== undefined;
  const confidence = num(response.confidence) ?? 0;
  const fallbackFrom = text(response.fallbackFrom);
  return {
    message: chosen ? `proposed the next action (${confidenceBucket(confidence)})` : "no next action fit",
    degraded: fallbackFrom !== undefined,
    attributes: {
      "ghost.proposed": chosen,
      "ghost.confidence.bucket": confidenceBucket(confidence),
      "ghost.provider": text(response.provider),
      "ghost.calibrated": bool(response.calibrated),
      "ghost.fallback_from": fallbackFrom,
      "ghost.latency_ms": num(response.latencyMs),
    },
  };
}

/** `/v1/predict/command` (the terminal ghost). The command itself is never read, only whether there was one. */
export function summarizeCommand(body: unknown): Summary {
  const response = record(body);
  if (!response) return EMPTY;
  const proposed = typeof response.command === "string";
  const confidence = num(response.confidence) ?? 0;
  const fallbackFrom = text(response.fallbackFrom);
  return {
    message: proposed ? `proposed a command (${confidenceBucket(confidence)})` : "no command fit",
    degraded: fallbackFrom !== undefined,
    attributes: {
      "ghost.proposed": proposed,
      "ghost.confidence.bucket": confidenceBucket(confidence),
      "ghost.candidates": num(response.candidates),
      "ghost.provider": text(response.provider),
      "ghost.calibrated": bool(response.calibrated),
      "ghost.cache": text(response.cache),
      "ghost.fallback_from": fallbackFrom,
      "ghost.latency_ms": num(response.latencyMs),
    },
  };
}

/** `/v1/shabang-text` with `?stream=0`. The draft is measured, never read. */
export function summarizeGhostText(body: unknown): Summary {
  const response = record(body);
  if (!response) return EMPTY;
  const chars = typeof response.text === "string" ? response.text.length : 0;
  const fallbackFrom = text(response.fallbackFrom);
  return {
    message: chars > 0 ? `drafted ${chars} characters` : "no draft",
    degraded: fallbackFrom !== undefined,
    attributes: {
      "ghost.draft_chars": chars,
      "ghost.provider": text(response.provider),
      "ghost.cache": text(response.cache),
      "ghost.first_token_ms": num(response.firstTokenMs),
      "ghost.fallback_from": fallbackFrom,
      "ghost.latency_ms": num(response.latencyMs),
    },
  };
}

/** `/v1/loop/synthesize`: did two runs generalize into a program, and how much of it did the model have to resolve. */
export function summarizeLoop(body: unknown): Summary {
  const response = record(body);
  if (!response) return EMPTY;
  const program = record(response.program);
  const steps = program ? list(program.steps).length : 0;
  const unresolved = list(response.unresolved).length;
  const fallbackFrom = text(response.fallbackFrom);
  return {
    message: program ? `synthesized ${steps} steps, ${unresolved} unresolved` : "the two runs did not generalize",
    degraded: fallbackFrom !== undefined,
    attributes: {
      "ghost.program": program !== undefined,
      "ghost.steps": steps,
      "ghost.unresolved": unresolved,
      "ghost.resolved_by_model": num(response.resolvedByModel),
      "ghost.model_calls": num(response.modelCalls),
      "ghost.provider": text(response.provider),
      "ghost.cache": text(response.cache),
      "ghost.fallback_from": fallbackFrom,
      "ghost.latency_ms": num(response.latencyMs),
    },
  };
}

/** `/v1/vision/label`: how many controls came back named, locked or sensitive. No label text is read. */
export function summarizeVisionLabel(body: unknown): Summary {
  const response = record(body);
  if (!response) return EMPTY;
  const labels = list(response.labels).map(record);
  let named = 0;
  let locked = 0;
  let sensitive = 0;
  for (const entry of labels) {
    if (!entry) continue;
    if (typeof entry.label === "string" && entry.label.length > 0) named += 1;
    if (entry.irreversible === true) locked += 1;
    if (entry.sensitive === true) sensitive += 1;
  }
  return {
    message: `named ${named} of ${labels.length} controls, ${locked} locked`,
    degraded: false,
    attributes: {
      "ghost.boxes": labels.length,
      "ghost.named": named,
      "ghost.locked": locked,
      "ghost.sensitive": sensitive,
      "ghost.cache": response.cached === true ? "hit" : "miss",
      "gen_ai.request.model": text(response.model),
      "ghost.provider": text(response.provider),
      "ghost.latency_ms": num(response.latencyMs),
    },
  };
}

/** `POST /v1/metrics/event`: the client's own counters. Deltas and (confidence, accepted) pairs; numbers only. */
export interface ClientCounters {
  counters: Record<string, number>;
  calibration: Array<{ bucket: ConfidenceBucket; accepted: boolean }>;
}

const COUNTER_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,32}$/;

export function summarizeClientMetrics(body: unknown): ClientCounters | undefined {
  const request = record(body);
  if (!request) return undefined;
  const counters: Record<string, number> = {};
  for (const [name, value] of Object.entries(record(request.counters) ?? {})) {
    const n = num(value);
    if (n !== undefined && COUNTER_NAME.test(name)) counters[name] = n;
  }
  const calibration: Array<{ bucket: ConfidenceBucket; accepted: boolean }> = [];
  for (const entry of list(request.calibration)) {
    const pair = record(entry);
    const confidence = num(pair?.confidence);
    if (confidence === undefined) continue;
    calibration.push({ bucket: confidenceBucket(confidence), accepted: pair?.accepted === true });
  }
  return Object.keys(counters).length === 0 && calibration.length === 0 ? undefined : { counters, calibration };
}

/** Which summariser answers for a route. A route without one still gets a transaction, just no outcome line. */
export function summarizerFor(route: string): ((body: unknown) => Summary) | undefined {
  switch (route) {
    case "/v1/predict/form":
      return summarizeForm;
    case "/v1/predict/next":
      return summarizeNext;
    case "/v1/predict/command":
      return summarizeCommand;
    case "/v1/shabang-text":
      return summarizeGhostText;
    case "/v1/loop/synthesize":
      return summarizeLoop;
    case "/v1/vision/label":
      return summarizeVisionLabel;
    default:
      return undefined;
  }
}
