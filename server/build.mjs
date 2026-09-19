// Bundles the prediction server into ONE file, server/dist/server.mjs, so the background LaunchAgent
// (scripts/install-background.sh) needs nothing but a node binary: no pnpm, no tsx, no workspace.
//
//   node server/build.mjs            bundle + smoke start (heuristic, template, random free port, /v1/health)
//   node server/build.mjs --no-smoke bundle only
//
// What is NOT in the bundle, and why:
//   playwright-core  It locates its own files at run time (package.json, browsers.json, a forked driver
//                    process) relative to its install directory, so it cannot live inside a single file.
//                    The server only imports it lazily, when a Browserbase batch actually runs, so the
//                    bundle starts and serves every other route without it. install-background.sh puts a
//                    real copy in <install dir>/node_modules/playwright-core (it has no dependencies).
// Everything else (hono, @hono/node-server, ai, @ghost/shared) is bundled. @typesafe-ai/sdk is a declared
// dependency but never imported (TypeSafe is called over plain HTTP), so it is simply absent.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const outfile = join(here, "dist", "server.mjs");

/** Written to dist/externals.txt, which scripts/install-background.sh reads to copy these next to the installed bundle. */
const EXTERNAL = ["playwright-core"];

function fail(message) {
  console.error(`server bundle: FAILED: ${message}`);
  process.exit(1);
}

function loadEsbuild() {
  // The server has no esbuild of its own: borrow the workspace's (the extension and the demo both depend on it).
  const require = createRequire(import.meta.url);
  const roots = ["extension", "server", "demo", "."].map((dir) => join(repo, dir, "node_modules", "esbuild"));
  for (const candidate of [...roots, "esbuild"]) {
    try {
      return require(candidate);
    } catch {
      // try the next place
    }
  }
  return fail("esbuild not found. Run `pnpm install` at the repo root first.");
}

async function bundle() {
  const esbuild = loadEsbuild();
  mkdirSync(dirname(outfile), { recursive: true });
  const result = await esbuild.build({
    entryPoints: [join(here, "src", "index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: EXTERNAL,
    charset: "utf8",
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
    alias: { "@ghost/shared": join(repo, "shared", "src", "index.ts") },
    // Bundled CommonJS dependencies call require() for node builtins; an ES module has none until we make one.
    banner: { js: 'import { createRequire as __ghostCreateRequire } from "node:module";\nconst require = __ghostCreateRequire(import.meta.url);' },
  });
  // Anything esbuild left as a bare import that is neither a node builtin nor on the list would crash the LaunchAgent at start.
  const stray = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (!imported.external) continue;
      const name = imported.path;
      if (name.startsWith("node:") || EXTERNAL.includes(name)) continue;
      if (createRequire(import.meta.url).resolve.paths(name) === null) continue; // a builtin without the node: prefix
      stray.add(name);
    }
  }
  if (stray.size > 0) fail(`unexpected external imports: ${[...stray].join(", ")}`);
  // The install script copies each external as ONE directory. That is only a complete install while it has no dependencies.
  for (const name of EXTERNAL) {
    const manifest = join(here, "node_modules", name, "package.json");
    if (!existsSync(manifest)) continue; // not installed: the bundle still serves every route that does not need it
    const deps = Object.keys(JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {});
    if (deps.length > 0) fail(`${name} now depends on ${deps.join(", ")}: copy it with \`pnpm --filter @ghost/server deploy --prod\` instead (see scripts/install-background.sh).`);
  }
  // The install script reads this to know which packages to place next to the bundle.
  writeFileSync(join(here, "dist", "externals.txt"), EXTERNAL.map((name) => `${name}\n`).join(""));
  const kb = Math.round(statSync(outfile).size / 1024);
  console.log(`server bundle: ${outfile} (${kb} KB, external: ${EXTERNAL.join(", ") || "none"})`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** Starts the bundle offline (no keys reach it: the environment is rebuilt from scratch) and asks for /v1/health. */
async function smoke() {
  const port = await freePort();
  const env = { PATH: process.env.PATH ?? "", PORT: String(port), GHOST_PROVIDER: "heuristic", GHOST_DECISION_PROVIDER: "heuristic", GHOST_TEXT_PROVIDER: "template" };
  const child = spawn(process.execPath, [outfile], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  let exited = false;
  child.once("exit", () => (exited = true));
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`the bundle exited at start: ${stderr.trim().slice(0, 400)}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          console.log(`server bundle: smoke start ok (GET /v1/health -> ${response.status} on port ${port})`);
          return;
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("no answer from /v1/health within 8 s");
  } finally {
    child.kill("SIGTERM");
  }
}

try {
  await bundle();
  if (!process.argv.includes("--no-smoke")) await smoke();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
