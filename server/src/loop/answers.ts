import { isRecord } from "../providers/errors";
import { isLoopTransform, type LoopTransform } from "./transforms";

/** One usable pick. A step the model skipped, answered "none" for, or answered in a shape code cannot read has no entry. */
export interface ModelPick {
  candidate: number;
  /** Advisory: code re-derives the transform and only uses this one if it verifies. */
  transform?: LoopTransform;
}

/** Thrown when the reply holds no JSON object at all. Anything less broken is tolerated answer by answer. */
export class MalformedAnswer extends Error {}

function jsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new MalformedAnswer("no JSON object");
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (isRecord(parsed)) return parsed;
  } catch {
    // falls through
  }
  throw new MalformedAnswer("unparseable JSON");
}

/** 3, "3" and "c3" all mean candidate 3. "none", null and anything else mean no pick. */
function candidateIndex(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const m = /^c?(\d{1,4})$/i.exec(value.trim());
  return m ? Number(m[1]) : undefined;
}

function pickOf(value: unknown): ModelPick | undefined {
  const candidate = candidateIndex(isRecord(value) ? (value.candidate ?? value.index) : value);
  if (candidate === undefined) return undefined;
  const transform = isRecord(value) && isLoopTransform(value.transform) ? value.transform : undefined;
  return transform === undefined ? { candidate } : { candidate, transform };
}

/** Accepts `{answers:{s0:{...}}}`, a bare `{s0:{...}}`, or `{answers:[{step:"s0",...}]}`, possibly wrapped in a code fence or prose. */
export function parseModelPicks(raw: string, stepKeys: readonly string[]): Map<string, ModelPick> {
  const parsed = jsonObject(raw);
  const answers: unknown = parsed.answers ?? parsed;
  const entries: Array<[unknown, unknown]> = Array.isArray(answers)
    ? answers.map((a): [unknown, unknown] => [isRecord(a) ? a.step : undefined, a])
    : isRecord(answers) ? Object.entries(answers) : [];
  const picks = new Map<string, ModelPick>();
  for (const [key, value] of entries) {
    if (typeof key !== "string" || !stepKeys.includes(key) || picks.has(key)) continue;
    const pick = pickOf(value);
    if (pick) picks.set(key, pick);
  }
  return picks;
}
