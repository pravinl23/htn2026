import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "../config";
import { classifyCaller, TOKEN_HEADER, type AccessConfig } from "../executors/access";
import { getMetrics, type Metrics } from "../lib/metrics";
import { BadRequest, readJsonBody } from "../providers/validation";
import { budgetLimitFrom, processVisionBudget, type VisionBudget } from "../vision/budget";
import { cacheLimitFrom, LabelCache, visionCacheKey } from "../vision/cache";
import { visionConfigFrom } from "../vision/config";
import { buildLabelBody, buildLocateBody, imageView } from "../vision/prompts";
import { validateLabelReply, validateLocateReply, type VisionLabel } from "../vision/replies";
import { callResponses, visionTimeoutMs, VisionError } from "../vision/responses";
import { parseLabelRequest, parseLocateRequest, VISION_LIMITS, type LabelRequest } from "../vision/validation";

const LABEL_ROUTE = "/v1/vision/label";
const LOCATE_ROUTE = "/v1/vision/locate";
const PROVIDER = "openai";
const WEB_CALLER = "vision is only available to Shabang (the extension or Shabang Desktop), not to web pages or other extensions";
const UNPINNED_EXTENSION =
  "vision from a browser extension needs a pinned caller: set SHABANG_EXTENSION_ID to the Shabang extension's id (chrome://extensions), or SHABANG_EXECUTE_TOKEN and send it as X-Shabang-Token";

/**
 * Vision spends the user's paid OpenAI quota and carries screen pixels, so it takes the loop routes' caller rules
 * (executors/access.ts), not just the local-only guard: a web page never reaches it, not even one on localhost; a
 * browser extension must be the pinned Shabang extension or send X-Shabang-Token; a caller without an Origin is a local
 * process (Shabang Desktop, a script) and may send the token but need not. A wrong token is 401.
 */
function refuseVisionCaller(c: Context, access: AccessConfig): Response | undefined {
  const origin = c.req.header("origin");
  const verdict = classifyCaller(access, origin, c.req.header(TOKEN_HEADER));
  if ("refuse" in verdict) return c.json({ error: verdict.refuse === 401 ? verdict.error : WEB_CALLER }, verdict.refuse);
  if (origin !== undefined && !verdict.trusted) return c.json({ error: UNPINNED_EXTENSION }, 403);
  return undefined;
}

/** Test seam: `registerVisionRoutes(app, config)` stays the public signature. */
export interface VisionRouteDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  budget?: VisionBudget;
  cache?: LabelCache;
  metrics?: Metrics;
  log?: (line: string) => void;
}

/** A route's per-page memory: a hit answers without a model call, so it costs neither money nor a budget unit. */
interface RouteCache<Req> {
  lookup(req: Req): { payload: Record<string, unknown>; summary: string } | undefined;
  store(req: Req, payload: Record<string, unknown>): void;
}

/**
 * The eyes: labels controls the accessibility tree / DOM cannot name, and points at an element an instruction describes.
 * Stateless: images are validated, forwarded once and dropped; nothing from the screen is cached or logged.
 * The answer is only ever a ghost suggestion: nothing here clicks or types.
 */
