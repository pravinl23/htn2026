# Shabang on Baseten: inference latency is the product

Shabang is Cursor Tab for the whole browser. A ghost that appears instantly feels like autocomplete; one that takes 3 seconds feels like a slow agent, and the user has already typed the field by hand. So Shabang has one hard number: **a whole form is decided inside 2.5 s, or the model's answer is thrown away** and a keyword heuristic answers instead (`DECISION_TIMEOUT_MS` in `server/src/providers/timeout.ts`). After that one call, every Tab is 0 ms because the answers are already in memory.

A wrong ghost is worse than no ghost, so there is a second number: **confidence gating at 0.7**. A provider is only useful to Shabang if its confidence is lower on the answers it gets wrong.

This document is what we built on Baseten's Model APIs to hit both numbers, what we measured, and what did not work. Everything under "Measured" comes from real runs; where a number was not measured it says TODO.

Code: `server/src/providers/baseten.ts` (provider), `consensus.ts` (vote math), `hedge.ts` (scheduling), `server/src/llm/client.ts` (streamed text). Reports: `docs/media/bench-providers.md`, `docs/media/bench-providers-ambiguous.md`. Reproduce: `node scripts/bench-providers.mjs` (prints the planned call count first, refuses more than 120 real calls) and `pnpm test:live baseten` (5 real calls).

## Setup

```
BASETEN_API_KEY=             # enables decision provider "baseten" and text provider "baseten"
BASETEN_BASE_URL=            # default https://inference.baseten.co/v1
BASETEN_DECISION_MODEL=      # default zai-org/GLM-5.3-Flash
BASETEN_TEXT_MODEL=          # default zai-org/GLM-5.3-Flash
BASETEN_SAMPLES=             # K, default 3 (1..8)
BASETEN_HEDGE=               # H, default 1 (0..4). One decision costs K + H requests
BASETEN_DECISION_MODEL_URL=  # optional: a dedicated deployment for decisions (see Stretch)
BASETEN_LOGPROBS=            # optional: 1 = ask for logprobs and use them if they ever come back
SHABANG_WARMUP=                # 0 = skip the one warm-up request at server start
SHABANG_DECISION_PROVIDER=baseten / SHABANG_TEXT_PROVIDER=baseten   # force Baseten when a higher-precedence key exists
```

Decision precedence is typesafe, jev-gateway, **baseten**, llm (OpenAI / xAI), heuristic. Text precedence is **baseten**, openai, xai, template. `GET /v1/health` reports the provider, both models and the sampling plan. `pnpm --filter @shabang/server baseten:models` lists the live catalog with the thinking switch the server would use for each model (no inference).

## The design

