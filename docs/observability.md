# Observability: reading a Ghost prediction in Sentry

Ghost's whole thesis is latency. A ghost that appears in 80 ms feels like Cursor; the same ghost at 3 s feels like a
slow agent. So tracing here is not decoration: **the trace is the answer to "where did the time go", and the logs are
the answer to "why was that ghost shown, or not"**.

Code: `server/src/observability/**`. Turned on by `SENTRY_DSN` and nothing else.

- **With no `SENTRY_DSN` this is a complete no-op.** The SDK is never imported, `Sentry.init` is never called, no
  socket is opened, `createApp` adds no middleware and every route keeps the exact dependencies it had before. Unit
  tests, the e2e run and a developer without keys pay nothing. `server/test/observability.test.ts` asserts this.
- **Nothing that could be a value ever leaves.** Spans, logs and metrics carry names, counts, durations, provider
  names, confidence buckets and booleans. A scrubber runs over every event, log and metric on the way out, and
  `server/test/observabilityScrub.test.ts` pushes hostile attributes through it and asserts they never survive.

## Turning it on

```
SENTRY_DSN=...            # the ghost-server (Node) project
GHOST_ENV=demo            # environment tag, default "dev"
```

Everything else has a working default: traces are sampled at 1.0, profiling at 1.0, logs and metrics are on, and the
release is the git short sha read straight from `.git` (two file reads, no subprocess). `SENTRY_TRACES_SAMPLE_RATE`
and `SENTRY_PROFILES_SAMPLE_RATE` override the rates; `SENTRY_RELEASE` overrides the sha. Variable names only live in
`.env.example`; the DSN itself is in the ignored `.env` and is never printed.

The server says what it did in one line at start:

```
[ghost] sentry on env=demo release=45bf176 traces=1.0 profiling=off (node 23.10.0 has no prebuilt profiler (LTS releases only)) logs=on metrics=on
[ghost] sentry off (SENTRY_DSN is not set)
```

## What a trace looks like

One transaction per request, named `METHOD <route>`, with the route's work as a span inside it:

```
POST /v1/predict/form                     http.server           458 ms   status=200 route=/v1/predict/form
└── predict.form                          ghost.predict         457 ms   fields=9 answered=8 guesses=1 cache=miss provider=typesafe
    └── decide.jev                        gen_ai.invoke_agent   432 ms   questions=7 answers=7 calibrated=true
        └── model.request                 gen_ai.chat           430 ms   server.address=api.typesafe.ai status=200
```

Read it as three gaps:

| Gap | What it is | What to do when it grows |
| --- | --- | --- |
| transaction minus `predict.form` | Hono, the local-only guard, CORS, JSON parsing | almost always sub-millisecond; if not, look at body size |
| `predict.form` minus `decide.*` | **Ghost's own code**: the heuristic, the field digest, the cache key, the gate | this is the part we control; it should stay near 1 ms |
| `decide.*` minus `model.request` | the provider's own work: retries, consensus over samples, parsing | for Baseten this gap holds K + H **sibling** `model.request` spans, because one decision is that many parallel requests |
| `model.request` | the network and the model | this is the number Jev's 70–500 ms latency budget refers to |

A cache hit is the same tree with no `decide.*` child at all and a `predict.form` of about 1 ms. A fast-path answer
(`ghost.fast_path=true`) is the same. That contrast, side by side in the trace list, is the latency story of the
product in one screenshot.

Free text is streamed, so it gets a different shape. The transaction is deliberately **held open until the last
token**, because the HTTP response returns after a few milliseconds while the user is still waiting for the draft:

```
POST /v1/ghost-text                       http.server          1519 ms
└── ghost.text                            ghost.predict           6 ms
    └── llm.stream                        gen_ai.chat          1515 ms   model=zai-org/GLM-5.3-Flash streaming=true
        └── llm.first-token               gen_ai.chat.first_token 850 ms
```

`llm.first-token` is the span that matters: it is the moment the ghost starts appearing. `llm.stream` also carries
`gen_ai.response.time_to_first_token_ms`, and the same number goes into the `ghost.model.first_token` distribution.

