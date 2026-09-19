import { defineConfig } from "@playwright/test";
import { E2E_SERVER_URL, KEYLESS_SERVER_ENV } from "./fixtures";

type WebServer = NonNullable<Parameters<typeof defineConfig>[0]["webServer"]>;
type WebServerEntry = Extract<WebServer, { command: string }>;

// The demo must be built first; the root "pnpm e2e" script runs "pnpm build" before this.
const demoServer: WebServerEntry = {
  command: "pnpm --filter @ghost/demo preview",
  url: "http://localhost:5173",
  reuseExistingServer: true,
  timeout: 60_000,
};

// Port 8788, never 8787: a developer server on 8787 may hold real keys. It is never reused either, so a run
// can only ever talk to the keyless server it started itself (a busy 8788 fails the run instead).
const predictionServer: WebServerEntry = {
  command: "pnpm --filter @ghost/server start",
  url: `${E2E_SERVER_URL}/v1/health`,
  reuseExistingServer: false,
  timeout: 60_000,
  env: { ...KEYLESS_SERVER_ENV, PORT: new URL(E2E_SERVER_URL).port },
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
  webServer: [demoServer, predictionServer],
});
