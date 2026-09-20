import { createGhostWalkReplayFixture, evaluateGhostWalkReplay, sanitizeGhostWalkReplayFixture, sanitizeGhostWalkOutcome } from "@ghost/shared";
import type { GhostWalkReplayFixture } from "@ghost/shared";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_DIR = join(REPO, "evals/walk-replays");

async function main(): Promise<void> {
  const [command = "eval", ...args] = process.argv.slice(2);
  if (command === "eval") return evaluateFiles(args);
  if (command === "export") return exportLocal(args);
  if (command === "promote") return promote(args);
  usage(`unknown command: ${command}`);
}

async function evaluateFiles(args: string[]): Promise<void> {
  const paths = args.length > 0 ? args.map(repoPath) : (await readdir(DEFAULT_DIR)).filter((name) => name.endsWith(".json")).map((name) => join(DEFAULT_DIR, name));
  if (paths.length === 0) usage("no replay fixtures found");
  let cases = 0;
  const failures: string[] = [];
  for (const path of paths) {
    const fixtures = await fixturesFromFile(path);
    for (const fixture of fixtures) {
      cases++;
      const result = evaluateGhostWalkReplay(fixture);
      if (!result.passed) failures.push(`${fixture.caseId}: ${result.failures.join(", ")}`);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    throw new Error(`${failures.length}/${cases} walk replay evals failed`);
  }
  console.log(`walk replay evals: ${cases} passed from ${paths.length} file(s)`);
}

async function exportLocal(args: string[]): Promise<void> {
  const server = option(args, "--server") ?? "http://127.0.0.1:8787";
  const output = repoPath(option(args, "--out") ?? "evals/walk-replays/captured.json");
  const response = await fetch(`${server.replace(/\/$/, "")}/v1/walk/replays`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`replay export failed: HTTP ${response.status}`);
  const fixtures = extractFixtures(await response.json());
  if (fixtures.length === 0) throw new Error("the server has no reviewable walk replays to export");
  await writeBundle(output, fixtures);
  console.log(`exported ${fixtures.length} reviewed-pending replay(s) to ${relative(output)}`);
}

async function promote(args: string[]): Promise<void> {
  const input = args.find((arg) => !arg.startsWith("--") && arg !== option(args, "--out"));
  if (!input) usage("promote needs an input JSON file");
  const output = repoPath(option(args, "--out") ?? `evals/walk-replays/promoted-${Date.now()}.json`);
  const fixtures = await fixturesFromFile(repoPath(input));
  if (fixtures.length === 0) throw new Error("no valid redacted replay fixtures found in the input");
  await writeBundle(output, fixtures);
  console.log(`promoted ${fixtures.length} replay(s) to ${relative(output)}; review expected outcomes before committing`);
}

async function fixturesFromFile(path: string): Promise<GhostWalkReplayFixture[]> {
  return extractFixtures(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function extractFixtures(raw: unknown): GhostWalkReplayFixture[] {
  const candidates: unknown[] = [];
  if (Array.isArray(raw)) candidates.push(...raw);
  else if (isObject(raw) && Array.isArray(raw.fixtures)) candidates.push(...raw.fixtures);
  else if (isObject(raw) && isObject(raw.extra) && raw.extra.walk_replay !== undefined) candidates.push(raw.extra.walk_replay);
  else if (isObject(raw) && isObject(raw.extra) && raw.extra.walk_outcome !== undefined) {
    const outcome = sanitizeGhostWalkOutcome(raw.extra.walk_outcome);
    if (outcome) candidates.push(createGhostWalkReplayFixture(outcome));
  } else candidates.push(raw);
  return candidates.map(sanitizeGhostWalkReplayFixture).filter((fixture): fixture is GhostWalkReplayFixture => fixture !== null);
}

async function writeBundle(path: string, fixtures: GhostWalkReplayFixture[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schemaVersion: "ghost.walk-replay.v1", count: fixtures.length, fixtures }, null, 2)}\n`, "utf8");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function repoPath(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO, path);
}

function relative(path: string): string {
  return path.startsWith(`${REPO}/`) ? path.slice(REPO.length + 1) : path;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usage(error: string): never {
  throw new Error(`${error}\nusage:\n  pnpm eval:walk-replays\n  pnpm eval:walk-replays export [--server URL] [--out FILE]\n  pnpm eval:walk-replays promote INPUT [--out FILE]`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
