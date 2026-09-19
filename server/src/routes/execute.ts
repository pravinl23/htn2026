import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "../config";
import { TOKEN_HEADER, UNTRUSTED_REAL_RUN, admit, classifyCaller } from "../executors/access";
import { recordedOrigins } from "../executors/browserbase";
import { compile } from "../executors/composio";
import { createExecutors, type ExecutorDeps } from "../executors/index";
import { createRunRegistry, type ActiveRun, type RunRegistry } from "../executors/runs";
import { irreversibleEffects } from "../executors/steps";
import { createTicketOffice, hashJob, type RedeemResult, type TicketOffice } from "../executors/tickets";
import { ExecutorRefusal, type ExecuteJob, type ExecuteReport, type LoopExecutor } from "../executors/types";
import { EXECUTE_LIMITS, parseCompileRequest, parseExecuteRequest } from "../executors/validation";
import { getMetrics, type Metrics } from "../lib/metrics";
import { sseResponse } from "../lib/sse";
import { BadRequest, readJsonBody } from "../providers/validation";

const EXECUTORS_ROUTE = "/v1/executors";
const COMPILE_ROUTE = "/v1/loop/compile";
const PREVIEW_ROUTE = "/v1/loop/preview";
const EXECUTE_ROUTE = "/v1/loop/execute";

/** Test seam: the third argument is optional so `registerExecuteRoutes(app, config)` stays the public signature. */
export interface ExecuteDeps extends ExecutorDeps {
  executors?: Partial<Record<"parallel" | "api", LoopExecutor>>;
  metrics?: Metrics;
  log?: (line: string) => void;
  tickets?: TicketOffice;
  runs?: RunRegistry;
  /** Overall budget of one run, in ms. */
  deadlineMs?: number;
}

const TOKEN_REFUSAL: Record<Exclude<RedeemResult, { ok: true }>["reason"], string> = {
  unknown: "confirmToken is unknown or was already used: preview the run again",
  expired: "confirmToken has expired: preview the run again",
  mismatch: "confirmToken was issued for a different mode, program, items or baseUrl: preview the run again",
};

function series(report: ExecuteReport): string {
  if (report.simulated) return "simulated";
  return report.mode === "parallel" ? "browserbase" : "composio";
}

