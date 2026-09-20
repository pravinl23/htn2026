// Safety rules for the terminal ghost. terminal/ghost.zsh applies the same secret rules before anything leaves the
// shell; the server applies them again here. terminal/tests/filter-cases.tsv pins both implementations to the same
// verdicts (server/test/commandFilter.test.ts and terminal/tests/ghost.test.zsh read it).

/** Longer lines are pastes, not commands anyone retypes. */
export const MAX_COMMAND_CHARS = 300;
const BLOB_MIN = 24;

const SENSITIVE_WORD = "(key|token|secret|password|passwd|passphrase|pass|pwd|credential)";

/** Case-insensitive shapes that mark a whole line as secret-bearing. */
const SECRET_PATTERNS: RegExp[] = [
  // export / set / typeset ... of a sensitive name, with or without a value
  new RegExp(`(^|[^a-z0-9_])(export|set|setenv|typeset|declare|local|readonly|env)\\s+(-[a-z]+\\s+)*[a-z0-9_]*${SENSITIVE_WORD}`, "i"),
  // NAME=value anywhere (inline env, --api-key=...)
  new RegExp(`[a-z0-9_]*${SENSITIVE_WORD}[a-z0-9_]*=`, "i"),
  // --password value, --token value, --api-key value, --pass value, --auth user:pw
  new RegExp(`--[a-z0-9-]*(password|passwd|token|secret|api-?key|passphrase|pass|pwd|auth)(\\s|=|$)`, "i"),
  // HTTP basic credentials on argv: curl -u alex:pw, --user alex:pw, --proxy-user alex:pw, httpie / xh -a alex:pw
  /(^|[^a-z0-9_-])(curl|wget|http|https|xh)\s([^;&|]*\s)?(-u|-a|--user|--proxy-user)(\s*|=)[^\s:=-][^\s:]*:\S/i,
  /authorization:/i,
  /bearer\s/i,
  /(x-api-key|api-key|x-auth-token|cookie)\s*:/i,
  // -p<password> (mysql and friends)
  /(^|\s)-p\S+/,
  // -p <password> after login (docker / podman / helm / cf / oc login -u alex -p pw), mysql / mongo clients
  /(^|\s)login\s([^;&|]*\s)?-p\s+\S/,
  /(^|[^a-z0-9_-])(mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlsh|mariadb|mariadb-dump|mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport)\s([^;&|]*\s)?-p\s+[^\s-]/,
  // redis-cli -a pw, openssl -pass / -passin / -passout pass:pw
  /(^|[^a-z0-9_-])redis-cli\s([^;&|]*\s)?-a\s+\S/,
  /(^|\s)-pass(in|out)?\s+\S/,
  // URLs with user:pass@
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  // private keys
  /-----begin/i,
  /private key/i,
  // well-known token prefixes that can be shorter than a blob
  /akia[0-9a-z]{16}/i,
  /(^|[^a-z0-9])(sk|pk|rk)-[a-z0-9_-]{16,}/i,
  /(ghp|gho|ghu|ghs|ghr)_[a-z0-9]{16,}/i,
  /github_pat_/i,
  /glpat-/i,
  /xox[abprs]-/i,
  /npm_[a-z0-9]{20,}/i,
  /(^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}/, // JWT
];

/** Commands whose arguments or neighbours carry key material. The line AND the command after it are dropped. */
const SECRET_COMMAND = /(^|[^a-z0-9_-])(ssh-keygen|gpg2?|sshpass)(\s|$)|(^|[^a-z0-9_-])security\s+(find|add|delete|set)-(generic|internet)-password/i;

const hasDigit = (s: string) => /[0-9]/.test(s);
const hasLetter = (s: string) => /[A-Za-z]/.test(s);

/**
 * Long base64 / hex runs: tokens, hashes, signatures. A run is split at "/", "=" and "-" before the length test, so
 * ordinary paths, flags and branch names survive; mixed-case pieces of 32+ characters are caught even with "-" inside.
 */
