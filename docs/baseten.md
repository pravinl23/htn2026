# Baseten, for pitching

Every number in this file came out of `node scripts/bench-providers.mjs` or a live run, on
**2026-09-20**. The full tables are in [bench-providers.md](media/bench-providers.md) and
[bench-providers-ambiguous.md](media/bench-providers-ambiguous.md). If a claim is not in here, do not
make it on stage.

---

## 1. The pitch, in one paragraph

> Shabang only shows a suggestion when it is confident — a wrong ghost is worse than no ghost, so
> everything is gated at 0.7. That makes *calibrated uncertainty*, not raw accuracy, the thing we
> actually buy from a model. Baseten's Model APIs accept `logprobs` and return none, so there was no
> uncertainty to read. We built it instead: the same schema-constrained request fired K+H times in
> parallel, voted, stragglers aborted — **agreement between samples becomes the confidence signal.**
> It scores 100% on both benchmark forms with **zero wrong answers above the gate**, and it writes
> every word of text the product produces.

---

## 2. What Baseten does in the product

Two jobs, both on the critical path of the demo:

| Job | Route | Model | What the user sees |
| --- | --- | --- | --- |
| **Text generation** | `POST /v1/shabang-text` | `zai-org/GLM-5.3-Flash` | the iMessage reply, the "Why this company?" essay, every long-form answer |
| **Decision fallback** | `POST /v1/predict/form` | `zai-org/GLM-5.3-Flash` | field→fact mapping when Jev is not configured |

Text is where it is irreplaceable. Jev returns **typed decisions and cannot write text at all** — it
picks, it never generates. So the moment the product needs a sentence, it is Baseten.

Live, end to end: a real iMessage thread in **646 ms**

```
controller: conversation of 4 messages (51 nodes) in the compose column
server: /v1/shabang-text started label=Message
controller: draft ready label=Message chars=61 provider=baseten
```

and a real application form, drafting both long answers (541 and 538 characters) which were then
written and verified into the page.

---

## 3. The interesting engineering: confidence without logprobs

This is the part worth talking about, and it is forced by the product rule, not chosen for fun.

**The constraint.** `confidenceThreshold` defaults to 0.7. A model that answers well but cannot say
*how sure it is* cannot be gated, and an ungated ghost is the worst failure this product has.

**The finding**, from the provider's own header comment:

> *"Measured on these APIs: logprobs are accepted but never returned, so agreement between samples is
> the confidence signal."*

`buildRequestBody` still sends `logprobs: true, top_logprobs: 5` and `readLogprobs` still parses
them, so the day the API returns them the code picks them up. It does not depend on them.

**The design** (`server/src/providers/baseten.ts`, `consensus.ts`, `hedge.ts`):

- ONE logical decision per form, not one per field.
- The same `json_schema`-constrained request is fired **K=3 samples + H=1 hedge** in parallel at
  temperature 0.7.
- The first K valid answers are **voted**; agreement across samples is the confidence.
- Stragglers are **aborted** as soon as the vote closes, so the hedge costs latency, not money.
- The deadline is `DECISION_TIMEOUT_MS - 200`, deliberately *inside* the caller's race, so a
  **partial vote** can still win rather than the whole form falling back to the heuristic.

**What the hedge costs, measured:**

| | first sample p50 | K-th sample p50 | slowest | stragglers aborted |
| --- | ---: | ---: | ---: | ---: |
| 12-field form | 1085 ms | 1335 ms | 2372 ms | 11 |
| ambiguous form | 579 ms | 972 ms | 1163 ms | 4 |

The first sample is what a single unhedged request would have cost in the best case. The gap — about
250–400 ms — is the honest price of a confidence signal on an API that does not provide one.

---

## 4. The numbers

**Decisions**, 12-field job application:

| provider | accuracy | shown as ghosts | wrong among shown | p50 | distinct conf. values |
| --- | ---: | ---: | ---: | ---: | ---: |
| **baseten** GLM-5.3-Flash | **100%** | 75.0% | **0** | 1528 ms | 3 |
| typesafe jev-latest | 100% | 100% | 0 | 266 ms | 6 |
| llm gpt-4o-mini | 0.0% | 100% | **96** | 986 ms | 1 |
| heuristic | 100% | 100% | 0 | 0 ms | 4 |

