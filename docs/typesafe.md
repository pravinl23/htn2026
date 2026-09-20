# TypeSafe (Jev), for pitching

Every number came out of `node scripts/bench-providers.mjs` or a live run on **2026-09-20**. Full
tables in [bench-providers.md](media/bench-providers.md) and
[bench-providers-ambiguous.md](media/bench-providers-ambiguous.md). If a claim is not in here, do not
make it on stage.

---

## 1. The pitch, in one paragraph

> Shabang shows a suggestion only when it is confident — a wrong ghost is worse than no ghost, so
> everything is gated at 0.7. That makes **calibrated confidence the thing we actually buy from a
> model**, not raw accuracy. Jev is the only provider we measured that ships it natively: 100% on a
> 12-field application at **266 ms**, with **six distinct confidence values** where a general LLM gave
> us one. It is the default decision provider, and it is the reason the gate means anything.

---

## 2. What Jev decides

One job, on the critical path of the headline demo: **mapping a form's fields to the facts we know
about the user.** Open a job application, and Jev is what turns "First and Last Name", "Email",
"LinkedIn Profile", "Location" into the right values from the profile.

```
controller: form answer provider=typesafe cache=miss assignments=17 579 ms
```

It also picks the next shell command for the terminal companion (see [warp.md](warp.md)).

**One batched call per form, never one per field.** All questions in a request are answered in
parallel and extra questions barely add latency, so a 12-field form is a single decision. That is
what makes the latency budget work: the Tab walk afterwards is reading precomputed answers out of
memory at 0 ms per keystroke.

---

## 3. The numbers

**12-field job application:**

| provider | accuracy | shown as ghosts | wrong among shown | p50 | **distinct conf. values** |
| --- | ---: | ---: | ---: | ---: | ---: |
| **typesafe** jev-latest | **100%** | 100% | 0 | **266 ms** | **6** |
| baseten GLM-5.3-Flash | 100% | 75.0% | 0 | 1528 ms | 3 |
| llm gpt-4o-mini | 0.0% | 100% | **96** | 986 ms | 1 |
| heuristic | 100% | 100% | 0 | 0 ms | 4 |

