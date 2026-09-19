export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Puts `confidence` on the chosen option and spreads the rest evenly, for providers with no real distribution. */
export function spreadProbabilities(options: string[], choice: string, confidence: number): Record<string, number> {
  const others = options.filter((o) => o !== choice);
  const rest = others.length === 0 ? 0 : (1 - confidence) / others.length;
  const out: Record<string, number> = {};
  for (const option of others) out[option] = rest;
  out[choice] = confidence;
  return out;
}

export function maxProbability(probabilities: Record<string, number> | undefined): number | undefined {
  const values = Object.values(probabilities ?? {}).filter((v) => Number.isFinite(v));
  return values.length === 0 ? undefined : Math.max(...values);
}
