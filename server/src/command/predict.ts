import { createHash } from "node:crypto";
import { NONE, type Answers, type ChoiceQuestion, type DecisionProvider, type Questions } from "@shabang/shared";
import { LruCache } from "../lib/cache";
import { withDeadline } from "../providers/timeout";
import { buildCandidates, cleanRequest, pickHeuristic, type Candidate, type CleanCommandRequest, type CommandRequest, type GitSummary } from "./candidates";
import { isSecretCommand, isSuggestible, looksSecret } from "./filter";

export const COMMAND_TIMEOUT_MS = 1500;
export const COMMAND_QUESTION = "next_command";
/** The model sees the most recent commands only: accuracy drops when the state fills with old, irrelevant lines. */
export const STATE_COMMANDS = 15;
const CACHE_ENTRIES = 500;
const HEURISTIC = "heuristic";

export interface CommandPrediction {
  command: string | null;
  confidence: number;
  provider: string;
  calibrated: boolean;
  latencyMs: number;
  cache: "hit" | "miss";
  /** How many candidates code built (numbers only, never the commands). */
  candidates: number;
  fallbackFrom?: string;
}

type Outcome = Omit<CommandPrediction, "latencyMs" | "cache">;

// A type alias, not an interface: only aliases are assignable to DecisionState's Record<string, unknown>.
export type CommandState = {
  cwd: string;
  git?: GitSummary;
  lastCommands: string[];
  lastExitCode?: number;
};

export interface CommandDecision {
  state: CommandState;
  questions: Questions;
  /** Option name (c0, c1, ...) -> command. */
  aliases: Record<string, string>;
}

export interface CommandPredictorOptions {
  provider: DecisionProvider;
  timeoutMs?: number;
  cache?: LruCache<Outcome>;
  onModelCall?: (info: { provider: string; latencyMs: number; questions: number; calibrated: boolean; ok: boolean }) => void;
}

/**
 * An option is the command plus the evidence code found for it, in words: Jev reads text and is bad at counting, so
 * code counts and states the result. No backticks here: those refer to paths in the state.
 */
export function describeCandidate(c: Candidate): string {
  const notes: string[] = [];
  if (c.bigram > 0) notes.push(`ran right after the last command ${c.bigram === 1 ? "once" : `${c.bigram} times`} earlier in this session`);
  if (c.reason) notes.push(c.reason);
  if (c.sources.includes("script")) notes.push("a script defined by this project");
  return notes.length > 0 ? `${c.command}  (${notes.join("; ")})` : c.command;
}

/** ONE choice question over candidate ids plus none. State: { cwd, git, lastCommands } (+ lastExitCode when known). */
export function buildCommandDecision(req: CleanCommandRequest, candidates: Candidate[]): CommandDecision {
  const criteria: ChoiceQuestion["criteria"] = {};
  const aliases: Record<string, string> = {};
  candidates.forEach((c, i) => {
    aliases[`c${i}`] = c.command;
    criteria[`c${i}`] = describeCandidate(c);
  });
  criteria[NONE] = "none of these is clearly the command they will run next";
  const state: CommandState = {
    cwd: req.cwd,
    ...(req.git ? { git: req.git } : {}),
    lastCommands: req.history.slice(-STATE_COMMANDS),
  };
  if (req.lastExitCode !== undefined) state.lastExitCode = req.lastExitCode;
  const context = [
    "A developer is working in a terminal in the directory `cwd`",
    req.git ? " of a git repository whose status is `git` (dirty: uncommitted changes; ahead/behind: commits relative to the upstream)" : "",
    ". `lastCommands` lists the shell commands they ran, oldest first; the last entry just finished",
    req.lastExitCode !== undefined ? " with exit status `lastExitCode` (0 means success)" : "",
    ".",
  ].join("");
  const instructions = `${context} Which option is the shell command they will run next? Answer none unless one option is clearly the most likely next command.`;
  return { state, questions: { [COMMAND_QUESTION]: { type: "choice", instructions, criteria } }, aliases };
}

export function readCommandAnswer(answers: Answers, aliases: Record<string, string>): { command: string | null; confidence: number } | undefined {
  const answer = answers[COMMAND_QUESTION];
  if (answer?.type !== "choice" || !Number.isFinite(answer.confidence)) return undefined;
  const confidence = Math.min(1, Math.max(0, answer.confidence));
  if (answer.choice === NONE) return { command: null, confidence };
  if (!Object.hasOwn(aliases, answer.choice)) return undefined;
  return { command: aliases[answer.choice] ?? null, confidence };
}

