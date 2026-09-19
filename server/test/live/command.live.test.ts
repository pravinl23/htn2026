import type { DecisionProvider } from "@ghost/shared";
import { describe, expect, it } from "vitest";
import { createCommandPredictor } from "../../src/command/predict";
import { loadConfig } from "../../src/config";
import { createJevGatewayProvider } from "../../src/providers/jevGateway";
import { createTypesafeProvider } from "../../src/providers/typesafe";

// Live only (pnpm test:live command). ONE real Jev call per configured Jev route: the terminal ghost predicts the next
// command of a fictional session. The generous timeout is for measuring; the route itself falls back after 1.5 s.
const LIVE_TIMEOUT_MS = 20_000;
const config = loadConfig({ ...process.env, GHOST_DECISION_PROVIDER: undefined, GHOST_TEXT_PROVIDER: undefined });

const SESSION = {
  cwd: "northwind-app",
  git: { branch: "feature/terminal-ghost", dirty: true, ahead: 0, behind: 0, untracked: 0 },
  history: ["pnpm install", "pnpm build", "pnpm test", "git status", "git add -A"],
  projectScripts: ["pnpm dev", "pnpm build", "pnpm test", "pnpm lint"],
  lastExitCode: 0,
};

async function predictOnce(provider: DecisionProvider) {
  const predict = createCommandPredictor({ provider, timeoutMs: LIVE_TIMEOUT_MS });
  const started = performance.now();
  const result = await predict(SESSION);
  const wallMs = Math.round(performance.now() - started);
  // The command is a fictional prediction, so it is safe to print; nothing from a real shell is involved.
  console.log(`[live] command provider=${result.provider} latencyMs=${result.latencyMs} wallMs=${wallMs} candidates=${result.candidates} command=${JSON.stringify(result.command)} confidence=${result.confidence.toFixed(2)}${result.fallbackFrom ? ` fallbackFrom=${result.fallbackFrom}` : ""}`);
  expect(result.fallbackFrom).toBeUndefined();
  expect(result.provider).toBe(provider.name);
  expect(result.confidence).toBeGreaterThanOrEqual(0);
  expect(result.confidence).toBeLessThanOrEqual(1);
  // After `git add -A` in a dirty tree the obvious next command is the commit.
  expect(result.command).toBe('git commit -m ""');
}

describe.skipIf(!config.typesafeApiKey)("live: terminal ghost through TypeSafe direct", () => {
  it("predicts the next shell command in one call", async () => {
    await predictOnce(createTypesafeProvider({ apiKey: config.typesafeApiKey ?? "", timeoutMs: LIVE_TIMEOUT_MS }));
  });
});

describe.skipIf(!config.aiGatewayApiKey)("live: terminal ghost through Jev on the Vercel AI Gateway", () => {
  it("predicts the next shell command in one call", async () => {
    await predictOnce(createJevGatewayProvider({ apiKey: config.aiGatewayApiKey ?? "", timeoutMs: LIVE_TIMEOUT_MS }));
  });
});
