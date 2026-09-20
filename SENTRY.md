# Sentry, for pitching

Everything in this file was verified live against the `university-of-waterloo-01` org on
**2026-09-20**, not read off a config. If a claim is not in here, do not make it on stage.

**The prize asks for two products beyond error monitoring. Shabang uses six products, five of them
beyond error monitoring.**

---

## 1. The pitch, in one paragraph

> Shabang proposes the next thing you are about to do, anywhere on your Mac, and you press Tab to take
> it. The interesting half is what happens when you *don't*. Every ghost the user turns down is a
> labelled training example, and before Sentry we could not see a single one of them. Sentry gives us
> the rejection stream, the trace that explains a slow ghost, the profile of the code that made it
> slow, and the replay of the moment it appeared — while the correction itself never leaves the laptop.

The follow-up they will ask is "how did Sentry change the project?" That is §5, and it is the part
the rubric actually scores.

---

## 2. The six products, and how to prove each one

Open these in order. Every row has real data.

| # | Product | What Shabang sends | Where to click |
| --- | --- | --- | --- |
| 1 | **Error Monitoring** | Unhandled route errors via our own middleware | **Issues** |
| 2 | **Logs** | One line per ghost outcome: `walk: 1 accepted, 0 rejected (0 typed over, 0 dismissed) of 1 ghosts` | **Explore → Logs** |
| 3 | **Metrics** | `ghost.proposed`, `ghost.accepted`, `ghost.rejected`, `ghost.corrected`, `ghost.dismissed`, `ghost.skipped`, `ghost.decision_ms` | **Explore → Metrics** |
| 4 | **Tracing** | One transaction per request, named by route, with our own spans inside | **Explore → Traces** |
| 5 | **Profiling** | Attached to traces (`profileLifecycle: "trace"`), so a slow prediction arrives with the stacks that made it slow | **Explore → Profiles** |
| 6 | **Session Replay** | The demo web app (`@sentry/react`, project `ghost-web`) | **Replays** |

Observed on 2026-09-20: 66 logs in one 15-minute window · 239 spans · "Slowest Functions by P75"
populated (`spanManualIn`, `span`) · 3 replays on `ghost-web`, one recording live.

### The single best thing to show

Expand one log row in **Explore → Logs**. It carries:

```
walk: 1 accepted, 0 rejected (0 typed over, 0 dismissed) of 1 ghosts
  ghost.accepted   1      ghost.rejected  0
  ghost.proposed   1      ghost.surface   desktop
  environment      demo
  trace            3e0cb05b754a47228d4574dc0076e95e
```

That trace id is the point. **Click it** — the trace opens, showing the same event's spans, and the
profile hangs off that trace. Log → trace → profile, one click each.

Most teams install six SDKs that know nothing about each other. Say that out loud.

---

## 3. The 30-second live demo

1. Press **Tab** on a ghost. Press **Escape** on the next one.
2. **Explore → Logs** — both appear within about a second, one line each, accept and reject.
3. Expand the reject → point at `ghost.rejected: 1` and `ghost.surface: desktop`.
4. Click the **trace id** → the trace opens.
5. **Profiles** → the stacks behind it.

Allow a second for ingestion. It is fast but not instant: measured 54 ms once, but a check 20 s later
has also come back empty and then appeared. If a log is missing, wait and refresh before saying
anything.

### Build this dashboard before you pitch

Four widgets tell the whole story on one screen:

1. `ghost.accepted / ghost.proposed` over time — **is Shabang getting better?**
2. `ghost.corrected` grouped by `ghost.confidence.bucket` — **are we wrong when we said we were sure?**
3. `ghost.decision_ms` p50/p95 — **how fast does a human take the ghost?**
4. `ghost.proposed` grouped by `ghost.source` — heuristic vs model vs learned.

Linger on widget 2. A correction in the `high` bucket is a confident wrong ghost, which is the single
worst thing this product can do. That chart is the regression alarm.

---

## 4. Why the integration is deep, not just installed

"Depth of integration" is a scored criterion. Three concrete answers:

**We removed four default integrations on purpose**, and can say why for each:

- **LocalVariables** — attaches every local in a stack frame, so one crash inside the form predictor
  would ship the captured fields and all.
- **Console** — turns every `console.log` into a breadcrumb, and a breadcrumb is not scrubbed.
- **RequestData** — would attach the URL, headers and body.
- **Hono** — opens a second transaction per request, named after the raw path.

**Nothing that could identify a page can physically reach Sentry.** The wire schema
(`shared/src/walkTelemetry.ts`) is closed string-literal unions, so a label, value, URL or page title
would fail to compile, not leak at runtime. On top of that, `beforeSend`, `beforeSendTransaction`,
`beforeSendLog` and `beforeSendMetric` all run a scrubber with an attribute allowlist. Confidence
leaves as a bucket, never a number — a confidence attached to one field is a fingerprint of what
Shabang saw on screen.

**Every metric is tagged** `ghost.class`, `ghost.source`, `ghost.confidence.bucket`, `ghost.surface`,
so acceptance rate is one division in the UI and splits by any dimension.

---

## 5. How Sentry actually changed the code

The rubric says *"how meaningfully Sentry data influenced your project, not just whether the SDK is
installed."* Four real answers, in descending order of how good they sound.

### 5.1 We were optimising the wrong thing, and tracing proved it

The assumption was that the model was the slow part. Per-span timing said otherwise:

| Stage | Time |
| --- | --- |
| `rankActions` (local ranker, 20 candidates) | **0.06 ms** |
| Jev decision, warm | ~194 ms |
| **Accessibility capture, ~400 nodes** | **~160 ms** |

