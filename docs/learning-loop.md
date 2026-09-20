# Ghost learning loop: local memory, Jev context, Sentry, and replay evals

Ghost has one product learning loop with two deliberately different latency tiers:

1. **Runtime learning is local.** A correction or repeated action is persisted on-device and can change the
   next ghost without waiting for Sentry, Jev, an LLM, or the Ghost server.
2. **Reliability learning is asynchronous.** Every Tab walk emits a value-free outcome. Sentry is the durable
   failure inbox, and reviewed failures become deterministic replay fixtures that gate later code changes.

Sentry is observability, not the runtime memory database. Putting Sentry reads on the Tab path would make the
experience slower and less reliable. The two tiers meet at the same proposal metadata and the same user verdict:
accepted, escaped, typed over, refused, or unresolved.

```text
user action / correction
  ├─ local fast path
  │    ├─ form answer -> ghost.answers -> proposeAnswer() on the next scan/site
  │    └─ generic action -> FastLaneMemory -> immediate next-action suggestion
  │                                  └─ relevant examples -> Jev state.memory (async refinement)
  └─ value-free outcome
       -> extension allowlist -> server allowlist -> one Sentry client + one scrubber
       -> reviewable replay -> policy eval and/or synthetic semantic learning eval
```

## How form corrections reach the next site

With **Learn from what I type** enabled, `extension/src/content/learning.ts` records a manual answer through the
shared `recordCorrection` policy. `LearnedAnswerStore` persists it in `chrome.storage.local` under
`ghost.answers`. The key is a site-independent normalized question signature; company names and harmless ATS
wording such as “legally” and “for any employer” are removed, and choice answers also retain their visible
option label so a site-specific value can be remapped.

On every form scan, `proposeAnswer()` applies answers in this order:

1. a learned correction;
2. a supported profile fact;
3. a visible conservative guess;
4. no proposal for sensitive or unsafe-to-invent answers.

Learned answers are applied locally before the model result. `predictableFields(fields, answers)` removes a
field with a learned answer from `FormPredictRequest`, so its value, signature, and question wording do not go
to the server or Jev. This is faster than passing the correction through model state and makes the privacy
boundary structural. The options page's **Learned** tab lists and deletes this local memory.

A guess has `answer.needsReview: true`, renders with a dotted treatment, and stops held Tab. One fresh Tab can
still accept it. A learned answer does not stop held Tab.

## How generic action learning reaches Jev

Forms and generic computer-use actions have different state:

- A form correction already contains the user's answer, so asking Jev to decide it again adds latency and can
  only make the result worse. It stays local.
- For buttons, links, search/results flows, and repeated navigation, the background worker stores value-free
  state-to-action pairs in `FastLaneMemory`. It returns a matching local suggestion immediately.

When the server is configured, the visible local suggestion never waits for it. `/v1/predict/next` runs in the
background and warms a short-lived upgrade for the next rescan. The server's `buildNextDecision()` passes the
relevant examples to Jev in the typed state object:

```ts
type NextState = {
  page: { origin: string; url: string };
  recentActions: TraceEvent[];
  candidates: NextCandidate[];
  memory: EpisodicPair[];
};
```

Opaque signatures are removed before model state is built, sensitive actions are filtered again on the server,
and recall is constrained by evidence from the current origin. Local query values never enter `state.memory`.

## Where the LLM fits without slowing Tab

Jev picks from closed choices; it does not generate text. Free-text fields use the existing speculative draft
path: `DraftScheduler` starts `/v1/ghost-text` while the user is still on earlier fields and caches the result.
Tab consumes an in-memory draft; it does not start an LLM call. A pending draft stops held Tab, just like a
guess. A template fallback keeps the path functional without a key.

The LLM does not rewrite prompts, thresholds, learned answers, or production policy. Semantic learning
regressions are exercised by reviewed synthetic fixtures in code, not by a model running in the critical path.

## Sentry: one client, one scrubber

`server/src/observability/instrument.ts` is the only module allowed to call `Sentry.init`. Server startup calls it
once. Default integrations, tracing, loader hooks, and default PII are disabled. `normalizeDepth` is 6 so the
nested proposal array reaches `beforeSend` intact.