1. **Thinking off.** Every model in the catalog reasons by default; with a small `max_tokens` most return `content: null` and only `reasoning_content`. Reasoning costs seconds Shabang does not have. `thinkingControl()` keeps a per-family table: GLM and DeepSeek take `chat_template_kwargs` (`enable_thinking: false`), gpt-oss takes `reasoning_effort: "low"`, GLM-5.3-Fast and inkling cannot be switched off and are marked `required` (they get token headroom and are a poor fit). Reasoning is also stripped defensively: `reasoning_content` deltas are never read and `<think>` blocks are filtered out of streams, whatever delta boundary they are split at.
2. **One structured call per form.** All questions go into one prompt. The answer is a JSON object constrained by `response_format: json_schema` (strict) with one `enum` per question. The option list a form's questions share is sent once. Long or odd option names are aliased to short codes and mapped back. `max_tokens` is sized to the question count (48 + 16 per question). The model picks; it never writes.
3. **Self-consistency as a logprob-free confidence signal.** The Model APIs accept `logprobs` and return none, and `n` must be 1. So the same request is fired K times in parallel at temperature 0.7 and the answers are voted on per question (`consensus.ts`). Probabilities are vote fractions with one pseudo-vote shared by the offered options (they sum to 1; 3 of 3 on a 13-option question is 0.77, never 1.0). A tie answers `none`. Codes that were never offered are discarded per question, not per sample. This mirrors TypeSafe's own self-consistency cookbook. It is a ranking signal, not an audited calibration, so the provider reports `calibrated: false`.
4. **Hedged requests for the tail.** K + H identical requests go out at once. The decision resolves with the first K valid samples and aborts the stragglers (`hedge.ts`). One slow replica cannot hold a form hostage. At the 2.3 s deadline a partial vote still answers, with every confidence scaled by `votes / K`, which drops it under the gate; zero samples throws and the heuristic takes over.
5. **Session affinity.** Every request of one schema carries `x-session-affinity: ghost-<hash of model + schema>`, so repeated forms land where the grammar and the prompt prefix are warm. Text requests share one affinity value for their common system prompt.
6. **Warm-up.** On server start, when Baseten is the active decision provider, ONE request with `max_tokens: 1` makes the standard form schema compile before the first real form. Never sent under Vitest; `SHABANG_WARMUP=0` disables it.
7. **A rate budget, because K + H multiplies requests.** The provider reads `x-ratelimit-remaining-requests` and `x-ratelimit-limit-requests`, models the refill between forms, and never fans out further than the estimate (the hedge is dropped first, then samples, which lowers confidence instead of failing). A 429 burst is not retried. `401` / `403` pauses the provider for 60 s and logs one line without the key.
8. **Streamed, speculative ghost text.** Essay fields go through the same OpenAI-compatible client with thinking off. The extension starts drafting every essay field on the first scan of the form (`extension/src/content/freeText.ts`), so by the time the user Tabs to it the stream is usually done. `firstTokenMs` and `latencyMs` are measured per draft, returned in the final stream event and logged per call; total draft latency goes into the server's metrics.

## Measured

All from one machine on 2026-09-19, model `zai-org/GLM-5.3-Flash`, thinking off. Sample sizes are small (credits and a 15 requests per minute limit); treat these as observations, not a benchmark paper. This session spent 92 real Baseten requests in total.

### Reported to this session by the orchestrating script (measured earlier the same day, not re-measured here)

- Plain short calls: GLM-5.3-Flash 378 ms, DeepSeek-V4.1-Flash 447 ms with thinking off; gpt-oss-120b 551 ms with `reasoning_effort: "low"` (still about 30 reasoning tokens). GLM-5.3-Fast answers 400 when asked not to think. inkling-small ignores the switch (`content: null`).
- `logprobs` / `top_logprobs` are accepted; `choices[].logprobs` is absent, streaming or not. `n > 1` is rejected.
- `json_schema` on a new schema: 3994 ms, then 1853, 911, 816 ms, with one 8187 ms outlier among 5 parallel samples. One streamed TTFT of about 770 ms.

### Measured in this session

**Single decision requests** (12-field form, 1081 input tokens, 68 output tokens, temperature 0.7, sequential). All six were valid JSON and 12 of 12 correct.

| response_format | call 1 | call 2 |
| --- | ---: | ---: |
| `json_schema` (strict) | 651 ms | 1263 ms |
| `json_object` | 1742 ms | 28323 ms |
| none (prompt only) | 791 ms | 474 ms |

The 28 s call is why the design hedges. We did NOT reproduce the cold-schema penalty: a never-seen schema (9 fields plus a unique option name) took 731, 753 and 998 ms. The penalty is real in the earlier measurement and absent in ours, so it is spiky, not constant.

**Four identical requests in parallel** (arrival times of each response):

| variant | arrivals |
| --- | --- |
| `json_schema`, one affinity value | 571 / 1121 / 1333 / 1777 ms |
| no response_format, one affinity value | 680 / 1166 / 1169 / 1262 ms |
| `json_schema`, a different affinity value per request | 569 / 1302 / 1390 / 1391 ms |

Parallel requests do not all come back at the speed of the fastest one: the third of four arrives around 1.2 to 1.4 s. That is the real price of the vote.

**Provider benchmark, 12-field form, 8 decisions each** (`docs/media/bench-providers.md`):

