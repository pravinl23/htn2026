/**
 * Sentry initialisation. Imported first by `server/src/index.ts`, before the config, the app or any route module, so
 * the SDK is in place before anything it instruments is loaded.
 *
 * Without SENTRY_DSN this is a complete no-op: the SDK is never imported, `Sentry.init` is never called, no socket is
 * opened and nothing is queued. That is not a convenience, it is the contract the unit tests and the e2e run depend on.
 * The import is dynamic and its specifier is assembled at run time so that the single-file bundle (server/build.mjs)
 * does not try to inline the SDK and its native profiler; a bundle without the packages next to it simply runs with
 * observability off.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scrubEvent, scrubLog, scrubMetric } from "./scrub";
import { attachSdk } from "./sentry";

type SentryNode = typeof import("@sentry/node");
type Profiling = typeof import("@sentry/profiling-node");

// Assembled at run time: esbuild cannot fold this, so it stays a real dynamic import in the bundle.
const SENTRY_NODE = ["@sentry", "node"].join("/");
const SENTRY_PROFILING = ["@sentry", "profiling-node"].join("/");

/**
 * Default integrations that would carry data we promised never to send.
 * - LocalVariables attaches the local variables of every stack frame to an error: one crash inside the form predictor
 *   would ship the captured fields, labels and all.
 * - Console turns every `console.log` into a breadcrumb. Ghost's own log lines are counts only, but a dependency's
 *   are not, and a breadcrumb is not covered by the log scrubber.
 * - RequestData attaches the incoming URL, headers and body. The route name is already on the transaction.
 * - Hono is the auto-instrumentation for this framework. It opens a SECOND transaction per request (named after the
 *   raw path, so an unmatched URL becomes the transaction name) around the one `middleware.ts` opens, and fills the
 *   trace with sub-millisecond `middleware.hono` spans. One deliberate transaction per request reads better and keeps
 *   the naming under our control; errors are captured by the middleware instead.
 */
const DROP_INTEGRATIONS = new Set(["LocalVariables", "Console", "RequestData", "Hono"]);

export interface InstrumentResult {
  enabled: boolean;
  environment: string;
  release?: string;
  profiling: boolean;
  /** Why profiling is off although Sentry is on (a Node release with no prebuilt profiler, for instance). */
  profilingReason?: string;
  /** Why it is off, when it is off. Printed once at start so a missing DSN is never a silent mystery. */
  reason?: string;
}

type Env = Record<string, string | undefined>;

function sampleRate(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * The git short sha, read straight from `.git` (two small file reads, no subprocess). Returns undefined rather than
 * guessing: a wrong release tag is worse than none, because it silently merges two builds in the UI.
 */
export function gitRelease(from: string = process.cwd()): string | undefined {
  const gitDir = findGitDir(from);
  if (!gitDir) return undefined;
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 7) : undefined;
    const ref = head.slice(4).trim();
    const direct = readRef(join(gitDir, ref));
    if (direct) return direct;
    const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      const [sha, name] = line.split(" ");
      if (name === ref && sha && /^[0-9a-f]{40}$/.test(sha)) return sha.slice(0, 7);
    }
  } catch {
    // No .git, a shallow copy, a permission problem: the release is simply unknown.
  }
  return undefined;
}

function readRef(path: string): string | undefined {
  try {
    const sha = readFileSync(path, "utf8").trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : undefined;
  } catch {
    return undefined;
  }
}

