# Sentry: what we use, and how to show it

The prize asks for **two products beyond error monitoring**, and for evidence that Sentry data
*shaped* the project. We use **six**, and the shaping story is real — see §5, which is the part
judges actually score.

---

## 1. You have to do this first (5 minutes, needs your account)

Nothing below sends anything until a DSN exists. `SENTRY_DSN=` is currently **empty**, which makes
the entire integration a deliberate no-op.

1. In Sentry, create two projects:
   - **`ghost-server`** — platform **Node.js**
   - **`ghost-web`** — platform **React**
2. Copy each project's DSN into the repo-root `.env`:

```bash
SENTRY_DSN=<the ghost-server DSN>
SENTRY_WEB_DSN=<the ghost-web DSN>
GHOST_ENV=demo
```

3. Start the server and confirm the startup line says `sentry on`:

```bash
pnpm --filter @ghost/server dev
```

It prints exactly one line, and it never lies about state:

```
[ghost] sentry on env=demo release=<sha> traces=1.0 profiling=on logs=on metrics=on
```

If it says `sentry off (SENTRY_DSN is not set)`, the DSN did not load. Nothing else will work.

---

## 1b. The desktop agent loads ONE OF TWO libraries — get this wrong and nothing logs

`desktop/` builds two dylibs, and they are not interchangeable:

| Library | Who loads it | Built by |
| --- | --- | --- |
| `desktop/build/libghost.dylib` | `make run` and `tools/ghostctl` (sets `GHOST_LIB`) | `make lib` |
| `~/Library/Application Support/Ghost/libghost.dylib` | **a plain `open Ghost.app`** | `make install-lib` |

`make lib` updates only the first one. So after changing agent code, launching Ghost normally still runs
the **old** release library and sends nothing — the agent looks healthy, the menu bar says On, ghosts
appear, and Sentry stays empty. Always:

```bash
make -C desktop lib && make -C desktop install-lib
```

Accessibility is bound to the host binary's code hash, and the Makefile never rebuilds the host for that
reason — so installing a new library does not cost you the grant.

**If the grant is refused anyway**, look for duplicate entries: several builds at different paths all
report as "Ghost" with bundle id `dev.ghost.desktop`, and they shadow each other. Reset and grant once:

```bash
tccutil reset Accessibility dev.ghost.desktop
```

## 2. The six products, and where to click

| # | Product | What Ghost sends | Where to show it |
| --- | --- | --- | --- |
| 1 | **Error monitoring** | Unhandled route errors, captured by our middleware | **Issues** |
| 2 | **Tracing** | One transaction per request, named by route, with our own spans inside | **Traces** → open a `/v1/predict/form` transaction |
| 3 | **Logs** | One line per finished walk: `walk: 7 accepted, 2 corrected of 9 ghosts` | **Logs** |
| 4 | **Metrics** | `ghost.proposed`, `ghost.accepted`, `ghost.corrected`, `ghost.skipped`, `ghost.dismissed`, `ghost.decision_ms` | **Metrics**, or a saved **Dashboard** |
| 5 | **Profiling** | Attached to traces (`profileLifecycle: "trace"`), so a slow prediction arrives with the stacks that made it slow | **Profiles**, or the profile tab inside a trace |
| 6 | **Session Replay** | The demo web app (`@sentry/react`, `ghost-web`) | **Replays** |

Every metric is tagged `ghost.class`, `ghost.source`, `ghost.confidence.bucket`, `ghost.surface`,
so **acceptance rate is one division in the UI**: `ghost.accepted / ghost.proposed`, split by any tag.

### Build this one dashboard before you pitch

Four widgets, and it tells the whole story on one screen:

1. `ghost.accepted / ghost.proposed` over time — **is Ghost getting better?**
2. `ghost.corrected` grouped by `ghost.confidence.bucket` — **are we wrong when we said we were sure?**
3. `ghost.decision_ms` p50/p95 — **how fast does a human take the ghost?**
4. `ghost.proposed` grouped by `ghost.source` — **heuristic vs model vs learned**

