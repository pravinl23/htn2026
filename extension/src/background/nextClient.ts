// Next-action prediction in the worker (docs/loops.md section 2): answers "ghost:next-candidates". Episodic memory
// answers first with zero network; with a server configured, POST /v1/predict/next gets the tab's last 20 actions
// (what was acted on, never a value), the candidates and the top 5 memories. A confident memory wins when the
// server is down or slower than 800 ms.
//
// Recording is NOT done here: traceRouter.record already feeds every user action (clicks included) to
// memory.observe, with the events before it as the state. Recording again would count one demonstration twice.
//
// One site never learns about another. Only this origin's actions go out, as origin + path PATTERN (an account
// number in a path stays home). Memory pairs carry no origin, so exact and recent-site recall only count when this
// origin's own trace proves that the user performed that action in that recorded state.
import { EPISODIC_MAX_PAIRS, EPISODIC_TOP_K, NONE, actionFromEvent, actionKey, filterNoise, isSensitive, normalizeUrl, predictFromMemory, predictFromRecentSiteMemory, rankNextCandidates, stateSummary } from "@ghost/shared";
import type { EpisodicPair, MemoryPrediction, NextCandidate, NormalizedUrl, TraceEvent } from "@ghost/shared";
import { isLoopMessage, sanitizeNextCandidates } from "../lib/loopMessages";
import type { LoopMessageOf, NextPredictionReply } from "../lib/loopMessages";
import { getSettings } from "../lib/storage";
import type { EpisodicMemory } from "./episodic";
import { serverBaseUrl } from "./serverClient";
import type { FetchLike } from "./serverClient";
import type { LoopSender } from "./traceRouter";
import { TRACE_MAX_EVENTS } from "./traceStore";
import type { TraceStore } from "./traceStore";

export const NEXT_RECENT_ACTIONS = 20;
export const NEXT_MEMORY = EPISODIC_TOP_K;
/** How long a confident memory waits for the server before it answers on its own. */
export const MEMORY_RACE_MS = 800;
export const NEXT_TIMEOUT_MS = 2500;
export const MEMORY_PROVIDER = "memory";
export const BEST_EFFORT_CONFIDENCE = 0.25;
/** The router's own window for "the state before an action" (traceRouter SUMMARY_WINDOW). */
const ROUTER_WINDOW = 12;
/** Exact matches with different actions all have to be tallied, not just the top 5. */
const LOCAL_RECALL = 50;
/** Card numbers and US social security numbers, whatever the words around them (content/pageFacts.ts SENSITIVE_VALUE). */
const SENSITIVE_SHAPE = /\b(?:\d[ -]?){13,19}\b|\b\d{3}-\d{2}-\d{4}\b/;

export type NextMessage = LoopMessageOf<"ghost:next-candidates">;

/** One action as /v1/predict/next reads it: what was acted on, where. Never a typed value. */
export interface WireEvent {
  type: string;
  url: string;
  label?: string;
  kind?: string;
  signature?: string;
}

/** Server shape of a memory: in the state `summary`, right after `previousAction`, the user did `action`. */
export interface WireMemory {
  summary: string;
  previousAction?: WireEvent;
  action: Omit<WireEvent, "url">;
}

export interface NextRequestBody {
  origin: string;
  url: string;
  recentActions: WireEvent[];
  candidates: NextCandidate[];
  memory: WireMemory[];
}

export interface NextClientDeps {
  trace: Pick<TraceStore, "recent">;
  memory: Pick<EpisodicMemory, "retrieve" | "recent">;
  extensionId: string;
  fetch?: FetchLike;
  getServerUrl?: () => Promise<string | null>;
  getThreshold?: () => Promise<number>;
  isEnabled?: () => Promise<boolean>;
  now?: () => number;
  timeoutMs?: number;
  raceMs?: number;
}

export interface NextClient {
  /** Null when the message is not "ghost:next-candidates" from our own extension. */
  handle(message: unknown, sender: LoopSender): Promise<NextPredictionReply> | null;
}

