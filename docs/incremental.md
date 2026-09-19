# Incremental suggestion: never propose a step whose prerequisites are not met

Binding design. A bug the first live Greenhouse run made obvious: Ghost filled seven fields, skipped two dropdowns, and then parked the ghost cursor on **Submit application** with a lock badge. Submit was impossible at that moment, because required fields were still empty. Proposing it was noise, and worse, it implied the form was finished.

The rule: **Ghost suggests the next thing the user could actually do, and nothing further.** Like inline code completion, every suggestion is optional and costs one Tab to take or one keystroke to ignore, but it must never be a step the page would reject.

## 1. Requiredness, detected generically

`shared/src/form/required.ts` (pure, no DOM) decides whether a captured field is required, from evidence the capture layer already collects:

- the `required` / `aria-required` attribute (extension) or `AXRequired` (desktop);
- a required marker next to the label: a trailing `*`, `✱`, "(required)", "required", "obligatoire", or a marker element whose accessible name is "required" (the capture layer passes a `requiredMarker` boolean; a red asterisk is a marker regardless of colour, which Ghost does not read);
- a `<fieldset>`/section legend that says every question in it is required.

`isFilled(field)` is equally generic: a non-empty trimmed value; for a select, a chosen non-placeholder option; for a radio group, one checked; for a checkbox, checked; for a file input, an attached file name visible in the widget.

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

1. A **terminal action** (any locked control: submit, send, pay, place order, confirm, and "Continue"/"Next" that leaves the page) is proposed **only when every required field that precedes it in reading order is filled, or is about to be filled by a pending ghost the user can still accept**. Otherwise no ghost is created for it at all: no cursor, no lock badge.
2. When a terminal action is withheld, the HUD says exactly why: "2 required fields still empty" plus the label of the first one, and Tab at the end of the walk jumps to that field instead of to Submit.
3. Ordering stays reading order. Ghost never proposes a later step to skip an earlier unfilled required field; the walk simply ends on the last thing that still needs the user.
4. Once the last required field is filled (by Ghost or by the user typing), a rescan re-runs the gate and the terminal ghost appears, parked with its lock. This is the moment the demo wants: the cursor arrives at Submit only when the form is genuinely ready.
5. Optional fields never gate anything. A skipped optional dropdown does not block Submit.
6. Multi-step forms: "Next"/"Continue" is treated as terminal for the current step, so the same rule makes Ghost walk page 1 to completion before suggesting page 2.

## 3. Guesses count as filled only when accepted

A guessed ghost that is still pending does not count as filled. The gate looks at what is actually on the page plus what the user has already accepted. Hold-Tab still stops at the first guess (`docs/answers.md`), so a held Tab can never fill a required field with a guess and then unlock Submit in the same breath: the user sees every guess before the terminal action becomes proposable.

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