**Decisions**, 10 deliberately ambiguous look-alike labels (an emergency contact's phone, a
referrer's email — all must map to `none`):

| provider | accuracy | shown as ghosts | wrong among shown |
| --- | ---: | ---: | ---: |
| **baseten** | **100%** | 97.5% | **0** |
| typesafe | 90.0% | 90.0% | 0 |
| llm gpt-4o-mini | 50.0% | 0.0% | 0 |

Baseten is the only provider that is 100% on **both** forms, and it never once put a wrong answer
above the gate.

**Streamed drafts:**

| | TTFT p50 | total p50 | chars/s | drafts with leaked reasoning |
| --- | ---: | ---: | ---: | ---: |
| baseten GLM-5.3-Flash | 831 ms | 1135 ms | 236 | **0** |

---

## 5. Why Baseten and not something else

**Not a raw OpenAI-compatible endpoint alone.** gpt-4o-mini in the same harness scored **0%** on the
main form and returned **one distinct confidence value** (a flat self-reported 0.70) across every
call — so 96 wrong answers sailed through a 0.7 gate. A model that is confidently wrong is *worse
than the heuristic*, because gating cannot save you. Baseten's spread of vote-derived confidence is
what makes gating mean something.

**Not Jev, for this job.** Jev is better where it applies — 266 ms, calibrated, 6 distinct
confidence values — but it **reads text and cannot write it**. Every sentence the product emits has
to come from somewhere else.

**Not a local model.** Time-to-first-token is the product. 831 ms TTFT streaming into a ghost is the
difference between "Cursor-fast" and "a slow agent".

**Baseten specifically** gave a single OpenAI-compatible surface across a whole model catalog, which
is what made the provider swappable behind one `decide(state, questions)` interface — the same
interface the heuristic and Jev implement. Changing model is a config line.

---

## 6. What went wrong, and what it taught us

**Every model in the catalog reasons by default.** That costs seconds and, on short token limits,
returns `content: null` — a "successful" call with no answer. There is now a per-family thinking
control table, verified live rather than assumed:

- `zai-org/GLM-*` → `chat_template_kwargs: {enable_thinking: false}`
- `deepseek-ai/*` → `{thinking: false, enable_thinking: false}`
- `openai/gpt-oss*` → accepts `reasoning_effort` and **still spends about 30 reasoning tokens**
- `GLM-5.3-Fast` → answers **400** when asked to stop thinking (conflicts with thinking mode
  `required`), so it is not usable for this

Only the first two rows were verified live; the rest of each family is assumed, and the code says so.
There is also a `REASONING_HEADROOM_TOKENS = 700` allowance so a reasoning model cannot starve its
own answer.

**Reasoning leaking into user-visible text.** A drafting model that thinks out loud will ship its
thoughts into the compose box. The benchmark tracks this as a first-class column — **0 drafts with
leaked reasoning** — because it is a demo-ruining failure, not a nicety.

**Rate limits are tighter than they look.** Measured on a fresh account:
`x-ratelimit-limit-requests: 15`, and remaining behaves like a token bucket — about 8 after an idle
stretch, refilling one request every ~4 s. Since each decision costs K+H=4 requests, a naive
implementation exhausts the budget in four forms. The provider remembers the budget for one window
and paces itself; the benchmark run reported **0 requests answered 429**.

**We accidentally rigged our own benchmark.** `baseten.ts` carried a system-prompt line that named
two rows of the benchmark form. Baseten was effectively handed the grader's rubric while Jev — which
has no system-prompt channel — got nothing. Removed. **Baseten still scores 100%, so the line was
redundant**, but the comparison was not trustworthy until it was gone. Found while investigating a
Sentry-surfaced accuracy gap; the full story is in [SENTRY.md](../SENTRY.md) §5.3.

---

## 7. Configuration

```dotenv
BASETEN_API_KEY=
BASETEN_BASE_URL=            # defaults to the Model APIs inference endpoint
BASETEN_DECISION_MODEL=      # zai-org/GLM-5.3-Flash
BASETEN_TEXT_MODEL=
BASETEN_SAMPLES=             # K, default 3
BASETEN_HEDGE=               # H, default 1
BASETEN_LOGPROBS=1           # sent anyway; picked up if the API ever returns them
```

Each extra sample or hedge is another paid request. Keep the defaults unless a measured product need
justifies changing them.

Credentials live with the loopback server, never in the desktop binary, never in a plist, a
screenshot or a commit. Without a key the server answers `textProvider: template` — canned text, no
network — which is a safe fallback and an obvious one in `/v1/health`.