`server/src/observability/scrub.ts` is the only outbound boundary. It rejects non-walk events, validates the
outcome again, then rebuilds the event and any replay attachment from an allowlist. The event may contain only:

- closed walk state/reason/provider/action/source/verdict values;
- coarse confidence, latency, and duration buckets;
- booleans and bounded counts;
- value-free answer metadata: class (`ordinary`, `protected`, `declaration`), source
  (`fact`, `learned`, `guess`), and `needsReview`;
- a random run UUID.

It cannot represent a field label, question, value, signature, typed/generated text, URL, origin, page title,
profile, DOM, breadcrumb, request, user, exception, or screenshot. Unknown properties are dropped; invalid
closed-vocabulary values reject the envelope.

`captureEvent()` returns an ID before transport. The sink therefore waits for `Sentry.flush(2000)` and reports
`captured: true` only after the real SDK drains successfully. This happens after the walk through a best-effort
message path and never gates a ghost or a Tab press.

Configure a Sentry **Node.js** project in the gitignored root `.env`:

```dotenv
SENTRY_DSN=https://PUBLIC_KEY@o123.ingest.sentry.io/456
SENTRY_ENVIRONMENT=hackathon
SENTRY_RELEASE=ghost@YOUR_GIT_SHA
```

No auth token is needed for SDK ingestion. With no DSN, outcomes are still accepted and reviewable cases enter
the bounded local queue, but `captured` is false. `GHOST_PROVIDER=heuristic` disables Sentry for deterministic
e2e. `GET /v1/health` reports `sentry: "on" | "off"` from the validated configuration.

## Reviewed replay loop

There are two fixture types because the production privacy boundary is intentional:

- `ghost.walk-replay.v1` contains only value-free proposal verdicts. `replayGhostWalkPolicy()` recomputes the
  terminal state, reason, counts, reviewability, and locked-action invariant instead of comparing telemetry to
  itself.
- `ghost.learning-replay.v1` is a checked-in, synthetic, human-reviewed fixture that may contain fake question
  wording and fake values. It runs the real `LearnedAnswerStore`, `recordCorrection()`, and `proposeAnswer()`
  across site variants. Production Sentry events can never be promoted into this format without a human
  supplying synthetic data.

A walk is reviewable when a locked proposal was accepted, a high-confidence calibrated proposal was rejected,
or the walk was abandoned. The local queue keeps the newest 100 cases; Sentry is the durable inbox.

```bash
# Run both the value-free policy replay and semantic learning fixtures.
pnpm eval:learning-loop

# Legacy command name; it now runs the same combined corpus.
pnpm eval:walk-replays

# Inspect/export the volatile queue.
curl -s http://127.0.0.1:8787/v1/walk/replays
pnpm eval:walk-replays export --out evals/walk-replays/captured.json

# Promote a reviewed local bundle or scrubbed Sentry event.
pnpm eval:walk-replays promote sentry-event.json \
  --out evals/walk-replays/reviewed-case.json
```

The real SDK transport is tested against a local fake ingest in `server/test/sentryWalk.integration.test.ts`.
That test verifies a depth-four outcome and its attachment reach the transport without Sentry's old `[Object]`
normalization failure. It proves SDK/scrubber/transport behavior without external credentials.

## Cross-site proof

`e2e/tests/learning-loop.spec.ts` runs the built extension against local, non-submitting replicas at:

- `greenhouse.localhost`: Ghost makes a conservative work-authorization guess; the user corrects it to Yes;
- `amazon.localhost`: Ghost immediately proposes the learned Yes through Amazon's different radio value;
- `airbnb.localhost`: Ghost reuses the same correction through another wording and another value.

The test uses trusted browser clicks and real `chrome.storage.local`, asserts that exactly one lesson was stored,
and never presses Submit. The checked-in semantic replay covers the same transfer without a browser.

## Current boundary

The extension form and generic next-action paths are connected. Ghost Desktop still needs to emit the same walk
outcome and consume the shared learned-answer store. A live Sentry project remains an environment check: the
real SDK path is integration-tested locally, but no external event can be confirmed without a valid DSN.