Other spans, same rules: `vision.label` → `openai.responses`, `loop.synthesize` → `llm.chat`, `predict.next`,
`predict.command`, `profile.extract`, `facts.scan`.

## What each span means

| Span | Op | Started by | Says |
| --- | --- | --- | --- |
| `METHOD <route>` | `http.server` | `observability/middleware.ts` | one request. The name is a ROUTE from a closed list; an unrecognised path is `<other>`, never a URL |
| `predict.form`, `ghost.text`, `vision.label`, … | `ghost.predict` | same middleware | the route's own work, plus the outcome attributes |
| `decide.jev` / `decide.baseten` / `decide.llm` / `decide.heuristic` | `gen_ai.invoke_agent` | `observability/provider.ts` | ONE logical decision: the whole form in one call |
| `model.request`, `llm.chat`, `llm.stream`, `openai.responses` | `gen_ai.chat` | `observability/fetch.ts` | one HTTP call to a model provider |
| `llm.first-token` | `gen_ai.chat.first_token` | `observability/fetch.ts` | request start → first byte of a streamed answer |

`decide.*` and the model-request spans use the OpenTelemetry GenAI attribute names (`gen_ai.system`,
`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`), so Sentry reads them as AI calls
and they show up under **Agents** as well as in the trace.

## The one line per decision

Every prediction writes one structured log with the same value-free attributes as its span, plus the outcome:

```
info   /v1/predict/form: answered 8 of 9, 1 guess, 1 without a fact
warn   baseten failed after 2503ms; the heuristic answers instead
warn   typesafe answered in 2100ms, close to the 2500ms deadline
```

- "answered N of M" counts fields that got a fact key; "without a fact" is `factKey: "none"`, which is a field Ghost
  deliberately left alone (a consent checkbox, a button, a sensitive field).
- "guesses" is the `always-propose` bucketing: anything below 0.85 is shown as a guess, so this is the number of
  ghosts the user saw with a "guess" chip.
- A WARN is written whenever a provider falls back to the heuristic, and whenever a decision takes more than 80 % of
  its deadline — the early warning before a fallback.

## Metrics

| Metric | Type | Attributes |
| --- | --- | --- |
| `ghost.decision.latency` | distribution (ms) | `ghost.provider`, `gen_ai.request.model`, `ghost.ok` |
| `ghost.model.first_token` | distribution (ms) | — |
| `ghost.decision` | counter | `ghost.provider`, `gen_ai.request.model`, `ghost.ok` |
| `ghost.proposed` | counter | `ghost.class`, `ghost.source`, `ghost.confidence.bucket` |
| `ghost.accepted` | counter | same |
| `ghost.corrected` | counter | same |
| `ghost.skipped`, `ghost.dismissed` | counter | same (walk sink only) |

`ghost.class` is what was proposed (`form-field`, `free-text`, `next-action`, `command`, `vision-label`, `loop-step`,
`client`); `ghost.source` is who proposed it (the provider name, or `fact` / `learned` / `guess` / `prior` from the
walk sink). Acceptance rate is `sum(ghost.accepted) / sum(ghost.proposed)` grouped by either.

Two sources feed these counters today: the server itself (what it proposed), and `POST /v1/metrics/event`, which is
the extension reporting what the user did — a calibration pair that was not accepted is counted as
`ghost.corrected`. `observability/walkSink.ts` is the sink for the richer per-ghost walk outcomes; see below.

## How to read a slow prediction

1. **Traces → `span.op:http.server`**, sort by duration. Open the slowest `POST /v1/predict/form`.
2. Look at `predict.form`'s `self_time`. If it is more than a few milliseconds, the slowness is Ghost's own code, not
   the model — check `ghost.request.fields` and `ghost.request.fact_keys`, because the decision grows with both.
3. Otherwise open `decide.*`. Compare its duration with the `model.request` span(s) under it.
   - One `model.request` that takes nearly all of it → the provider is slow; check `gen_ai.usage.input_tokens`, and
     whether the trace has `ghost.cache=miss` where a hit was expected.
   - Several `model.request` siblings → Baseten's K + H sampling; the decision waits for the K-th, so the slowest
     sample sets the latency. Lower `BASETEN_SAMPLES` or raise `BASETEN_HEDGE`.
   - `decide.*` much longer than its children → time spent in consensus/parsing, or a retry with backoff.
