# Always propose something

The single rule that outranks every other heuristic in this repo.

**If Ghost can see anything actionable, it proposes one. It never goes quiet because it is unsure.**

Silence is only correct when there is literally nothing on screen to act on. "I am not confident" is never a reason to show nothing: it is a reason to show the proposal *as a guess*. A suggestion you ignore costs one keystroke. A blank screen costs the whole product.

## What this replaces

- The confidence threshold no longer silences anything. It changes **how** a proposal looks, not **whether** it exists:

| Confidence | Tier | What the user sees |
| --- | --- | --- |
| >= 0.85 and at or above the user's threshold (a fact, or a twice-confirmed learned answer) | `confident` | Ordinary ghost. Hold-to-accept walks through it. |
| At or above the user's threshold but under 0.85, or anything the engine inferred rather than knew | `guess` | Ordinary ghost with a "guess" chip. Hold-to-accept stops here so the user sees it. |
| Below the user's threshold (anything else, including a pure prior on a page Ghost has never seen) | `long-shot` | Dimmer ghost, "guess" chip, and the reason in the HUD. Still one key to accept, still one keystroke to ignore. |

The threshold is a slider between the tiers, not a cutoff: the two lower rows are defined by where the user put it, so dragging it to 0.99 turns every proposal on the page into a long shot and removes none of them. `ghostTier()` in `shared/src/types.ts` is the one place that decides this, and the native client's `tier()` mirrors it.

The chip on a non-confident ghost reads "guess", except where calling it a guess would be a lie: a declaration, or an answer Ghost did not guess at all -- a fact, or something the user said before -- that merely came in under the bar, reads "check this" instead. (Today the overlay decides that from the answer engine's `answerSource`, so a profile fact dimmed by a raised threshold still reads "guess"; the two paths should say the same thing.)

- Every place in the code that previously produced "no ghost" for a low score now produces the best available candidate with `source: "guess"`. The complete list of legitimate silences is the `SkipReason` union in `shared/src/types.ts`, and `grep SkipReason` finds every one of them: `sensitive` (passwords, cards, government IDs are never captured, proposed or filled), `already-answered` (the field already holds a value, which is never overwritten), `no-candidate` (every rung of the fallback chain came up empty for that field), and `paused` (Ghost is switched off, or paused for that app). Low confidence is not on that list and never will be.
- A page where every field ends in `no-candidate` is still not silent: the walk falls back to proposing the first control the user could act on at all -- a long shot that only moves to it, which is where a native Tab was going anyway -- so the only page that draws nothing is one with nothing on it, or one whose every control is sensitive or irreversible.

## Still true, and not in conflict

Proposing is not doing. Ghost may propose anything, including an irreversible action, but it still never *performs* one without an explicit human press: Submit, Send, Pay, Delete and friends keep their lock, and holding the accept key stops at every lock and every guess. A wrong guess is one keystroke to fix; an unasked-for purchase is not.

Sensitive fields remain untouched: they are never captured, never proposed, never filled. That is a privacy rule, not a confidence rule, which is why it holds at a threshold of 0 as well.

Every proposal names a key that takes it (`docs/accept-key.md`): the Ghost key accepts wherever a ghost is on screen, and Tab accepts a field ghost on an origin observed to leave Tab alone. A proposal nobody can accept is worse than no proposal, so this layer never answers "no key" -- on a locked action the key still only walks to it, and the chip says Enter.

## Consequences the code must honour

1. Ranking always returns a best candidate when candidates exist; a "none" answer from a model is a signal to fall back to priors and habits, never to show nothing.
2. On a page Ghost has never seen, page-kind priors alone are enough to propose (`docs/anywhere.md`).
3. A question with no matching fact and no learned answer still gets the most neutral option, and for the rare protected question with no decline-style option, the least specific option available, marked as a guess (`docs/answers.md`).
4. Every guess is visibly a guess and is remembered once the user corrects it, which is what turns a rough first day into an accurate second one.

## Where the rule is held

- `extension/test/always-propose.test.ts`: the tier table, one test per `SkipReason`, and "low confidence is never a skip reason" across six thresholds.
- `extension/test/always-propose-hard-cases.test.ts`: the whole browser pipeline (capture, plan, overlay, keys) over the pages with nothing to go on -- unlabelled icon buttons, a form matching no fact, a dropdown matching no fact, a video page, a page with one link -- plus the one page where silence is right.
- `e2e/tests/stage10-always-propose.spec.ts`: the same six pages in a real Chromium with the built extension loaded, offline, asserting the tier and chip actually drawn, that a hold stops at the first guess, that a locked action is proposed and never pressed, and that a field with a value is untouched.