| provider | p50 | slowest | failed | accuracy | confidence |
| --- | ---: | ---: | ---: | ---: | --- |
| baseten (K=3, H=1) | 1052 ms | 1150 ms | 0 | 100% | 0.77 on every answer (all votes unanimous) |
| llm adapter (xAI grok-4.20-non-reasoning) | 1275 ms | 1448 ms | 0 | 100% | 0.90 on every answer (self-reported) |
| heuristic | 0 ms | 9 ms | 0 | 100% | 4 distinct values |

Baseten's first valid sample arrived at 604 ms p50 and the K-th at 1050 ms p50 (slowest 1123 ms). 8 stragglers were aborted, no request was answered 429, no vote was partial. Every decision finished with more than a second to spare under the 2.3 s deadline.

**The form that matters: 10 look-alike labels, 4 decisions each** (`docs/media/bench-providers-ambiguous.md`). "Emergency contact phone", "Referrer's email address", "Current employer's website", "First language" and "Manager's last name" must map to `none`; a wrong ghost here types the applicant's own phone number into someone else's field.

| provider | accuracy | mean confidence, correct | mean confidence, incorrect | wrong answers that pass the 0.7 gate | p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseten (K=3, H=1) | 97.5% (39 of 40) | 0.74 | 0.52 | 0 | 811 ms |
| TypeSafe Jev direct | 55.0% | 0.91 | 0.81 | 16 | 197 ms |
| llm adapter (xAI) | 60.0% | 0.90 | 0.90 | 16 | 1038 ms |
| heuristic | 100% | 0.76 | none wrong | 0 (but it shows only 50% of its answers) | 0 ms |

Why this matters for gating: the xAI adapter reports a flat 0.90 whether it is right or wrong, so the gate cannot do its job and all 16 wrong answers would have been shown as ghosts. The vote's one wrong answer came with a split vote (0.52) and was gated off. **Caveats, stated plainly:** (a) 4 decisions per provider is tiny; (b) the Baseten system prompt contains one rule ("an option must fit exactly ... answer none") that was written after seeing this kind of mistake on a similar form, so this is not a blind test for Baseten, while the Jev and xAI requests use the generic form questions with no such tuning; (c) a systematic error (every sample wrong the same way) gets full confidence from a vote. Self-consistency catches uncertainty, not bias. A comment in `baseten.ts` records an earlier session's experiment (8-field form, K = 5, not re-measured here): the prompt rule took wrong answers from 4 to 2, and "Emergency contact phone" still went to `phone` in 5 of 5 samples, an error no amount of voting removes.

**Streamed ghost text** (at most 360 characters, 4 drafts each through `POST /v1/shabang-text`):

| text provider | TTFT p50 | TTFT slowest | total p50 | chars/s p50 | reasoning leaked |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseten GLM-5.3-Flash | 1213 ms | 8083 ms | 2135 ms | 70 | 0 |
| xAI grok-4.20-non-reasoning | 421 ms | 717 ms | 1201 ms | 177 | 0 |

Individual Baseten drafts (TTFT / total): 410 / 2135, 3053 / 3429, 8083 / 8437, 1213 / 1599 ms. The live test drew 440 / 789 ms. The median request is fast; the tail is not, and the text path is a single unhedged stream. An interleaved A/B of the affinity header (4 drafts each): with `x-session-affinity` TTFT 418 / 419 / 376 / 671 ms (totals 3630 / 1006 / 712 / 1036), without it 519 / 2488 / 358 / 960 ms (totals 2568 / 2915 / 744 / 1822). Affinity looks helpful and is kept, but 4 samples per arm proves nothing.

**Rate limit.** `x-ratelimit-limit-requests: 15`. `x-ratelimit-remaining-requests` behaves like a token bucket: about 8 after an idle stretch, 7 / 6 / 5 / 4 over four back-to-back calls, back to 7 after 28 s. With K + H = 4 that is two forms back to back, then one form every 16 s. Aborted stragglers still count.

**Live test** (`pnpm test:live baseten`, run twice): decisions in 1277 ms (samples at 1077 / 1253 / 1272 ms) and 779 ms (539 / 640 / 775 ms); each time 4 launched, 1 aborted, 3243 input and 204 output tokens over the three samples, all 12 mappings right, every probability map sums to 1. Drafts: TTFT 440 ms / total 789 ms, and 374 / 870 ms; no reasoning text.