export function registerVisionRoutes(app: Hono, config: ServerConfig, deps: VisionRouteDeps = {}): void {
  const env = deps.env ?? process.env;
  const vision = visionConfigFrom(config, env);
  const budget = deps.budget ?? processVisionBudget(budgetLimitFrom(env.SHABANG_VISION_BUDGET));
  const cache = deps.cache ?? new LabelCache(cacheLimitFrom(env.SHABANG_VISION_CACHE));
  const metrics = deps.metrics ?? getMetrics(config);
  const log = deps.log ?? ((line: string) => (process.env.VITEST ? undefined : console.log(line)));
  const doFetch = deps.fetch ?? fetch;
  const access: AccessConfig = { extensionId: config.extensionId, executeToken: config.executeToken };
  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);
  const limit = bodyLimit({ maxSize: VISION_LIMITS.bodyBytes, onError: tooLarge });

  app.get("/v1/vision", (c) =>
    c.json({ available: Boolean(vision), provider: vision ? PROVIDER : null, model: vision?.model ?? null, budget: budget.snapshot(), cache: cache.stats() }),
  );

  /** Shared plumbing: availability, validation, budget, ONE model call, error mapping, one log line with counts only. */
  async function handle<Req extends { image: { kind: string; width: number; height: number; bytes: number }; boxes: unknown[] }>(
    c: Context,
    route: string,
    parse: (body: unknown) => Req,
    build: (model: string, req: Req) => Record<string, unknown>,
    finish: (json: unknown, req: Req, model: string) => { payload: Record<string, unknown>; summary: string },
    routeCache?: RouteCache<Req>,
  ): Promise<Response> {
    const refused = refuseVisionCaller(c, access);
    if (refused) return refused;
    if (!vision) return c.json({ error: "vision unavailable", reason: "Add OPENAI_API_KEY to enable the vision fallback" }, 503);
    let req: Req;
    try {
      req = parse(await readJsonBody(c.req, VISION_LIMITS.bodyBytes));
    } catch (err) {
      if (err instanceof BadRequest) return c.json({ error: err.message }, err.status);
      throw err;
    }
    const shape = `image=${req.image.kind} ${req.image.width}x${req.image.height} bytes=${req.image.bytes} boxes=${req.boxes.length}`;
    const started = performance.now();
    // Before the budget check on purpose: a page already labelled still answers once the budget is spent.
    const hit = routeCache?.lookup(req);
    if (hit) {
      const latencyMs = Math.round(performance.now() - started);
      metrics.recordLatency(route, PROVIDER, latencyMs);
      log(`[ghost] ${PROVIDER} ${route} ${latencyMs}ms model=${vision.model} calibrated=false cache=hit ${shape} attempts=0 ${hit.summary}`);
      return c.json({ ...hit.payload, provider: PROVIDER, model: vision.model, calibrated: false, cached: true, latencyMs });
    }
    if (budget.remaining() === 0) return c.json({ error: "vision budget exhausted", limit: budget.limit }, 429);
    try {
      const timeoutMs = deps.timeoutMs ?? visionTimeoutMs(req.boxes.length);
      const { json, attempts, usage } = await callResponses(vision, build(vision.model, req), { fetch: doFetch, budget, timeoutMs });
      const { payload, summary } = finish(json, req, vision.model);
      routeCache?.store(req, payload);
      const latencyMs = Math.round(performance.now() - started);
      metrics.recordLatency(route, PROVIDER, latencyMs);
      const tokens = usage ? ` tokens=${usage.input}/${usage.output}${usage.reasoning > 0 ? `+${usage.reasoning}r` : ""}` : "";
      log(`[ghost] ${PROVIDER} ${route} ${latencyMs}ms model=${vision.model} calibrated=false cache=miss ${shape} attempts=${attempts}${tokens} ${summary}`);
      return c.json({ ...payload, provider: PROVIDER, model: vision.model, calibrated: false, cached: false, latencyMs });
    } catch (err) {
      const latencyMs = Math.round(performance.now() - started);
      if (!(err instanceof VisionError)) throw err;
      // Only thrown before the first attempt (the retry's unit is taken before its backoff): nothing was sent or billed.
      if (err.kind === "budget") return c.json({ error: "vision budget exhausted", limit: budget.limit }, 429);
      metrics.recordLatency(route, PROVIDER, latencyMs, false);
      log(`[ghost] ${PROVIDER} ${route} ${latencyMs}ms model=${vision.model} failed=${err.kind}${err.status ? ` status=${err.status}` : ""} ${shape}`);
      if (err.kind === "timeout") return c.json({ error: "vision timed out" }, 504);
      return c.json({ error: "vision provider failed", reason: err.kind, ...(err.status ? { upstreamStatus: err.status } : {}) }, 502);
    }
  }

  const labelSummary = (labels: VisionLabel[], droppedText: number): string =>
    `answered=${labels.filter((l) => l.confidence > 0 || l.label !== null).length} locked=${labels.filter((l) => l.irreversible).length} droppedText=${droppedText}`;

  /**
   * Per-page memory, only for a client that sent `page.pathPattern`. The key is a hash of that pattern, the model, the
   * crop size and the box rectangles: the same page laid out the same way answers from memory, at no cost. A moved or
   * resized control changes the key and costs a call, which is the safe direction.
   */
  const keyFor = (req: LabelRequest): string | undefined =>
    req.pathPattern && vision ? visionCacheKey({ pathPattern: req.pathPattern, model: vision.model, image: req.image, boxes: req.boxes }) : undefined;

  const labelCache: RouteCache<LabelRequest> = {
    lookup(req) {
      const key = keyFor(req);
      const labels = key ? cache.get(key, req.boxes) : undefined;
      return labels ? { payload: { labels }, summary: labelSummary(labels, req.droppedText) } : undefined;
    },
    store(req, payload) {
      const key = keyFor(req);
      if (key) cache.set(key, payload.labels as VisionLabel[]);
    },
  };

  app.post(LABEL_ROUTE, limit, (c) =>
    handle(
      c,
      LABEL_ROUTE,
      parseLabelRequest,
      buildLabelBody,
      (json, req) => {
        const { labels, answered } = validateLabelReply(json, req.boxes, { pathPattern: req.pathPattern, mediaControls: req.context.mediaControls });
        const locked = labels.filter((l) => l.irreversible).length;
        return { payload: { labels }, summary: `answered=${answered} locked=${locked} droppedText=${req.droppedText}` };
      },
      labelCache,
    ),
  );

  app.post(LOCATE_ROUTE, limit, (c) =>
    handle(c, LOCATE_ROUTE, parseLocateRequest, buildLocateBody, (json, req, model) => {
      const result = validateLocateReply(json, req.image, req.boxes, req.instruction, imageView(model, req.image));
      const found = result.box ? (result.boxId ? "box" : "point") : "none";
      return { payload: { ...result }, summary: `found=${found} locked=${result.irreversible} sensitive=${result.sensitive}` };
    }),
  );
}
