# Atomic workflows: macOS context, Jev choices, and Composio execution

This layer predicts and executes one action at a time. It sits beside the existing native form walk; it does not replace `GHEventTap`, `GHWalkState`, `GHWriter`, or the overlay.

## Demo

Start the server and demo site:

```sh
pnpm --filter @ghost/server dev
pnpm --filter @ghost/demo dev
```

Open `http://localhost:5173/workflow/index.html`. The no-key demo is explicitly simulated and never touches an external account. Press Tab three times to run:

1. Check calendar availability (read; ordinary Tab approval).
2. Create a reviewed draft response (reversible; the complete proposed change is visible before approval).
3. Create a reviewed tentative event (reversible).

Choose “Try Slack → GitHub issue” to switch to the second polished workflow: Ghost captures the visible bug report, offers one reviewed `github.create_issue` action, and completes with deterministic issue #42 in simulator mode.

The “Try local field action” button demonstrates the same loop returning a `local.fill_focused_field` directive. The client writes it and reports the verified result before the server predicts again.

## Owned modules

- `shared/src/workflow/`: wire types for `ContextSnapshot`, normalized actions, suggestions, workflow state, and structured results.
- `server/src/workflows/context.ts`: strict allowlist normalization, bounds, and defense-in-depth redaction.
- `server/src/workflows/catalog.ts`: stable action IDs, safety/confirmation policy, semantic discovery queries, and accepted tool-slug patterns.
- `server/src/workflows/candidates.ts`: application/workflow/account-aware filtering and deterministic argument preparation.
- `server/src/workflows/predict.ts`: one Jev Choice question over the filtered action IDs plus `no_action`. Values and tool arguments are never Jev output.
- `server/src/workflows/composioClient.ts`: Composio v3.1 per-user sessions, account discovery, Connect Links, tool search, and session execution.
- `server/src/workflows/store.ts`: in-memory workflow state plus short-lived, single-use approval and local-completion tokens.
- `server/src/routes/workflows.ts`: local-only HTTP boundary.
- `desktop/src/GHWorkflowCoordinator.*`: narrow native client/context seam for the existing Tab UI.
- `demo/public/workflow/index.html`: polished, deterministic hackathon demonstration.

## Loop

```text
AX metadata → privacy-safe ContextSnapshot → filtered ActionCandidates
           → one Jev Choice question → visible suggestion → approval
           → local/Composio execution → structured result → next snapshot
```

`preparedArguments` remain server-side. The prediction response carries an action definition and human-readable preview, never the hidden execution payload. Approval issues a random token bound to the current user, workflow, action, arguments, and required confirmation mode. The token expires after five minutes and is consumed exactly once.

## Confirmation policy

| Safety | Examples | Required UI evidence |
| --- | --- | --- |
| `read` | Check availability, search connected data | `tab` |
| `reversible` | Create a draft, tentative event, issue, or local fill | `review` after the complete preview; local fill can use `tab` because the exact text is already visible in the focused field overlay |
| `high-impact` | Send email/Slack, submit, delete, purchase/payment | `explicit`; ordinary or repeated Tab is rejected |

The server validates the confirmation mode; clients cannot downgrade it. The native writer remains responsible for verifying local effects and reporting them through `/v1/workflows/local-result`.

Live prediction performs synchronous cache reads only: it never waits on Composio. The native coordinator exposes `prefetchComposioForContext` so focus/context changes can warm account and capability metadata before requesting a Jev prediction. A cold cache fails closed to `no_action` until prefetch completes.

## HTTP interface

- `POST /v1/workflows/predict` — normalize context, discover/filter capabilities, ask Jev once, return the suggestion.
- `POST /v1/workflows/approve` — bind the displayed suggestion to the confirmation the UI collected.
- `POST /v1/workflows/execute` — redeem the token once; return either a structured result or a local action directive.
- `POST /v1/workflows/local-result` — add the native writer's verified result to workflow state.
- `GET /v1/workflows/:userId` — current non-sensitive workflow state.
- `GET /v1/composio/connections?userId=...` — active connected accounts by toolkit.
- `POST /v1/composio/connect-link` — create an exact toolkit Connect Link for the per-user session.
- `POST /v1/composio/oauth-complete` — redeem optional callback identity verification and verify the account is `ACTIVE`.
- `POST /v1/composio/prefetch` — warm connected-account and capability caches off the latency-sensitive prediction path.

Bodies are bounded. Errors are short codes. Upstream bodies are never logged because they can echo arguments or account metadata.

## Composio contract

The implementation uses the current session API rather than giving Jev an unbounded tool catalog:

- `POST /api/v3.1/tool_router/session`
- `POST /api/v3.1/tool_router/session/{session_id}/search`
- `POST /api/v3.1/tool_router/session/{session_id}/link`
- `POST /api/v3.1/tool_router/session/{session_id}/execute`
- `GET /api/v3.1/connected_accounts`

References: [Sessions](https://docs.composio.dev/reference/api-reference/tool-router), [connected accounts](https://docs.composio.dev/reference/api-reference/connected-accounts), and [tools](https://docs.composio.dev/reference/api-reference/tools).

Set `COMPOSIO_API_KEY` in the gitignored root `.env` (or the process environment) to enable real sessions. A scoped key needs session-management write, session tool-execution write, connected-account read, and Connect Link permissions. Never put it in `.env.example` as a value or expose it to the native app.

Real account and execution routes also require the repository's existing pinned-caller protection: set `GHOST_EXTENSION_ID`, or set a random `GHOST_EXECUTE_TOKEN` of at least 16 characters and have the native client send it as `X-Ghost-Token`. Browser demo calls remain allowed only when every candidate is explicitly simulated.

With `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`, workflow prediction uses the existing Jev provider; otherwise the explicit demo uses a deterministic local selector. On the audited developer machine, direct TypeSafe/Jev is configured and the complete three-action meeting workflow was live-verified with calibrated Jev choices. Production no-key requests are inert and return only `no_action`/local actions.
