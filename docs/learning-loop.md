# Local learning and outcome telemetry

Shabang treats a user’s acceptance, dismissal, or correction as feedback. That feedback can improve local answer and action memory. It does not automatically modify prompts, model configuration, thresholds, or source code.

## Desktop flow

~~~text
ghost shown
  → accepted, escaped, typed over, or left unresolved
  → local answer/action memory is updated when eligible
  → a value-free outcome may be posted to the local server
  → optional Sentry sink records a sanitized event
~~~

The active desktop client sends outcomes through POST /v1/walk/outcomes. It is the current replacement for the old browser-client wording found in historical notes.

## What may leave the Mac

The server validates a closed, value-free outcome schema before it can send an event to Sentry. It contains only bounded categories and counts: action/source type, confidence bucket, locked/calibrated flags, closed user verdicts, provider category, and coarse timing. It is not intended to include labels, field signatures, values, generated text, URLs, page titles, profile data, DOM content, or screenshots.

Sentry is completely off without SENTRY_DSN. When it is configured, the server’s sink reconstructs the outgoing event from validated data rather than forwarding arbitrary request context.

## Configuration

Put an ingestion DSN—not a Sentry auth token—in the ignored .env file:

~~~dotenv
SENTRY_DSN=https://PUBLIC_KEY@o123.ingest.sentry.io/456
SENTRY_ENVIRONMENT=development
SENTRY_RELEASE=shabang@YOUR_GIT_SHA
~~~

For an installed background server, place the corresponding values in ~/.config/ghost/env and restart the LaunchAgent:

~~~bash
launchctl kickstart -k gui/$(id -u)/dev.ghost.server
~~~

## Review queue

GET /v1/walk/replays exposes a bounded in-memory queue of reviewable, sanitized outcomes. It disappears when the server restarts. pnpm eval:walk-replays validates checked-in replay fixtures; it is a regression tool, not an online learning system.

## Boundaries

Local answer and action memory are the supported learning behavior. Any inference from real page semantics must remain on-device or go through the explicit, route-specific provider controls described in [the server API note](server-api.md). No telemetry path is permission to collect arbitrary screen or profile content.