**10 deliberately ambiguous look-alike labels** (an emergency contact's phone, a referrer's email, an
employer's website — all must map to `none`):

| provider | accuracy | p50 | mean conf. correct | mean conf. incorrect | distinct conf. values |
| --- | ---: | ---: | ---: | ---: | ---: |
| **typesafe** | 90.0% | **194 ms** | **0.98** | **0.53** | **9** |
| baseten | 100% | 975 ms | 0.76 | — | 2 |
| llm gpt-4o-mini | 50.0% | 1130 ms | 0.00 | 0.00 | 1 |

**Look at the last three columns of that second table.** On the answers it got right Jev was 0.98
sure; on the ones it got wrong it was 0.53 sure. That gap is the entire product: the 0.7 gate
converts it into "show this one, hold that one back". A model with one distinct confidence value
cannot do that at any accuracy.

Live, just now, on the cached path: `provider: typesafe, 12 assignments, confidence 0.97–1.00`.

---

## 4. Why Jev and not something else

**Not a general LLM.** gpt-4o-mini in the same harness, on the same forms, scored **0%** on the main
form and returned a flat self-reported `0.70` on every call. 96 wrong answers went straight through a
0.7 gate, because a constant is not a signal. Jev's confidence is calibrated and the server marks it
`calibrated: true` — everything else is marked `false`, deliberately.

**Not Baseten, for this job.** Baseten is excellent and scores 100% on both forms, but it returns no
logprobs, so its confidence has to be manufactured from a hedged vote of K=3 samples + 1 hedge — four
paid requests and ~1.3 s per decision (see [baseten.md](baseten.md) §3). Jev answers in **266 ms**
with calibration built in. That is **5.7× faster** for the same job.

**Not the heuristic.** The heuristic is free and 100% on both forms, which sounds like it wins — but
it is label-keyword matching. It holds up on a benchmark written in English and falls over on the
real thing (a combobox whose only name is "Start typing…", a label rendered as a CSS pseudo-element).
It is the fallback, not the answer.

**Speed is the product.** A ghost that takes 3 seconds feels like a slow agent; one that appears
instantly feels like Cursor. 266 ms for a whole form is inside that budget. 1.5 s is not.

---

## 5. What Jev is not, and how that shaped the build

These are constraints, and each one changed the architecture:

- **It returns typed decisions, not text. It cannot write.** So every sentence in the product — the
  iMessage reply, the "Why this company?" essay — comes from Baseten. The split between "pick" and
  "generate" is not a preference, it is what Jev is.
- **Three question types only**: `noul` (yes/no probability), `choice` (pick one of the options you
  define, returns `choice`, `probabilities`, `confidence`), `score` (a position on a scale you
  describe). A `choice` allows up to 255 options and we always add a `none` option, because a form
  field frequently maps to nothing we know.
- **It reads text, not images.** That is why the icon-labelling experiment went to OpenAI vision
  ([openai.md](openai.md) §4) rather than here.
- **It is bad at maths, counting and dates.** Dates and numbers are parsed in code, never asked.
- **Accuracy drops when the state is full of irrelevant content**, so candidates are filtered in code
  before the call. The state is small and relevant on purpose.
- **Rate limit ~1,200 requests/minute.** Never a constraint for us, because a whole form is one call.

---

## 6. What went wrong, and what it taught us

**We blamed the model for our own prompt.** The committed benchmark reported **Jev at 55%** on the
ambiguous form and we nearly wrote it up as a limitation. Reading *which* answers lost showed the
question was wrong, not the model: our criteria said `phone: "phone number"` without saying *whose*,
so on "Emergency contact phone" the answer `phone` was **correct for the question we actually
asked**. Stating ownership took it to **90%** and took wrong ghosts above the gate from **4 per call
to 0**.

The lesson generalises past this API: a typed decision model answers the question you wrote, exactly,
and will not quietly infer the question you meant. That is the same property that makes it
trustworthy.

**Our comparison was accidentally rigged.** `baseten.ts` carried a system-prompt line naming two rows
of the benchmark form. Baseten was effectively handed the grader's rubric while Jev — which has no
system-prompt channel at all — got nothing. Removed. Baseten still scores 100%, so the line was
redundant, but the comparison was not trustworthy until it was gone.

Both were found by reading Sentry data rather than by staring at code; the full story is in
[SENTRY.md](../SENTRY.md) §5.3.

**Agents invent request fields.** The wire contract is exactly `{ model, state, questions }`, and
`questions` is a keyed object, not an array. Building a request by guessing produced a 422 and then a
400 before it produced an answer. `server/src/providers/typesafe.ts` keeps that contract explicit
over plain `fetch` for this reason, rather than hiding it behind a wrapper.

---

## 7. Configuration

```dotenv
TYPESAFE_API_KEY=       # direct: POST https://api.typesafe.ai/v1/systemone
AI_GATEWAY_API_KEY=     # optional: Jev via Vercel AI Gateway, model typesafe-ai/jev
```

Provider precedence, chosen at server start and reported by `GET /v1/health`:

1. `TYPESAFE_API_KEY` → **TypeSafe direct** (what we run)
2. `AI_GATEWAY_API_KEY` → Jev through the Vercel AI Gateway
3. `OPENAI_API_KEY` → OpenAI adapter, **marked uncalibrated**
4. nothing → deterministic heuristic

Health should read `"provider":"typesafe","calibrated":true,"model":"jev-latest"`. If it says
`heuristic`, no key loaded.

> **Worth knowing before the demo:** `AI_GATEWAY_API_KEY` is currently **empty**, so there is no
> second path to Jev. If TypeSafe hiccups mid-demo it falls to the OpenAI adapter or the heuristic,
> not to Jev-via-Gateway. Filling that key in buys a second route to the same model.

Retries cover 429 and 529 with backoff, inside one deadline for the whole `decide()` call. Keys live
with the loopback server, never in the desktop binary.
