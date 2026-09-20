/**
 * Every name that reaches Sentry is built here, from a closed list.
 *
 * A transaction name is grouped on in the Sentry UI, so it must be a ROUTE, never a URL: an id or a query string in
 * the name is both a privacy leak and an unusable dashboard. Anything this module does not recognise becomes
 * "<other>", which is the honest answer and carries nothing.
 */

/** Every path the server registers. A request outside this list is never named after its URL. */
const ROUTES = [
  "/v1/health",
  "/v1/predict/form",
  "/v1/predict/next",
  "/v1/predict/command",
  "/v1/ghost-text",
  "/v1/profile/extract",
  "/v1/metrics",
  "/v1/metrics/event",
  "/v1/presence",
  "/v1/loop/synthesize",
  "/v1/loop/compile",
  "/v1/loop/preview",
  "/v1/loop/execute",
  "/v1/executors",
  "/v1/vision",
  "/v1/vision/label",
  "/v1/vision/locate",
  // The learning loop. Without these the most important endpoint in the product reported as "<other>".
  "/v1/walk/outcomes",
  "/v1/walk/replays",
] as const;

const KNOWN = new Set<string>(ROUTES);
export const UNKNOWN_ROUTE = "<other>";

/** Routes with a path parameter. The parameter is never kept: `/v1/loop/execute/<uuid>` is `/v1/loop/execute/:runId`. */
const PARAMETERIZED: Array<{ prefix: string; pattern: string }> = [
  { prefix: "/v1/loop/execute/", pattern: "/v1/loop/execute/:runId" },
];

/** The route a path belongs to, with query strings, fragments and path parameters removed. */
export function routeOf(path: string): string {
  const clean = path.split("?")[0]?.split("#")[0] ?? "";
  const trimmed = clean.length > 1 && clean.endsWith("/") ? clean.slice(0, -1) : clean;
  if (KNOWN.has(trimmed)) return trimmed;
  for (const { prefix, pattern } of PARAMETERIZED) {
    if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) return pattern;
  }
  return UNKNOWN_ROUTE;
}

/** The transaction name: method plus route, the two things a judge groups by. */
export function transactionName(method: string, path: string): string {
  return `${method.toUpperCase()} ${routeOf(path)}`;
}

/**
 * The span that holds the actual work of a route, inside the request transaction. The gap between this span and its
 * children is the time Ghost spent in its own code (heuristic, hashing, cache, gating) rather than waiting on a model.
 */
const WORK_SPANS: Record<string, string> = {
  "/v1/predict/form": "predict.form",
  "/v1/predict/next": "predict.next",
  "/v1/predict/command": "predict.command",
  "/v1/ghost-text": "ghost.text",
  "/v1/profile/extract": "profile.extract",
  "/v1/loop/synthesize": "loop.synthesize",
  "/v1/vision/label": "vision.label",
  "/v1/vision/locate": "vision.locate",
  "/v1/walk/outcomes": "walk.outcome",
};

export function workSpanName(route: string): string | undefined {
  return WORK_SPANS[route];
}

/** `decide.jev` reads better than `decide.typesafe` in a trace: both providers ask the same model the same question. */
export function decideSpanName(provider: string): string {
  if (provider === "typesafe" || provider === "jev-gateway") return "decide.jev";
  return `decide.${provider}`;
}

/** `gen_ai.system` follows the OpenTelemetry GenAI convention, so Sentry's AI views pick these calls up. */
export function genAiSystem(provider: string): string {
  if (provider === "typesafe" || provider === "jev-gateway") return "typesafe";
  return provider;
}

/**
 * Confidence never leaves as a number attached to one field: that is a fingerprint of what Ghost saw. It leaves as the
 * bucket from docs/always-propose.md, which is the thing the product actually branches on.
 */
export type ConfidenceBucket = "high" | "guess" | "weak" | "none";

export function confidenceBucket(confidence: number): ConfidenceBucket {
  if (!Number.isFinite(confidence) || confidence <= 0) return "none";
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.7) return "guess";
  return "weak";
}

/** A host is a service name, never a URL: no scheme, no path, no query string. Unparseable input yields nothing. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}