export function registerExecuteRoutes(app: Hono, config: ServerConfig, deps: ExecuteDeps = {}): void {
  const executors = { ...createExecutors(config, deps), ...deps.executors };
  const metrics = deps.metrics ?? getMetrics(config);
  const log = deps.log ?? ((line: string) => (process.env.VITEST ? undefined : console.log(line)));
  const tickets = deps.tickets ?? createTicketOffice(deps.now);
  const runs = deps.runs ?? createRunRegistry();
  const access = { extensionId: config.extensionId, executeToken: config.executeToken };
  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);

  /** Maps the refusals every route shares. Anything else is a bug and becomes a 500. */
  async function guarded(c: Context, handler: () => Promise<Response>): Promise<Response> {
    try {
      return await handler();
    } catch (err) {
      if (err instanceof BadRequest) return c.json({ error: err.message }, err.status);
      if (err instanceof ExecutorRefusal) return c.json({ error: err.message, ...err.details }, 400);
      throw err;
    }
  }

  /** What the user confirms, exactly once: every click and locked fill with how often it runs, and every site the run touches. */
  function summary(job: ExecuteJob): { items: number; irreversible: Array<{ stepIndex: number; description: string; count: number }>; origins: string[] } {
    const count = job.items.length;
    return { items: count, irreversible: irreversibleEffects(job.program).map((effect) => ({ ...effect, count })), origins: recordedOrigins(job) };
  }

  /**
   * "visible" and "background" run inside the extension and are always there; the server only reports them so the UI has one list.
   * `authorized` tells THIS caller whether preview/execute would accept it for that mode (a real executor needs a pinned caller).
   */
  app.get(EXECUTORS_ROUTE, (c) => {
    const verdict = classifyCaller(access, c.req.header("origin"), c.req.header(TOKEN_HEADER));
    const admitted = !("refuse" in verdict);
    const trusted = admitted && verdict.trusted;
    return c.json([
      { mode: "visible", available: true },
      { mode: "background", available: true },
      ...[executors.parallel, executors.api].map((e) => ({
        mode: e.mode,
        available: e.available,
        ...(e.reason ? { reason: e.reason } : {}),
        simulated: !e.available,
        authorized: admitted && (trusted || !e.available),
      })),
    ]);
  });

  app.post(COMPILE_ROUTE, bodyLimit({ maxSize: EXECUTE_LIMITS.compileBodyBytes, onError: tooLarge }), (c) =>
    guarded(c, async () => {
      const caller = admit(c, access);
      if (caller instanceof Response) return caller;
      return c.json(compile(parseCompileRequest(await readJsonBody(c.req, EXECUTE_LIMITS.compileBodyBytes))));
    }),
  );

  app.post(PREVIEW_ROUTE, bodyLimit({ maxSize: EXECUTE_LIMITS.executeBodyBytes, onError: tooLarge }), (c) =>
    guarded(c, async () => {
      const caller = admit(c, access);
      if (caller instanceof Response) return caller;
      const { mode, job } = parseExecuteRequest(await readJsonBody(c.req, EXECUTE_LIMITS.executeBodyBytes));
      const executor = executors[mode];
      if (executor.available && !caller.trusted) return c.json({ error: UNTRUSTED_REAL_RUN }, 403);
      const alreadyRun = executor.available ? runs.alreadyRun(job.program.id, job.items) : [];
      if (alreadyRun.length > 0) return c.json({ error: "some items already ran for this program: remove them and preview again", alreadyRun }, 409);
      // Unreachable or private URLs and uncovered steps are refused here, before the user is asked to confirm anything.
      await executor.check(job);
      const ticket = tickets.issue(hashJob(mode, job));
      return c.json({ ...ticket, mode, simulated: !executor.available, ...summary(job) });
    }),
  );

  app.post(EXECUTE_ROUTE, bodyLimit({ maxSize: EXECUTE_LIMITS.executeBodyBytes, onError: tooLarge }), (c) =>
    guarded(c, async () => {
      const caller = admit(c, access);
      if (caller instanceof Response) return caller;
      const { mode, job, confirmToken } = parseExecuteRequest(await readJsonBody(c.req, EXECUTE_LIMITS.executeBodyBytes));
      const executor = executors[mode];
      if (executor.available && !caller.trusted) return c.json({ error: UNTRUSTED_REAL_RUN }, 403);
      if (confirmToken === undefined) {
        return c.json({ error: "confirmToken is required: POST /v1/loop/preview, show its list to the user, and send the token it returned", ...summary(job) }, 400);
      }
      const busy = runs.active();
      if (busy) return c.json({ error: "another run is in progress", runId: busy.runId }, 409);
      const redeemed = tickets.redeem(confirmToken, hashJob(mode, job));
      if (!redeemed.ok) return c.json({ error: TOKEN_REFUSAL[redeemed.reason] }, 409);
      const alreadyRun = executor.available ? runs.alreadyRun(job.program.id, job.items) : [];
      if (alreadyRun.length > 0) return c.json({ error: "some items already ran for this program: remove them and preview again", alreadyRun }, 409);
      // No await since runs.active(): the lock cannot be taken twice.
      const run = runs.begin(redeemed.runId, job.program.id, deps.deadlineMs);
      if (!run) return c.json({ error: "another run is in progress" }, 409);
      // A client that went away (tab closed, extension worker killed, Esc) can no longer supervise the run: it stops.
      c.req.raw.signal.addEventListener("abort", () => run.stop("disconnected"), { once: true });
      // Only here, after the single-use token matched this exact job, does the batch count as confirmed.
      const confirmed: ExecuteJob = { ...job, confirmIrreversible: true };

      if (c.req.query("stream") !== "1") {
        try {
          return c.json({ runId: run.runId, report: await perform(executor, confirmed, run) });
        } finally {
          run.finish();
        }
      }
      return sseResponse(async (send, gone) => {
        gone.addEventListener("abort", () => run.stop("disconnected"), { once: true });
        try {
          send({ runId: run.runId, total: job.items.length });
          const report = await perform(executor, confirmed, run, (progress) => send({ progress }));
          send({ done: true, runId: run.runId, report });
        } catch (err) {
          send({ done: true, runId: run.runId, error: err instanceof ExecutorRefusal ? err.message : "the run failed" });
        } finally {
          run.finish();
        }
      });
    }),
  );

  /** Esc in the UI. In-flight items stop before their next step; no new item starts. Answers 404 for a run that is not active. */
  app.delete(`${EXECUTE_ROUTE}/:runId`, (c) => {
    const caller = admit(c, access);
    if (caller instanceof Response) return caller;
    const runId = c.req.param("runId");
    return runs.cancel(runId, "cancelled") ? c.json({ runId, cancelled: true }) : c.json({ error: "no active run with this id" }, 404);
  });

  async function perform(executor: LoopExecutor, job: ExecuteJob, run: ActiveRun, onProgress?: (p: unknown) => void): Promise<ExecuteReport> {
    const report = await executor.run(job, { signal: run.signal, onProgress });
    runs.record(job.program.id, report);
    const failed = report.results.filter((r) => !r.ok).length;
    const latencyMs = report.finishedAt - report.startedAt;
    metrics.recordLatency(EXECUTE_ROUTE, series(report), latencyMs, failed === 0);
    // Names and numbers only: never an item URL, a var, a token or a key.
    log(
      `[ghost] ${series(report)} ${EXECUTE_ROUTE} ${latencyMs}ms mode=${report.mode} items=${report.results.length} failed=${failed} irreversible=${irreversibleEffects(job.program).length}${report.stopped ? ` stopped=${report.stopped}` : ""}`,
    );
    return report;
  }
}