interface ServerPick {
  candidateId: string;
  confidence: number;
  provider: string;
  calibrated: boolean;
}

/** Rule 3 by words or by shape: "SSN", or 123-45-6789 / a 13 to 19 digit run in a label, a signature or a summary. */
export function looksSensitive(text: string | undefined): boolean {
  return text !== undefined && (isSensitive({ label: text }) || SENSITIVE_SHAPE.test(text));
}

/** What the server and the model see of a place: origin + path pattern, so /accounts/00123456789 goes out as /accounts/:id. */
export function wirePlace(origin: string, pathPattern: string): string {
  return `${origin}${pathPattern}`;
}

export function toWireEvent(event: TraceEvent): WireEvent {
  const wire: WireEvent = { type: event.type, url: wirePlace(event.origin, event.pathPattern) };
  const target = event.target;
  if (target && !looksSensitive(target.label) && !looksSensitive(target.signature)) {
    wire.label = target.label;
    wire.kind = target.kind;
    wire.signature = target.signature;
  }
  return wire; // event.value and the raw url are never read
}

function wireAction(pair: EpisodicPair): WireMemory["action"] {
  const action: WireMemory["action"] = { type: pair.action.type, label: pair.action.label };
  if (pair.action.kind) action.kind = pair.action.kind;
  if (pair.action.signature) action.signature = pair.action.signature;
  return action;
}

function pairIsSensitive(pair: EpisodicPair): boolean {
  return looksSensitive(pair.action.label) || looksSensitive(pair.action.signature) || SENSITIVE_SHAPE.test(pair.summary);
}

/**
 * True when every event `summary` was built from happened on `origin`. A summary holds the labels and paths of the
 * last few non-noise events (stateSummary), so one built across sites would carry the other site's actions. The key
 * count is read from the summary itself: a label containing " > " only makes the check stricter.
 */
export function summaryIsFrom(summary: string, events: readonly TraceEvent[], origin: string): boolean {
  const keys = summary.split(" > ").length - 1;
  return keys === 0 || filterNoise(events).slice(-keys).every((event) => event.origin === origin);
}

/**
 * How often this origin's own trace shows each (state summary, action): the router's computation (the last 12
 * events of all tabs before a user action, synthetic ones never remembered) replayed over the stored trace. Only
 * states made entirely of this origin's events count.
 */
