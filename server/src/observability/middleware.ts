/**
 * One transaction per request, with the route's work as a span inside it.
 *
 * The shape a judge sees for a form prediction:
 *
 *   POST /v1/predict/form            http.server      142ms
 *   └── predict.form                 ghost.predict    140ms   fields=14 answered=12 cache=miss
 *       └── decide.jev               gen_ai.invoke_agent 118ms  model=jev-latest questions=9
 *           └── model.request        gen_ai.chat      112ms   server.address=api.typesafe.ai
 *
 * The gap between `predict.form` and `decide.jev` is Shabang's own code: the heuristic, the field digest, the cache
 * lookup and the gate. The gap between `decide.jev` and `model.request` is the provider's own work (for Baseten,
 * several sibling `model.request` spans, because one decision is K + H parallel samples).
 *
 * Nothing in here reads a request or response VALUE. It reads counts out of the JSON the route already produced, and
 * the summarisers in `summary.ts` are written so that a label or a draft cannot come out of them.
 */
import type { MiddlewareHandler } from "hono";
import { routeOf, transactionName, workSpanName } from "./names";
import { captureError, count, isEnabled, log, span, spanManualIn, type Attrs, type GhostSpan } from "./sentry";
import { summarizeClientMetrics, summarizeFormRequest, summarizerFor, type Summary } from "./summary";

const FORM_ROUTE = "/v1/predict/form";
const METRICS_EVENT = "/v1/metrics/event";

/** Which kind of ghost a route proposes. Used to group the counters. */
const SHABANG_CLASS: Record<string, string> = {
  "/v1/predict/form": "form-field",
  "/v1/predict/next": "next-action",
  "/v1/predict/command": "command",
  "/v1/shabang-text": "free-text",
  "/v1/vision/label": "vision-label",
};

/** Reads a finished JSON answer. Streamed answers (SSE) are skipped: there is no body to look at without consuming it. */
async function jsonBody(response: Response): Promise<unknown> {
  if (response.status !== 200) return undefined;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return undefined;
  try {
    return (await response.clone().json()) as unknown;
  } catch {
    return undefined;
  }
}

function proposedCounters(route: string, summary: Summary): void {
  const ghostClass = SHABANG_CLASS[route];
  if (!ghostClass) return;
  const source = typeof summary.attributes["ghost.provider"] === "string" ? (summary.attributes["ghost.provider"] as string) : "unknown";
  const byBucket: Array<[string, unknown]> = [
    ["high", summary.attributes["ghost.confidence.high"]],
    ["guess", summary.attributes["ghost.confidence.guess"]],
    ["weak", summary.attributes["ghost.confidence.weak"]],
  ];
  let counted = false;
  for (const [bucket, value] of byBucket) {
    if (typeof value === "number" && value > 0) {
      counted = true;
      count("ghost.proposed", value, { "ghost.class": ghostClass, "ghost.source": source, "ghost.confidence.bucket": bucket });
    }
  }
  // Routes that propose exactly one thing report their bucket instead of per-bucket counts.
  const single = summary.attributes["ghost.confidence.bucket"];
  if (!counted && summary.attributes["ghost.proposed"] === true && typeof single === "string") {
    count("ghost.proposed", 1, { "ghost.class": ghostClass, "ghost.source": source, "ghost.confidence.bucket": single });
  }
}

/**
 * The client's own counters, forwarded as Sentry metrics. `ghostsShown` / `ghostsAccepted` are deltas; a calibration
 * pair that was NOT accepted is a ghost the user corrected, which is the number that says whether Shabang is any good.
 */
function clientCounters(body: unknown): number {
  const parsed = summarizeClientMetrics(body);
  if (!parsed) return 0;
  let emitted = 0;
  const shown = parsed.counters.ghostsShown ?? 0;
  const accepted = parsed.counters.ghostsAccepted ?? 0;
  if (shown > 0) {
    count("ghost.proposed", shown, { "ghost.class": "client", "ghost.source": "extension" });
    emitted += 1;
  }
  if (accepted > 0) {
    count("ghost.accepted", accepted, { "ghost.class": "client", "ghost.source": "extension" });
    emitted += 1;
  }
  for (const pair of parsed.calibration) {
    count(pair.accepted ? "ghost.accepted" : "ghost.corrected", 1, {
      "ghost.class": "client",
      "ghost.source": "extension",
      "ghost.confidence.bucket": pair.bucket,
    });
    emitted += 1;
  }
  return emitted;
}