4. Check the log at the same timestamp. `ghost.fallback_from` on the span, or a WARN, means the user got the
   heuristic's answer: the latency was paid AND the quality was lower.
5. With an LTS Node, the profile attached to the transaction shows which function burned the non-model time.

For a slow **ghost text**, look at `llm.first-token` rather than the total: the user stops waiting at the first token.

## Privacy: what may leave, and how that is enforced

Three layers, in this order:

1. **Only safe things are built.** `observability/summary.ts` reads a route's own JSON answer and returns counts. It
   never reads a label, a value, a signature, a locator, a draft or a URL. `observability/fetch.ts` reads exactly
   three things out of an outgoing model request — `model`, `stream` and how many messages there are — and the host,
   never the path or query string. `observability/names.ts` maps a path to a route from a closed list.
2. **A strict allowlist on attributes.** Inside a span's `data` or a log's/metric's `attributes`, only keys on
   `EMITTED_KEYS` in `observability/scrub.ts` survive; anything else is replaced by a marker. Adding a new attribute
   means adding it there on purpose.
3. **A content scrubber on everything else.** Every event, transaction, log and metric passes `beforeSend` /
   `beforeSendTransaction` / `beforeSendLog` / `beforeSendMetric`. A string that contains an email address, a phone
   number, a 12-plus digit run, an SSN/SIN shape, a URL, an absolute file path, a credential shape, a newline, or is
   longer than 120 characters is replaced **whole** by `[redacted:<reason>:<length>]`. Redacting only the match would
   leak the text around it, which is usually the more identifying half.

Stack traces are the one thing kept verbatim: they are Ghost's own source and are what makes an error actionable.
Exception messages are still content-checked.

Three default integrations are switched off for the same reason: `LocalVariables` (would attach the captured fields to
any error thrown inside the predictor), `Console` (turns a dependency's `console.log` into an un-scrubbed breadcrumb)
and `RequestData` (the raw URL, headers and body). `Hono` is off too, because it opens a second transaction per
request named after the raw path; unhandled route errors are captured by the middleware instead.

## Walk telemetry

`observability/walkSink.ts` is the Sentry sink for walk outcomes — one Tab-Tab-Tab pass over a form, and what the user
did with each ghost. It takes an already-value-free `WalkOutcome` (`ghostClass`, `source`, `bucket`, `outcome`,
`surface`, `decisionMs`) and turns it into the `ghost.proposed` / `ghost.accepted` / `ghost.corrected` counters plus
one log line. Wiring it in is one line wherever outcomes are recorded:

```ts
import { recordWalkOutcome } from "../observability/walkSink";
recordWalkOutcome(outcome); // no-op when Sentry is off
```

The walk telemetry modules themselves are owned elsewhere and are not written here.

## Known gaps

- **Profiles need an LTS Node.** `@sentry/profiling-node` ships prebuilt binaries for even-numbered Node majors only.
  On the Node 23 in this workspace the profiler is not loaded at all (it would print a stack trace and then collect
  nothing), and the startup line says so. Run the server on Node 22 to get profiles.
- **The single-file bundle has no Sentry.** `server/build.mjs` produces one file for the background LaunchAgent, and
  the SDK is deliberately left out of it (it has a native dependency). The import specifier is assembled at run time,
  so the bundle simply starts with observability off. `pnpm --filter @ghost/server dev` / `start` have it.
- **Inside `predict.form` there is one span, not four.** `cache.lookup`, `answers.propose` and `gate.evaluate` happen
  inside `server/src/providers/formPredict.ts`, which this instrumentation does not modify; their outcome is on the
  `predict.form` span and in the decision log (`ghost.cache`, `ghost.fast_path`, the bucket counts) rather than as
  spans of their own. Adding them is four `span()` calls in that file.
- **Sentry tags events with a coarse geo** (city-level, from the IP the envelope was sent from). That is inferred
  server-side after `beforeSend`, so it cannot be removed in code; switch on "Prevent Storing of IP Addresses" in the
  project's security settings to stop it.