/** Hash of (cwd, git summary, last 3 commands, prefix, last exit status). Raw commands never become map keys. */
export function commandCacheKey(req: CleanCommandRequest): string {
  const git = req.git ? [req.git.branch, req.git.dirty, req.git.ahead > 0, req.git.behind > 0, req.git.untracked > 0] : null;
  const material = JSON.stringify([req.cwd, git, req.history.slice(-3), req.prefix, req.lastExitCode ?? null]);
  return createHash("sha256").update(material).digest("hex");
}

/** Defense in depth: whatever a provider or the cache returns, a destructive or secret-looking command is never sent. */
function safe(outcome: Outcome, prefix: string): Outcome {
  if (outcome.command === null) return outcome;
  if (outcome.command.startsWith(prefix) && outcome.command !== prefix && isSuggestible(outcome.command)) return outcome;
  return { ...outcome, command: null, confidence: 0 };
}

export function createCommandPredictor(options: CommandPredictorOptions): (req: CommandRequest) => Promise<CommandPrediction> {
  const { provider, timeoutMs = COMMAND_TIMEOUT_MS, onModelCall } = options;
  const cache = options.cache ?? new LruCache<Outcome>(CACHE_ENTRIES);
  const inflight = new Map<string, Promise<Outcome>>();

  function heuristic(candidates: Candidate[], prefix: string, fallbackFrom?: string): Outcome {
    return { ...pickHeuristic(candidates, prefix), provider: HEURISTIC, calibrated: false, candidates: candidates.length, ...(fallbackFrom ? { fallbackFrom } : {}) };
  }

  async function askModel(req: CleanCommandRequest, candidates: Candidate[]): Promise<Outcome> {
    const { state, questions, aliases } = buildCommandDecision(req, candidates);
    const started = performance.now();
    const report = (ok: boolean) =>
      onModelCall?.({ provider: provider.name, latencyMs: Math.round(performance.now() - started), questions: 1, calibrated: provider.calibrated, ok });
    try {
      const result = await withDeadline(timeoutMs, () => provider.decide(state, questions));
      const pick = readCommandAnswer(result.answers, aliases);
      if (!pick) throw new Error("unusable answer");
      report(true);
      return { ...pick, provider: result.provider, calibrated: result.calibrated, candidates: candidates.length };
    } catch {
      report(false);
      return heuristic(candidates, req.prefix, provider.name);
    }
  }

  async function compute(req: CleanCommandRequest): Promise<{ outcome: Outcome; cache: "hit" | "miss" }> {
    const candidates = buildCandidates(req);
    if (candidates.length === 0) return { outcome: { command: null, confidence: 0, provider: HEURISTIC, calibrated: false, candidates: 0 }, cache: "miss" };
    if (provider.name === HEURISTIC) return { outcome: heuristic(candidates, req.prefix), cache: "miss" };

    const key = commandCacheKey(req);
    const cached = cache.get(key);
    // A hit only counts while its command is still one of this request's candidates (older history may differ).
    if (cached && (cached.command === null || candidates.some((c) => c.command === cached.command))) return { outcome: { ...cached, candidates: candidates.length }, cache: "hit" };

    let pending = inflight.get(key);
    if (!pending) {
      pending = askModel(req, candidates).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const outcome = await pending;
    if (!outcome.fallbackFrom) cache.set(key, outcome);
    return { outcome, cache: "miss" };
  }

  return async function predictCommand(raw) {
    const started = performance.now();
    const req = cleanRequest(raw);
    // A typed buffer that looks like a secret, or that is typed right after ssh-keygen / gpg / security ... (the
    // likeliest place for a pasted passphrase), is never used, cached or sent anywhere.
    const afterSecretCommand = isSecretCommand((raw.history.at(-1) ?? "").trim());
    if (looksSecret(req.prefix) || (req.prefix !== "" && afterSecretCommand)) {
      return { command: null, confidence: 0, provider: HEURISTIC, calibrated: false, latencyMs: Math.round(performance.now() - started), cache: "miss", candidates: 0 };
    }
    const { outcome, cache: status } = await compute(req);
    return { ...safe(outcome, req.prefix), latencyMs: Math.round(performance.now() - started), cache: status };
  }
}