The local ranker uses **0.4% of one 16.7 ms frame**. Capture is **~2,600× slower than the ranker**.
The fix is not a faster model, it is incremental capture via `AXObserver` so a focus change costs one
node instead of four hundred. Nobody guesses that; it came out of the spans.

### 5.2 The rejection stream was invisible, and the logs showed it

A walk where the user turned every ghost down logged as `walk: 0 accepted, 0 corrected of 1 ghosts`.
A dismissed ghost counted as neither accepted nor corrected, so the only signal the product learns
from read as **silence**. Now:

```
walk: 0 accepted, 2 rejected (1 typed over, 1 dismissed) of 2 ghosts
```

Fixing it also exposed a second bug: `ghost.rejected` was not on the scrub allowlist, so the counts
shipped as `[redacted:key:0]` while every test that did not assert on the *value* still passed. There
is now a test that asserts the value.

### 5.3 We were blaming the model for our own prompt

The committed benchmark reported **Jev at 55%** on ambiguous fields. Reading *which* answers lost
showed the question was wrong, not the model: our criteria said `phone: "phone number"` without
saying *whose*, so on "Emergency contact phone" the answer `phone` was correct for the question we
actually asked. Stating ownership took it to **90%**, and took wrong ghosts above the confidence gate
from **4 per call to 0**.

Worse, the comparison was rigged by accident — `baseten.ts` had a system-prompt line naming two rows
of the benchmark, so one provider was handed the grader's rubric while Jev, which has no
system-prompt channel, got nothing. Removed; Baseten still scores 100%, so it was redundant.

### 5.4 Error monitoring caught three zombie servers

An `EADDRINUSE` issue appeared. It was not a product bug — three server processes were running and
the oldest held port 8787, which is why a code change appeared not to take effect. Sentry found it
before a demo did.

---

## 6. What NOT to claim

**AI Agent Monitoring.** It shows a setup screen and it is not going to light up. That product is
built around conversation threads, tool calls and handoffs, and Shabang has none of those — Jev returns
typed decisions, not messages. It is a product mismatch, not a wiring gap.

While checking, we did fix a real correctness bug: `gen_ai.operation.name` carried our own words
(`"decide"`, `"decision"`) instead of the GenAI spec's closed vocabulary. The agent span is now
`invoke_agent` with `gen_ai.agent.name`, the model span is `chat`, and our label moved to
`ghost.operation`. Those attributes are what Sentry's AI views inside **Traces** read, so the fix is
worth having — just do not point at the Agents tab.

Six products is three times what the prize asks. Do not reach for a seventh.

---

## 7. Setup and the traps that will cost you the demo

### Two DSNs

```bash
SENTRY_DSN=<ghost-server, Node project>
SENTRY_WEB_DSN=<ghost-web, React project>
GHOST_ENV=demo
```

Start the server and confirm the one line it prints. It never lies about state:

```
[ghost] sentry on env=demo traces=1.0 profiling=on logs=on metrics=on
```

`sentry off (SENTRY_DSN is not set)` means nothing will be sent at all.

### Run the server on Node 22, not 23

`@sentry/profiling-node` ships prebuilt binaries for LTS (even majors) only. On Node 23 the startup
line says `profiling=off` and you silently lose a product.

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" pnpm --filter @ghost/server dev
```

### The desktop agent loads ONE OF TWO libraries

| Library | Who loads it | Built by |
| --- | --- | --- |
| `desktop/build/libghost.dylib` | `make run`, `tools/ghostctl` (sets `GHOST_LIB`) | `make lib` |
| `~/Library/Application Support/Ghost/libghost.dylib` | **a plain `open Ghost.app`** | `make install-lib` |

`make lib` updates only the first. Change agent code, launch normally, and the agent looks perfectly
healthy — menu bar On, ghosts appearing, Tab working — while **Sentry stays empty**, because the old
library is the one running. Always:

```bash
make -C desktop lib && make -C desktop install-lib
```

### If Accessibility keeps refusing

Several builds at different paths all report as "Shabang" with bundle id `dev.ghost.desktop` and shadow
each other in the Accessibility list, so granting the visible one does nothing. Reset and grant once:

```bash
tccutil reset Accessibility dev.ghost.desktop
```

It printed "Successfully reset" three times here — three stale entries. The Makefile never rebuilds
the host binary precisely so the grant survives a library change.

---

## 8. Where the code is

| Thing | File |
| --- | --- |
| SDK init, dropped integrations, sample rates | `server/src/observability/instrument.ts` |
| Spans, logs, metrics, counters | `server/src/observability/sentry.ts` |
| The rejection sink (metrics + the walk log line) | `server/src/observability/walkSink.ts` |
| Scrubber and the attribute allowlist | `server/src/observability/scrub.ts` |
| Route names — add a route here or it reports as `<other>` | `server/src/observability/names.ts` |
| GenAI attributes on provider spans | `server/src/observability/provider.ts`, `fetch.ts` |
| Wire schema (closed vocabularies) | `shared/src/walkTelemetry.ts` |
| Mapping wire → sink vocabulary | `server/src/routes/walkSentry.ts` |
| Desktop reporting every outcome | `desktop/src/GHServerClient.m`, `GHController.m` |
| Demo web app: replay, tracing, logs | `demo/src/observability.ts` |

A route missing from `names.ts` reports as `POST <other>`. That is how `/v1/walk/outcomes` — the most
important endpoint in the product — was invisible until it was added.
