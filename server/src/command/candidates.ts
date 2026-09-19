import { filterHistory, isSuggestible, looksSecret } from "./filter";

export interface GitSummary {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  untracked: number;
}

/** The body of POST /v1/predict/command after validation. `history` is oldest first. */
export interface CommandRequest {
  cwd: string;
  git?: GitSummary;
  history: string[];
  projectScripts?: string[];
  prefix?: string;
  /** Exit status of the last command (0 = success). */
  lastExitCode?: number;
}

/** A request after the server-side safety pass: what the n-gram, the heuristic and the model may see. */
export interface CleanCommandRequest {
  cwd: string;
  git?: GitSummary;
  history: string[];
  projectScripts: string[];
  prefix: string;
  lastExitCode?: number;
}

export type CandidateSource = "ngram" | "context" | "recent" | "script";

export interface Candidate {
  command: string;
  sources: CandidateSource[];
  /** How often it followed the last command (bigram) plus the last two commands (trigram). */
  ngram: number;
  bigram: number;
  trigram: number;
  /** Prior of a context move (after `git add`, `git commit -m ""`), 0 when none applies. */
  prior: number;
  /** Why the context move applies, in words the model can read. */
  reason?: string;
  /** Index in history of its most recent occurrence (as a follower for n-gram candidates), -1 when never. */
  recency: number;
  /** Position in projectScripts, used as the last tie-break. */
  order: number;
}

export const MAX_CANDIDATES = 60;
const MAX_CWD = 100;
const MAX_BRANCH = 100;

/** Basename only, never a path; "~" stays "~". A secret-looking name is dropped. */
export function cwdBasename(cwd: string): string {
  const base = cwd.split("/").filter((p) => p !== "").pop() ?? "";
  return looksSecret(base) ? "" : base.slice(0, MAX_CWD);
}

/** Applies the same filter the shell client applies, again, before anything else reads the request. */
export function cleanRequest(req: CommandRequest): CleanCommandRequest {
  const git = req.git ? { ...req.git, branch: looksSecret(req.git.branch) ? "" : req.git.branch.slice(0, MAX_BRANCH) } : undefined;
  return {
    cwd: cwdBasename(req.cwd),
    ...(git ? { git } : {}),
    history: filterHistory(req.history),
    projectScripts: (req.projectScripts ?? []).map((s) => s.trim()).filter((s) => s !== "" && isSuggestible(s)),
    prefix: req.prefix ?? "",
    ...(req.lastExitCode !== undefined ? { lastExitCode: req.lastExitCode } : {}),
  };
}

const TEST_COMMAND = /(^|[\s:/@-])(test|tests|jest|vitest|pytest|rspec|phpunit|ctest|mocha)([\s:]|$)/;

interface Move {
  command: string;
  prior: number;
  reason: string;
}

function cloneDirectory(line: string): string | undefined {
  const args = line.split(/\s+/).slice(2).filter((a) => !a.startsWith("-"));
  const last = args[args.length - 1];
  if (!last) return undefined;
  const name = last.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop();
  return name && /^[A-Za-z0-9._-]+$/.test(name) ? name : undefined;
}

/** Small, explainable moves that ordinary code knows are likely next. Priors are uncalibrated heuristics. */
export function contextMoves(last: string | undefined, git: GitSummary | undefined, lastExitCode: number | undefined): Move[] {
  const moves: Move[] = [];
  const dirty = git !== undefined && (git.dirty || git.untracked > 0);
  const move = (command: string, prior: number, reason: string) => moves.push({ command, prior, reason });
  if (git && git.behind > 0) move("git pull", 0.5, "pulls the commits the branch is behind by");
  if (!last) return moves;

  if (lastExitCode !== undefined && lastExitCode !== 0 && TEST_COMMAND.test(last)) move(last, 0.75, "reruns the test command that just failed");
  if (/^git add(\s|$)/.test(last)) {
    move('git commit -m ""', 0.8, "commits the changes that were just staged");
    move("git status", 0.4, "checks what is staged");
  }
  if (/^git commit(\s|$)/.test(last) && git && git.ahead > 0) move("git push", 0.8, "pushes the new commit, the branch is ahead of its upstream");
  const newBranch = /^git (checkout -b|switch -c) ([A-Za-z0-9._/-]+)$/.exec(last)?.[2];
  if (newBranch) move(`git push -u origin ${newBranch}`, 0.5, "publishes the new branch");
  if (/^git status(\s|$)/.test(last) && git) {
    if (dirty) {
      move("git add -A", 0.6, "stages the uncommitted changes");
      move("git diff", 0.4, "reviews the uncommitted changes");
    } else if (git.ahead > 0) move("git push", 0.6, "pushes the commits the branch is ahead by");
  }
  if (/^git fetch(\s|$)/.test(last)) move("git status", 0.4, "checks the state after fetching");
  if (/^git stash( push.*)?$/.test(last)) move("git stash pop", 0.5, "restores the stashed changes");
  if (/^git clone\s/.test(last)) {
    const dir = cloneDirectory(last);
    if (dir) move(`cd ${dir}`, 0.8, "enters the repository that was just cloned");
  }
  const made = /^mkdir (-p )?([A-Za-z0-9._/-]+)$/.exec(last)?.[2];
  if (made) move(`cd ${made}`, 0.7, "enters the directory that was just created");
  if (/^cd(\s|$)/.test(last)) {
    move("ls", 0.4, "lists the directory just entered");
    move("git status", 0.3, "checks the repository just entered");
  }
  return moves;
}

