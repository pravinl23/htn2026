# Incremental suggestion: never propose a step whose prerequisites are not met

Binding design. A bug the first live Greenhouse run made obvious: Ghost filled seven fields, skipped two dropdowns, and then parked the ghost cursor on **Submit application** with a lock badge. Submit was impossible at that moment, because required fields were still empty. Proposing it was noise, and worse, it implied the form was finished.

The rule: **Ghost suggests the next thing the user could actually do, and nothing further.** Like inline code completion, every suggestion is optional and costs one Tab to take or one keystroke to ignore, but it must never be a step the page would reject.

## 1. Requiredness, detected generically

`shared/src/form/required.ts` (pure, no DOM) decides whether a captured field is required, from evidence the capture layer already collects:

- the `required` / `aria-required` attribute (extension) or `AXRequired` (desktop);
- a required marker next to the label: a trailing `*`, `✱`, "(required)", "required", "obligatoire", or a marker element whose accessible name is "required" (the capture layer passes a `requiredMarker` boolean; a red asterisk is a marker regardless of colour, which Ghost does not read);
- a `<fieldset>`/section legend that says every question in it is required.

`isFilled(field)` is equally generic: a non-empty trimmed value; for a select, a chosen non-placeholder option; for a radio group, one checked; for a checkbox, checked; for a file input, an attached file name visible in the widget.

It answers in three states, not two: **filled**, **empty**, and **unknown**. Unknown is what capture did not say -- a select or radio group whose option list came back empty, which is how a lazily-populated combobox captures before it is opened. Unknown is not filled (the gate withholds the terminal action) and it is not empty either (section 3: it never retires an acceptance). The placeholder wordings are the canonical list from the question signature (`--`, "Select", "Choose", "Please", "Pick", plus "Click to select"), matched with leading whitespace tolerated, because a widget's reported value is rarely trimmed.

## 2. Gating

```ts
// shared/src/form/gate.ts
export interface WalkGate {
  unmetRequired: string[];        // signatures, in reading order
  terminalAllowed: boolean;       // may a terminal action be proposed at all?
  reason?: string;                // "3 required fields still empty"
}
export function gateWalk(fields: CapturedField[], ghosts: Ghost[]): WalkGate;
```

Rules, applied by both clients:

1. A **terminal action** (any locked control: submit, send, pay, place order, confirm, and "Continue"/"Next" that leaves the page) is proposed **only when every required field it could submit is filled, or has already been accepted by the user**. Otherwise no ghost is created for it at all: no cursor, no lock badge.

   "Precedes it in reading order" is *not* the test, because capture order is document order and document order is not visual order. A sticky submit bar, a header action or an action rail in a two-column layout is declared before the body it submits, and counting only the fields walked past so far would allow it with the whole form empty. **Form membership** decides instead: capture reports which `<form>` each control belongs to (honouring a `form=` attribute, so a bar outside the form still belongs to it), and a control in no form at all is its own scope -- a required search box in the site header does not withhold a newsletter's Subscribe. Where capture cannot say, the field blocks: silence is never read as "a different form".
2. When a terminal action is withheld, the HUD says exactly why: "2 required fields still empty" plus the label of the first one, and Tab at the end of the walk jumps to that field instead of to Submit.
3. Ordering stays reading order. Ghost never proposes a later step to skip an earlier unfilled required field; the walk simply ends on the last thing that still needs the user.
4. Once the last required field is filled (by Ghost or by the user typing), a rescan re-runs the gate and the terminal ghost appears, parked with its lock. This is the moment the demo wants: the cursor arrives at Submit only when the form is genuinely ready.
5. Optional fields never gate anything. A skipped optional dropdown does not block Submit.
6. Multi-step forms: "Next"/"Continue" is treated as terminal for the current step, so the same rule makes Ghost walk page 1 to completion before suggesting page 2.

## 3. Guesses count as filled only when accepted

A guessed ghost that is still pending does not count as filled. The gate looks at what is actually on the page plus what the user has already accepted.

**An acceptance stands only while the answer does.** The accepted set is reconciled against the page on every rescan: a signature is dropped as soon as the field is back reporting nothing -- the user selected the text and deleted it, the site's own validation reset the control, a re-render remounted it empty -- and the terminal action goes straight back behind the gate. Without that, the set only ever grows, and one cleared field leaves Submit proposed over a visibly empty form for the life of the page. The reconciliation is deliberately one-sided: a control capture cannot read (a combobox that hides its chosen value in a child widget, a file input that reports no filename) keeps its acceptance, because silence is not proof the answer went away, and dropping it would strand the walk on a field Ghost has already filled. That is the same `unknown` state `isFilled` reads as "not filled": unknown withholds a terminal action, but it never retires an answer. Hold-Tab still stops at the first guess (`docs/answers.md`), so a held Tab can never fill a required field with a guess and then unlock Submit in the same breath: the user sees every guess before the terminal action becomes proposable.

## 4. What the user sees

- Walk with nothing missing: ghosts, then the cursor parks on the locked Submit. Unchanged.
- Walk with something missing: ghosts, then the cursor parks on the **first unfilled required field**, and the HUD reads "2 required fields still empty: Country". Nothing suggests the form is done.
- Everything optional filled, one required dropdown Ghost cannot match: the cursor waits there with a guess, so one Tab (or the user's own choice) completes the form and Submit becomes proposable on the next rescan.

## 5. Tests that must exist

- Fixture replay of the real Viam Greenhouse form: with Country and "How did you hear" empty, NO Submit ghost exists and the HUD reason names Country; after both are answered, the Submit ghost appears last and is locked.
- A form whose only unfilled required field is above the fold, and one below the fold (the jump pill must point at it).
- An optional-only remainder: Submit is proposed.
- A multi-step form: "Continue" is withheld until step 1's required fields are filled.
- Hold-Tab cannot reach Submit through a guess.
- A submit button declared BEFORE the form body (a sticky bar) is withheld just the same, and a required field in one form does not withhold another form's action.
- A required field Ghost filled and the user then cleared withholds the terminal action again on the next rescan.
