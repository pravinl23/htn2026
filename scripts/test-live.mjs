// Runs live provider tests only when at least one real key is present.
// Extra arguments go to vitest, e.g. `pnpm test:live decision` runs only the decision test (one real call).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(\S+)/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const keys = ["TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY", "BASETEN_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"];
const present = keys.filter((k) => process.env[k]);
if (present.length === 0) {
  console.log("test:live skipped: no provider keys set (" + keys.join(", ") + ")");
  process.exit(0);
}
console.log("test:live using keys: " + present.join(", "));
const r = spawnSync("pnpm", ["--filter", "@ghost/server", "test:live", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
