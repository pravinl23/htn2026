# Loopback service API

The Node service in server/ is a local companion for Shabang Desktop and the optional terminal integration. It binds to 127.0.0.1:8787 by default and is **not a hosted or stable public API**.

## Access and configuration

Every request passes the local-only guard:

- the Host must be loopback (or the configured bind host);
- foreign Origin values are rejected;
- POST requests require Content-Type: application/json.

Do not set GHOST_HOST to a public interface unless you have independently designed authentication and network controls. CORS is not an authentication mechanism.

Provider selection and optional telemetry configuration are read at startup from environment variables. Copy [.env.example](../.env.example) to an ignored .env file for local development. With no provider credential, the decision path uses a deterministic heuristic and text drafting uses a template fallback.

## Routes used by the current desktop product

| Route | Purpose |
| --- | --- |
| GET /v1/health | Active decision/text provider and version. |
| POST /v1/predict/form | One bounded, batched form-mapping request. The desktop client sends non-sensitive field metadata and fact keys, not profile values. |
| POST /v1/ghost-text | Bounded text draft. Streaming is the default; ?stream=0 returns JSON. Sensitive labels are refused. |
| POST /v1/walk/outcomes | Validates a value-free outcome and optionally delivers it to the Sentry sink. |
| GET /v1/walk/replays | Reads the bounded, process-local review queue. |
| GET /v1/metrics | In-memory route/provider metrics. |
| POST /v1/metrics/event | Accepts bounded client counters. |
| GET /v1/presence | Reads short-lived local client-presence entries. The desktop app reads it; no current extension is shipped. |

The service also exposes POST /v1/predict/command for the optional zsh integration. Its client-side and server-side filters drop secret-looking input and refuse destructive suggestions; see [the terminal README](../terminal/README.md).

## Experimental routes

The repository still registers routes for next-action prediction, loop synthesis/execution, executors, presence heartbeats, profile extraction, and OpenAI vision. Some have no active desktop caller, and some are legacy from earlier product experiments. They are implementation surfaces, not advertised product capabilities or compatibility promises.

- /v1/vision, /v1/vision/label, and /v1/vision/locate require OpenAI configuration and have additional caller/budget checks because they handle screen pixels. The desktop vision flow is not complete.
- Loop and executor endpoints may be present in the server but batch automation is outside the supported desktop scope.
- /v1/presence still accepts the historical extension client kind for compatibility with its in-memory schema; Shabang does not ship an extension.

Read the route validators and tests before integrating any of these endpoints. The service has no API-versioning or external-support commitment.

## Logging and observability

Normal route logging is designed to record provider names, route names, counts, and latency—not field or profile values. SENTRY_DSN enables optional Sentry instrumentation and the sanitized outcome sink. See [observability](observability.md) and [learning telemetry](learning-loop.md).
