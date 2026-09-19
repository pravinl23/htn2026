# Redacted Jev outcomes, Sentry, and replay evals

Ghost now has a controlled learning loop for the `Alt+Shift+J` computer-use runner. It learns by turning reviewed failures into regression fixtures—not by changing prompts, thresholds, code, or model behavior in production.

```text
terminal browser run
  -> extension builds a value-free outcome
  -> background worker rebuilds it from an allowlist
  -> local server validates it again
     -> Sentry event + blocked-run JSON attachment (when SENTRY_DSN is set)
     -> bounded in-memory replay review queue
  -> human reviews and promotes a fixture
  -> deterministic replay eval runs in CI/local tests
```

## What is captured

The versioned `ghost.agent-run.v1` envelope can represent only:

- terminal state and a closed reason code;
- closed-vocabulary operations (`FILL`, `SELECT`, `CHECK`, `CLICK`, `WAIT`, `DONE`, `BLOCKED`);
- success/change booleans and closed error categories;
- bounded candidate counts and available operation kinds;
- provider category, calibrated/fallback booleans, and coarse confidence/latency/duration buckets;
- a random run UUID used to join the event to its replay.

It has no fields for the goal, URL/origin/title, labels/context, target IDs, profile facts, field values, typed/generated text, DOM, screenshots, or arbitrary browser/model exceptions. Unknown provider and error strings collapse to `other` or `execute-failed`; they are never forwarded verbatim.

The extension content script creates the envelope, the background worker sanitizes it, and the server sanitizes it again. Sentry initializes only when a valid `SENTRY_DSN` exists, with default integrations disabled, default PII disabled, and tracing disabled. Its `beforeSend` hook discards the proposed SDK event and reconstructs a new event from the validated outcome. This prevents future request, user, breadcrumb, exception, or scope data from being added accidentally.

## Configure Sentry

Create a Sentry **Node.js** project, then put its client-key DSN in the gitignored root `.env`:

```dotenv
SENTRY_DSN=https://PUBLIC_KEY@o123.ingest.sentry.io/456
SENTRY_ENVIRONMENT=hackathon
SENTRY_RELEASE=ghost@YOUR_GIT_SHA
```

No Sentry auth token is required to send SDK events. Keep API/auth tokens out of the repo. `SENTRY_DSN` is currently absent on the audited machine, so the route accepts and queues replays locally but reports `captured: false`; adding the DSN activates the live sink without a code change. `GHOST_PROVIDER=heuristic` intentionally disables Sentry so deterministic e2e cannot make external calls even if the shell contains a DSN.

If Ghost is installed as a LaunchAgent, add the same three variables to `~/.config/ghost/env` and restart it:

```bash
launchctl kickstart -k gui/$(id -u)/dev.ghost.server
```

## Inspect, export, and promote

Every blocked outcome becomes a `ghost.agent-replay.v1` case in a newest-first, process-local queue capped at 100. The same case is placed in the Sentry event extras and attached as `agent-replay-<run-id>.json` when Sentry is configured.

```bash
# Inspect the volatile local review queue.
curl -s http://127.0.0.1:8787/v1/agent/replays

# Export it to canonical, schema-validated JSON.
pnpm eval:agent-replays export --out evals/agent-replays/captured.json

# Promote a local bundle or a Sentry event JSON containing
# extra.agent_replay or extra.agent_outcome.
pnpm eval:agent-replays promote sentry-event.json \
  --out evals/agent-replays/reviewed-case.json

# Run every checked-in replay expectation.
pnpm eval:agent-replays
```

Review the page-independent failure signature and edit `expected` to describe the behavior the fixed system should produce before committing the fixture. The evaluator compares terminal state/reason, step ceiling, decision operations, and action operations; provider and timing variance are ignored. The checked-in low-confidence seed proves the plumbing.

The local queue is intentionally not durable and disappears on server restart. Sentry is the durable failure inbox. The Sentry MCP or API can be used to retrieve the redacted event/attachment, but neither is a runtime dependency.

## Current boundary and next improvement

These outcome replays catch policy/control-flow regressions and cluster recurring failure signatures. They cannot reproduce semantic page interpretation because labels and page text are intentionally absent. A future semantic fixture must use an explicitly synthetic, reviewed page fixture—not production telemetry.

The next demo improvement remains a second synthetic scenario with a reversible click, navigation, and wait. Its blocked/success outcomes should be captured through this pipeline and promoted into the corpus after review.
