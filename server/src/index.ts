// Sentry first. `initObservability` is awaited before anything else is imported, so the SDK is in place before the
// config, the routes or any model client exist. With no SENTRY_DSN it imports nothing and returns at once
// (docs/observability.md).
import { describe, initObservability } from "./observability/instrument";

const observability = await initObservability();
console.log(describe(observability));

const { loadConfig } = await import("./config");
const { startServer } = await import("./listen");

const config = loadConfig();
startServer(config, (port) => {
  console.log(`[ghost] prediction server on http://${config.host}:${port} (decisions: ${config.decisionProvider}, text: ${config.textProvider})`);
});
