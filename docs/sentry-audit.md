# Sentry walk-telemetry audit

Independent audit of the walk-outcome learning loop, run against a detached checkout of `origin/main`
with a **local fake ingest on `127.0.0.1`**. Nothing was sent to sentry.io. No `.env` was read (none exists
in that checkout). No file owned by this feature was edited — every fix below is a sketch, not a commit.

## Verdict

**The redaction works; the delivery does not.** With a valid DSN configured, every walk outcome that
carries at least one proposal is destroyed by the sink's own `beforeSend` hook before it leaves the
process, and the API still answers `captured: true`. The cause is a two-line interaction: the Sentry SDK
normalizes `event.extra` to depth 3 *before* `beforeSend` runs, which replaces each
`extra.walk_outcome.proposals[i]` object (depth 4) with the literal string `"[Object]"`;
`scrubSentryWalkEvent` then re-validates that mangled event, correctly rejects `"[Object]"` as a proposal,
returns `null`, and the SDK drops the event. The only envelope shape that survives is one with
`proposals: []` — the one containing no learning signal. Everything *around* that last hop is genuinely
well built: I threw forged `user`, `request.headers.cookie`, `server_name`, breadcrumbs, contexts and
PII-stuffed proposal keys at it and **zero markers reached the wire**, the bounds checks hold, and the
local review queue works. This is one bad line in an otherwise careful feature, and it shipped green
because nothing in 2,586 tests ever initializes the real SDK. Separately, `pnpm eval:walk-replays` is not
a replay harness: it scores each fixture against expectations derived from that same fixture, so only the
`lockedAccepted === 0` invariant can ever fail.

## Claims versus what was actually proven

| # | Claim (source) | Verdict | Evidence |
|---|---|---|---|
| 1 | "Sentry event + reviewable-walk JSON attachment (when `SENTRY_DSN` is set)" — `learning-loop.md` | **FALSE** | 7 outcomes accepted, **2 delivered** — both `proposals: []`. 5 discarded by `before_send`. |
| 2 | "Sentry is the durable failure inbox" — `learning-loop.md` | **FALSE** | Follows from 1: the inbox receives only signal-free events. |
| 3 | "`captured` means a configured Sentry SDK accepted the event for delivery" — `server-api.md:135` | **FALSE** | `captureEvent()` returns an id synchronously, before `beforeSend`. 5 false positives observed. |
| 4 | "`beforeSend` discards the proposed SDK event and reconstructs a new one from the validated outcome" | **PROVEN** — and is the bug | Rebuild verified on the wire; it is exactly what rejects the SDK-mangled input. |
| 5 | "No fields for labels, question text, values, URL, origin, page title, profile, DOM" | **PROVEN** | Hostile event → 0/7 PII markers on the wire; proposal rebuilt to the allowlist. |
| 6 | "Unknown provider, source and dismissal strings collapse onto the closed vocabulary" | **PROVEN** (one gap) | Holds for `source`/`confidence`; `action` is **not** coerced (`extension/src/content/walkTelemetry.ts:94,140`). |
| 7 | "A summary that contradicts the proposals it describes" returns 400 — `server-api.md:133` | **PARTLY FALSE** | The check is one-sided. `summary.shown: 99` against 1 proposal → **200**. Under-counting is rejected, over-counting is not. |
| 8 | "Invalid or widened actions, sources, verdicts, counts, buckets or IDs return 400" | **PROVEN** | Widened `action` → 400; array body → 400; malformed JSON → 400. |
| 9 | "64 KB maximum" | **PROVEN** | 200 KB body → 413. |
| 10 | "`SHABANG_PROVIDER=heuristic` intentionally disables Sentry" | **PROVEN** | `config.ts:163,186`; `offline` requires that literal value. |
| 11 | "With no `SENTRY_DSN` … reporting `captured: false`" | **PROVEN by code path** | `config.sentry` undefined → `NoopWalkOutcomeSink` → `capture()` returns `undefined` → `captured: false`. Not re-run live this pass. |
| 12 | "Deterministic replay eval" catches regressions — `learning-loop.md` | **FALSE as written** | Self-comparison; see below. |
| 13 | "The native client only needs to emit it" (Shabang Desktop) | **PROVEN absent** | `grep -ril "walk-outcome\|walkOutcome\|walk/outcomes" desktop/` → no hits. |

## Delivery evidence

**Unpatched, real server, DSN → loopback ingest.** Seven outcomes accepted with `200 {"captured":true}`:

```
event envelopes delivered : 2   (runId 4444…, 7777…  — both proposals: [])
client_report discards    : {"reason":"before_send","category":"error","quantity":5}
```

Every outcome with ≥1 proposal was dropped. SDK debug: ``before send for type `error` returned `null`, will not send event.``
The object `beforeSend` actually receives: `"proposals":["[Object]","[Object]"]`.

**Depth sweep** (real `scrubSentryWalkEvent`, real SDK, 2-proposal outcome):

