// Bundles core/entry.ts (which pulls in @ghost/shared and the extension's pure predict rules) into
// build/ghost-core.js: one IIFE whose global is `GhostCore`, for JavaScriptCore.
//
// Then PROVES the bundle: it is run in a bare VM context (no DOM, no Node, no chrome), every export the
// native side calls must be a function, and a smoke form must map. Any failure exits non-zero so
// `make core` fails loudly.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const outfile = resolve(here, "../build/ghost-core.js");

/** What GHCore.m calls. Keep in sync with docs/desktop.md "Core bridge". */
const REQUIRED_EXPORTS = [
  "demoProfile", "defaultSettings", "mapForm", "ghostsFor", "isSensitive", "isLockedAction", "textFacts",
  "upgradeGhosts", "formRequest", "cleanAssignments", "isPlaceholder", "textPastAnswers",
];

function loadEsbuild() {
  // desktop/ has no node_modules of its own: borrow the workspace's esbuild.
  const require = createRequire(import.meta.url);
  const roots = ["extension", "server", "demo", "."].map((dir) => join(repo, dir, "node_modules", "esbuild"));
  for (const candidate of [...roots, "esbuild"]) {
    try {
      return require(candidate);
    } catch {
      // try the next place
    }
  }
  throw new Error("esbuild not found. Run `pnpm install` at the repo root first.");
}

function fail(message) {
  console.error(`core: FAILED: ${message}`);
  process.exit(1);
}

const esbuild = loadEsbuild();
mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
  entryPoints: [join(here, "entry.ts")],
  outfile,
  bundle: true,
  format: "iife",
  globalName: "GhostCore",
  platform: "neutral",
  // JavaScriptCore on macOS 13 (Safari 16). Array.prototype.at, used by predict.ts, shipped in 15.4.
  target: "safari16",
  charset: "utf8",
  legalComments: "none",
  alias: { "@ghost/shared": join(repo, "shared/src/index.ts") },
  logLevel: "warning",
}).catch((err) => fail(err.message));

// ---------- verification ----------
const source = readFileSync(outfile, "utf8");
const sandbox = vm.createContext(Object.create(null));
try {
  vm.runInContext(source, sandbox, { filename: "ghost-core.js" });
} catch (err) {
  fail(`the bundle throws when evaluated without a DOM: ${err.message}`);
}
const core = vm.runInContext("typeof GhostCore === 'object' ? GhostCore : undefined", sandbox);
if (!core) fail("the bundle does not define the global GhostCore");
const missing = REQUIRED_EXPORTS.filter((name) => typeof core[name] !== "function");
if (missing.length > 0) fail(`GhostCore is missing export(s): ${missing.join(", ")}`);

try {
  const profile = JSON.parse(core.demoProfile());
  if (profile.facts.firstName !== "Alex") fail("demoProfile() is not the fictional demo profile");
  const fields = [
    { signature: "f1", label: "First name", kind: "text", rect: { x: 0, y: 0, width: 200, height: 24 } },
    { signature: "f2", label: "Password", kind: "text", inputType: "password", rect: { x: 0, y: 40, width: 200, height: 24 } },
    { signature: "b1", label: "Submit application", kind: "button", locked: true, rect: { x: 0, y: 80, width: 120, height: 30 } },
  ];
  const fieldsJson = JSON.stringify(fields);
  const assignments = core.mapForm(fieldsJson, JSON.stringify(Object.keys(profile.facts)));
  const ghosts = JSON.parse(core.ghostsFor(fieldsJson, assignments, JSON.stringify(profile), core.defaultSettings(), "offline"));
  const ok = ghosts.length === 2 && ghosts[0].signature === "f1" && ghosts[0].value === "Alex" && ghosts[1].locked === true;
  if (!ok) fail(`smoke test: unexpected ghosts ${JSON.stringify(ghosts.map((g) => [g.signature, g.action, g.locked]))}`);
  if (core.isSensitive(JSON.stringify({ label: "Card number" })) !== true) fail("smoke test: isSensitive let a card field through");
  if (core.isLockedAction(JSON.stringify({ text: "Place order" })) !== true) fail("smoke test: isLockedAction missed 'Place order'");
} catch (err) {
  fail(`smoke test threw: ${err.message}`);
}

const kb = (statSync(outfile).size / 1024).toFixed(1);
console.log(`core: ${outfile.replace(`${repo}/`, "")} ${kb} KB, exports ok (${REQUIRED_EXPORTS.length}), smoke test ok`);