/** Attaches the outcome to the work span, writes the one structured line, and moves the counters. Never throws. */
async function report(route: string, response: Response, work: GhostSpan, requestBody: () => Promise<unknown>): Promise<void> {
  try {
    if (route === METRICS_EVENT) {
      const emitted = clientCounters(await requestBody());
      work.setAttributes({ "ghost.counters": emitted });
      return;
    }
    const summarize = summarizerFor(route);
    if (!summarize) return;
    const body = await jsonBody(response);
    if (body === undefined) return;
    const summary = summarize(body);
    const attributes: Attrs = { ...summary.attributes, "ghost.route": route };
    if (route === FORM_ROUTE) Object.assign(attributes, summarizeFormRequest(await requestBody()));
    work.setAttributes(attributes);
    log(summary.degraded ? "warn" : "info", `${route}: ${summary.message}`, attributes);
    proposedCounters(route, summary);
  } catch {
    // Observability must never be the reason a prediction fails.
  }
}

/**
 * A streamed answer (`/v1/shabang-text`) returns its Response as soon as the headers are ready, while the model is
 * still writing. Ending the transaction there would cut the trace at 6 ms and leave the `llm.stream` span orphaned,
 * which is the opposite of the truth: the user waited for the last token. So the transaction is kept open until the
 * body is done, and the stream is handed back wrapped in a reader that ends it (also on cancel, so a client that
 * walks away cannot leave a span open forever).
 */
function holdOpenUntilStreamEnds(response: Response, transaction: GhostSpan, started: number): Response {
  const body = response.body;
  if (!body) return response;
  const reader = body.getReader();
  let closed = false;
  const finish = (ok: boolean): void => {
    if (closed) return;
    closed = true;
    transaction.setAttributes({ "http.response.status_code": response.status, "ghost.latency_ms": Math.round(performance.now() - started) });
    transaction.setStatus(ok);
    transaction.end();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(true);
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish(false);
        controller.error(err);
      }
    },
    cancel(reason) {
      finish(false);
      return reader.cancel(reason);
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function isStreamed(response: Response): boolean {
  return response.body !== null && (response.headers.get("content-type") ?? "").includes("text/event-stream");
}

/**
 * Returns undefined when Sentry is off, so `createApp` adds no middleware at all rather than a pass-through.
 */
export function tracingMiddleware(): MiddlewareHandler | undefined {
  if (!isEnabled()) return undefined;
  return async function ghostTracing(c, next) {
    const route = routeOf(c.req.path);
    const method = c.req.method;
    const work = workSpanName(route);
    // Hono caches a parsed body, so asking for it AFTER the handler re-reads the cache rather than the socket.
    const requestBody = async (): Promise<unknown> => {
      try {
        return (await c.req.json()) as unknown;
      } catch {
        return undefined;
      }
    };
    await spanManualIn(
      { name: transactionName(method, c.req.path), op: "http.server", transaction: true, attributes: { "http.request.method": method, "ghost.route": route } },
      async (transaction) => {
        const started = performance.now();
        const run = async (inner: GhostSpan): Promise<void> => {
          await next();
          await report(route, c.res, inner, requestBody);
        };
        try {
          // A route without work of its own (health, presence, the client's metrics) still reports onto its transaction.
          if (work) await span({ name: work, op: "ghost.predict", attributes: { "ghost.route": route } }, run);
          else await run(transaction);
        } catch (err) {
          transaction.setStatus(false, err instanceof Error ? err.name : "error");
          transaction.setAttributes({ "ghost.latency_ms": Math.round(performance.now() - started) });
          transaction.end();
          // The Hono auto-instrumentation is switched off, so this is where an unhandled route error becomes an event.
          captureError(err, { "ghost.route": route, "http.request.method": method });
          throw err;

        }
        // Hono catches a handler's exception itself and answers 500, so `c.error` is where an unhandled error shows
        // up; the catch above only fires for one thrown outside the handler chain.
        if (c.error) captureError(c.error, { "ghost.route": route, "http.request.method": method });
        if (isStreamed(c.res)) {
          c.res = holdOpenUntilStreamEnds(c.res, transaction, started);
          return;
        }
        const status = c.res.status;
        transaction.setAttributes({ "http.response.status_code": status, "ghost.latency_ms": Math.round(performance.now() - started) });
        transaction.setStatus(status < 500, status < 500 ? undefined : `http ${status}`);
        transaction.end();
      },
    );
  };
}
