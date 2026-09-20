// Import this module before the server/app modules. It is the ONLY place allowed to call Sentry.init.
import * as Sentry from "@sentry/node";
import type { ServerConfig } from "../config";
import { scrubSentryEvent } from "./scrub";

let initialized = false;
let enabled = false;

/** Idempotent so createApp/test seams cannot accidentally replace the process-wide Sentry client. */
export function initializeObservability(config: ServerConfig): boolean {
  if (initialized) return enabled;
  initialized = true;
  if (!config.sentry) return false;
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    release: config.sentry.release,
    defaultIntegrations: false,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    normalizeDepth: 6,
    registerEsmLoaderHooks: false,
    beforeSend: (event, hint) => scrubSentryEvent(event, hint) as typeof event | null,
  });
  enabled = true;
  return true;
}

export function sentryClient(): typeof Sentry | null {
  return enabled ? Sentry : null;
}

/** Test/documentation seam: health is about configured+initialized, not merely a DSN-shaped string. */
export function sentryEnabled(): boolean {
  return enabled;
}
