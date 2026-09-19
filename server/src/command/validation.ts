import { isRecord } from "../providers/errors";
import { BadRequest } from "../providers/validation";
import type { CommandRequest, GitSummary } from "./candidates";

export const COMMAND_LIMITS = {
  bodyBytes: 32_000,
  history: 30,
  projectScripts: 40,
  /** Raw line length accepted; the safety filter then drops anything over 300 characters. */
  historyLineChars: 2_000,
  scriptChars: 200,
  prefixChars: 300,
  cwdChars: 255,
  branchChars: 255,
  count: 1_000_000,
} as const;

/** Messages name the offending path only. They never echo request values (they may be commands). */
function string(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new BadRequest(`${path} must be a string`);
  if (value.length > max) throw new BadRequest(`${path} must be at most ${max} characters`);
  return value;
}

function strings(value: unknown, path: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) throw new BadRequest(`${path} must be an array`);
  if (value.length > maxItems) throw new BadRequest(`${path} must have at most ${maxItems} items`);
  return value.map((v, i) => string(v, `${path}[${i}]`, maxChars));
}

function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > COMMAND_LIMITS.count) throw new BadRequest(`${path} must be a non-negative integer`);
  return value;
}

const absent = (value: unknown) => value === undefined || value === null;

function parseGit(value: unknown): GitSummary {
  if (!isRecord(value)) throw new BadRequest("git must be an object");
  if (typeof value.dirty !== "boolean") throw new BadRequest("git.dirty must be a boolean");
  return {
    branch: absent(value.branch) ? "" : string(value.branch, "git.branch", COMMAND_LIMITS.branchChars),
    dirty: value.dirty,
    ahead: absent(value.ahead) ? 0 : count(value.ahead, "git.ahead"),
    behind: absent(value.behind) ? 0 : count(value.behind, "git.behind"),
    untracked: absent(value.untracked) ? 0 : count(value.untracked, "git.untracked"),
  };
}

/** POST /v1/predict/command. Unknown keys are ignored; null counts as absent for optional fields. */
export function parseCommandRequest(body: unknown): CommandRequest {
  if (!isRecord(body)) throw new BadRequest("body must be an object");
  const req: CommandRequest = {
    cwd: absent(body.cwd) ? "" : string(body.cwd, "cwd", COMMAND_LIMITS.cwdChars),
    history: strings(body.history, "history", COMMAND_LIMITS.history, COMMAND_LIMITS.historyLineChars),
  };
  if (!absent(body.git)) req.git = parseGit(body.git);
  if (!absent(body.projectScripts)) req.projectScripts = strings(body.projectScripts, "projectScripts", COMMAND_LIMITS.projectScripts, COMMAND_LIMITS.scriptChars);
  if (!absent(body.prefix)) req.prefix = string(body.prefix, "prefix", COMMAND_LIMITS.prefixChars);
  if (!absent(body.lastExitCode)) {
    const code = body.lastExitCode;
    if (typeof code !== "number" || !Number.isInteger(code) || code < 0 || code > 255) throw new BadRequest("lastExitCode must be an integer from 0 to 255");
    req.lastExitCode = code;
  }
  return req;
}
