# Handoff: Composio track ("API mode")

Owner: teammate (and their coding agent). Pravin's agent will NOT touch the files listed under "Your scope" from now on.

**Status after the 2026-09-19 integration:** this older invoice-loop executor still exists, and the extension now exposes its API execution mode. A second, atomic workflow engine based on Composio v3.1 sessions, capability prefetch, one Jev choice and single-use approval tokens is documented in `docs/workflows.md`; its simulated meeting and Slack → GitHub stories pass browser tests. The local Composio key/account identifiers remain unset, so neither path has touched a real account. The live test, invoice demo script, judging write-up and clip below are still outstanding.

## The one-paragraph pitch

Ghost watches you do a multi-step task twice (open an invoice email, copy vendor / number / date / total into a spreadsheet, reply "received"), generalizes it into a small JSON program, previews every remaining item in a grid, and runs the rest after ONE confirmation. It can run the program four ways: visibly in the tab, in hidden frames, in parallel cloud browsers (Browserbase), or **compiled to API calls through Composio**: the same learned loop becomes `GOOGLESHEETS…APPEND` + `GMAIL…REPLY/SEND` tool calls, so 48 items finish without a browser at all. That last mode is the Composio track: "Build and scale an agent using Composio" (judged on creativity, ambition, usefulness).

## What already exists (written, unit-tested, NEVER run against the real Composio API)

| Piece | Where |
| --- | --- |
| Compile a `LoopProgram` into Composio tool calls; run them sequentially; stub when no key | `server/src/executors/composio.ts` |
| Executor interface, job validation, confirmation tickets, run registry, stub | `server/src/executors/{types,validation,tickets,runs,steps,stub,index,access}.ts` |
| Routes: `GET /v1/executors`, `POST /v1/loop/compile`, `POST /v1/loop/preview`, `POST /v1/loop/execute`, `DELETE /v1/loop/execute/:runId` | `server/src/routes/execute.ts` |
| Config from env | `server/src/config.ts` (`composioFromEnv`) |
| Tests (mocked fetch, no network) | `server/test/executors*.test.ts`, `server/test/executeRoutes.test.ts` |
| API contract (request/response JSON, safety gates) | `docs/server-api.md`, sections "`/v1/executors`", "`/v1/loop/compile`", "`/v1/loop/preview` and `/v1/loop/execute`" |
| Loop design and the `LoopProgram` type | `docs/loops.md`, `shared/src/loop/types.ts` |

Env vars (put them in YOUR local `.env`, never in chat, never committed): `COMPOSIO_API_KEY`, `COMPOSIO_USER_ID` (default `default`), `COMPOSIO_GMAIL_ACCOUNT_ID`, `COMPOSIO_GOOGLESHEETS_ACCOUNT_ID`, `COMPOSIO_SPREADSHEET_ID`, `COMPOSIO_SHEET_RANGE` (default `Sheet1`).

**Known unverified assumptions** (flagged in the code with "MUST be confirmed against the live docs"):
- Endpoint `POST https://backend.composio.dev/api/v3.1/tools/execute/{tool_slug}`, header `x-api-key`, body `{ user_id, connected_account_id?, arguments, version? }`, answer `{ data, error, successful, log_id }`.
- Tool slugs `GMAIL_REPLY_TO_THREAD`, `GMAIL_SEND_EMAIL`, `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` and their argument names (`thread_id`, `recipient_email`, `message_body`, `spreadsheet_id`, `range`, `value_input_option`, `values`).

## Your scope (your agent owns these; ours will not edit them)

- `server/src/executors/composio.ts` and any new `server/src/executors/composio*.ts`
- Composio-specific tests: new `server/test/composio*.test.ts`, `server/test/live/composio.live.test.ts`
- `scripts/demo-composio.mjs` (new), `docs/composio.md` (new: the write-up for judges), this file
- Composio-only lines in `.env.example`

Shared files you may touch only with small additive edits (tell Pravin first, they are hot): `server/src/config.ts` (the `composio` block only), `server/src/routes/execute.ts`, `docs/server-api.md` (Composio paragraphs only).

**Historical ownership note:** the original parallel work used the scope below to avoid collisions. That work has now been integrated; the extension loop panel calls `GET /v1/executors` and offers "API (Composio)" when available. Preserve the documented HTTP contract when changing either Composio path.

## Tasks, in order

