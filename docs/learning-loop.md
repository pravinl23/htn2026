# Redacted walk outcomes, Sentry, and replay evals

Ghost has a controlled learning loop for the Tab walk — the path the extension and Ghost Desktop both drive
through `POST /v1/predict/form`. It learns by turning reviewed failures into regression fixtures. It never
changes prompts, thresholds, code, or model behavior in production.

The ground truth is the user. Every ghost is either accepted (Tab), escaped, typed over, or left unresolved,
and that verdict is the label. A walk that went wrong becomes a reviewable case; a healthy walk stays a counter.

```text
one Tab walk
  -> content script builds a value-free outcome from controller events
  -> background worker rebuilds it from an allowlist
  -> local server validates it again
     -> Sentry event + reviewable-walk JSON attachment (when SENTRY_DSN is set)
     -> bounded in-memory replay review queue
  -> human reviews and promotes a fixture
  -> deterministic replay eval runs in CI/local tests
```

## What is captured

The versioned `ghost.walk-outcome.v1` envelope can represent only:

- how the walk ended (`parked`, `exhausted`, `abandoned`) and a closed reason code;
- per proposal: the closed action kind (`fill`, `select`, `check`, `click`), the closed source
  (`offline`, `server`, `cache`, `llm`, `loop`), a `calibrated` and a `locked` boolean, a coarse confidence
  bucket, and the user's closed verdict (`accepted`, `escaped`, `typed-over`, `refused`, `unresolved`);
- bounded counts of what was shown, accepted, dismissed and locked;
- provider category and coarse latency/duration buckets;
- a random run UUID used to join the event to its replay.

It has no fields for labels, question text, field signatures, values, typed or generated text, the URL,
origin or page title, the profile, the DOM, or screenshots. Unknown provider, source and dismissal strings
collapse onto the closed vocabulary; they are never forwarded verbatim. The summary must agree with the
proposals it describes, or the whole envelope is rejected.

The content script creates the envelope, the background worker sanitizes it, and the server sanitizes it
again. Sentry initializes only when a valid `SENTRY_DSN` exists, with default integrations disabled, default
PII disabled, and tracing disabled. Its `beforeSend` hook discards the proposed SDK event and reconstructs a
new one from the validated outcome, so future request, user, breadcrumb, exception, or scope data cannot be
added accidentally.

### Why no question signature

`docs/answers.md` proposes learning a correction against a `questionSignature` so an answer learned on
Greenhouse applies on Lever. That signature is derived from normalized question text, which is page content,
and this envelope deliberately carries none. The two are compatible but separate: learned answers stay on the
device (`chrome.storage.local`, `answers.json`), and only the value-free counters above cross the wire. If a
future case genuinely needs to identify a question, it must use an explicitly synthetic, reviewed page fixture
rather than production telemetry.

## What counts as reviewable

Only three things put a walk in the review queue, so the corpus stays small and every case means something:

1. **A safety violation** — a locked proposal was accepted. This must never happen, and every fixture asserts
   `lockedAccepted: 0` whatever else it checks.
2. **A calibration failure** — a *calibrated* provider proposed something with high confidence and the user
   rejected it. An uncalibrated rejection is not a failure: its confidence was never a promise.
3. **An abandoned walk** — the user left mid-walk or switched Ghost off.

## Configure Sentry

Create a Sentry **Node.js** project, then put its client-key DSN in the gitignored root `.env`:

```dotenv
SENTRY_DSN=https://PUBLIC_KEY@o123.ingest.sentry.io/456
SENTRY_ENVIRONMENT=hackathon
SENTRY_RELEASE=ghost@YOUR_GIT_SHA
```

No Sentry auth token is required to send SDK events. Keep API/auth tokens out of the repo. With no
`SENTRY_DSN` the route still accepts outcomes and queues replays locally, reporting `captured: false`; adding
the DSN activates the live sink without a code change. `GHOST_PROVIDER=heuristic` intentionally disables
Sentry so deterministic e2e cannot make external calls even if the shell contains a DSN.

If Ghost is installed as a LaunchAgent, add the same three variables to `~/.config/ghost/env` and restart it:

```bash
launchctl kickstart -k gui/$(id -u)/dev.ghost.server
```

## Inspect, export, and promote

Every reviewable walk becomes a `ghost.walk-replay.v1` case in a newest-first, process-local queue capped at
100. The same case goes into the Sentry event extras and is attached as `walk-replay-<run-id>.json` when
Sentry is configured.

```bash
# Inspect the volatile local review queue.
curl -s http://127.0.0.1:8787/v1/walk/replays

# Export it to canonical, schema-validated JSON.
pnpm eval:walk-replays export --out evals/walk-replays/captured.json

# Promote a local bundle or a Sentry event JSON containing
# extra.walk_replay or extra.walk_outcome.
pnpm eval:walk-replays promote sentry-event.json \
  --out evals/walk-replays/reviewed-case.json

# Run every checked-in replay expectation.
pnpm eval:walk-replays
```

Review the page-independent failure signature and edit `expected` to describe the behavior the fixed system
should produce before committing the fixture. The evaluator compares how the walk ended, the proposal
ceiling, the action sequence and the verdict sequence, and always re-checks that no locked proposal was
accepted; provider and timing variance are ignored. The checked-in seed
(`evals/walk-replays/rejected-confident-fill.json`) is a calibration failure: a 95%+ calibrated `select` the
user typed over, on a walk that still parked correctly on the locked Submit.

The local queue is intentionally not durable and disappears on server restart. Sentry is the durable failure
inbox. The Sentry MCP or API can retrieve the redacted event and attachment, but neither is a runtime
dependency.

## Current boundary and next improvement

These outcome replays catch policy and control-flow regressions and cluster recurring failure signatures.
They cannot reproduce semantic page interpretation, because labels and page text are intentionally absent.

The next improvement is to feed the same pipeline from Ghost Desktop, which drives the identical
`/v1/predict/form` walk over the Accessibility tree. The envelope is already client-agnostic; the native
client only needs to emit it.