**Warm-up request** (`max_tokens: 1`, strict `json_schema` for the standard form): accepted, 548 ms, measured once through `provider.warmUp()`.

### Not measured (TODO)

- TODO: p95 / p99 of the hedged decision over hundreds of forms; how often the 2.3 s deadline produces a partial vote in practice.
- TODO: whether the warm-up request actually moves the first real form (the cold penalty did not reproduce, so we could not measure the saving).
- TODO: K = 5 against K = 3 on a labelled set large enough to draw a reliability curve for the vote.
- TODO: DeepSeek-V4.1-Flash and gpt-oss-120b through the full provider (only their plain-call latency is known).
- TODO: cost per form in dollars (we only know tokens: about 1081 in and 68 out per sample on the 12-field form).

## Limitations we found

- **No logprobs on the Model APIs.** Accepted, never returned. A single request therefore has no confidence at all; ours costs K requests. The provider keeps a capability probe (`BASETEN_LOGPROBS=1`): if a response ever carries `logprobs.content`, token probabilities of the answered values replace the vote (`confidenceSource: "logprobs"`, server-internal). Unit-tested against a synthetic response, never seen live.
- **`n` must be 1.** Sampling is K separate requests, each paying for the full 1081-token prompt, and each counted by the rate limiter.
- **Spiky tails.** 28 s on a `json_object` call, 8 s to the first token of a draft, 4 to 8 s reported on cold `json_schema`. Hedging hides this for decisions. Drafts are not hedged yet.
- **15 requests per minute on a new account** makes K + H = 4 expensive: a third form inside one minute runs with a reduced fan-out and lower confidence. Shabang softens this outside the provider: fields with structural evidence (`autocomplete` tokens) skip the model, and form mappings are cached per site, so a repeat visit makes zero model calls.
- **Thinking-required models** (GLM-5.3-Fast, inkling) cannot be used for a 2.5 s product. The catalog's fastest-sounding model is the one that rejects `enable_thinking: false`.
- **Unanimous is not calibrated.** On easy forms every answer is 0.77. The signal only carries information when samples disagree. With K = 3 the possible confidences are few (0.77 unanimous, 0.52 for 2 of 3 on a 13-option question).
- **The warm-up only covers the standard 12-field schema.** A form with a different number of model-asked fields or different fact keys has a different schema and grammar.

## Stretch: our own Tab model on Baseten (PLAN, nothing below is built or measured)

The general-purpose model is doing a tiny job: pick one of about 13 labels for a form field. A small fine-tuned model on a dedicated deployment would be faster, cheaper per form, and would return real logprobs, which removes the K-times cost of the vote.

1. **Corpus.** Generate a synthetic labelled field corpus: label, kind, placeholder, autocomplete, surrounding context -> fact key, `needs_text` or `none`. Seed it from the shared heuristic's keyword tables and the demo sites, paraphrase with an LLM, add hard negatives of exactly the kind in the ambiguous benchmark (someone else's phone, an employer's website), several languages, and ATS-style markup (Workday, Greenhouse, Lever). Hold out whole sites, not rows, for evaluation. No real personal data: the task only ever sees labels and fact KEYS.
2. **Train.** LoRA fine-tune a small open model (1B to 4B class) on a Baseten H100 workstation. Output format is the same one-object-per-form JSON, so the prompt builder and decoder in `baseten.ts` are reused unchanged.
3. **Serve.** Package with Truss, serve with vLLM on a dedicated deployment, where `logprobs` ARE available, with guided decoding for the enum schema.
4. **Plug in.** Set `BASETEN_DECISION_MODEL_URL` to the deployment's OpenAI-compatible base URL (already read by `config.ts` and used for decisions only; unverified against a real deployment) and `BASETEN_LOGPROBS=1`. Then K = 1, H = 1: one request plus one hedge, confidence from token probabilities of the answered value.
5. **Prove it.** Reliability curve (confidence bucket against accuracy) for vote against logprobs on the held-out sites, and the same latency table as above. Only then would the provider be allowed to say `calibrated: true`.