export function hasBlob(line: string): boolean {
  for (const run of line.match(/[A-Za-z0-9+/=_-]{24,}/g) ?? []) {
    if (/[0-9a-fA-F]{24,}/.test(run)) return true;
    if (/[A-Za-z0-9]{20,}={1,2}$/.test(run)) return true;
    if (run.includes("+") && hasDigit(run) && hasLetter(run)) return true;
    if (run.split(/[/=-]/).some((p) => p.length >= BLOB_MIN && hasDigit(p) && hasLetter(p))) return true;
    if (run.split(/[/=]/).some((p) => p.length >= 32 && hasDigit(p) && /[a-z]/.test(p) && /[A-Z]/.test(p))) return true;
    if (looksRandom(run)) return true;
  }
  return false;
}

/**
 * Random-looking even when "/" splits it into short pieces (an AWS secret access key): 30+ letters and digits of all
 * three kinds that change between upper case, lower case and digit every 3 characters or less on average. Paths and
 * flags change far less often.
 */
function looksRandom(run: string): boolean {
  const alnum = run.replace(/[^A-Za-z0-9]/g, "");
  if (alnum.length < 30 || !/[A-Z]/.test(alnum) || !/[a-z]/.test(alnum) || !hasDigit(alnum)) return false;
  const stretches = run.match(/[A-Z]+|[a-z]+|[0-9]+/g)?.length ?? 0;
  return alnum.length < 3 * stretches;
}

export function isSecretCommand(line: string): boolean {
  return SECRET_COMMAND.test(line);
}

/** True when the line must never leave the shell, reach a model or be suggested. */
export function looksSecret(line: string): boolean {
  if (line.includes("\n") || line.includes("\r")) return true;
  if (line.length > MAX_COMMAND_CHARS) return true;
  if (isSecretCommand(line)) return true;
  if (SECRET_PATTERNS.some((re) => re.test(line))) return true;
  return hasBlob(line);
}

/**
 * History as the model and the n-gram may see it: trimmed, secret-looking lines dropped, and the command right after
 * ssh-keygen / gpg / security find-generic-password dropped too (the likeliest place for a pasted passphrase). The
 * shell decides this over one entry more than it sends, so a secret command just outside its window still counts.
 */