Widget 2 is the one to linger on. A correction in the `high` bucket is a confident wrong ghost,
which is the single worst thing this product can do. That chart is our regression alarm.

---

## 3. What is actually sent (and what never is)

The wire schema is `shared/src/walkTelemetry.ts`, and it **cannot represent** a label, a value, a
URL, an origin or a page title — the types are closed string-literal unions, so a leak fails to
compile rather than shipping. On top of that, `beforeSend`, `beforeSendTransaction`, `beforeSendLog`
and `beforeSendMetric` all run a scrubber, and four default integrations are deliberately dropped:

- **LocalVariables** — would attach every local in a stack frame, so one crash inside the form
  predictor would ship the captured fields and all.
- **Console** — turns every `console.log` into a breadcrumb, and a breadcrumb is not scrubbed.
- **RequestData** — would attach the URL, headers and body.
- **Hono** — opens a second transaction per request, named after the raw path.

**Say this to the Sentry judges.** Most teams install the SDK and ship whatever it grabs. We removed
four default integrations *on purpose* and can say exactly why for each. That is depth of
integration, which is a scored criterion.

---

## 4. The demo, in 60 seconds

1. Ghost proposes something. Press **Tab** — accept.
2. Ghost proposes again. **Do something else instead** — a rejection.
3. Switch to Sentry. In **Logs**, the walk line is already there.
4. In **Metrics**, `ghost.accepted` and `ghost.corrected` both ticked.
5. Open the **trace** for that prediction: capture → rank → provider → render, as separate spans.
6. Open the **profile** attached to that trace.

Then the line that ties it together:

> *Every ghost the user turns down is a labelled training example. We could not see them before.
> Sentry gives us the rejection stream, the trace that explains a slow ghost, and the replay of the
> moment it appeared — and the correction itself never leaves the laptop.*

---

## 5. How Sentry actually changed the code (this is the scored part)

Do not skip this. The rubric says *"how meaningfully Sentry data influenced your project, not just
whether the SDK is installed."*

**We were optimising the wrong thing, and tracing proved it.** The assumption was that the model was
the slow part. Measurement said otherwise:

| Stage | Time |
| --- | --- |
| `rankActions` (local ranker, 20 candidates) | **0.06 ms** |
| Jev decision, warm | ~194 ms |
| **Accessibility capture, ~400 nodes** | **~160 ms** |

The local ranker uses **0.4% of one 16.7 ms frame**. Capture is **~2,600× slower than the ranker**.
The fix is not a faster model, it is incremental capture via `AXObserver` so a focus change costs one
node instead of four hundred. We would not have known without per-span timing.

Second one, same origin: the provider benchmark said Jev scored **55%** on ambiguous fields. Looking
at *which* answers lost told us the question was wrong, not the model — our criteria said
`phone: "phone number"` without saying *whose*, so on "Emergency contact phone" the answer `phone`
was correct for the question we actually asked. Stating ownership took it to **90%**, and took wrong
ghosts above the confidence gate from **4 per call to 0**.

That is two real changes driven by measurement, one of them a user-facing correctness bug.

---

## 6. Known gap, decide before you pitch

Pravin wants a *small amount of screen context* on each event so the dashboard reads like the pitch —
"on a video page we proposed the nav button, they clicked the video instead."

Today the schema sends **no screen context at all**, by design. The safe version that gives you the
story without leaking anything is to add three closed-vocabulary fields:

- `screenKind` — `feed | media | list | reader | commerce | settings | editor | board | form | unknown`
- `proposedRole` — the affordance role Ghost proposed
- `chosenRole` — the affordance role the user took instead

All three already exist in `shared/src/affordance` and `shared/src/knowledge`, all three are closed
sets, and none of them is a label, a URL or a value. That turns a metric into a sentence a judge
understands — *`screenKind=media`, `proposed=nav`, `chose=list-item`* — while keeping the property
that a leak would not compile.

**This is not built yet.** It is the next change.
