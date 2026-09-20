# Sentry handoff — for someone with no context

Paste this whole file into a fresh conversation. It is self-contained: every number is in here, so
you do not need the repo open.

**Your job:** help record and annotate a ~3 minute screen recording of Sentry for a hackathon pitch.
The product is real, the data is real, and it was all generated on **2026-09-20**. Do not invent
numbers. If something is missing from the dashboard, say so rather than narrating it as if it were
there — the section "If a panel is empty" tells you what to do.

---

## 1. What the product is (30 seconds of context)

**Shabang** is a native macOS menu-bar agent. It reads the accessibility tree of whatever app is
frontmost — a web page, Spotify, Messages, Finder — and proposes the single next thing you are likely
to do. A purple ring marks it, a ghost cursor points at it, **right ⌘** takes it.

The pitch in one sentence, and the reason Sentry matters:

> Every ghost the user **turns down** is a labelled training example, and before Sentry we could not
> see a single one of them.

So Sentry is not "monitoring bolted on". It is the only way the team can see the product's own
training signal.

---

## 2. Access and setup

- Org: **`university-of-waterloo-01`** (`https://university-of-waterloo-01.sentry.io`)
- Two projects: the **server** project, and **`ghost-web`** (the React demo site — this is the only
  one with Session Replay)
- **Set the environment filter to `demo` and the time range to `Last 1 hour` before recording** —
  for Logs, Traces, Profiles and Metrics. **Replays is the exception: it is tagged `development`,
  so clear the filter on that tab** (Shot 7 has the ready-made URL).

That filter is the single most common way this goes wrong. The server was running as `env=dev`
earlier in the day; it was restarted as `env=demo` specifically so the recording has one clean
filter. If a panel looks empty, check the filter before anything else.

Ingestion is fast but not instant — measured at 54 ms once, but a check 20 s later has also come back
empty and then appeared. **Give it a beat and refresh before concluding anything is broken.**

---

## 3. The recording, shot by shot

Each shot earns the next. Total ~3 minutes.

### Shot 1 — the product itself (20s, NOT in Sentry)

A ghost appearing in Messages, taken with right ⌘.

Without this the rest is meaningless: the viewer has to see the thing that produces the data.

**Circle:** the purple ring on the control.
**Say:** *"Every one of these is a labelled training example — including the ones I turn down."*

### Shot 2 — Logs (30s)

**Left sidebar → Explore → Logs.**

Find a row that reads like:

```
walk: 1 accepted, 0 rejected (0 typed over, 0 dismissed) of 1 ghosts
```

**Expand the row.** The attributes are the shot:

```
ghost.accepted 1     ghost.rejected 0     ghost.proposed 1
ghost.surface  desktop               environment demo
trace          3e0cb05b754a47228d4574dc0076e95e
```

**Circle:** `ghost.accepted` and `ghost.surface: desktop`.
**Say:** *"That is a user decision. There is no page, no label and no value anywhere in it."*

> Why that matters: the wire schema is closed string-literal unions, so a label, URL or page title
> would **fail to compile** — it is not scrubbed at runtime, it cannot be represented.

### Shot 3 — the click that makes the point (25s) ← BEST MOMENT

Still inside that expanded log row: **click the `trace` id.** The trace opens.

**Circle:** the trace id *before* clicking, then the trace view that opens.
**Say:** *"Most teams install six SDKs that know nothing about each other. One click took me from a
product event to the request that produced it."*

If you only keep one shot, keep this one.

### Shot 4 — Traces, the cache contrast (30s)

**Explore → Traces.** Look for `/v1/predict/form`.

You will see the **same route** at two very different durations:

| what | duration | why |
| --- | --- | --- |
| `/v1/predict/form` cold | **~231 ms** | a real Jev decision |
| `/v1/predict/form` cached | **0–4 ms** | per-site form mapping, zero model calls |
| `/v1/shabang-text` | **~1.3 s** | Baseten writing a sentence (it streams, so first token is much sooner) |

**Circle:** two rows of the same route with wildly different durations, side by side.
**Say:** *"Same endpoint. The second visit to a site costs nothing, because the mapping is cached."*

Then open one form trace and show the spans **inside** it — those are the team's own spans, not just
the HTTP envelope.

### Shot 5 — Profiles (20s) ← STRONGEST TECHNICAL CLAIM

**Explore → Profiles**, or the profile hanging off the trace you already have open (profiling is
configured with `profileLifecycle: "trace"`, so every trace carries one).

Show **"Slowest Functions by P75"**.

The story, with real numbers:

| stage | time |
| --- | --- |
| `rankActions` — the local ranker, 20 candidates | **0.06 ms** |
| Jev decision, warm | ~194 ms |
| **Accessibility capture, ~400 nodes** | **~160 ms** |

**Circle:** the slowest function row.
**Say:** *"We assumed the model was the slow part. The local ranker is 0.06 ms — 0.4% of one frame.
Capture is 2,600× slower than the ranker. The fix isn't a faster model, it's incremental capture.
Nobody guesses that; it came out of these spans."*

### Shot 6 — Metrics (25s)

**Explore → Metrics.**

Metric names: `ghost.proposed`, `ghost.accepted`, `ghost.rejected`, `ghost.corrected`,
`ghost.dismissed`, `ghost.skipped`, `ghost.decision_ms`. Every one is tagged `ghost.source`,
`ghost.surface`, `ghost.confidence.bucket`, `ghost.class`.

