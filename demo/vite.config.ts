import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The web Sentry DSN reaches the bundle as `import.meta.env.VITE_SENTRY_DSN`. Two ways in, neither of which
 * puts a key in the repo: a real `VITE_SENTRY_DSN` env var (that is how the deployed demo gets it), or
 * `SENTRY_WEB_DSN` in the repo-root `.env` for a local build. A browser DSN is public by design; the server's
 * `SENTRY_DSN` is never read here.
 */
export default defineConfig(({ mode }) => {
  const root = loadEnv(mode, REPO_ROOT, ["VITE_", "SENTRY_WEB_DSN"]);
  const local = loadEnv(mode, process.cwd(), "VITE_");
  const dsn = local["VITE_SENTRY_DSN"] ?? root["VITE_SENTRY_DSN"] ?? root["SENTRY_WEB_DSN"] ?? "";

  return {
    plugins: [react()],
    define: { "import.meta.env.VITE_SENTRY_DSN": JSON.stringify(dsn) },
    // Readable stack traces in Sentry: the maps sit next to the bundle, so no upload step and no auth token.
    build: { sourcemap: true },
    server: { port: 5173, strictPort: true },
    preview: { port: 5173, strictPort: true },
  };
});
