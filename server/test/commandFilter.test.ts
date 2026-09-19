import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filterHistory, hasBlob, isDestructive, isSuggestible, looksSecret } from "../src/command/filter";

// terminal/ghost.zsh implements the same rules in zsh; terminal/tests/ghost.test.zsh checks it against this fixture.
const FIXTURE = fileURLToPath(new URL("../../terminal/tests/filter-cases.tsv", import.meta.url));
const rows = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => {
    const tab = line.indexOf("\t");
    return { verdict: line.slice(0, tab), command: line.slice(tab + 1) };
  });

describe("parity fixture (same verdicts as terminal/ghost.zsh)", () => {
  it("has rows of every kind", () => {
    for (const verdict of ["secret", "destructive", "ok"]) expect(rows.filter((r) => r.verdict === verdict).length).toBeGreaterThan(10);
  });

  it.each(rows)("$verdict: $command", ({ verdict, command }) => {
    expect(looksSecret(command)).toBe(verdict === "secret");
    if (verdict !== "secret") expect(isDestructive(command)).toBe(verdict === "destructive");
    expect(isSuggestible(command)).toBe(verdict === "ok");
  });
});

describe("secret rules, one by one", () => {
  const cases: [string, string, string][] = [
    ["export of a *KEY* name", "export OPENAI_API_KEY=abc", "export EDITOR=vim"],
    ["set / setenv / typeset of a *TOKEN*", "launchctl setenv GH_TOKEN abc", "setopt autocd"],
    ["inline *SECRET* assignment", "CLIENT_SECRET=abc node app.js", "NODE_ENV=production node app.js"],
    ["*PASSWORD* assignment", "PGPASSWORD=x psql", "PGHOST=localhost psql"],
    ["--password / --token flags", "docker login --password abc", "docker login"],
    ["Authorization: header", 'curl -H "Authorization: x" example.com', 'curl -H "Accept: json" example.com'],
    ["Bearer token", "http example.com 'Bearer abc'", "http example.com"],
    ["-p<password>", "mysql -uroot -psecret", "mkdir -p src/lib"],
    ["user:pass@ in a URL", "psql postgres://alex:pw@db.example.com/app", "psql postgres://db.example.com/app"],
    ["hex blob of 24+", "echo 0123456789abcdef01234567", "echo 0123456789abcdef"],
    ["base64 blob of 24+", "echo QWxleCBDaGVuIGlzIGZpY3Rpb25hbA", "echo QWxleCBDaGVu"],
    ["private key header", "echo '-----BEGIN RSA PRIVATE KEY-----'", "echo begin"],
    ["ssh-keygen", "ssh-keygen -f id", "ssh example.com"],
    ["gpg", "gpg -d secrets.gpg", "git log"],
    ["security find-generic-password", "security find-generic-password -a alex -w", "security list-keychains"],
    ["AWS access key id", "aws s3 ls --profile AKIAABCDEFGHIJKLMNOP", "aws s3 ls"],
    ["-p <password> after login", "docker login -u alex -p hunter2", "docker login -u alex"],
    ["mysql / mongo -p <password>", "mysql -u root -p hunter2", "mysql -u root -p"],
    ["curl -u user:pass", "curl -u alex:hunter2 example.com", "curl -u alex example.com"],
    ["--user user:pass on an HTTP client, not docker's uid:gid", "curl --user alex:hunter2 example.com", "docker run --user 1000:1000 alpine"],
    ["redis-cli -a <password>", "redis-cli -a hunter2", "redis-cli ping"],
    ["openssl -pass", "openssl enc -pass pass:hunter2 -in a", "openssl rand -hex 16"],
    ["*PASS* and *PWD* names", "export DB_PASS=hunter2", "export DB_HOST=localhost"],
    ["random-looking run split by /", "echo wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "cd Projects/htn2026/terminal/tests/fixtures"],
  ];
  it.each(cases)("%s", (_rule, secret, fine) => {
    expect(looksSecret(secret)).toBe(true);
    expect(looksSecret(fine)).toBe(false);
  });

  it("drops multi-line and over-long lines", () => {
    expect(looksSecret("cat <<EOF\nhello\nEOF")).toBe(true);
    expect(looksSecret(`echo ${"a ".repeat(200)}`)).toBe(true);
  });

  it("keeps ordinary long paths, flags and branch names (a blob needs letters AND digits in one long piece)", () => {
    for (const fine of ["cd src/components/buttons/primary/large", "NODE_OPTIONS=--max-old-space-size=4096 pnpm build", "git checkout feature/add-login-page-2", "pnpm exec vitest run test/commandCandidates.test.ts"]) {
      expect(hasBlob(fine)).toBe(false);
    }
  });
});

describe("filterHistory", () => {
  it("trims, drops empty and secret lines, and drops the command right after ssh-keygen / gpg / security", () => {
    const history = ["  pnpm install ", "", "export API_TOKEN=abc", "gpg --decrypt notes.gpg", "echo pasted-passphrase", "git status", "security find-generic-password -w", "pnpm test"];
    expect(filterHistory(history)).toEqual(["pnpm install", "git status"]);
  });
});

describe("destructive rules, one by one", () => {
  const cases: [string, string, string][] = [
    ["rm -rf", "rm -rf build", "rm build.log"],
    ["rm through xargs", "ls | xargs rm -rf", "ls | xargs echo"],
    ["git push --force / -f / +ref", "git push -fu origin main", "git push -u origin main"],
    ["git push -d (deletes a remote branch)", "git push -d origin feature", "git push --dry-run origin feature"],
    ["git push :branch (empty source deletes it)", "git push origin :feature", "git push origin HEAD:refs/for/main"],
    ["git push --prune", "git push --prune origin", "git push origin"],
    ["git reset --hard", "git reset --hard origin/main", "git reset --soft HEAD~1"],
    ["git clean -fd", "git clean -f", "git clean -n"],
    ["sudo", "sudo npm i -g pnpm", "npm i -g pnpm"],
    ["dd", "dd if=a of=b", "add file"],
    ["mkfs", "mkfs.vfat /dev/sdc1", "mkdir build"],
    ["chmod -R 777", "chmod -R 777 public", "chmod +x run.sh"],
    ["DROP", "sqlite3 app.db 'drop database app'", "sqlite3 app.db 'select 1'"],
    ["TRUNCATE", "psql -c 'TRUNCATE users'", "psql -c 'select 1'"],
    ["kubectl delete", "kubectl -n prod delete deploy web", "kubectl -n prod get deploy"],
    ["terraform destroy", "terraform apply -destroy", "terraform apply"],
    ["docker system prune", "docker system prune -af", "docker system df"],
    ["killall", "killall -9 node", "ps aux"],
  ];
  it.each(cases)("%s", (_rule, destructive, fine) => {
    expect(isDestructive(destructive)).toBe(true);
    expect(isDestructive(fine)).toBe(false);
  });

  it("checks every segment of a compound command and ignores case", () => {
    expect(isDestructive("pnpm build; RM -RF dist")).toBe(true);
    expect(isDestructive("echo $(sudo whoami)")).toBe(true);
    expect(isDestructive("git status && git push")).toBe(false);
  });

  it("allows git's own rm (the index, recoverable)", () => {
    expect(isDestructive("git rm -r --cached dist")).toBe(false);
  });
});