export function filterHistory(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let skipNext = false;
  for (const raw of lines) {
    const line = raw.trim();
    const afterSecretCommand = skipNext;
    skipNext = isSecretCommand(line);
    if (afterSecretCommand || line === "" || looksSecret(line)) continue;
    kept.push(line);
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------------------------
// Destructive commands: never suggested, whatever the history or the model says.

const LINE_RULES: RegExp[] = [
  /(^|[^a-z0-9_])drop\s+(table|database|schema|index|view|user|role|collection)([^a-z0-9_]|$)/i,
  /(^|[^a-z0-9_])(truncate|dropdb|dropdatabase)([^a-z0-9_]|$)/i,
  /(curl|wget)[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh([^a-z0-9_]|$)/i, // pipe a download into a shell
  />\s*\/dev\/(r?disk|sd|hd|nvme)/i,
  /:\(\)\s*\{/, // fork bomb
  /(^|[^a-z0-9_])mv\s[^;&|]*\s\/dev\/null/i,
];

const ALWAYS = new Set(["sudo", "doas", "dd", "newfs", "killall", "pkill", "shred", "srm", "wipefs", "shutdown", "reboot", "halt", "poweroff"]);
const SEPARATORS = /;|&&|\|\||\||&|\$\(|`|\(|\)|\{|\}/;

function tokens(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[\\'"]+|['"]+$/g, ""))
    .filter((t) => t !== "");
}

const shortFlagWith = (letters: string) => new RegExp(`^-[a-zA-Z]*[${letters}][a-zA-Z]*$`);
const RM_FLAG = shortFlagWith("rRf");
const PUSH_FORCE = shortFlagWith("f");
const PUSH_DELETE = shortFlagWith("d");
const CLEAN_FORCE = shortFlagWith("f");

function gitIsDestructive(args: string[]): boolean {
  let i = 0;
  // global options: -C <path>, -c <k=v>, --no-pager ...
  while (i < args.length && args[i]?.startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  const sub = args[i]?.toLowerCase();
  const rest = args.slice(i + 1);
  const has = (pred: (a: string) => boolean) => rest.some(pred);
  switch (sub) {
    case "push":
      // force, mirror, and every way of deleting a remote ref: -d / --delete, --prune, an empty source (:branch)
      return has(
        (a) =>
          PUSH_FORCE.test(a) ||
          PUSH_DELETE.test(a) ||
          a.startsWith("--force") ||
          a === "--mirror" ||
          a === "--delete" ||
          a === "--prune" ||
          ((a.startsWith("+") || a.startsWith(":")) && a.length > 1),
      );
    case "reset":
      return has((a) => a === "--hard" || a === "--merge");
    case "clean":
      return has((a) => CLEAN_FORCE.test(a) || a === "--force");
    case "branch":
      return has((a) => a === "-D" || /^-[a-zA-Z]*D/.test(a)) || (has((a) => a === "-d" || a === "--delete") && has((a) => a === "-f" || a === "--force"));
    case "checkout":
      return has((a) => a === "-f" || a === "--force") || (rest.includes("--") && rest.includes("."));
    case "stash":
      return rest[0] === "clear" || rest[0] === "drop";
    case "filter-branch":
    case "filter-repo":
      return true;
    case "reflog":
      return rest[0] === "expire" || rest[0] === "delete";
    default:
      return false;
  }
}

function segmentIsDestructive(words: string[]): boolean {
  const lower = words.map((w) => w.toLowerCase());
  for (let i = 0; i < lower.length; i += 1) {
    const word = lower[i] ?? "";
    const after = words.slice(i + 1);
    const afterLower = lower.slice(i + 1);
    if (ALWAYS.has(word) || word.startsWith("mkfs")) return true;
    if (word === "rm" && lower[i - 1] !== "git" && after.some((a) => RM_FLAG.test(a) || a === "--recursive" || a === "--force")) return true;
    if (word === "git" && gitIsDestructive(after)) return true;
    if (word === "chmod" && after.some((a) => /^-[a-zA-Z]*R/.test(a)) && after.some((a) => /^0?777$|^(a|ugo)\+rwx$/.test(a))) return true;
    if (word === "kubectl" && afterLower.includes("delete")) return true;
    if ((word === "terraform" || word === "tofu" || word === "terragrunt") && (afterLower.includes("destroy") || afterLower.includes("-destroy"))) return true;
    if ((word === "docker" || word === "podman" || word === "docker-compose") && afterLower.includes("prune")) return true;
    if ((word === "docker" || word === "docker-compose") && afterLower.includes("down") && afterLower.some((a) => a === "-v" || a === "--volumes")) return true;
    if (word === "kill" && after.some((a) => a === "-9" || a.toUpperCase() === "-KILL" || a.toUpperCase() === "-SIGKILL")) return true;
    if (word === "find" && afterLower.includes("-delete")) return true;
    if (word === "diskutil" && afterLower.some((a) => a.startsWith("erase") || a === "zerodisk" || a === "partitiondisk")) return true;
    if ((word === "npm" || word === "pnpm" || word === "yarn") && afterLower.some((a) => a === "publish" || a === "unpublish")) return true;
    if (word === "gh" && afterLower.includes("delete")) return true;
  }
  return false;
}

/** True for commands Shabang must never suggest (rm -rf, force pushes, sudo, DROP TABLE, ...). Over-blocking is fine. */
export function isDestructive(command: string): boolean {
  if (LINE_RULES.some((re) => re.test(command))) return true;
  return command.split(SEPARATORS).some((segment) => segmentIsDestructive(tokens(segment)));
}

/** Suggestions must pass both gates. */
export function isSuggestible(command: string): boolean {
  return command.trim() !== "" && !looksSecret(command) && !isDestructive(command);
}
