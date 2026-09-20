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
  "proposeAnswers", "recordCorrection", "gateFor", "walkSkips",
  "nextAction", "recordRoleOutcome", "emptyRoleMemory", "lockedForCandidate",
  "rankWindow", "recordWindowOutcome", "forgetKnowledgeSurface",
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

  // The answer engine and the gate, through the same bundle the native side loads.
  const gated = [
    { signature: "r1", label: "Country", kind: "select", required: true, options: [{ value: "", label: "Select..." }, { value: "CA", label: "Canada" }], value: "", rect: fields[0].rect },
    { signature: "b1", label: "Submit application", kind: "button", locked: true, rect: fields[2].rect },
  ];
  const gate = JSON.parse(core.gateFor(JSON.stringify(gated), "[]"));
  if (gate.terminalAllowed !== false || gate.unmetRequired.length !== 1) fail(`smoke test: the gate did not withhold Submit (${JSON.stringify(gate)})`);
  const eeo = [{ signature: "e1", label: "Gender", kind: "select", value: "", rect: fields[0].rect,
                 options: [{ value: "", label: "Select..." }, { value: "m", label: "Male" }, { value: "d", label: "I don't wish to answer" }] }];
  const proposed = JSON.parse(core.proposeAnswers(JSON.stringify(eeo), JSON.stringify(profile), "", core.defaultSettings()));
  if (proposed.length !== 1 || proposed[0].class !== "protected" || proposed[0].value !== "d") {
    fail(`smoke test: a protected question was not declined (${JSON.stringify(proposed)})`);
  }
  const learned = JSON.parse(core.recordCorrection(JSON.stringify(eeo[0]), "m", "", "2026-01-01T00:00:00.000Z"));
  if (learned.counter !== "answer.corrected.protected" || learned.answers.answers.length !== 1) {
    fail(`smoke test: a correction was not learned (${JSON.stringify(learned)})`);
  }

  // Ghost anywhere (docs/anywhere.md): a window that is not a form still gets one proposal. A playing video
  // wants fullscreen; nothing here names a site, and the whole pass is the SHARED affordance layer.
  const player = [
    { id: "c1", kind: "button", label: "Pause", locked: false, insideMediaControls: true },
    { id: "c2", kind: "button", label: "", identifier: "player-fullscreen-button", locked: false, insideMediaControls: true },
  ];
  const anywhere = JSON.parse(core.nextAction(JSON.stringify(player), JSON.stringify({ hasMediaElement: true, mediaPlaying: true })));
  if (anywhere.pageKind !== "media" || anywhere.top?.id !== "c2" || anywhere.top?.role !== "fullscreen") {
    fail(`smoke test: the anywhere pass did not propose fullscreen on a playing video (${JSON.stringify(anywhere.top)})`);
  }
  const remembered = JSON.parse(core.recordRoleOutcome(core.emptyRoleMemory(), JSON.stringify({ pageKind: "media", role: "captions" }), "accepted"));
  if (remembered.entries.length !== 1 || remembered.entries[0].role !== "captions") {
    fail(`smoke test: role memory did not record an accept (${JSON.stringify(remembered)})`);
  }
  if (core.lockedForCandidate(JSON.stringify({ id: "x", kind: "button", label: "Place your order", locked: false }), "buy") !== true) {
    fail("smoke test: lockedForCandidate let an irreversible control through");
  }

  // The knowledge layer (docs/knowledge.md), through the same bundle: an accessibility walk of a window becomes
  // the one context key, the SHARED rankActions scores it, and what the person does here changes the answer.
  // The surface is an opaque token and nothing in the result carries a label.
  const windowControls = JSON.stringify([
    { id: "a1", axRole: "AXButton", label: "Pause", insideMediaControls: true },
    { id: "a2", axRole: "AXButton", label: "Full screen", insideMediaControls: true },
    { id: "a3", axRole: "AXButton", label: "Captions", insideMediaControls: true },
  ]);
  const windowSignals = JSON.stringify({ surface: "w1", screenKind: "media", state: { mediaPlaying: true }, hasMediaElement: true });
  const cold = JSON.parse(core.rankWindow(windowControls, windowSignals, ""));
  if (cold.top?.id !== "a2" || cold.top?.role !== "fullscreen" || cold.top?.tier !== "shape") {
    fail(`smoke test: an empty brain did not lead with the shape's answer on a playing video (${JSON.stringify(cold.top)})`);
  }
  if (JSON.stringify(cold).includes("Full screen")) fail("smoke test: rankWindow leaked a control's label into its result");
  let file = "";
  for (let i = 0; i < 4; i += 1) {
    const step = JSON.parse(
      core.recordWindowOutcome(file, JSON.stringify({ surface: "w1", screenKind: "media", role: "captions", visit: true }), "taken"),
    );
    if (step.changed !== true || typeof step.file !== "string") fail(`smoke test: an outcome was not recorded (${JSON.stringify(step)})`);
    file = step.file;
  }
  const taught = JSON.parse(core.rankWindow(windowControls, windowSignals, file));
  if (taught.top?.id !== "a3" || taught.top?.tier !== "surface") {
    fail(`smoke test: the window did not learn what this person does here (${JSON.stringify(taught.top)})`);
  }
  const forgotten = JSON.parse(core.forgetKnowledgeSurface(file, "w1"));
  if (forgotten.removed < 1 || JSON.parse(core.rankWindow(windowControls, windowSignals, forgotten.file)).top?.id !== "a2") {
    fail(`smoke test: forgetting a surface did not undo what it learned (${JSON.stringify(forgotten)})`);
  }
} catch (err) {
  fail(`smoke test threw: ${err.message}`);
}

const kb = (statSync(outfile).size / 1024).toFixed(1);
console.log(`core: ${outfile.replace(`${repo}/`, "")} ${kb} KB, exports ok (${REQUIRED_EXPORTS.length}), smoke test ok`);
