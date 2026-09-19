// POST /v1/loop/synthesize, asked only when the heuristics left a fill unresolved (docs/loops.md 3.3). This is
// the one place typed values leave the extension. The route may not exist yet (404/501) or may be slow: every
// failure resolves to null and the caller keeps its heuristic program. The answer is never trusted as a program:
// only `extract` steps for the variables that were unresolved are taken from it, so a reply can neither add a
// click, unlock a locked step, nor point the run at another page.
import type { FactLocator, FactsByUrl, LoopProgram, LoopStep, TraceEvent, ValueTransform } from "@ghost/shared";
import { normalizeServerUrl, serverBaseUrl } from "./serverClient";
import type { FetchLike } from "./serverClient";

export const SYNTHESIZE_TIMEOUT_MS = 4000;
/** Replaces the synthesizer's 0.5 "unresolved" penalty with 0.8: a model's locator is plausible, not verified. */
const REMOTE_RESOLVED_FACTOR = 1.6;
const LOCATOR_MAX = 300;

export interface RemoteSynthesisRequest {
  runs: [TraceEvent[], TraceEvent[]];
  /** Facts of the pages the two runs visited, nothing else. */
  pageSamples: FactsByUrl;
  /** The heuristic program with its `unresolved` list: what the server is asked to complete. */
  program: LoopProgram;
}

/** Resolves to the raw reply (`{ program }` or a program), or null when there is none. May reject: callers tolerate it. */
export type RemoteSynthesizer = (request: RemoteSynthesisRequest) => Promise<unknown>;

export interface RemoteSynthesizerDeps {
  fetch?: FetchLike;
  getServerUrl?: () => Promise<string | null>;
  timeoutMs?: number;
}

export function createRemoteSynthesizer(deps: RemoteSynthesizerDeps = {}): RemoteSynthesizer {
  return async (request) => {
    const configured = await (deps.getServerUrl ?? serverBaseUrl)().catch(() => null);
    const base = configured ? normalizeServerUrl(configured) : null;
    if (!base) return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? SYNTHESIZE_TIMEOUT_MS);
    try {
      const response = await (deps.fetch ?? fetch)(`${base}/v1/loop/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(request),
        signal: abort.signal,
        credentials: "omit",
        cache: "no-store",
      });
      return response.ok ? ((await response.json()) as unknown) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

type ExtractStep = Extract<LoopStep, { op: "extract" }>;

const LOCATOR_KINDS: ReadonlySet<string> = new Set<FactLocator["by"]>(["testid", "data-field", "id", "label", "css"]);
const TRANSFORMS: ReadonlySet<string> = new Set<ValueTransform>(["number", "date-iso", "trim"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanExtract(raw: unknown, wanted: ReadonlySet<string>): ExtractStep | null {
  if (!isObject(raw) || raw.op !== "extract" || typeof raw.var !== "string" || !wanted.has(raw.var) || !isObject(raw.from)) return null;
  const { pathPattern, locator, transform } = raw.from;
  if (typeof pathPattern !== "string" || !isObject(locator) || typeof locator.by !== "string" || !LOCATOR_KINDS.has(locator.by)) return null;
  if (typeof locator.value !== "string" || locator.value === "" || locator.value.length > LOCATOR_MAX) return null;
  const from: ExtractStep["from"] = { pathPattern, locator: { by: locator.by, value: locator.value } as FactLocator };
  if (typeof transform === "string" && TRANSFORMS.has(transform)) from.transform = transform as ValueTransform;
  return { op: "extract", var: raw.var, from };
}

/** Where a page pattern is first on screen in the program, or -1 when the program never shows it. */
function anchorOf(program: LoopProgram, pathPattern: string): number {
  if (pathPattern === program.iterator.pathPattern) return 0;
  const opened = program.steps.findIndex((s) => s.op === "open-item");
  if (pathPattern === program.iterator.itemPathPattern && opened >= 0) return opened + 1;
  const gone = program.steps.findIndex((s) => s.op === "goto" && s.pathPattern === pathPattern);
  return gone >= 0 ? gone + 1 : -1;
}

function remoteSteps(raw: unknown): unknown[] {
  const program = isObject(raw) && isObject(raw.program) ? raw.program : raw;
  return isObject(program) && Array.isArray(program.steps) ? program.steps : [];
}

/**
 * The heuristic program completed with the server's extract steps for its unresolved variables.
 * Null when the reply resolves nothing, so the caller keeps the heuristic program as it is.
 */
export function mergeRemoteProgram(program: LoopProgram, raw: unknown): LoopProgram | null {
  const wanted = new Set((program.unresolved ?? []).map((u) => u.var));
  const inserts = new Map<number, ExtractStep[]>();
  for (const candidate of remoteSteps(raw)) {
    const step = cleanExtract(candidate, wanted);
    const anchor = step ? anchorOf(program, step.from.pathPattern) : -1;
    if (!step || anchor < 0) continue;
    wanted.delete(step.var); // the first answer for a variable wins
    inserts.set(anchor, [...(inserts.get(anchor) ?? []), step]);
  }
  if (inserts.size === 0) return null;
  const steps: LoopStep[] = [];
  const moved: number[] = [];
  for (let i = 0; i <= program.steps.length; i++) {
    steps.push(...(inserts.get(i) ?? []));
    const step = program.steps[i];
    if (step) moved[i] = steps.push(step) - 1;
  }
  const at = (index: number): number => moved[index] ?? index;
  const unresolved = (program.unresolved ?? []).filter((u) => wanted.has(u.var)).map((u) => ({ ...u, stepIndex: at(u.stepIndex) }));
  const resolved = (program.unresolved ?? []).length - unresolved.length;
  return {
    ...program,
    steps,
    irreversible: program.irreversible.map((effect) => ({ ...effect, stepIndex: at(effect.stepIndex) })),
    unresolved,
    confidence: Math.min(1, Math.round(program.confidence * REMOTE_RESOLVED_FACTOR ** resolved * 100) / 100),
  };
}
