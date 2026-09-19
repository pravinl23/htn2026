# Learning loop handoff

Last updated: 2026-09-19, after merging main and retargeting the loop onto the Tab walk.

## Objective

Turn ordinary Ghost usage into a privacy-safe learning loop:

1. every Tab walk produces a strictly value-free outcome;
2. the local Ghost server validates and normalizes it again;
3. configured deployments send the normalized outcome to Sentry;
4. walks that went wrong become deterministic replay cases an evaluator runs without a browser, profile, or model call.

This is **learning from failures through tests**, not live model self-modification. A developer reviews exported
replays, promotes useful cases into the checked-in corpus, and improves the policy against that corpus.

## What changed on 2026-09-19

The branch originally carried a second, parallel Jev path: an autonomous `Alt+Shift+J` computer-use runner on
`/v1/agent/next`. Main meanwhile landed Pravin's terminal, vision, next-action and desktop streams, and his live
Greenhouse proof showed the **form walk** is the product. The runner was removed and the loop rebuilt on the walk.

That was the right trade: the walk is driven by both clients (the extension and Ghost Desktop, through the same
`POST /v1/predict/form`), and its accept/dismiss signal is human ground truth rather than an inferred failure.

## Privacy and safety invariants

- Never capture a label, question text, field signature, value, typed or generated text, URL, origin, title,
  profile fact, DOM or screenshot.
- Only closed vocabularies, coarse confidence/latency/duration buckets, booleans, and bounded counts may cross
  the telemetry boundary.
- Rebuild the payload from an allowlist in the background worker and validate it again on the server.
- Sentry runs with default PII disabled; `beforeSend` rebuilds the outbound event rather than trusting extras.
- Telemetry failure must never fail, delay or change a walk.
- Replays may assert safety/outcome invariants; they may not replay user data or change production behavior.
- **Not adopted:** `docs/answers.md`'s `questionSignature`. It is derived from normalized question text, which is
  page content. See "Open question" below.

## State

- [x] Merge `origin/main` (terminal, vision, next-action ghosts, presence, desktop Greenhouse fixes).
- [x] Remove the `/v1/agent/next` runner, panel, browser adapter, providers, contract and e2e.
- [x] Versioned `ghost.walk-outcome.v1` / `ghost.walk-replay.v1` contracts with adversarial tests.
- [x] Content-script collector on the controller event bus; background forwarding; server route.
- [x] Opt-in Sentry sink, bounded replay store, reviewable-walk rule, export/promote CLI, seed fixture.
- [x] `pnpm eval:walk-replays` wired into `pnpm test`.
- [x] Loaded-extension e2e for both the reviewable and the healthy path.
- [x] Docs: `docs/learning-loop.md`, architecture, server API, README, PLAN.
- [ ] Add a `SENTRY_DSN` and confirm one live scrubbed event plus its replay attachment.
- [ ] Emit the same envelope from Ghost Desktop.

## Implementation notes

- `shared/src/walkTelemetry.ts` is the only wire schema. `sanitizeGhostWalkOutcome` rebuilds it from an allowlist,
  `isReviewableWalk` decides what deserves a human, and `createGhostWalkReplayFixture` / `evaluateGhostWalkReplay`
  turn reviewed outcomes into deterministic assertions that ignore provider and timing variance.
- `extension/src/content/walkTelemetry.ts` subscribes to `ghosts:shown`, `ghost:accepted`, `ghost:dismissed` and
  `walk:finished`. It uses a field signature only as a local map key for the calibration lookup. `observeWalkProvider`
  wraps the predictor the same way `observePredictions` does, so the controller stays unaware of telemetry.
- `server/src/routes/walkTelemetry.ts` accepts outcomes (64 KB streamed limit) and keeps the newest 100 reviewable
  fixtures in memory. `server/src/telemetry/walkOutcomes.ts` is a no-op sink without a DSN; with one it lazily
  initializes Sentry with no default integrations, PII or tracing, attaches the replay JSON, and rebuilds every
  outbound event in `beforeSend`.
- `pnpm eval:walk-replays` validates the corpus. `export` snapshots the server queue; `promote` accepts that bundle
  or a Sentry event containing `extra.walk_replay` / `extra.walk_outcome`.

## Open question for the next session

`docs/answers.md` §6 (Pravin's binding design, not yet implemented) wants `answer.corrected` scored by the replay
evals so a correction learned on Greenhouse applies on Lever. That needs a stable `questionSignature`, which is
derived from page text — exactly what this envelope refuses to carry. The two are compatible but currently
disjoint: learned answers stay on the device, only value-free counters cross the wire.

Resolving it is a deliberate privacy decision, not a coding one. The options are to keep corrections countable but
not replayable, to carry a one-way hash of the normalized signature, or to keep the signature in clear for local
evals and strip it at the Sentry boundary. **Ask Pravin before touching `shared/src/answers/**`** — that file tree
is his design and may already exist on an unpushed branch.

## Verification at handoff

- `pnpm typecheck`: pass.
- `pnpm test`: 2,386 unit tests plus the replay eval, pass.
- `pnpm build`: extension and demo production builds pass.
- `pnpm e2e`: 37 passed, 1 failed. The failure is `stage5-next.spec.ts:187` (the extension presence heartbeat),
  which **fails identically on pristine `origin/main`** — verified in a clean worktree, so it is pre-existing and
  unrelated to this work. It is Pravin's stream; `MORNING.md` still records that suite as 36/36 green.
- The new `walk-telemetry.spec.ts` passes both paths: an abandoned walk becomes a redacted replay fixture in the
  loaded extension, and a healthy completed walk stays out of the review queue.
- Live Sentry delivery: still unverified, because `.env` has no `SENTRY_DSN`.
