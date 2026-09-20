# Observability

The local server can emit structured latency, error, and outcome data. It remains useful without any remote telemetry: normal logs use route/provider names, counts, and latency rather than field or profile values.

## Sentry

Set SENTRY_DSN to enable the optional server-side Sentry integration. Without it, the server does not initialize Sentry. The configured integration covers request instrumentation and the sanitized walk-outcome sink; it is not permission to forward arbitrary request bodies, page content, or user identity.

Use SENTRY_ENVIRONMENT and SENTRY_RELEASE to label events. Keep auth tokens out of .env and never commit them. The demo site has a separate optional Sentry DSN, SENTRY_WEB_DSN, for its own development instrumentation.

## What to inspect

- server health and selected provider;
- route/provider latency and failure counts from GET /v1/metrics;
- sanitized accepted/rejected outcome trends, when explicitly enabled;
- errors that survive the server’s value-scrubbing boundary.

The repository’s old pitch/audit files contain historical measurements and should not be treated as a production privacy certification or uptime claim. See [learning telemetry](learning-loop.md) for the current event boundary.