export function originEvidence(allEvents: readonly TraceEvent[], origin: string): Map<string, number> {
  const seen = new Map<string, number>();
  allEvents.forEach((event, i) => {
    if (event.origin !== origin || event.synthetic) return;
    const action = actionFromEvent(event);
    if (!action) return;
    const before = allEvents.slice(Math.max(0, i - ROUTER_WINDOW), i);
    const summary = stateSummary(before, event.pathPattern);
    if (!summaryIsFrom(summary, before, origin)) return;
    const key = `${summary}\n${actionKey(action)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  });
  return seen;
}

/** Pairs this origin demonstrated, counted only as often as it did; never another site's. */
export function learnedHere(recalled: readonly EpisodicPair[], evidence: ReadonlyMap<string, number>): EpisodicPair[] {
  const kept: EpisodicPair[] = [];
  for (const pair of recalled) {
    const count = Math.min(pair.count, evidence.get(`${pair.summary}\n${actionKey(pair.action)}`) ?? 0);
    if (count > 0 && !pairIsSensitive(pair)) kept.push({ ...pair, count });
  }
  return kept;
}

/**
 * The body of POST /v1/predict/next. Only this origin's actions of the tab. An exactly matching memory followed the
 * same last (non-noise) action as now, which is what the server's heuristic compares, so it carries that action as
 * `previousAction`. `recalled` must already be this origin's (learnedHere).
 */
export function buildNextRequest(place: NormalizedUrl, tabEvents: readonly TraceEvent[], candidates: NextCandidate[], summary: string, recalled: readonly EpisodicPair[]): NextRequestBody {
  const here = tabEvents.filter((event) => event.origin === place.origin);
  const last = filterNoise(here).at(-1);
  const previous = last ? toWireEvent(last) : undefined;
  const memory = recalled
    .filter((pair) => !pairIsSensitive(pair))
    .slice(0, NEXT_MEMORY)
    .map((pair): WireMemory => (pair.summary === summary && previous ? { summary: pair.summary, previousAction: previous, action: wireAction(pair) } : { summary: pair.summary, action: wireAction(pair) }));
  return {
    origin: place.origin,
    url: wirePlace(place.origin, place.pathPattern),
    recentActions: here.slice(-NEXT_RECENT_ACTIONS).map(toWireEvent),
    candidates,
    memory,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePick(raw: unknown, ids: ReadonlySet<string>): ServerPick | null {
  if (!isObject(raw) || typeof raw.candidateId !== "string" || typeof raw.confidence !== "number") return null;
  if (!Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) return null;
  if (raw.candidateId !== NONE && !ids.has(raw.candidateId)) return null; // an id we never offered is no answer
  const provider = typeof raw.provider === "string" && raw.provider.length <= 40 ? raw.provider : "server";
  return { candidateId: raw.candidateId, confidence: raw.confidence, provider, calibrated: raw.calibrated === true };
}

/** Unique ids, never the reserved "none" (the server answers 400 otherwise). */
function uniqueCandidates(raw: unknown): NextCandidate[] {
  const seen = new Set<string>([NONE]);
  const out: NextCandidate[] = [];
  for (const candidate of sanitizeNextCandidates(raw)) {
    if (seen.has(candidate.id) || looksSensitive(candidate.label) || SENSITIVE_SHAPE.test(candidate.id)) continue;
    seen.add(candidate.id);
    if (looksSensitive(candidate.context)) {
      const { context: _context, ...rest } = candidate;
      out.push(rest);
    } else {
      out.push(candidate);
    }
  }
  return out;
}

function senderOrigin(sender: LoopSender): string | null {
  try {
    return (sender.origin ?? (sender.url ? new URL(sender.url).origin : "")).toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Resolves with the promise's value, or undefined once `ms` passed. The timer never outlives the race. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createNextClient(deps: NextClientDeps): NextClient {
  const now = deps.now ?? Date.now;
  const isEnabled = deps.isEnabled ?? (async () => (await getSettings()).enabled);
  const getThreshold = deps.getThreshold ?? (async () => (await getSettings()).confidenceThreshold);

  /**
   * Tab summary first; the router summarizes the last actions of every tab, so that is the second key tried. Either
   * only when it is made of this origin's events, and only with pairs this origin demonstrated.
   */
  async function fromMemory(tabEvents: TraceEvent[], allEvents: TraceEvent[], place: NormalizedUrl, candidates: NextCandidate[]): Promise<{ summary: string; recalled: EpisodicPair[]; pick: MemoryPrediction }> {
    const nothing: MemoryPrediction = { candidateId: NONE, confidence: 0 };
    const evidence = originEvidence(allEvents, place.origin);
    const recall = async (key: string): Promise<EpisodicPair[]> => (evidence.size === 0 ? [] : learnedHere(await deps.memory.retrieve(key, LOCAL_RECALL), evidence));
    const summary = stateSummary(tabEvents, place.pathPattern);
    const recalled = summaryIsFrom(summary, tabEvents, place.origin) ? await recall(summary) : [];
    let pick = recalled.length > 0 ? predictFromMemory(summary, candidates, recalled) : nothing;
    const routerEvents = allEvents.slice(-ROUTER_WINDOW);
    const routerSummary = stateSummary(routerEvents, place.pathPattern);
    if (pick.candidateId === NONE && routerSummary !== summary && summaryIsFrom(routerSummary, routerEvents, place.origin)) {
      pick = predictFromMemory(routerSummary, candidates, await recall(routerSummary));
    }
    // Large SPAs rarely recreate the exact last-three-action state. Fall back to what this user did most recently
    // on this origin when that target is available now; evidence prevents another website's memory from entering.
    const recentHere = evidence.size === 0 ? [] : learnedHere(await deps.memory.recent(EPISODIC_MAX_PAIRS), evidence);
    if (pick.candidateId === NONE) pick = predictFromRecentSiteMemory(candidates, recentHere);
    const forServer = [...recalled, ...recentHere.filter((pair) => !recalled.some((exact) => exact.summary === pair.summary && actionKey(exact.action) === actionKey(pair.action)))];
    return { summary, recalled: forServer, pick };
  }

  async function askServer(base: string, body: NextRequestBody, ids: ReadonlySet<string>): Promise<ServerPick | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? NEXT_TIMEOUT_MS);
    try {
      const response = await (deps.fetch ?? fetch)(`${base}/v1/predict/next`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
        credentials: "omit",
        cache: "no-store",
      });
      return response.ok ? parsePick(await response.json(), ids) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function predict(message: NextMessage, sender: LoopSender): Promise<NextPredictionReply> {
    const started = now();
    const tabId = sender.tab?.id;
    const place = typeof message.url === "string" ? normalizeUrl(message.url) : null;
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || !place) return { ok: false, error: "bad-request" };
    if (senderOrigin(sender) !== place.origin) return { ok: false, error: "bad-origin" }; // the frame that asked, as Chrome reports it
    if (!(await isEnabled().catch(() => false))) return { ok: false, error: "disabled" };
    const candidates = uniqueCandidates(message.candidates);
    if (candidates.length === 0) return { ok: true, candidateId: NONE, confidence: 0, provider: MEMORY_PROVIDER, calibrated: false, latencyMs: now() - started };

    const allEvents = await deps.trace.recent(TRACE_MAX_EVENTS);
    const tabEvents = allEvents.filter((event) => event.tabId === tabId);
    const local = await fromMemory(tabEvents, allEvents, place, candidates);
    const answer = (pick: MemoryPrediction | ServerPick, provider: string, calibrated: boolean): NextPredictionReply =>
      ({ ok: true, candidateId: pick.candidateId, confidence: pick.confidence, provider, calibrated, latencyMs: now() - started });
    const bestEffort = (): MemoryPrediction => {
      if (local.pick.candidateId !== NONE) return local.pick;
      const last = filterNoise(tabEvents).at(-1)?.target;
      const candidate = rankNextCandidates(candidates, last)[0];
      return candidate
        ? { candidateId: candidate.id, confidence: BEST_EFFORT_CONFIDENCE }
        : local.pick;
    };
    const memoryAnswer = (): NextPredictionReply => answer(bestEffort(), MEMORY_PROVIDER, false);

    const base = await (deps.getServerUrl ?? serverBaseUrl)().catch(() => null);
    if (!base) return memoryAnswer();
    const threshold = await getThreshold().catch(() => 0.7);
    const confident = local.pick.candidateId !== NONE && local.pick.confidence >= threshold;
    const body = buildNextRequest(place, tabEvents, candidates, local.summary, local.recalled);
    const server = askServer(base, body, new Set(candidates.map((c) => c.id)));
    const picked = confident ? await within(server, deps.raceMs ?? MEMORY_RACE_MS) : await server;
    if (!picked) return memoryAnswer(); // down, refused, or slower than a memory that already knows
    // An uncalibrated "none" (the server's heuristic) does not overrule a memory that saw this exact state before.
    if (picked.candidateId === NONE) return memoryAnswer();
    return answer(picked, picked.provider, picked.calibrated);
  }

  return {
    handle(message, sender) {
      if (sender.id !== deps.extensionId || !isLoopMessage(message) || message.type !== "ghost:next-candidates") return null;
      return predict(message, sender).catch((): NextPredictionReply => ({ ok: false, error: "failed" }));
    },
  };
}

/** Production wiring, called synchronously at worker start with the trace router's own store and memory. */
export function registerNextClient(services: { trace: TraceStore; memory: EpisodicMemory }): NextClient {
  const client = createNextClient({ trace: services.trace, memory: services.memory, extensionId: chrome.runtime.id });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const reply = client.handle(message, sender);
    if (!reply) return false;
    void reply.then(sendResponse);
    return true; // keep the channel open for the async reply
  });
  return client;
}
