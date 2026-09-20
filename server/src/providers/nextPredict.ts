import { NONE, type DecisionProvider } from "@shabang/shared";
import { buildNextDecision, pickNextFromMemory, readNextAnswer, withoutSensitive, type NextPredictRequest } from "./nextQuestions";
import { DECISION_TIMEOUT_MS, withDeadline } from "./timeout";

const HEURISTIC = "heuristic";

export interface NextPrediction {
  candidateId: string;
  confidence: number;
  provider: string;
  calibrated: boolean;
  latencyMs: number;
  fallbackFrom?: string;
}

export interface NextPredictorOptions {
  provider: DecisionProvider;
  timeoutMs?: number;
  onModelCall?: (info: { provider: string; latencyMs: number; questions: number; calibrated: boolean; ok: boolean }) => void;
}

type Outcome = Omit<NextPrediction, "latencyMs">;

/** Predicts the next element the user will act on: ONE choice question over the candidates plus none. */
export function createNextPredictor(options: NextPredictorOptions): (req: NextPredictRequest) => Promise<NextPrediction> {
  const { provider, timeoutMs = DECISION_TIMEOUT_MS, onModelCall } = options;

  async function askModel(req: NextPredictRequest): Promise<Outcome> {
    const { state, questions, aliases } = buildNextDecision(req);
    const started = performance.now();
    const report = (ok: boolean) =>
      onModelCall?.({ provider: provider.name, latencyMs: Math.round(performance.now() - started), questions: 1, calibrated: provider.calibrated, ok });
    try {
      const result = await withDeadline(timeoutMs, () => provider.decide(state, questions));
      const pick = readNextAnswer(result.answers, aliases);
      if (!pick) throw new Error("unusable answer");
      report(true);
      return { ...pick, provider: result.provider, calibrated: result.calibrated };
    } catch {
      report(false);
      return { ...pickNextFromMemory(req), provider: HEURISTIC, calibrated: false, fallbackFrom: provider.name };
    }
  }

  async function compute(req: NextPredictRequest): Promise<Outcome> {
    if (req.candidates.length === 0) return { candidateId: NONE, confidence: 0.99, provider: HEURISTIC, calibrated: false };
    if (provider.name === HEURISTIC) return { ...pickNextFromMemory(req), provider: HEURISTIC, calibrated: false };
    return askModel(req);
  }

  return async function predictNext(req) {
    const started = performance.now();
    const outcome = await compute(withoutSensitive(req));
    return { ...outcome, latencyMs: Math.round(performance.now() - started) };
  };
}
