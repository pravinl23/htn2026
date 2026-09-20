import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { DecisionProvider } from "@ghost/shared";
import type { ServerConfig } from "../config";
import { classifyCaller, TOKEN_HEADER, type AccessConfig } from "../executors/access";
import type { HostLookup } from "../executors/netguard";
import { runScan, type ScanResult } from "../facts/scan";
import { FACT_SCAN_LIMITS, parseScanRequest } from "../facts/validation";
import { getMetrics, type Metrics } from "../lib/metrics";
import { createLlmClient } from "../llm/client";
import { createDecisionProvider } from "../providers";
import { BadRequest, readJsonBody } from "../providers/validation";

const SCAN_ROUTE = "/v1/facts/scan";
const INFO_ROUTE = "/v1/facts";
const WEB_CALLER = "a fact scan reads sources the user owns: it is only available to Ghost (the extension or Ghost Desktop), not to web pages";

/** Test seam: `registerFactsRoutes(app, config)` stays the public signature. */
export interface FactsRouteDeps {
  fetch?: typeof fetch;
  lookup?: HostLookup;
  provider?: DecisionProvider;
  metrics?: Metrics;
  log?: (line: string) => void;
  timeoutMs?: { github?: number; website?: number; model?: number; conflicts?: number };
  now?: () => string;
}

/**
 * Building the fact graph from what the user already has (docs/profile-sources.md).
 *
 * A scan reads the sources named in the request, returns PROPOSALS, and forgets them: nothing is written
 * to disk, nothing is cached, no value is logged. The user reviews the proposals in the options page and
 * accepts them one by one; only then does anything enter the graph, which never leaves their machine.
 *
 * Access: the same rule as the loop and vision routes minus the pinning requirement — a web page never
 * reaches this route, not even one on localhost, because the proposals are the user's own details. With
 * GHOST_EXTENSION_ID set, only that extension's origin is admitted; a caller without an Origin (Ghost
 * Desktop, a script) is local by the global guard, and a wrong X-Ghost-Token is still 401.
 */
export function registerFactsRoutes(app: Hono, config: ServerConfig, deps: FactsRouteDeps = {}): void {
  const client = config.llm ? createLlmClient(config.llm, deps.fetch ? { fetch: deps.fetch } : {}) : undefined;
  // warmUp: false — the prediction routes own the Baseten warm-up; a scan must never add a second billed request at start-up.
  const provider = deps.provider ?? createDecisionProvider(config, { warmUp: false, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const metrics = deps.metrics ?? getMetrics(config);
  const log = deps.log ?? ((line: string) => (process.env.VITEST ? undefined : console.log(line)));
  const access: AccessConfig = { extensionId: config.extensionId, executeToken: config.executeToken };
  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);

  app.get(INFO_ROUTE, (c) =>
    c.json({
      adapters: ["github", "website", "text", "resume"],
      /** Without a text model the code extractors answer alone: regex, vCard and the GitHub profile still work. */
      model: client ? { provider: client.name, model: client.model } : null,
      conflicts: provider.name === "heuristic" ? null : { provider: provider.name, calibrated: provider.calibrated },
      limits: { sources: FACT_SCAN_LIMITS.sources, textChars: FACT_SCAN_LIMITS.textChars, proposals: FACT_SCAN_LIMITS.proposals },
    }),
  );

  app.post(SCAN_ROUTE, bodyLimit({ maxSize: FACT_SCAN_LIMITS.bodyBytes, onError: tooLarge }), async (c) => {
    const origin = c.req.header("origin");
    const verdict = classifyCaller(access, origin, c.req.header(TOKEN_HEADER));
    if ("refuse" in verdict) return c.json({ error: verdict.refuse === 401 ? verdict.error : WEB_CALLER }, verdict.refuse);
    try {
      const req = parseScanRequest(await readJsonBody(c.req, FACT_SCAN_LIMITS.bodyBytes));
      const result = await runScan(req, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
        ...(client ? { client } : {}),
        provider,
        ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        // One sample and one line per model call, failures included. Counts only: never a value, a key or a URL.
        onModelCall(info) {
          metrics.recordLatency(SCAN_ROUTE, info.provider, info.latencyMs, info.ok);
          log(`[ghost] ${info.provider} ${SCAN_ROUTE} ${info.latencyMs}ms questions=${info.questions} calibrated=false cache=miss${info.ok ? "" : " failed=1"}`);
        },
      });
      // Model calls were recorded one by one above; a scan answered purely in code is charged to the code path.
      if (result.modelCalls === 0) metrics.recordLatency(SCAN_ROUTE, "heuristic", result.latencyMs);
      log(summary(result));
      return c.json(result);
    } catch (err) {
      if (err instanceof BadRequest) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
}

/** The one line a scan writes. Counts, source KINDS and fixed reasons only: never a login, a URL, a key or a value. */
function summary(result: ScanResult): string {
  const kinds = result.sources.map((source) => `${source.kind}:${source.status}${source.reason ? `(${source.reason})` : ""}`).join(",");
  return `[ghost] facts ${SCAN_ROUTE} ${result.latencyMs}ms sources=${result.sources.length} [${kinds}] proposals=${result.proposals.length} conflicts=${result.conflicts.length} sensitiveDropped=${result.sensitiveDropped} modelCalls=${result.modelCalls}`;
}
