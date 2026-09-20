import type { ServerConfig } from "../config";
import type { VisionModelConfig } from "./responses";

/**
 * Documented as vision-capable, Responses-API, Structured-Outputs and `reasoning.effort: "none"` on
 * developers.openai.com/api/docs/models/gpt-5.6-luna (the cost-optimized tier). See docs/openai.md.
 */
export const DEFAULT_VISION_MODEL = "gpt-5.6-luna";
const MODEL_ID = /^[A-Za-z0-9][\w.:-]{0,63}$/;

type Env = Record<string, string | undefined>;

/**
 * Vision rides on the OpenAI key of the server's LLM config, so every offline switch that drops that config
 * (SHABANG_PROVIDER=heuristic in e2e, heuristic + template overrides) also switches vision off: zero network.
 * An xAI or Baseten key is not an OpenAI key and does not enable it.
 */
export function visionConfigFrom(config: ServerConfig, env: Env = process.env): VisionModelConfig | undefined {
  if (config.llm?.name !== "openai") return undefined;
  const requested = (env.OPENAI_VISION_MODEL ?? "").trim();
  return { apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl, model: MODEL_ID.test(requested) ? requested : DEFAULT_VISION_MODEL };
}