1. **Verify the API for real.** Create a Composio account/key, connect a THROWAWAY Gmail account and Google Sheets in the Composio dashboard, read the current docs (https://docs.composio.dev), and fix endpoint, auth header, slugs and argument names in `composio.ts` until one real append-row call and one real email send succeed. Remove the "MUST be confirmed" comments once true.
2. **Live test**, gated like the others: `server/test/live/composio.live.test.ts` runs only when `COMPOSIO_API_KEY` exists (see `scripts/test-live.mjs` and the other files in `server/test/live/`). At most 3 real calls per run: append one row to the test sheet, send one email to YOUR OWN test inbox, read back the row.
3. **End-to-end script** `scripts/demo-composio.mjs`: start from the canonical invoice program (build it with `shared/test/helpers/traceBuilder.ts` + `synthesizeProgram`, or paste the literal), `POST /v1/loop/compile`, then `POST /v1/loop/preview` (shows the irreversible list + returns `confirmToken`), then `POST /v1/loop/execute` with `mode: "api"` for 5 items, print the report. The server needs `X-Ghost-Token` for real executors: read `server/src/executors/access.ts` for how trust works.
4. **Close the realism gap.** Our demo invoices are fictional local data, so there are no real Gmail threads: `GMAIL_REPLY_TO_THREAD` needs `threadId` and `senderEmail` vars the demo does not have. Pick one and document it: (a) simplest: compile the reply step to `GMAIL_SEND_EMAIL` to a configured test recipient with subject `Re: Invoice {{invoiceNumber}}` when no `threadId` var exists; or (b) more impressive: a seeding script that sends 50 fictional invoice emails into the throwaway Gmail inbox through Composio, plus a fetch step so the loop runs on REAL Gmail threads end to end.
5. **Scale story** (the track says "build and scale"): run 48 items with a concurrency pool where the API allows it (appends must stay ordered or carry their row key; sends can be parallel), show items/second versus the visible browser run, handle 429s with backoff, never retry a send whose outcome is unknown.
6. **Write-up + clip:** `docs/composio.md` (what Composio does in Ghost, architecture, measured numbers only) and a 30 second screen recording of API mode filling the real Google Sheet while the inbox receives the replies.

## Non-negotiable safety rules (from `CLAUDE.md`)

- Irreversible effects (every email send) run only after the single batch confirmation: that is the server-issued `confirmToken` flow. Do not add any path around it.
- Only ever email the throwaway test inbox. Never real people, never the fictional vendors' domains.
- Never log or print keys, email bodies, or sheet values. Never commit `.env`. The repo has a pre-commit hook that blocks key-shaped strings and any literal value from `.env`.
- Unit tests must pass with no keys and no network (`pnpm --filter @ghost/server test`). Live tests skip cleanly without a key.

## How to work without colliding with us

- `git pull --rebase origin main` before every push. Commit small, prefix messages with `composio:`.
- Work on a branch `composio` and open a PR if the change touches a shared file; pure-scope files can go straight to `main` once `pnpm --filter @ghost/server test` and `pnpm --filter @ghost/server typecheck` are green.
- Run the server: `pnpm install`, then `pnpm --filter @ghost/server start` (port 8787, reads `../.env`). Health: `curl -s localhost:8787/v1/health`, executors: `curl -s localhost:8787/v1/executors`.

## Definition of done

- `GET /v1/executors` reports `{ "mode": "api", "available": true }` with your key.
- `scripts/demo-composio.mjs` appends N correct rows to a real Google Sheet and sends N emails to the test inbox after one confirmation, and refuses to send anything without the token.
- Live test green, unit tests green, `docs/composio.md` has real measured numbers, clip recorded.

## Prompt to paste into your coding agent

> You are working in the Ghost monorepo (read `CLAUDE.md`, then `docs/handoff-composio.md` and follow it exactly). Your scope is ONLY the Composio track: the files listed under "Your scope" in that handoff. Do not edit `extension/`, `desktop/`, `shared/`, `demo/`, `e2e/` or other `server/` files; keep the HTTP contract in `docs/server-api.md` unchanged. Never print or commit keys; never email anyone except the configured throwaway test inbox; never add a path that sends email without the server-issued confirmation token. Start with task 1 (verify the real Composio API against the live docs and fix `server/src/executors/composio.ts`), then continue down the task list. Run `pnpm --filter @ghost/server test` and `typecheck` before every commit, `git pull --rebase origin main` before every push, and prefix commits with `composio:`.
