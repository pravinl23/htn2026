# Baseten provider option

Baseten is an optional provider for the local Shabang server. It is not required for the desktop app: without credentials, Shabang uses local heuristics and template text.

When BASETEN_API_KEY is set and Baseten is selected by the server configuration, the service can use an OpenAI-compatible Baseten endpoint for decision and text requests. The defaults, parsing rules, sample/hedge limits, and provider precedence are defined in server/src/config.ts.

## Configuration

Copy the relevant variable names from .env.example into an ignored .env file:

~~~dotenv
BASETEN_API_KEY=
BASETEN_BASE_URL=
BASETEN_DECISION_MODEL=
BASETEN_TEXT_MODEL=
BASETEN_SAMPLES=
BASETEN_HEDGE=
BASETEN_DECISION_MODEL_URL=
BASETEN_LOGPROBS=1
GHOST_WARMUP=0
~~~

Each additional sample or hedge is an additional paid request. Keep the defaults unless a measured product need justifies changing them. Never put a key in a plist, source file, screenshot, or commit.

## Scope

Provider credentials live with the loopback server, not the desktop binary. The current desktop client uses the server for optional form mapping and text drafting; it does not make Baseten a requirement for next-action suggestions. See [the server API note](server-api.md) for the local-service boundary.