Best single chart: **`ghost.corrected` grouped by `ghost.confidence.bucket`.**

**Circle:** the `high` confidence bucket.
**Say:** *"A correction in the high bucket is a confident wrong ghost — the worst thing this product
can do. That chart is our regression alarm."*

### Shot 7 — Session Replay (20s)

**Replays**, project **`ghost-web`** (NOT the server project — replay only exists here).

> **Its environment is `development`, not `demo`.** The demo site tags itself with Vite's mode, which
> is a different code path from the server's `SHABANG_ENV`. Filtering this tab by `demo` shows
> **nothing**, which looks exactly like a broken integration and is not one. Use no environment
> filter here, and a 24h range:
> `https://university-of-waterloo-01.sentry.io/explore/replays/?statsPeriod=24h&project=4512116052525056`

Open one and scrub it.

**Circle:** a masked input field.
**Say:** *"Every input is masked. We get the shape of the session, never its contents."*

### Shot 8 — the live moment (30s) ← ONLY PROOF IT IS LIVE

Split screen: the Mac desktop on one side, **Explore → Logs** on the other.

1. Take one ghost with **right ⌘**.
2. Press **Escape** on the next one.
3. Switch to Logs, refresh once.
4. **Both rows appear** — one accept, one reject.

**Circle:** the reject row's `ghost.rejected: 1`.
**Say:** *"The reject is the whole product. Before Sentry we could not see a single one."*

**Rehearse this twice before recording.** It is the only shot that proves the loop is live rather
than pre-recorded, and it is the one most likely to need a second take.

### Shot 9 — the close (20s, NOT in Sentry)

Say the four things Sentry data actually changed, in this order. These are the answers to *"how did
Sentry influence the project?"*, which is what the rubric scores.

1. **The rejection stream was invisible.** A walk where the user refused every ghost logged as
   `0 accepted, 0 corrected` — the only signal the product learns from read as **silence**. Fixing it
   exposed a second bug: `ghost.rejected` was not on the scrub allowlist, so counts shipped as
   `[redacted:key:0]` while every test that did not assert on the value still passed.
2. **We were optimising the wrong thing** (the 0.06 ms / 160 ms story from Shot 5).
3. **We were blaming the model for our own prompt.** The benchmark reported **Jev at 55%** on
   ambiguous fields. Reading *which* answers lost showed the question was wrong, not the model: the
   criteria said `phone: "phone number"` without saying *whose*, so on "Emergency contact phone" the
   answer `phone` was correct for the question actually asked. Stating ownership took it to **90%**
   and took wrong ghosts above the confidence gate from **4 per call to 0**.
4. **Error monitoring caught three zombie servers.** An `EADDRINUSE` issue turned out to be three
   server processes running, the oldest holding port 8787 — which is why a code change appeared to
   have no effect.

---

## 4. Do NOT record these

- **Issues / error monitoring.** It is product #1 of six and the least interesting thing here. The
  smoke script's deliberate-500 route now returns **404** (the route moved), so the tab may be empty.
  **Do not open a tab nobody has checked.**
- **AI Agent Monitoring.** It will show a setup screen and will not light up. That product is built
  around conversation threads, tool calls and handoffs; this agent has none — the decision model
  returns typed decisions, not messages. It is a product mismatch, not a wiring gap. If asked, say
  exactly that; it is a better answer than a blank tab.

---

## 5. If a panel is empty

In this order:

1. **Environment filter** — `demo` for logs/traces/profiles/metrics. **But Replays is tagged
   `development`**, so clear the filter on that tab (see Shot 7).
2. **Time range** — `Last 1 hour`.
3. **Right project** — Replay is only on `ghost-web`; everything else is the server project.
4. **Wait and refresh.** Ingestion is usually about a second but is not guaranteed.
5. **Is the server running?** `curl -s localhost:8787/v1/health` should return
   `"provider":"typesafe"` and `"textProvider":"baseten"`. If it says `heuristic` / `template`, the
   API keys did not load and nothing model-related will be generated.
6. **Is Sentry even on?** The server's startup line must read
   `sentry on env=demo traces=1.0 profiling=on logs=on metrics=on`. If it says `profiling=off`, it is
   running on Node 23 instead of 22 — `@sentry/profiling-node` ships binaries for even LTS only.

To generate more traffic, from the repo root:

```bash
node scripts/sentry-smoke.mjs --base http://127.0.0.1:8787
```

That drives one of every span shape. It costs real model calls (7 by default), so do not loop it.

---

## 6. Claims that are safe, and their evidence

| Claim | Evidence |
| --- | --- |
| "Six Sentry products, five beyond error monitoring" | Errors, Logs, Metrics, Tracing, Profiling, Session Replay — all have live data |
| "We removed four default integrations on purpose" | LocalVariables (would ship captured field values), Console (breadcrumbs are not scrubbed), RequestData (URL/headers/body), Hono (duplicate transaction per request) |
| "A label or URL cannot physically reach Sentry" | The wire schema is closed string-literal unions — it would fail to compile, not leak at runtime |
| "Confidence leaves as a bucket, never a number" | A confidence attached to one field is a fingerprint of what was on screen |
| "Acceptance rate is one division in the UI" | Every metric is tagged `ghost.class`, `ghost.source`, `ghost.confidence.bucket`, `ghost.surface` |

**The prize asks for two products beyond error monitoring. This uses six, five of them beyond it.**
That is three times what is asked — do not reach for a seventh.
