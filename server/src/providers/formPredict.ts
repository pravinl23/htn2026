import { createHash } from "node:crypto";
import {
  NONE,
  mapFieldToFact,
  type CapturedField,
  type DecisionProvider,
  type FieldAssignment,
  type FormPredictRequest,
  type FormPredictResponse,
} from "@shabang/shared";
import { LruCache } from "../lib/cache";
import { buildFormDecision, cleanFactKeys, factCriteria, isModelCandidate, readFormAnswer, wordingFor } from "./formQuestions";
import { DECISION_TIMEOUT_MS, withDeadline } from "./timeout";

export const FAST_PATH_CONFIDENCE = 0.9;
export const FORM_CACHE_ENTRIES = 500;
/** Criteria repeat per question, so a small request can become a huge model call. Above this the heuristic answers instead. */
export const MAX_DECISION_BYTES = 200_000;
const HEURISTIC = "heuristic";

export interface SourcedAssignment extends FieldAssignment {
  /** Who decided this field: "heuristic" or the model provider's name. */
  source: string;
  /** True only when `confidence` is a calibrated probability. Heuristic confidences are hand-set constants. */
  calibrated: boolean;
}

export interface FormPrediction extends FormPredictResponse {
  assignments: SourcedAssignment[];
  cache: "hit" | "miss";
  fallbackFrom?: string;
  /** True when every field had structural evidence and no model was asked. */
  fastPath?: boolean;
}

export interface FormPredictorOptions {
  provider: DecisionProvider;
  fastPath: boolean;
  timeoutMs?: number;
  /** Called once per model call, for the log line and the metrics. */
  onModelCall?: (info: { provider: string; latencyMs: number; questions: number; calibrated: boolean; ok: boolean }) => void;
}

type Outcome = Omit<FormPrediction, "latencyMs" | "cache">;

interface Computed {
  outcome: Outcome;
  /** False for fallbacks and partial answers: the provider may do better on the next visit. */
  cacheable: boolean;
}

