import { defineConfig } from "@playwright/test";

type WebServer = NonNullable<Parameters<typeof defineConfig>[0]["webServer"]>;
type WebServerEntry = Extract<WebServer, { command: string }>;

// The demo must be built first; the root "pnpm e2e" script runs "pnpm build" before this.
const demoServer: WebServerEntry = {
  command: "pnpm --filter @ghost/demo preview",
  url: "http://localhost:5173",
  reuseExistingServer: true,
  timeout: 60_000,
};

// Stage 2: opt in with GHOST_E2E_SERVER=1. Blank keys plus GHOST_PROVIDER keep tests on the
// heuristic provider even when a real .env exists (process env wins over --env-file).
const predictionServer: WebServerEntry = {
  command: "pnpm --filter @ghost/server start",
  url: "http://localhost:8787/v1/health",
  reuseExistingServer: true,
  timeout: 60_000,
  env: {
    GHOST_PROVIDER: "heuristic",
    TYPESAFE_API_KEY: "",
    AI_GATEWAY_API_KEY: "",
    OPENAI_API_KEY: "",
  },
};

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5173" },
  webServer: process.env.GHOST_E2E_SERVER === "1" ? [demoServer, predictionServer] : [demoServer],
});
