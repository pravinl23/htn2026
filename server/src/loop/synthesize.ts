import { synthesizeProgram, type UnresolvedStep } from "@shabang/shared";
import { LruCache } from "../lib/cache";
import type { LlmClient } from "../llm/client";
import { parseModelPicks, type ModelPick } from "./answers";
import { applyMappings, type VerifiedMapping } from "./apply";
import { buildOpenQuestion, verifyCandidate, type OpenQuestion } from "./candidates";
import { loopMessages } from "./prompt";
import { programTitle } from "./title";
import type { ServerLoopProgram } from "./transforms";
import type { SynthesizeRequest } from "./validation";

export interface SynthesizeResult {
  /** Null when the two runs do not generalize (no list iterator, a masked value, a half-done item). */
  program: ServerLoopProgram | null;
  /** "llm" only when the model was consulted and answered. Its picks still had to pass verification. */
  provider: "heuristic" | "llm";
  resolvedByModel: number;
  unresolved: UnresolvedStep[];
  latencyMs: number;
  modelCalls: 0 | 1;
  model?: string;
  cache?: "hit" | "miss";
  /** Set when the model call failed or its reply was unusable: the heuristic result is returned as is. */
  fallbackFrom?: "llm";
}

export interface ModelCallInfo {
  provider: "llm";
  latencyMs: number;
  questions: number;
  ok: boolean;
}

export interface LoopSynthesizerOptions {
  client?: LlmClient;
  timeoutMs?: number;
  onModelCall?: (info: ModelCallInfo) => void;
}

// A loop proposal is not on the keystroke path, but the preview grid should not wait long for a nicer program.
const DEFAULT_TIMEOUT_MS = 8_000;
const CACHE_ENTRIES = 100;
const TOKENS_PER_STEP = 40;

type Picks = Map<string, ModelPick>;

function verifiedMappings(question: OpenQuestion, picks: Picks): VerifiedMapping[] {
  const out: VerifiedMapping[] = [];
  for (const open of question.steps) {
    const pick = picks.get(open.key);
    const candidate = pick && question.sets.find((s) => s.id === open.setId)?.candidates[pick.candidate];
    // An index that was never offered, or a fact that cannot reproduce both typed values, is a hallucination: dropped.
    const mapping = candidate ? verifyCandidate(candidate, open.step, pick.transform) : null;
    if (mapping) out.push({ ...mapping, var: open.step.var });
  }
  return out;
}

export function createLoopSynthesizer(options: LoopSynthesizerOptions = {}): (req: SynthesizeRequest) => Promise<SynthesizeResult> {
  const { client } = options;
  // The extension re-detects the same loop after every further action, so the identical question comes back often.
  const cache = new LruCache<Picks>(CACHE_ENTRIES);

  async function askModel(llm: LlmClient, question: OpenQuestion): Promise<{ picks: Picks; cache: "hit" | "miss" }> {
    const messages = loopMessages(question);
    const key = messages.map((m) => m.content).join("\n");
    const cached = cache.get(key);
    if (cached) return { picks: cached, cache: "hit" };
    const started = performance.now();
    const report = (ok: boolean): void => options.onModelCall?.({ provider: "llm", latencyMs: Math.round(performance.now() - started), questions: question.steps.length, ok });
    try {
      const raw = await llm.chat({ messages, maxTokens: 60 + TOKENS_PER_STEP * question.steps.length, temperature: 0, json: true, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
      const picks = parseModelPicks(raw, question.steps.map((s) => s.key));
      report(true);
      cache.set(key, picks);
      return { picks, cache: "miss" };
    } catch (err) {
      report(false);
      throw err;
    }
  }

  return async (req) => {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    // The same pure code the extension runs. The model is only ever asked about what this leaves open.
    const heuristic = synthesizeProgram(req.candidate, req.factsByUrl);
    if (!heuristic) return { program: null, provider: "heuristic", resolvedByModel: 0, unresolved: [], latencyMs: elapsed(), modelCalls: 0 };
    const base: ServerLoopProgram = { ...heuristic, unresolved: heuristic.unresolved ?? [] };
    const finish = (program: ServerLoopProgram, extra: Partial<SynthesizeResult>): SynthesizeResult => {
      const titled = { ...program, name: programTitle(program) };
      return { program: titled, provider: "heuristic", resolvedByModel: 0, unresolved: titled.unresolved ?? [], latencyMs: elapsed(), modelCalls: 0, ...extra };
    };

    const open = base.unresolved ?? [];
    if (open.length === 0 || !client) return finish(base, {});
    const question = buildOpenQuestion(req.candidate, req.factsByUrl, open);
    if (question.steps.length === 0) return finish(base, {});
    try {
      const { picks, cache: cacheState } = await askModel(client, question);
      const program = applyMappings(base, verifiedMappings(question, picks));
      const resolvedByModel = open.length - (program.unresolved ?? []).length;
      return finish(program, { provider: "llm", resolvedByModel, modelCalls: cacheState === "hit" ? 0 : 1, model: client.model, cache: cacheState });
    } catch {
      // Timeout, upstream error or a reply with no JSON in it: the heuristic program stands, with its steps still open.
      return finish(base, { modelCalls: 1, fallbackFrom: "llm" });
    }
  };
}
