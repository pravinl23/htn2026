# Always propose something

The single rule that outranks every other heuristic in this repo.

**If Ghost can see anything actionable, it proposes one. It never goes quiet because it is unsure.**

Silence is only correct when there is literally nothing on screen to act on. "I am not confident" is never a reason to show nothing: it is a reason to show the proposal *as a guess*. A suggestion you ignore costs one keystroke. A blank screen costs the whole product.

## What this replaces

- The confidence threshold no longer silences anything. It changes **how** a proposal looks, not **whether** it exists:

| Confidence | What the user sees |
| --- | --- |
| >= 0.85 (a fact, or a twice-confirmed learned answer) | Ordinary ghost. Hold-to-accept walks through it. |
| 0.7 to 0.85 | Ordinary ghost with a "guess" chip. Hold-to-accept stops here so the user sees it. |
| < 0.7 (anything else, including a pure prior on a page Ghost has never seen) | Dimmer ghost, "guess" chip, and the reason in the HUD. Still one key to accept, still one keystroke to ignore. |

- Every place in the code that previously produced "no ghost" for a low score now produces the best available candidate with `source: "guess"`. The only outcomes that legitimately produce nothing: no candidates at all, every candidate is sensitive (passwords, cards, government IDs are never filled), or Ghost is switched off or paused for that app.

## Still true, and not in conflict

Proposing is not doing. Ghost may propose anything, including an irreversible action, but it still never *performs* one without an explicit human press: Submit, Send, Pay, Delete and friends keep their lock, and holding the accept key stops at every lock and every guess. A wrong guess is one keystroke to fix; an unasked-for purchase is not.

Sensitive fields remain untouched: they are never captured, never proposed, never filled. That is a privacy rule, not a confidence rule.

## Consequences the code must honour

1. Ranking always returns a best candidate when candidates exist; a "none" answer from a model is a signal to fall back to priors and habits, never to show nothing.
2. On a page Ghost has never seen, page-kind priors alone are enough to propose (`docs/anywhere.md`).
3. A question with no matching fact and no learned answer still gets the most neutral option, and for the rare protected question with no decline-style option, the least specific option available, marked as a guess (`docs/answers.md`).
4. Every guess is visibly a guess and is remembered once the user corrects it, which is what turns a rough first day into an accurate second one.
