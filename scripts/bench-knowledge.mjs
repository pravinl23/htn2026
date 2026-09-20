#!/usr/bin/env node
// Prints the knowledge-layer benchmark: docs/knowledge.md section 6, from the same code the test asserts on
// (shared/test/knowledgeBenchmark.ts). No keys, no network, no machine of yours involved — sixteen synthetic
// screens, one scripted person, three conditions:
//
//   empty        a graph that knows nothing: the shape of the screen decides
//   cold start   what the first-run local scan could know about this person, per KIND of screen, never per place
//   learned      after five simulated sessions on the screen itself, with the ranker in the loop
//
//   node scripts/bench-knowledge.mjs                 print the table and the detail
//   node scripts/bench-knowledge.mjs --cycles 3      play the five-session script three times over
//   node scripts/bench-knowledge.mjs --json          the whole result as JSON
//   node scripts/bench-knowledge.mjs --write         write the table into docs/knowledge.md between its markers
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = join(ROOT, "shared");
const HARNESS = join(SHARED, "test", "knowledgeBenchmark.ts");
const DOC = join(ROOT, "docs", "knowledge.md");
const START = "<!-- benchmark:start -->";
const END = "<!-- benchmark:end -->";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const at = argv.indexOf(flag);
  if (at < 0 || at + 1 >= argv.length) return fallback;
  const parsed = Number.parseInt(argv[at + 1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const cycles = valueOf("--cycles", 1);

// The harness is TypeScript, so it runs under tsx. `shared` has no node_modules of its own beyond its bin shims:
// run from whichever workspace has the package linked, which changes nothing, because the harness imports its own
// neighbours by relative path.
const tsxHome = [SHARED, join(ROOT, "server"), join(ROOT, "extension"), ROOT].find((dir) =>
  existsSync(join(dir, "node_modules", "tsx")),
);
if (!tsxHome) {
  console.error("bench-knowledge: tsx is not installed. Run `pnpm install` at the repo root first.");
  process.exit(1);
}

const code = `
const harness = await import(${JSON.stringify(HARNESS)});
const result = harness.runBenchmark({ cycles: ${cycles} });
process.stdout.write(JSON.stringify({ table: harness.formatTable(result), detail: harness.formatDetail(result), result }));
`;
const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
  cwd: tsxHome,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
if (child.status !== 0 || typeof child.stdout !== "string" || child.stdout.trim() === "") {
  console.error("bench-knowledge: the benchmark did not run. Run `pnpm install` at the repo root first.");
  process.exit(child.status === 0 ? 1 : (child.status ?? 1));
}

let payload;
try {
  payload = JSON.parse(child.stdout);
} catch {
  console.error("bench-knowledge: the benchmark printed something that is not JSON.");
  process.exit(1);
}

if (has("--json")) {
  console.log(JSON.stringify(payload.result, null, 2));
  process.exit(0);
}

console.log("");
console.log(payload.table);
console.log("");
console.log(payload.detail);
console.log("");

if (has("--write")) {
  const doc = readFileSync(DOC, "utf8");
  const from = doc.indexOf(START);
  const to = doc.indexOf(END);
  if (from < 0 || to < 0 || to < from) {
    console.error(`bench-knowledge: docs/knowledge.md has no ${START} / ${END} block to write into.`);
    process.exit(1);
  }
  const updated = `${doc.slice(0, from + START.length)}\n\n${payload.table}\n\n${doc.slice(to)}`;
  if (updated === doc) console.log("docs/knowledge.md: already up to date");
  else {
    writeFileSync(DOC, updated);
    console.log("docs/knowledge.md: table updated");
  }
}
