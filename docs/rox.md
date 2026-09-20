# Rox Best AI Agent, for pitching

**There is no Rox SDK in this repo, and there is nothing to integrate.** This track is judged on the
agent itself, against five criteria. This file answers each one with something measured.

If someone asks "how did you use Rox?" the answer is that it is a category, not a dependency — then
go straight to the five.

---

## The five criteria, answered

### 1. Messy inputs

The input is the macOS accessibility tree of whatever app happens to be frontmost, which is as messy
as real software gets. Four examples, all found by measurement and all fixed:

- **A field with no name at all.** On a live Ashby application the Location field publishes no
  `AXTitle`, no `aria-label`, no `aria-labelledby`. Its label sat in the static text before it — and
  the *required star*, which the page renders as a CSS `::after`, arrives as its own text node, so
  the nearest text to the field was `"*"`. Handled: a content-free placeholder never outranks a real
  label, and a bare marker never displaces the label it decorates.
- **A file input that does not say it is one.** Chromium publishes `<input type=file>` as a plain
  `AXButton` with no `AXFileUploadButton` subrole. Three separate gates wanted that subrole, so
  uploads silently did not exist in Chrome while working fine in Safari. Handled by reading the
  state the browser writes into the name (`"Resume / CV: No file chosen"`).
- **A list that publishes its own headings as rows.** A notes app puts "Pinned", "Today",
  "Previous 7 Days" in the same list and the same index space as the notes. A heading is not an item.
- **An app with no media element that is obviously a player.** Chromium publishes no `AXVideo` for a
  `<video>`, so a video page classified as a feed and the best thing on offer was a sidebar advert.
  Handled by recognising a transport bar: play/pause **plus** one of mute, fullscreen, captions.

### 2. Repetition learning

Two loops, both live. Details in [learning-loop.md](learning-loop.md).

**Local — role memory.** Every accept or refusal is recorded as a **role transition**, never an app
or a label:

```json
{"pageKind":"media","previousRole":"primary-item","role":"play","stat":{"accepted":1}}
{"pageKind":"commerce","previousRole":"primary-item","role":"cart","stat":{"accepted":1}}
```

Because it stores roles, what it learns **transfers**: "after starting a video, go fullscreen"
learned on one site applies on a site it has never seen. Two accepts reorder a place's defaults.

**Remote — the rejection stream.** Every outcome reaches Sentry as a closed-vocabulary envelope. The
label is free: the user pressing the key *is* the positive example, escaping or typing over it *is*
the negative one. Nobody annotates anything.

### 3. Validation

**Nothing is assumed to have worked.** Every write is read back, and a write that did not hold is
reported and stops the walk:

```
writer: fill kind=text label=School ok=1 method=value reason=- 64 ms
writer: upload kind=file label=Resume ok=0 method=none reason=upload-no-upload-target 2 ms
```

This caught a bug that had been reporting success for a long time: in a Chromium-hosted window
`AXPress` returns `kAXErrorSuccess` and **does nothing**. The ghost was right, the accept said it
worked, and nothing happened. Now those apps get a real click, and a row gets two — because a row
selects on one and opens on two.

### 4. Confidence

Calibration is treated as a measurable property, not a vibe. From
[bench-providers.md](media/bench-providers.md):

| provider | accuracy | wrong answers shown above the 0.7 gate | distinct confidence values |
| --- | ---: | ---: | ---: |
| typesafe jev-latest | 100% | 0 | 6 |
| baseten GLM-5.3-Flash | 100% | 0 | 3 |
| llm gpt-4o-mini | 0.0% | **96** | **1** |

A model with one distinct confidence value cannot be gated, so a wrong answer reaches the user. That
is why the product ships a provider whose confidence means something, and why Baseten's confidence is
built from a **hedged vote** rather than trusted from self-report ([baseten.md](baseten.md) §3).

### 5. Safe refusal

- **Irreversible actions are locked.** Submit, send, pay, place order, delete: Shabang draws the ring
  and **will not press it**. On the live demo application it filled 14 fields, attached a résumé, and
  stopped on "Submit application" untouched.
- **Sensitive fields are never captured, predicted or filled** — passwords, card numbers, government
  IDs.
- **Safety-paused apps.** Terminal, Keychain, System Settings and password prompts are left alone.
- **The user always wins.** Typing overrides a ghost, Escape dismisses it, and a held accept key
  always stops at a locked action.
- **Refusal is visible, not silent.** A low-confidence proposal is still drawn — as a dimmer guess
  with a dotted underline — rather than hidden, so the user can see what it was thinking and say no.

---

## The one-sentence version

> It runs on the messiest input there is — whatever app is frontmost — learns from what you refuse
> rather than only what you accept, verifies every action instead of assuming it worked, ships a
> provider chosen for calibrated confidence rather than raw accuracy, and will draw the Submit button
> but never press it.
