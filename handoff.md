# Ghost implementation handoff

Last updated: 2026-09-19

## Objective

Turn terminal Jev computer-use runs into a privacy-safe learning loop:

1. the extension creates a strictly value-free run outcome;
2. the local Ghost server validates and normalizes it again;
3. configured deployments send the normalized outcome to Sentry;
4. blocked runs become deterministic replay cases that an evaluator can run without a browser, profile, or model call.

This is deliberately **learning from failures through tests**, not live model self-modification. A developer reviews exported replays, promotes useful cases into the checked-in corpus, and improves the policy/provider against that corpus.

## Current branch and baseline

- Branch: `codex/jev-computer-use-e2e`
- Jev end-to-end baseline commit: `d837bd2 feat: add Jev computer-use demo loop`
- Baseline verification before this work: 2,029 unit tests, 34 Playwright tests, and one live TypeSafe/Jev browser run passed.
- Sentry MCP is not exposed to this Codex task and `.env` currently has no `SENTRY_DSN`. The implementation must therefore be fully testable with a no-op sink and activate live capture only when a DSN is explicitly configured.

## Privacy and safety invariants

- Never capture the raw goal, URL, origin, title, candidate IDs/labels/context, profile facts, field values, DOM, screenshots, or arbitrary exception/error text.
- Only closed-vocabulary operations, terminal/result codes, coarse confidence/latency buckets, booleans, and bounded counts may cross the telemetry boundary.
- Rebuild the payload from an allowlist in the extension background worker and validate it again on the server.
- Sentry must run with default PII disabled; the final event hook must rebuild the outbound event rather than trusting arbitrary extras.
- Telemetry failure must never fail, delay, or change an agent run.
- Replays may assert safety/outcome invariants; they may not replay user data or autonomously change production behavior.

## Planned implementation slices

- [x] Shared versioned redacted outcome, replay-case, and evaluator contracts with adversarial tests.
- [x] Extension run collector plus background forwarding and tests proving sensitive run fields are absent.
- [x] Server outcome route, bounded replay store, Sentry sink/no-op sink, and route/privacy tests.
- [x] Replay export/promote workflow and checked-in seed fixtures/eval command.
- [ ] Documentation and environment/install plumbing.
- [ ] Full typecheck, unit tests, extension build, server bundle, and relevant end-to-end verification.

## Resume instructions

Start with `git status --short --branch` and `git log --oneline --decorate -8`. Read this file and `docs/jev-agent.md`. Continue from the first unchecked slice, preserve the invariants above, and make a focused commit after every green slice. Do not put a Sentry DSN in git. If live capture is still unverified, ask the owner to create a Sentry Node project and add its DSN to the repo-local `.env`, then exercise one synthetic blocked run and confirm the sanitized event.

## Implementation notes

- `shared/src/agentTelemetry.ts` defines the only wire schema. `sanitizeAgentRunOutcome` reconstructs it from an allowlist, while `createAgentReplayFixture` and `evaluateAgentReplay` turn reviewed outcomes into deterministic regression assertions that ignore provider/timing variance.
- `extension/src/content/agentTelemetry.ts` listens to terminal runner updates, copies only structural summaries, and reports best-effort. `serverClient.ts` sanitizes the envelope again before POSTing `/v1/agent/outcomes`.
- `server/src/routes/agentTelemetry.ts` accepts outcomes and keeps the newest 100 blocked fixtures in memory. `server/src/telemetry/agentOutcomes.ts` uses a no-op sink without a DSN; with a DSN it lazily initializes Sentry with no default integrations or PII, attaches the replay JSON, and rebuilds every outbound event in `beforeSend`.
- `pnpm eval:agent-replays` validates the checked-in corpus. `export` snapshots the local server queue; `promote` accepts that bundle or a Sentry event containing `extra.agent_replay` / `extra.agent_outcome`, validates it, and writes canonical JSON for human review.
