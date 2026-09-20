# Demo captions

For a video editor or captioning agent. Each segment has a **title** (large, on screen 1–2 s), a
**sub** (one line under it), and **callouts** (short labels pinned to a specific thing on screen).

Rules for whoever uses this:
- Titles are 2–5 words. Subs are one line, under ~12 words. Callouts are 1–4 words.
- **Every number here is real and measured.** Do not round them up, and do not invent new ones.
- Nothing may say Sentry "trains the model". It carries the signal; the local loop learns. See the
  wording in segments 7 and 10 and use it as written.

---

## Part 1 — the product

### 1. Cold open — an app
- **Title:** Cursor Tab, for your Mac
- **Sub:** It reads the screen and proposes the next thing you'll do
- **Callouts:** `purple ring = the proposal` · `right ⌘ to take it`

### 2. It works anywhere
- **Title:** Any app. Not a browser extension.
- **Sub:** Native apps, web pages, Finder — same agent, same accessibility tree
- **Callouts:** `Spotify` · `Finder` · `Chrome`

### 3. A website — the form
- **Title:** A real job application
- **Sub:** One batched call maps every field; Tab walks the answers
- **Callouts:** `14 fields filled` · `resume attached` · `Submit stays locked`

### 4. Submit is never pressed
- **Title:** It draws Submit. It won't press it.
- **Sub:** Anything irreversible is locked — send, pay, delete, submit
- **Callouts:** `locked` · `no ghost cursor`

### 5. iMessage — the reply
- **Title:** It writes the reply
- **Sub:** Reads the thread off the screen, drafts into the compose box
- **Callouts:** `739 ms` · `Baseten wrote this` · `Jev picks — it can't write`

### 6. It won't make things up
- **Title:** It refuses to invent
- **Sub:** Asked about a time it doesn't know, it says it'll check
- **Callouts:** `"let me check and get back to you"`

---

## Part 2 — Sentry

### 7. The turn
- **Title:** The interesting half is what you *don't* take
- **Sub:** Every ghost you turn down is a labelled example — your own verdict, no annotation
- **Callouts:** `accept = positive` · `escape = negative`

### 8. Tab 1 — Logs
- **Title:** One line per decision
- **Sub:** Sentry → Explore → Logs
- **Callouts:** `ghost.accepted 1` · `ghost.surface desktop` · `no label, no value, no URL`

### 9. Tab 1 — the click
- **Title:** Log → trace, one click
- **Sub:** Most teams install six SDKs that know nothing about each other
- **Callouts:** `trace id` · `same event, now a trace`

### 10. What the loop actually is
- **Title:** How it learns
- **Sub:** Locally it reorders suggestions now; in Sentry the confident-but-rejected become regression tests
- **Callouts:** `learns you immediately` · `rejections become tests`

### 11. Tab 2 — Traces
- **Title:** Same endpoint, 60× apart
- **Sub:** A cold model call against a cached form mapping
- **Callouts:** `231 ms — Jev` · `0–4 ms — cached` · `1.3 s — Baseten writing`

### 12. Tab 3 — Profiles
- **Title:** We were optimising the wrong thing
- **Sub:** We assumed the model was slow. The profiler disagreed.
- **Callouts:** `ranker: 0.06 ms` · `capture: 160 ms` · `2,600× slower`

### 13. Tab 4 — Metrics
- **Title:** The regression alarm
- **Sub:** Corrections grouped by confidence — a confident wrong ghost is the worst thing we can do
- **Callouts:** `ghost.corrected` · `high bucket = the alarm`

### 14. Tab 5 — Replays
- **Title:** The session, not its contents
- **Sub:** Every input masked before it leaves the page
- **Callouts:** `masked` · `shape only`

### 15. The live moment
- **Title:** Watch it land
- **Sub:** Take one. Refuse the next. Both appear in Sentry.
- **Callouts:** `accepted` · `rejected` · `~1 second`

---

## Part 3 — close

### 16. What Sentry changed
- **Title:** It changed the code
- **Sub:** Four things we would not have found by reading it
- **Callouts (one at a time):**
  - `rejections logged as silence`
  - `capture, not the model, was slow`
  - `our prompt, not Jev: 55% → 90%`
  - `three zombie servers`

### 17. The providers
- **Title:** Calibrated, not just correct
- **Sub:** We gate at 0.7, so we buy confidence that means something
- **Callouts:** `Jev: 6 distinct values` · `gpt-4o-mini: 1 value, 96 wrong shown`

### 18. Sign-off
- **Title:** Shabang
- **Sub:** It proposes. You decide. Both answers are the product.

---

## Lower-thirds (reusable, any time the thing appears)

| when | caption |
| --- | --- |
| a ghost appears | `proposal — right ⌘ to take` |
| a locked control | `locked — it won't press this` |
| a dotted underline | `a guess — shown, not hidden` |
| Jev runs | `Jev · typed decision · calibrated` |
| Baseten runs | `Baseten · GLM-5.3-Flash` |
| a Sentry panel | `Sentry · live data` |

## Numbers safe to put on screen

`739 ms` iMessage reply · `910 ms` second reply · `266 ms` Jev, 12-field form ·
`231 ms` Jev live · `0–4 ms` cached form · `1.3 s` Baseten draft · `0.06 ms` local ranker ·
`160 ms` accessibility capture · `2,600×` capture vs ranker · `2.1 s` resume attach ·
`14` fields filled · `55% → 90%` after the prompt fix · `96` wrong answers shown by gpt-4o-mini ·
`6` Sentry products