/** Everything that feeds the heuristic, the model state or the sensitive gate. Signatures alone are client claims and would let one request poison another's entry. */
function fieldsDigest(fields: CapturedField[]): string {
  const rows = fields.map((f) => [f.signature, f.kind, f.inputType, f.label, f.name, f.id, f.autocomplete, f.placeholder, f.context, f.options?.map((o) => o.label)]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function formCacheKey(req: FormPredictRequest): string {
  return [req.origin, req.formSignature, cleanFactKeys(req.factKeys).sort().join(","), fieldsDigest(req.fields)].join("|");
}

function fromHeuristic(a: FieldAssignment): SourcedAssignment {
  return { ...a, source: HEURISTIC, calibrated: false };
}

function blocked(field: CapturedField): SourcedAssignment {
  return fromHeuristic({ signature: field.signature, factKey: NONE, confidence: 0.99 });
}

/**
 * Label-regex confidences are constants, not probabilities ("First language" scores 0.95 for firstName), so they never
 * skip the model. Only structural evidence does: a standard autocomplete token (the match survives without the label),
 * or a confident "none", where being wrong just means no ghost.
 */
function isStructurallyCertain(field: CapturedField, a: FieldAssignment, factKeys: string[]): boolean {
  if (a.confidence < FAST_PATH_CONFIDENCE) return false;
  if (a.factKey === NONE) return true;
  const unlabeled = mapFieldToFact({ signature: field.signature, kind: field.kind, autocomplete: field.autocomplete, label: "", rect: field.rect }, factKeys);
  return unlabeled.factKey === a.factKey && unlabeled.confidence >= FAST_PATH_CONFIDENCE;
}

/** Rule 3 holds on every response, cached or not: a blocked field is always none. */
function enforceBlocked(outcome: Outcome, fields: CapturedField[]): Outcome {
  const assignments = outcome.assignments.map((a, i) => {
    const field = fields[i];
    return field && !isModelCandidate(field) ? blocked(field) : a;
  });
  return { ...outcome, assignments };
}

/** Maps a form to profile fact keys with at most ONE model call, and zero when structure or the cache can answer. */
export function createFormPredictor(options: FormPredictorOptions): (req: FormPredictRequest) => Promise<FormPrediction> {
  const { provider, fastPath, timeoutMs = DECISION_TIMEOUT_MS, onModelCall } = options;
  const cache = new LruCache<Outcome>(FORM_CACHE_ENTRIES);
  const inFlight = new Map<string, Promise<Computed>>();

  const heuristicOnly = (assignments: SourcedAssignment[], extra: Partial<Outcome> = {}): Outcome => ({ assignments, provider: HEURISTIC, calibrated: false, ...extra });

  async function askModel(req: FormPredictRequest, heuristic: SourcedAssignment[], asked: number[]): Promise<Computed> {
    const fields = asked.map((i) => req.fields[i]).filter((f): f is CapturedField => f !== undefined);
    const wording = wordingFor(provider.name);
    const { state, questions } = buildFormDecision(req.origin, fields, req.factKeys, wording);
    if (Buffer.byteLength(JSON.stringify({ state, questions })) > MAX_DECISION_BYTES) {
      return { outcome: heuristicOnly(heuristic, { fallbackFrom: provider.name }), cacheable: false };
    }
    const allowed = factCriteria(req.factKeys, wording);
    const started = performance.now();
    const report = (ok: boolean) =>
      onModelCall?.({ provider: provider.name, latencyMs: Math.round(performance.now() - started), questions: asked.length, calibrated: provider.calibrated, ok });
    try {
      const result = await withDeadline(timeoutMs, () => provider.decide(state, questions));
      report(true);
      const assignments = [...heuristic];
      let unanswered = 0;
      asked.forEach((fieldIndex, questionIndex) => {
        const answer = readFormAnswer(result.answers, questionIndex, allowed);
        const current = assignments[fieldIndex];
        if (answer && current) assignments[fieldIndex] = { signature: current.signature, ...answer, source: result.provider, calibrated: result.calibrated };
        else unanswered += 1;
      });
      // Calibrated only if every ghost the client can show carries a calibrated confidence.
      const calibrated = result.calibrated && assignments.every((a) => a.calibrated || a.factKey === NONE);
      return { outcome: { assignments, provider: result.provider, calibrated }, cacheable: unanswered === 0 };
    } catch {
      report(false);
      return { outcome: heuristicOnly(heuristic, { fallbackFrom: provider.name }), cacheable: false };
    }
  }

  async function compute(req: FormPredictRequest): Promise<Computed> {
    const factKeys = cleanFactKeys(req.factKeys);
    const candidate = req.fields.map(isModelCandidate);
    const heuristic = req.fields.map((field, i) => (candidate[i] ? fromHeuristic(mapFieldToFact(field, factKeys)) : blocked(field)));
    if (provider.name === HEURISTIC) return { outcome: heuristicOnly(heuristic), cacheable: true };
    const asked = heuristic.flatMap((a, i) => {
      const field = req.fields[i];
      const skip = !candidate[i] || !field || (fastPath && isStructurallyCertain(field, a, factKeys));
      return skip ? [] : [i];
    });
    if (asked.length === 0) return { outcome: heuristicOnly(heuristic, { fastPath: true }), cacheable: true };
    return askModel(req, heuristic, asked);
  }

  /** Single flight: identical concurrent requests (load + focus + mutation observer) share one model call. */
  function computeOnce(key: string, req: FormPredictRequest): Promise<Computed> {
    const running = inFlight.get(key);
    if (running) return running;
    const started = compute(req).finally(() => inFlight.delete(key));
    inFlight.set(key, started);
    return started;
  }

  return async function predictForm(req) {
    const started = performance.now();
    const key = formCacheKey(req);
    const cached = cache.get(key);
    const computed = cached ? { outcome: cached, cacheable: false } : await computeOnce(key, req);
    if (computed.cacheable) cache.set(key, computed.outcome);
    const outcome = enforceBlocked(computed.outcome, req.fields);
    return { ...outcome, latencyMs: Math.round(performance.now() - started), cache: cached ? "hit" : "miss" };
  };
}