function findGitDir(from: string): string | undefined {
  let dir = resolve(from);
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, ".git");
    try {
      const stat = readFileSync(candidate, "utf8");
      // A worktree or submodule: `.git` is a file that points at the real directory.
      const match = /^gitdir:\s*(.+)$/m.exec(stat);
      if (match?.[1]) return resolve(dir, match[1].trim());
    } catch {
      // `.git` is a directory (readFileSync on a directory throws EISDIR), or it is not here at all.
      try {
        readFileSync(join(candidate, "HEAD"), "utf8");
        return candidate;
      } catch {
        // keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * `@sentry/profiling-node` ships prebuilt binaries for LTS releases only (the even majors). On anything else it
 * prints a stack trace at import and then silently collects nothing, so it is not loaded at all: a startup line that
 * says `profiling=off` is more useful than one that says `on` and produces no profile.
 */
function profilerSupported(): boolean {
  const major = Number(process.versions.node.split(".")[0]);
  return Number.isInteger(major) && major >= 18 && major % 2 === 0;
}

async function loadProfiling(): Promise<Profiling | undefined> {
  if (!profilerSupported()) return undefined;
  try {
    return (await import(SENTRY_PROFILING)) as Profiling;
  } catch {
    // Not installed (the single-file bundle has no node_modules beside it). Everything else still works.
    return undefined;
  }
}

/**
 * Starts Sentry when a DSN is configured. Safe to call more than once: the second call is ignored.
 * Never throws: an observability problem must not stop the prediction server from answering.
 */
export async function initObservability(env: Env = process.env): Promise<InstrumentResult> {
  const environment = env.GHOST_ENV || "dev";
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return { enabled: false, environment, profiling: false, reason: "SENTRY_DSN is not set" };
  try {
    const Sentry = (await import(SENTRY_NODE)) as SentryNode;
    if (Sentry.isInitialized()) {
      attachSdk(Sentry);
      return { enabled: true, environment, profiling: false, reason: "already initialized" };
    }
    const profilesRate = sampleRate(env.SENTRY_PROFILES_SAMPLE_RATE, 1);
    const profiling = profilesRate > 0 ? await loadProfiling() : undefined;
    const release = env.SENTRY_RELEASE?.trim() || gitRelease();
    Sentry.init({
      dsn,
      environment,
      release,
      // The demo is a handful of requests, and every one of them is the thing we want to look at.
      tracesSampleRate: sampleRate(env.SENTRY_TRACES_SAMPLE_RATE, 1),
      profileSessionSampleRate: profiling ? profilesRate : 0,
      // Profiles are attached to traces, so a slow prediction comes with the stacks that made it slow.
      profileLifecycle: "trace",
      enableLogs: true,
      enableMetrics: true,
      sendDefaultPii: false,
      // The machine name is the user's, and nothing here needs it.
      serverName: "ghost-server",
      integrations: (defaults) => [
        ...defaults.filter((integration) => !DROP_INTEGRATIONS.has(integration.name)),
        // Every span in a Ghost trace is one we started on purpose; the automatic HTTP spans would only add noise,
        // and their breadcrumbs carry full URLs with query strings.
        Sentry.httpIntegration({ spans: false, breadcrumbs: false }),
        Sentry.nativeNodeFetchIntegration({ spans: false, breadcrumbs: false }),
        ...(profiling ? [profiling.nodeProfilingIntegration()] : []),
      ],
      beforeSend: (event) => scrubEvent(event),
      beforeSendTransaction: (event) => scrubEvent(event),
      beforeSendLog: (entry) => scrubLog(entry),
      beforeSendMetric: (metric) => scrubMetric(metric),
    });
    attachSdk(Sentry);
    return {
      enabled: true,
      environment,
      release,
      profiling: profiling !== undefined,
      profilingReason: profiling ? undefined : profilerSupported() ? "@sentry/profiling-node is not installed" : `node ${process.versions.node} has no prebuilt profiler (LTS releases only)`,
    };
  } catch (err) {
    return { enabled: false, environment, profiling: false, reason: err instanceof Error ? err.message : "the Sentry SDK could not be loaded" };
  }
}

/** The one line the server prints at start, so it is never a mystery whether traces are being sent. */
export function describe(result: InstrumentResult): string {
  if (!result.enabled) return `[ghost] sentry off (${result.reason ?? "disabled"})`;
  const release = result.release ? ` release=${result.release}` : "";
  const profiling = result.profiling ? "on" : `off (${result.profilingReason ?? "disabled"})`;
  return `[ghost] sentry on env=${result.environment}${release} traces=1.0 profiling=${profiling} logs=on metrics=on`;
}
