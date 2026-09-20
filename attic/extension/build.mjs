import { build, context } from "esbuild";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Every path below is relative to extension/, so "node extension/build.mjs" from the repo root cannot wipe another "dist".
process.chdir(dirname(fileURLToPath(import.meta.url)));

// Chrome (default) writes dist/. "--target=firefox" writes dist-firefox/ with manifest.firefox.json and never touches dist/.
const TARGETS = {
  chrome: { outdir: "dist", manifest: "manifest.json", esbuildTarget: "chrome120" },
  firefox: { outdir: "dist-firefox", manifest: "manifest.firefox.json", esbuildTarget: "firefox121" },
};
const targetName = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length) ?? "chrome";
const target = TARGETS[targetName];
if (!target) {
  console.error(`extension: unknown --target=${targetName} (expected ${Object.keys(TARGETS).join(" or ")})`);
  process.exit(1);
}

const watch = process.argv.includes("--watch");
const outdir = target.outdir;
const readManifest = (file) => JSON.parse(readFileSync(join("public", file), "utf8"));

/** The Firefox manifest is a hand-written sibling: fail the build when it drifts from the Chrome one. */
function checkFirefoxManifest() {
  const chrome = readManifest(TARGETS.chrome.manifest);
  const firefox = readManifest(TARGETS.firefox.manifest);
  const same = (key) => JSON.stringify(chrome[key]) === JSON.stringify(firefox[key]);
  const problems = ["manifest_version", "name", "version", "description", "content_scripts", "action", "commands"].filter((key) => !same(key)).map((key) => `"${key}" differs from manifest.json`);
  const permissions = chrome.permissions.filter((p) => p !== "debugger"); // Firefox has no chrome.debugger
  if (JSON.stringify(firefox.permissions) !== JSON.stringify(permissions)) problems.push(`"permissions" must be ${JSON.stringify(permissions)}`);
  if (JSON.stringify(firefox.background) !== JSON.stringify({ scripts: [chrome.background.service_worker] })) problems.push('"background" must be { scripts: ["background.js"] }');
  if (firefox.options_ui?.page !== chrome.options_page) problems.push('"options_ui.page" must be the Chrome options_page');
  if (!firefox.browser_specific_settings?.gecko?.id) problems.push('"browser_specific_settings.gecko.id" is missing');
  if (problems.length > 0) throw new Error(`public/${TARGETS.firefox.manifest}: ${problems.join("; ")}`);
}
if (targetName === "firefox") checkFirefoxManifest();

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
const manifests = new Set(Object.values(TARGETS).map((t) => t.manifest));
const copyStatic = () => {
  cpSync("public", outdir, { recursive: true, filter: (source) => !manifests.has(basename(source)) });
  copyFileSync(join("public", target.manifest), join(outdir, "manifest.json"));
};
copyStatic();

// pdf.js (resume import) ships as two local files the options page loads on demand. MV3 forbids remote
// code, so nothing comes from a CDN; see src/lib/pdfText.ts.
const pdfjsBuild = join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "build");
for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) copyFileSync(join(pdfjsBuild, file), join(outdir, file));

const options = {
  entryPoints: {
    content: "src/content/index.ts",
    background: "src/background/index.ts",
    options: "src/options/index.ts",
  },
  outdir,
  absWorkingDir: process.cwd(), // esbuild remembers the cwd it was imported in, which is before the chdir above
  bundle: true,
  format: "iife",
  target: target.esbuildTarget,
  sourcemap: true,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("extension: watching for changes");
} else {
  await build(options);
}