| `normalizeDepth` | `beforeSend` sees | Result |
|---|---|---|
| unset (SDK default 3) | `["[Object]","[Object]"]` | **dropped** |
| `3` | `["[Object]","[Object]"]` | **dropped** |
| `0` / `4` / `6` | full proposal objects | **delivered** |

**Latency** (route side): cold first POST **692 ms** (lazy `import("@sentry/node")` + `init()` inside the
awaited `sink.capture()`); warm **3–5 ms**. Not user-facing today, but a 700 ms stall on a latency product.

**Delivered envelope, values reduced to lengths** (2 items: event + attachment, 1848 B):

```
event_id <str:32> · timestamp <num> · platform <str:4> · level <str:7> · message <str:20>
fingerprint [<str:10>,<str:9>,<str:9>,<str:8>]
tags { feature, schema, state, reason, provider }
extra.walk_outcome { schemaVersion, runId <str:36>, state, reason, duration, provider, latency,
                     proposals[{ index, action, source, calibrated, confidence, locked, outcome }],
                     summary { shown, accepted, dismissed, locked } }
extra.walk_replay  { schemaVersion, caseId, observed{…}, expected{…, lockedAccepted: 0 } }
environment <str:6> · release <str:12> · sdk { name, version, integrations: [], packages }
attachment: {"type":"attachment","length":486,"filename":"walk-replay-<runId>.json","content_type":"application/json"}
```

No `request`, `user`, `breadcrumbs`, `exception`, `contexts`, `server_name` or `modules`.

## Privacy attack results

A single event carrying, simultaneously: a scope `user` (`email`, `id`), `request.url` +
`request.headers.cookie`, `server_name: "secret-host"`, a breadcrumb with a query-string URL, a `contexts`
entry, a `tags.leak`, a top-level `message` with an email, extra proposal keys
(`label: "Social Security Number"`, `value: "4111111111111111"`, `email`, `url`), and top-level `url` /
`pageTitle` / `dom`.

| Marker | Occurrences on the wire |
|---|---|
| `alex.chen.victim@…`, `4111111111111111`, `greenhouse.io`, `Social Security`, `secret-host`, `cookie`, `123-45-6789` | **0 each** |

Rebuilding the event from the validated allowlist is the right design and it genuinely works. Prototype
pollution via a literal `"__proto__"` key in the raw JSON body also had no effect
(`Object.prototype.polluted === undefined`).

## Bounds results

| Input | Result |
|---|---|
| 200 KB body | 413 |
| malformed / truncated JSON | 400 |
| array body | 400 |
| widened `action` (free text) | 400 |
| `"__proto__"` key in body | 200, no pollution |
| summary over-counting (`shown: 99` vs 1 proposal) | **200 — gap, see claim 7** |

## Does the replay/eval harness learn anything?

**No. It is a log with ambitions.** `server/scripts/walkReplays.ts:27` is the only production call site of
`evaluateGhostWalkReplay(fixture)` and passes no `actual`, so it defaults to `fixture.observed`
(`shared/src/walkTelemetry.ts:240-243`). `createGhostWalkReplayFixture` (`:193-207`) derives
`expected.state/reason/actions/outcomes/maxProposals` *from* `observed`. Five of the six checks compare a
frozen JSON blob against itself. Nothing re-runs Shabang against a page, so no change to the extension,
controller, predictor or server can ever move this number.

Proven: I exported 6 live fixtures and ran the documented command. 5 passed with **zero human review**;
the only failure was the one genuine safety violation:

```
FAIL 55555555-…-555555555555: locked-accepted:1
1/6 walk replay evals failed
```

That single real invariant creates a second problem. `observed` is immutable history and
`lockedAccepted: 0` is hard-coded (`shared/src/walkTelemetry.ts:204`, rejected otherwise at `:217`), so a
recorded violation can **never** be made green. Root `pnpm test` runs `pnpm eval:walk-replays`, so
following the review workflow in `learning-loop.md` and committing the case it exists to catch reds CI
permanently — and the only remedy is deleting the evidence.

## Fix sketches

Owner-owned files; these are proposals, not edits.

**1. `server/src/telemetry/walkOutcomes.ts:66-77` — the whole bug (one line).**

```diff
       sdk.init({
         dsn: this.config.dsn,
         ...
         registerEsmLoaderHooks: false,
+        // The SDK normalizes event.extra BEFORE beforeSend. The default depth of 3 stubs
+        // extra.walk_outcome.proposals[i] (depth 4) to "[Object]", which the scrub then
+        // correctly rejects, dropping every outcome that has proposals. Keep this >= 5.
+        normalizeDepth: 6,
         beforeSend: (event) => scrubSentryWalkEvent(event) as typeof event | null,
       });
```

Verified: `0`, `4` and `6` all deliver. Prefer `6` over `0` — `0` disables normalization entirely, losing
its circular-reference and breadth protection, and the rebuild does not need that. This value is silently
coupled to the schema depth, which is why fix 2 is not optional.