function blank(command: string): Candidate {
  return { command, sources: [], ngram: 0, bigram: 0, trigram: 0, prior: 0, recency: -1, order: Number.MAX_SAFE_INTEGER };
}

/** Heuristic order: n-gram count, then context prior, then recency, then project-script order. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return b.ngram - a.ngram || b.prior - a.prior || b.recency - a.recency || a.order - b.order;
}

/**
 * Candidates are built in code: what followed the last command before (n-gram), context moves, recent unique commands
 * and project scripts. Only suggestible commands that extend the typed prefix survive; at most 60, best first.
 */
export function buildCandidates(req: CleanCommandRequest): Candidate[] {
  const { history, prefix } = req;
  const byCommand = new Map<string, Candidate>();
  const entry = (command: string, source: CandidateSource): Candidate => {
    const found = byCommand.get(command) ?? blank(command);
    if (!found.sources.includes(source)) found.sources.push(source);
    byCommand.set(command, found);
    return found;
  };

  const n = history.length;
  const last = history[n - 1];
  const previous = history[n - 2];
  for (let i = 0; i + 1 < n; i += 1) {
    if (history[i] !== last) continue;
    const follower = entry(history[i + 1] ?? "", "ngram");
    follower.bigram += 1;
    follower.recency = Math.max(follower.recency, i + 1);
    if (i >= 1 && previous !== undefined && history[i - 1] === previous) follower.trigram += 1;
  }
  for (const c of byCommand.values()) c.ngram = c.bigram + c.trigram;

  for (const move of contextMoves(last, req.git, req.lastExitCode)) {
    const c = entry(move.command, "context");
    if (move.prior > c.prior) c.reason = move.reason;
    c.prior = Math.max(c.prior, move.prior);
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    const c = entry(history[i] ?? "", "recent");
    c.recency = Math.max(c.recency, i);
  }
  req.projectScripts.forEach((script, i) => {
    const c = entry(script, "script");
    c.order = Math.min(c.order, i);
  });

  return [...byCommand.values()]
    .filter((c) => c.command.startsWith(prefix) && c.command !== prefix && isSuggestible(c.command))
    .sort(compareCandidates)
    .slice(0, MAX_CANDIDATES);
}

export interface HeuristicPick {
  command: string | null;
  confidence: number;
}

const MAX_HEURISTIC_CONFIDENCE = 0.95;

/**
 * Fallback without a model: highest n-gram count, ties by recency (context priors and scripts after that). The
 * confidence is an uncalibrated estimate: the share of the last command's (prefix-matching) followers, smoothed so
 * one observation stays under the 0.7 gate and two consistent ones clear it.
 */
export function pickHeuristic(candidates: Candidate[], prefix: string): HeuristicPick {
  const best = candidates[0];
  if (!best) return { command: null, confidence: 0 };
  let confidence: number;
  if (best.bigram > 0) {
    const followers = candidates.reduce((sum, c) => sum + c.bigram, 0);
    confidence = Math.max(best.bigram / (followers + 0.5) + 0.05 * best.trigram, best.prior);
  } else if (best.prior > 0) {
    confidence = best.prior;
  } else if (prefix !== "") {
    confidence = candidates.length === 1 ? 0.75 : 0.5;
  } else {
    confidence = 0.3;
  }
  return { command: best.command, confidence: Math.round(Math.min(MAX_HEURISTIC_CONFIDENCE, confidence) * 1000) / 1000 };
}
