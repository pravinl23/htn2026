# Unified learning-loop handoff

Last updated: 2026-09-20 02:28 UTC on `codex/sentry-learning-loop`.

## Outcome

The extension now has one working learning loop across forms, generic computer-use actions, Sentry, and replay
evals. Runtime learning stays local and fast; Sentry stays asynchronous and value-free.

The loaded-extension proof is:

1. Greenhouse-shaped local form initially gets the conservative No work-authorization guess.
2. The user clicks Yes once.
3. The correction persists in `chrome.storage.local` under `ghost.answers`.
4. Amazon- and Airbnb-shaped forms immediately propose and fill Yes through different wording and site values.
5. No submit action is executed.

## Runtime data flow

### Form answers

- `extension/src/content/learning.ts` records manual answers through shared `recordCorrection()`.
- `extension/src/lib/storage.ts` serializes writes and publishes changes to already-open tabs.
- `extension/src/content/predict.ts` runs shared `proposeAnswer()` for every field.
- Learned answers outrank profile facts and guesses.
- `predictableFields(fields, answers)` removes learned questions before `FormPredictRequest`; the learned value,
  signature, and question never reach the server or Jev.
- Guesses are visibly marked and stop held Tab until one fresh deliberate Tab.
- Options -> **Learned** lists and forgets local entries.

### Generic next actions

The merged Fast Lane path remains the right Jev seam:

- the background worker records state-to-action pairs locally;
- local memory returns the visible suggestion immediately;
- `/v1/predict/next` runs in the background and warms a future rescan;
- `server/src/providers/nextQuestions.ts` places recalled examples in Jev's typed `state.memory` field;
- query values stay local, and sensitive events are removed before model state.

### Free text

The LLM only streams speculative drafts while the user is on earlier fields. Tab consumes an in-memory result;
it never starts a model call. A pending draft stops held Tab. The LLM does not mutate learning policy.

## Sentry

- `server/src/observability/instrument.ts` is the only `Sentry.init` owner and is called once at process start.
- Default integrations, tracing, loader hooks, and default PII are disabled; normalization depth is 6.
- `server/src/observability/scrub.ts` drops non-walk events and rebuilds the event and attachment from the shared
  allowlist.
- Proposal answer metadata is limited to class, `fact|learned|guess`, and `needsReview`.
- `captureEvent` success is not trusted on its own; `captured: true` requires a successful SDK flush.
- `server/test/sentryWalk.integration.test.ts` sends a real SDK envelope to local fake ingest and verifies the
  event, attachment, answer metadata, and absence of `[Object]` normalization damage.

No valid `SENTRY_DSN` is present in this checkout. External project delivery remains an environment proof, not
a code blocker. The local queue and all runtime learning continue without it.

## Replay evals

- `ghost.walk-replay.v1`: value-free proposal verdicts. `replayGhostWalkPolicy()` recomputes terminal state,
  reason, summary, reviewability, and locked-action safety.
- `ghost.learning-replay.v1`: checked-in synthetic questions/values. It runs the real answer store and policy
  across Greenhouse, Amazon, and Airbnb variants without weakening production telemetry privacy.
- `pnpm eval:learning-loop` and the legacy `pnpm eval:walk-replays` both run the combined corpus.

## Verification

- `pnpm typecheck`: pass.
- `pnpm build`: pass.
- `pnpm test`: 2,622 passed plus 2 replay fixtures.
- `pnpm e2e`: 56 passed, 0 failed, including cross-site learning, tab ownership, presence, walk telemetry, and
  the canonical 50-invoice story.
- Live external Sentry: not run; no DSN.
- Desktop tests: not rerun; this branch does not connect Desktop learning/outcome emission.

## Remaining work

1. With a real DSN, trigger one local reviewable walk and confirm the external Sentry event and attachment.
2. Add a Desktop persistence adapter for `LearnedAnswerStore` and emit the same value-free walk envelope.
3. Keep Sentry out of runtime recall; it remains a durable failure inbox, not a dependency of the Tab path.

Detailed design and commands: `docs/learning-loop.md`.