**2. `server/test/walkTelemetry.test.ts` — the test that would have caught it (no network).**
Every existing test injects a `vi.fn()` fake or `NoopWalkOutcomeSink`; `SentryWalkOutcomeSink` is never
constructed, and `scrubSentryWalkEvent` is only fed hand-built events the SDK never normalized — exactly
the shape that never occurs in production. Add one test using a stub transport (pattern verified working):

```ts
const sent: unknown[] = [];
const client = new Sentry.NodeClient({
  ...sinkInitOptions,                                  // the real options, incl. beforeSend
  integrations: [], stackParser: Sentry.defaultStackParser,
  transport: () => ({ send: async (e) => { sent.push(e); return {}; }, flush: async () => true }),
});
client.captureEvent({ extra: { walk_outcome: outcome } });
await client.flush(2000);
expect(sent).toHaveLength(1);                          // 0 on today's main, 1 once fixed
```

**3. `server/src/routes/walkTelemetry.ts:26-31` — stop reporting success for dropped events.**
`captured: eventId !== undefined` is true the moment the SDK loads. Either derive it from `beforeSend`
actually returning an event (have the sink track its own outcome and return `undefined` on a drop), or
rename the field and correct `docs/server-api.md:135`, which currently promises "accepted for delivery".

**4. `server/src/routes/health.ts` — make the sink observable.**
Add `sentry: "off" | "on"` to `/v1/health`. Combined with defect 3 there is currently no external way to
tell that every event is being discarded.

**5. `shared/src/walkTelemetry.ts:287` — close the summary gap.**
Add the upper bound to match the documented contract:
`if (summary.shown > proposals.length) return null;` (and cap `accepted`/`locked` at their actual counts).

**6. `extension/src/content/walkTelemetry.ts:94,140` — coerce `action` like its siblings.**
`source` and `confidence` go through `walkSource()` / `walkConfidenceBucket()`; `action` is passed raw.
An unexpected value makes the server reject the envelope and the **entire walk vanishes silently**. Not
reachable today (action is derived in code), but it is a latent asymmetry that fails closed and silently.

**7. `server/scripts/walkReplays.ts:11` + `shared/src/walkTelemetry.ts:204` — decide what the eval is.**
Either wire it to re-run a walk so `actual` is genuinely produced, or rename it to what it is (a failure
archive + one invariant checker) and stop hard-coding `lockedAccepted: 0` so a recorded violation can be
committed without reddening CI. Also: `pnpm eval:walk-replays <file>` fails with `unknown command: <file>`
because argv[0] is the subcommand — accept a bare path, or document `eval <file>` in the usage text.

## What a real Sentry DSN would add

My ingest returns 200 to anything, so these stay **unverifiable** without one:

- Whether sentry.io's relay **accepts this hand-rebuilt event shape** — it carries no `exception` and a
  bare `message`, and `extra` may exceed per-field size limits. This is the one that could still surprise.
- Rate-limit handling (429, `X-Sentry-Rate-Limits`), retry and backpressure when ingest is slow or down.
- Whether `promote` works on a **Sentry API export**: the web API returns extras under `context`, not
  `extra`, so `extractFixtures` (`walkReplays.ts:67-68`) would likely fall through and fail. Ten-minute check.
- Transport compression behaviour at larger payload sizes.

**Two-minute procedure once a DSN exists** (apply fix 1 first, or this proves nothing):

```bash
# 1. Real DSN, and NOT the offline provider — SHABANG_PROVIDER=heuristic disables Sentry by design.
SENTRY_DSN='https://<key>@oNNN.ingest.sentry.io/NNN' SENTRY_ENVIRONMENT=audit \
  SHABANG_PROVIDER= pnpm --filter @shabang/server start

# 2. Post one reviewable outcome with a real proposal (the shape that is dropped today).
curl -s localhost:8787/v1/walk/outcomes -H 'content-type: application/json' -d '{
  "schemaVersion":"shabang.walk-outcome.v1","runId":"11111111-1111-4111-8111-111111111111",
  "state":"abandoned","reason":"page-left","duration":"1s-4.9s","provider":"typesafe","latency":"250-499ms",
  "proposals":[{"index":1,"action":"fill","source":"server","calibrated":true,
                "confidence":"95-plus","locked":false,"outcome":"accepted"}],
  "summary":{"shown":1,"accepted":1,"dismissed":0,"locked":0}}'

# 3. Sentry UI -> Issues, search: ghost.walk.abandoned
```

**Pass** = the issue exists, `extra.walk_outcome.proposals` is a real object (not `"[Object]"`), the
`walk-replay-<runId>.json` attachment is present, and the event carries no `user` / `request` / breadcrumbs.
**Fail** = no issue at all, which is today's behaviour. Add `debug: true` to the `init()` options and look
for ``before send … returned `null` `` to confirm it is still the normalization bug.

---

*Method: detached `origin/main` worktree; ingest stub bound to `127.0.0.1` and stopped afterwards; all
ports released; `git status --porcelain` empty (no tracked file modified). Findings 1, 3 and 7 were reached
independently by a second audit agent working in the same checkout.*
