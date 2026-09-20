# OpenAI, for pitching

Every number here came out of `node scripts/bench-providers.mjs` on **2026-09-20** or a live run.
Full tables in [bench-providers.md](media/bench-providers.md) and
[bench-providers-ambiguous.md](media/bench-providers-ambiguous.md).

**Read §5 before pitching this track.** The honest OpenAI story is a negative result that shaped the
whole architecture, plus an experimental feature that works and rarely fires. Claiming more than that
will not survive a follow-up question.

---

## 1. The pitch, in one paragraph

> We benchmarked OpenAI as our decision provider against Jev and Baseten on the same forms, through
> the same interface, and it lost in a specific and useful way: **not on accuracy, on calibration.**
> gpt-4o-mini returned exactly **one distinct confidence value** across every call, so our 0.7
> confidence gate — the safety mechanism the whole product rests on — could not filter anything, and
> **96 wrong answers reached the user as ghosts.** That result is why Shabang has a pluggable
> provider interface with calibration as a first-class column, and why the default is a model that
> can say how sure it is. We also use OpenAI vision for the one thing accessibility genuinely cannot
> do: name a control that has no name.

---

## 2. Where OpenAI is wired in

| Use | Route / file | Model | Status |
| --- | --- | --- | --- |
| **Vision: name unnamed controls** | `POST /v1/vision/label` | `gpt-5.6-luna` | implemented, wired, **rarely fires** (§4) |
| **Vision: locate a control** | `POST /v1/vision/locate` | — | implemented, bounded |
| **Decision provider** | `server/src/providers/llm.ts` | `gpt-4o-mini` | implemented, benchmarked, **not the default** (§3) |
| **Text drafting fallback** | `POST /v1/shabang-text` | `gpt-4o-mini` | implemented, works well (§3) |
| **Résumé extraction** | `POST /v1/profile/extract` | — | implemented, one-off |

`GET /v1/vision` reports availability, cache state and remaining budget.

---

## 3. The benchmark: a useful negative result

Same 12-field job application, same provider interface, same harness:

| provider | accuracy | shown as ghosts | **wrong among shown** | p50 | **distinct conf. values** |
| --- | ---: | ---: | ---: | ---: | ---: |
| typesafe jev-latest | 100% | 100% | 0 | 266 ms | **6** |
| baseten GLM-5.3-Flash | 100% | 75.0% | 0 | 1528 ms | **3** |
| **llm gpt-4o-mini** | **0.0%** | 100% | **96** | 986 ms | **1** |
| heuristic | 100% | 100% | 0 | 0 ms | 4 |

On the 10 ambiguous look-alike labels it reached **50%** accuracy, with mean confidence **0.00** on
both correct and incorrect answers — so at the 0.7 gate it showed **0%** of its answers. Safe, but
only because it was uniformly unconfident rather than because it knew which answers were bad.

**The point is the last column, not the first.** One distinct confidence value means the model's
self-reported confidence carries no information. Our safety rule is "show a ghost only above 0.7";
against a flat 0.70 that rule is a no-op, and 96 wrong answers went straight through it. A model that
is *confidently wrong* is worse for this product than the deterministic heuristic, which is 100% and
free.

This is not "OpenAI is bad". It is a measured statement about **self-reported confidence from a
JSON-mode call**, which is the only uncertainty signal that path offers. Jev exposes calibrated
confidence natively; Baseten gets it from a hedged vote (see [baseten.md](baseten.md) §3). The
OpenAI adapter has neither, and the server marks its confidence as uncalibrated in logs
(`calibrated: false`) precisely so nobody mistakes it for the real thing.

**Where it is genuinely good: streaming text.** Fastest first token of anything measured —

| text provider | TTFT p50 | total p50 | chars/s | leaked reasoning |
| --- | ---: | ---: | ---: | ---: |
| llm gpt-4o-mini | **432 ms** | 811 ms | **317** | 0 |
| baseten GLM-5.3-Flash | 831 ms | 1135 ms | 236 | 0 |

Nearly **2× faster to first token**. It is a completely credible text provider and a poor
*uncalibrated* decision provider — and the benchmark is what separates those two claims.

---

## 4. Vision: the right idea, waiting for a machine that needs it

**The problem it solves.** Shabang classifies controls from the accessibility tree. A control with no
accessible name classifies `unknown` and cannot be ranked. Accessibility genuinely cannot help here —
there is nothing to read. A screenshot can.

**What it does.** `SBVision` crops *only* the unnamed controls into one strip and sends a single
batched request to `/v1/vision/label`. One call per page view, cached. The server re-derives
sensitivity and locked-action status **in code** after the model answers, so a model response can
never unlock an irreversible action or cause anything to execute. It never runs on a window
containing a sensitive field, and without Screen Recording permission it reports "needs Screen
Recording" and everything else keeps working.

**Measured:** 2.7 s, `gpt-5.6-luna`, correct labels.

**The honest problem: it almost never fires.** Measured across Spotify, Messages, Finder, Notes and
Chrome on a real Mac, `unnamedCount` is **0 or 1 on every app**. Nothing on this machine is nameless.
The earlier assumption — "Spotify's glyph buttons need vision" — turned out to be wrong: they are
named (`add`, `Record audio`, `Emoji picker`) and were classifying `unknown` because the *classifier
vocabulary* had no rule for those words. A vocabulary gap, not an eyes gap.

So vision is built, tested, wired, bounded and safe, and it is waiting for an app that actually needs
it. Say that plainly rather than demoing it and hoping.

---

## 5. What NOT to claim

- **Do not claim vision is load-bearing.** It is experimental and rarely triggers. `docs/openai.md`
  said "experimental" before this rewrite and it still means it.
- **Do not claim gpt-4o-mini is the decision provider.** It is not the default, and the benchmark
  explains why in one column.
- **Do not present the 0% as a broken integration.** It is a correct measurement of an uncalibrated
  confidence signal against a calibrated gate. Presenting it as a finding is strong; presenting it as
  an accident is not.
- **The OpenAI prize wants build-process evidence too** (Codex). That is a separate claim from the
  product integration and needs its own evidence before it is made.

---

## 6. Configuration and safety boundary

```dotenv
OPENAI_API_KEY=
SHABANG_VISION_BUDGET=      # whole number of calls; 0 switches vision off
SHABANG_VISION_CACHE=       # pages to remember; 0 disables the cache
```

The vision routes carry local-caller checks beyond the normal loopback guard. Requests are validated,
sent once, and discarded. Logs keep counts and status codes, never screen contents.

Provider credentials live with the loopback server, never in the desktop binary. Without a key the
vision routes report unavailable and the rest of the product is unaffected.
