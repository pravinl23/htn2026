import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
const copyStatic = () => cpSync("public", outdir, { recursive: true });
copyStatic();

const options = {
  entryPoints: {
    content: "src/content/index.ts",
    background: "src/background/index.ts",
    options: "src/options/index.ts",
  },
  outdir,
  bundle: true,
  format: "iife",
  target: "chrome120",
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
