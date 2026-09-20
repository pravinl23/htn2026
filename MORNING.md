# Current handoff

## 2026-09-20 09:30 UTC — accepts that do something, and proposals that lead somewhere

Pushed to `main` as `7df6bb8..HEAD`, nine commits. 454 desktop tests, 1,687 shared, 796 server, 0 failed.
Everything below was measured on the live agent with `shabangctl`, not reasoned about.

### The one-line summary

Ghost could see the desktop but could not act on it, and its proposals went nowhere. Four things were
wrong, and all four are fixed and proven live.

### 1. Accepts did nothing in half the apps

In a Chromium-hosted window — Electron, CEF, **or any browser** — a web control publishes `AXPress`,
answers `kAXErrorSuccess`, and does nothing at all. Chromium answers the action on the element's behalf
without dispatching the click the page listens for. So the press reported `ok=1`, and the real click that
would have worked was never tried, because the press "succeeded".

That is the worst failure in the product: the ghost is right, the accept says it worked, nothing happens.

Now: in those apps Ghost does not ask politely, it clicks. A row there gets a **single** click, not the
double click that opens a native row. Everywhere else `AXPress` is honest and is still preferred.

```
writer: click kind=item label=4 Play Hellcats & Trackhawks... ok=1 method=click reason=- 15 ms
```

**`shabangctl accept`** is new, and it is how any of this is checkable: it takes the ghost on screen exactly
as the Ghost key does and reports what moved. It is the only harness mode that actuates.

### 2. Every iMessage draft was the same because Ghost was reading the sidebar

A sidebar row publishes exactly the `"<who>, <what>, <when>"` description a message does — because it **is**
one: the last message of some other conversation. `GHConversation` walks the window breadth-first, the
sidebar is shallower than the thread, so the sidebar answered first.

Measured: `conversation of 8 messages`, **seven of them other people's previews**. That set is identical
whatever conversation is open, which is exactly why the draft never changed.

Baseten was never the problem. Handed two real threads by hand it answers *"got em, will bring"* and
*"on it, rolling staging back now"*. It was being fed the sidebar.

The fix is the compose box — which the reply path already finds, and which the code already says every chat
app puts under the thread and beside nothing else. Find the box first, read only the column it is in.

```
before: controller: conversation of 8 messages (51 nodes)
after:  controller: conversation of 4 messages (51 nodes) in the compose column
```

and the draft became a real 862 ms Baseten call of 97 chars where it had been a **34 ms cache hit of the
same 25 characters every time**.

### 3. Proposals led nowhere because no web page was ever a "player"

Three accepts on a real video site, before:

```
1. "Go to channel NBA"                     accepted
2. "Videos"                                not-visible   (a channel TAB)
3. "Damian Lillard's Most ICONIC Moments"  accepted      -> a video page
   then proposed: "RBC Bank Account Offer"               (an advert)
```

The page was `pageKind: feed` with `hasMediaElement: false`, while the same capture held `Play (k)`,
`Mute (m)` and `Full screen (f)`. Chromium publishes no `AXVideo` for a `<video>`, so `isMediaElement` —
which only knows `AXVideo`/`AXAudio` — can never fire on the web. Media priors never applied, play and
fullscreen scored the unlisted 0.435, and a sidebar advert won on 0.88.

Two generic fixes: a **scrubber** is a player and never said so (`markScrubbersIn:` runs *after* the loop
that decided `hasMediaElement`, so its seeds were thrown away); and a window that publishes a **transport
bar** is a player — play/pause **plus** one of mute, volume, full screen, captions, mini player, autoplay,
next track, playback speed. Two controls, never one: a lone "Play" is a verb the rest of the desktop uses.

```
after:  pageKind: media   evidence: [media-element, media-controls, media-roles]
        0.722 play        "Play (k)"
        0.644 fullscreen  "Full screen (f)"
took [click] "Play (k)" -> accepted, verified, 19 ms
now proposes: "Full screen (f)"
```

That is the chain you asked for: open a video, it plays it, then it offers fullscreen.

### 4. The resume upload — never a Finder problem, and never worked in Chrome

Chromium publishes `<input type=file>` as a **plain AXButton**: no `AXFileUploadButton` subrole, role
description `"button"`. It puts the control's own state in the name instead:

```
role=AXButton subrole=- roleDesc="button" title="Resume / CV: No file chosen"
```

**Three** separate gates each wanted that subrole, so in Chrome the upload silently did not exist: the
control captured as an ordinary button (no `file` field, no upload ghost — the walk filled thirteen fields
and skipped the resume without a word); then the writer refused its own ghost with `no-upload-target`; then
the Attach press was the same Chromium lie as (1). WebKit does publish the subrole, which is why the earlier
Greenhouse run in **Safari** worked and this looked like a mystery.

All three now read the state the browser itself writes into the name. The same text tells Ghost a file is
**already** there, so rule 9 holds and Ghost never replaces somebody's own attachment.

Live, on the local demo application in Chrome:

```
openpanel: -> pressUpload (0 ms in) ... -> done (2099 ms in)
openpanel: attached in done (escape=0 leftOpen=0) 2101 ms
walk: 14 accepted, upload/accepted, stopped=no-ghost
page now reads: "Resume / CV: resume-alex-chen.pdf"
```

`Submit application` stayed **locked and untouched** throughout. Both long questions were drafted by Baseten
and written verified — "Why Northwind?" at 541 chars, "a project you are proud of" at 538.

Every open-panel transition is now logged. An upload is ten steps in another process, and this is the only
way to see which one goes wrong.

### 5. A feed suggested the channel, not the video

```
before: 0.704 primary-item "Go to channel PedTalksFutbol"          <- top
        0.704 primary-item "Who Really Deserves the Ballon d'Or? 15 minutes"
        0.704 primary-item "PedTalksFutbol"
```

A tile's channel link, its title and its avatar are all the same kind of thing to the ranker — three members
of one list, tied on the place's prior, and the tie fell through to capture order.

The **duration** tells them apart, and it is the exact twin of the price rule already here: a price *beside* a
link makes it a product tile, so a duration *in* a link makes it a piece of media. `looksLikeDuration` only
knew the scrubber form ("0:42"), which never appears in a link's name; it now also knows the written-out form
a media list publishes ("15 minutes", "8 minutes, 57 seconds"), excluding "ago".

```
after:  0.724 primary-item "Who Really Deserves the Ballon d'Or? 15 minutes"   <- top
        0.724 primary-item "What Did Ancient Humans Actually Do All Day? 11 mi"
        0.720 primary-item "The NBA was TERRIFIED of this... 8 minutes, 57 sec"
```

### The "why this company" answer is good when it has the posting

Given the posting and the applicant's facts, the essay path produces a real answer — it used the matching
engine, correctness under load, tests, distributed systems, and the applicant's own order-book project.
`pageContext {company, role, description}` is capped at 2000 chars on both sides. The plumbing was fine;
what was missing was context, and that was (2) and (4).

### Sentry: it works, and it was invisible

`POST /v1/walk/outcomes` returns `{"accepted":true,"captured":true}` — `captured` is the Sentry event id.
The desktop's payload shape is valid and the route accepts it. (A first test said otherwise and **the test
was wrong**: a hand-written `runId` that was not a v4 UUID. The desktop uses `NSUUID`, which is.)

The post was fire-and-forget with **no logging at all**, so this could not be answered from the machine that
sends it. It now says so, and this is a real accept in Messages:

```
walk-outcome: accepted reported, sentry=captured
```

**What is logged:** per outcome — action, source (offline/server/cache/llm), a confidence bucket, locked,
and the outcome (accepted/escaped/typed-over/refused). Plus the server's own spans, latency percentiles and
cache hit rate.

**What is missing, and what I would change before leaning on it for training** (not done — it edits a
privacy-reviewed schema, and that is your call):

- `provider` and `latency` are **hardcoded to `"none"`** in the desktop's payload, even when the ghost came
  from typesafe or baseten with a real measured latency. Sentry cannot currently answer "which provider gets
  accepted more".
- `duration` is hardcoded to `"under-250ms"`. How long the user actually took to decide is never recorded.
- `state: "parked"`, `reason: "locked-action"` is claimed for **every** accept, whether or not the walk
  stopped at a lock. That is false data going to Sentry.
- **The role and the page kind are not sent at all.** This is the big one for your "use the logs to build the
  knowledge graph": the next-action proposal is the whole product, and Sentry never learns that it was
  `play` on a `media` page rather than `search` on a `feed`. Both are closed enums, so they would fit the
  value-free schema without weakening it.
- `/v1/metrics` counters (`ghostsShown`, `ghostsAccepted`) sit at 0 and always will: they are fed by the
  **browser extension**, which is in `attic/` and dead. Do not read them as "nothing is being reported".

### Still open

- **A channel page comes back unreachable.** This is why the earlier `"Videos"` press failed `not-visible`,
  and it is NOT a classifier problem. On a channel page Chromium reports all thirty video links with
  `height: 0` and an **identical rect** (`x:106, y:817`) — never laid out — so nothing there can be clicked
  whatever it classifies as. `mainRegionRepeats: 6`, so the list detector settles on a six-item strip and the
  page reads `app`; the top proposal is a per-video "More actions" menu, eight times. A home feed on the same
  site is fine (real geometry, `repeats: 24`), so this is specific to that layout. Worth a look at whether
  Ghost should re-capture when a whole list comes back zero-height, rather than proposing into it.
- **A tab is still not modelled.** A tab is `AXRadioButton` + subrole `AXTabButton` inside an `AXTabGroup`
  (that is also what ARIA `role="tab"` maps to), and `GHIsBrowserChrome` already suppresses exactly that —
  but only OUTSIDE a web area, so in-page tabs are kept deliberately. If you want "never offer a tab", the
  one-line home is the shared classifier, keyed on that subrole.
- **A knowledge tree about you.** Nothing was done here. It is what the Amazon-style flow needs
  ("you would look at X, add to cart, open the cart").
- **Role memory still re-poisons itself.** Walking a list with the accept key teaches "after an item comes an
  item"; it reached `accepted: 8` again during this session from my own measurement accepts. Cleared twice.
  It is healthy right now (one honest entry, `media/none/play`). Check
  `~/Library/Application Support/Shabang/memory.json` first when guesses get strange.
- `GHVision` is still called from nowhere useful: `unnamedCount` is 0 or 1 on every app here.
- ~~`PLAN.md` and `ROUTINE_PROMPT.md` are stale.~~ Both moved to `attic/docs/`; `CLAUDE.md` is now the only plan.
- **Rotate the OpenAI key** (it was pasted into a chat).

### A trap worth keeping

`make app` in a **fresh worktree also builds the host**, which changes its code signature and costs the
Accessibility grant. To take over the agent without a permission prompt, run *your* library under the
*already-granted* host:

```
SHABANG_APP=<granted-worktree>/desktop/build/Shabang.app SHABANG_LIB=<your-worktree>/desktop/build/libshabang.dylib ./tools/shabangctl run
```

`make install-lib` puts your library where a plain `open Shabang.app` finds it, so do it every time.

---


## 2026-09-20 06:50 UTC — the native agent stopped being a web form filler

Everything below this section predates the boundary in `CLAUDE.md` (Ghost is a native macOS app; the
extension is in `attic/`). Where the two disagree, this section and `CLAUDE.md` are right.

Pushed to `main` as `848969d..836c912`, seven commits. 445 desktop tests, 1,677 shared, 796 server, 0 failed.

### What was wrong, measured rather than guessed

`shabangctl next` on the live agent, before any of this:

| App | AX nodes walked | candidates found |
| --- | --- | --- |
| Spotify | **15** | 0 |
| Finder | **3,269** | 0 |
| Messages | 94 | 27, of which **21 were the messages on screen** |

Ghost was a web form filler running on a desktop. Five separate causes:

1. **Spotify is CEF, not Electron.** The detector only matched `Electron Framework.framework`, so
   `AXManualAccessibility` was never set and Chromium never built a tree. The window really was 15 nodes.
2. **`kindForRole` knew eight web-form roles.** A conversation, a track, a file and a mail message are all
   `AXRow`, and nothing mapped `AXRow`. There is a `GHKindItem` now.
3. **`AXToolbar` was skipped wholesale** outside a web area — which is where native apps keep their buttons.
4. **There was no click.** `grep CGEventCreateMouseEvent desktop/src` returned nothing: every accept was
   `AXPress`, which most of the desktop does not implement, and `kAXErrorCannotComplete` was counted as
   success, so a press that did nothing logged `ok=1`.
5. **The ranking carried no information.** Eight proposals on one real page, every one at exactly 0.70 with
   the same reason. `roleConfidence` returned the place's prior verbatim and threw the evidence away.

### What works now

- **Native apps are visible.** Spotify 206 candidates, Finder 29, Messages 9 (was 27, the 21 phantom
  message-bubble "fields" are gone). Chrome unchanged at 43 with no browser chrome leaking in.
- **Clicks land.** `AXPress` first, a real `CGEvent` left click at the element's centre when the control does
  not publish `AXPress`, pointer put back where the user left it.
- **Accepting works in native apps, and Tab is left alone.** Tab is form-only: where focus is not on the
  ghost's own field it goes straight to the app (`shabangctl autotab --frontmost Spotify` → `consumed: false`).
  Everywhere else the accept key is the Ghost key, a LONE tap of a right-hand modifier — holding it still
  works normally because a chord is never a tap. `acceptKey` in `settings.json` picks between
  `right-command` (the default) and `right-option`; the status line names whichever is set.

  **Right Option was the first default and it was wrong.** It only showed up when spamming the key rather
  than tapping it once: macOS toggles Mouse Keys on five Option presses, and apps bind a double tap of it —
  Claude's own desktop app does, so its quick-entry bar kept appearing over the ghost. Right Command has
  neither problem and is the default now.

  Briefly Tab did take a proposal in native apps, which worked but was the wrong trade: Tab is the most
  overloaded key on the keyboard. Reverted, with the reasoning in `docs/accept-key.md`.
- **The ghost stops fidgeting.** A row just taken or turned down is left alone for 2.5 s, and the row already
  on screen wins near-ties.
- **Sequential logic, not hardcoded.** `previousRole` now carries a prior of its own (compose→field,
  field→send, search→primary-item, play→fullscreen — roles only, no app is ever named), and the app's own
  cursor is read as a signal: a focused empty box makes filling it the top prior anywhere.
- **iMessage.** `GHConversation` reads the thread off the accessibility tree, `/v1/shabang-text` answers it with
  a reply prompt, and the draft lands in the compose box. Live: `conversation of 4 messages (34 nodes)` →
  `draft ready label=Message provider=baseten`. On a test thread, 752 ms for *"yep got it, ill bring the hdmi
  adapter"* — matching the register of the user's own lines.
- **A test panel.** Ghost menu → "Test buttons": **Tab** posts a real Tab a second from now, **Accept** takes
  the ghost directly. If Tab does nothing and Accept works, the key never arrived; if neither works, the
  actuation is broken. This is how the Tab-in-native-apps bug was found.

### Two things to know

- **`memory.json` was poisoned and has been cleared** (backup in this session's scratchpad). It held
  `{pageKind: app, previousRole: search, role: search, accepted: 10}`: Ghost proposed the search box, the only
  thing to Tab was the search box, it recorded an accept, search scored higher, repeat. Ten times. It will
  re-learn from the fixed behaviour.
- **The Sentry rejection stream is alive.** A `POST /v1/walk/outcomes` returns `{"accepted":true,
  "captured":true}` — `captured` is the Sentry event id. `/v1/walk/replays` stays near-empty on purpose:
  `isReviewableWalk` keeps only abandoned walks, locked accepts and confident rejections as replay fixtures;
  a healthy accepted walk is a counter and a Sentry event, not a fixture.

### Still open

- **`GHVision` is written, unit-tested and never called.** It crops icon-only controls into one strip for
  `/v1/vision/label`. It is what would name Spotify's and Discord's glyph buttons, which currently classify
  `unknown` at 0.435. Wiring it into `ghostsByAddingNextAction:` is the next obvious win.
- **`server/src/providers/nextPredict.ts` still does not use the brain** and is not on the desktop path at
  all (the desktop posts only `/v1/predict/form`). Unchanged today.
- **Filling a contact name** after "New Message" needs the Contacts cold-start source. Ghost proposes the
  `To` field correctly now; it has nothing to put in it.
- `PLAN.md` and `ROUTINE_PROMPT.md` still describe the invoice loop and are stale.

---

_Last updated: 2026-09-20 01:50 UTC by Samir's agent after the invoice-loop e2e landed. Build, typecheck and 2,586 unit tests pass; browser e2e is 49 passed / 3 failed (all 3 in `tab-surface.spec.ts`, a real break, see below)._

## What works now

- **Browser agent:** instant local ghosts are upgraded by the server with per-form caching; the extension also streams textarea drafts, imports resumes, learns opt-in facts, reports metrics, records safe traces/page facts, detects repeated loops, previews them and runs explicitly confirmed loops.
- **Demo sites:** the existing application, invoice, sheet, mail and calendar surfaces remain. `/workflow/index.html` adds a polished atomic-workflow lab with meeting coordination, Slack → GitHub issue and local-fill stories.
- **Server:** direct TypeSafe/Jev, Jev Gateway, Baseten, OpenAI-compatible and heuristic decision paths exist alongside text generation, profile extraction, metrics, presence, loop synthesis, Browserbase, the original Composio loop executor, and the new atomic Composio workflow engine.
- **Native macOS agent:** the stable host, hot-swappable library, Accessibility capture, verified writer and `shabangctl` harness are implemented. The new `GHWorkflowCoordinator` is tested as a narrow workflow seam.
- **Live Jev proof:** a 12-field mapping completed in 490 ms, and the three-step meeting workflow returned calibrated TypeSafe/Jev choices at 100%, 95% and 88% confidence before simulated execution.
- **Reviewed learning loop:** every Tab walk now produces a strict value-free outcome (the user's own accept / escape / type-over is the label), passes two sanitization boundaries, optionally reaches Sentry, and turns reviewable walks into versioned replay cases checked by `pnpm eval:walk-replays`. Labels, values, signatures and page identity never cross the wire. There is no Sentry DSN on this machine yet, so live delivery remains unverified.

## Who is working on what

Pull (`git pull --rebase origin main`) before you push; update this file when your stream's state changes. Small additive edits only in hot shared files: `server/src/{config,app}.ts`, `server/src/routes/execute.ts`, `docs/server-api.md`, `extension/src/content/{controller,index}.ts`, `extension/src/background/index.ts`, `.env.example`, `PLAN.md`, this file.

| Stream | Owner | Scope | State (19:20 UTC) |
| --- | --- | --- | --- |
| Ghost Desktop on a REAL Greenhouse form (Safari) | Pravin's agents | `desktop/**` | **LIVE on the real Viam Greenhouse form (2026-09-19 18:20 EDT):** 11 Tab presses in 13.8 s filled First/Last name, Email, Phone, LinkedIn, Github, Website (each verified), **attached the fictional resume through the native macOS open panel in 4.1 s** (the page then showed "Remove file"), and stopped parked on the locked "Submit application". Nothing was submitted. Open gap: react-select dropdowns were refused (Country was pre-filled; "How did you hear" refused) - being iterated on now. Evidence: `docs/media/desktop-greenhouse-autotab.json`, `docs/media/desktop-greenhouse-final-form.json` (labels and value LENGTHS only). |
| Composio (loop API mode + atomic workflows) | Tahseen | `server/src/executors/composio*`, `server/src/workflows/**`, see `docs/handoff-composio.md` | Atomic workflow engine merged; live API payload aligned. |
| Learning loop (walk outcomes -> Sentry -> replay evals) | Samir | `shared/src/walkTelemetry.ts`, `extension/src/content/walkTelemetry.ts`, `server/src/{routes,telemetry}/walk*`, `evals/walk-replays/`, `docs/learning-loop.md` | Done and merged onto main's streams. The `Alt+Shift+J` agent runner was REMOVED: the loop now hangs off Pravin's form walk, which Desktop drives too. Needs a `SENTRY_DSN` for live proof. See `handoff.md`. |
| Integration, invoice-loop proof, docs | Samir | `DEMO_WIN_PLAN.md`, e2e for the loop, `DEMO.md` | Invoice-loop e2e DONE and pushed (`e2e/tests/stage6-loop.spec.ts`, `e2e/loop.ts`, video recorded). `DEMO.md` still missing. |
| OpenAI vision fallback (OpenAI API prize) | Pravin's agents | `server/src/routes/vision.ts`, `server/src/vision/**`, `docs/openai.md` | Done, mock-tested (63 tests): `/v1/vision/label` and `/v1/vision/locate`; locks and sensitivity re-derived in code. Needs an `OPENAI_API_KEY` to go live; no client calls it yet. |
| Terminal ghost (zsh, Warp track) | Pravin's agents | `terminal/**`, `server/src/routes/command.ts`, `server/src/command/**` | Done: `source terminal/ghost.zsh`; Jev picks the next command (live: 491 ms, 0.89), Tab inserts, never runs; `pnpm test:terminal` 50 passed. Not in Warp (Warp replaces the line editor). |
| Ghost anywhere: affordances, page kinds, priors, role memory | Pravin's agents | `shared/src/affordance/**` (roles, pageKind, priors, memory) | Done, 161 unit tests, no keys, no network. `classifyAffordance` / `inferPageKind` / `priorsFor` / `predictByRole` + `RoleMemory` are pure and exported from `@shabang/shared`. No site, host or brand is named anywhere in the module or its fixtures. Consumers: the extension DOM ranker (`extension/src/content/nextAction.ts`) and the native agent should classify candidates, infer the page kind, take `priorsFor(kind, state)` and rank with `predictByRole`; `server/src/vision/affordance.ts` already adapts vision labels through the same `classifyAffordance`. Clients should pass the generic hints: `insideMediaControls`, `list {listSignature,index}`, `nearbyPrice`, `badgeCount`, `classTokens`, and `context.mainListSignature` (the MAIN region's list, or null) - without that last one a site's navigation bar classifies as feed items. Proven live (read-only) on two real sites: a real video page playing -> fullscreen 0.70 top; a real shop header with an empty cart -> the search box 0.70; same header with 2 in the cart -> the cart 0.70; a real results grid -> the first result 0.70. |
| Ghost anywhere on the NATIVE agent (macOS) | Pravin's agents | `desktop/core/anywhere.ts`, `desktop/src/GH{Affordance,NextAction,Vision}.*`, `GHCapture` (`capturesUnnamedControls`, `windowNode`), `GHField` (hints + `toCandidateJSONObject`), `GHCore.nextAction`, small hooks in `GHController`/`GHWriter`, `docs/desktop.md` | Done, 34 new desktop tests through the REAL shabang-core.js and fake AX trees. When the form walk has nothing to fill, Ghost proposes the one control the place is for: a playing video -> fullscreen, a paused one -> play, a grid -> the first item (not a nav entry), a shop with 2 in the cart -> the cart (checkout stays locked and can never be the proposal), an empty cart -> the search box (which is FOCUSED, never pressed). Capture now keeps icon-only controls (`unnamed`) and emits `insideMediaControls`, `list {signature,index}`, `nearbyPrice`, `badgeCount`, `hasMediaElement`, `mainListSignature`, `mainRegionRepeats`, `textDensity`, `isFullscreen`, `sensitiveOnScreen`. Role memory in `~/Library/Application Support/Shabang/memory.json` (0600, atomic, corrupt-tolerant): two accepts reorder a place's defaults. `GHVision` crops ONLY the unnamed controls into one strip for `/v1/vision/label` (one call per page view, cached, never from a window with a sensitive field); without Screen Recording it reports "needs Screen Recording" and everything else keeps working. Not yet rehearsed live on a real site. |
| Extension next-action ghosts + presence heartbeat | Pravin's agents | `extension/src/content/nextAction.ts`, `extension/src/background/{nextClient,presence}.ts` | Done: click ghosts from episodic memory + `/v1/predict/next`, form-submitting controls locked, 30 s `/v1/presence` beat; e2e 36 passed. |

Measured on Pravin's machine with real keys: Jev direct 12-field form 649 ms (12/12, confidence 0.93 to 1.00); Baseten GLM-5.3-Flash with 3 samples + 1 hedge p50 1052 ms (12/12; ambiguous form 97.5% with zero wrong answers above the 0.7 gate); xAI adapter about 1.3 s with a flat 0.90 confidence; Browserbase session up in 0.5 s and invoice fields extracted from the public demo (https://whitespace-delta.vercel.app) in 3.7 s. Tables: `docs/media/bench-providers*.md`, `docs/baseten.md`.

## What does not work end to end yet

- ~~The canonical 50-invoice story has no full loaded-extension run.~~ **Closed 2026-09-20:** `e2e/tests/stage6-loop.spec.ts` proves it end to end with the extension loaded, including the intentional one-row exception, and `docs/media/stage6-loop.webm` is recorded.
- **`main` cannot go green on e2e right now:** all 3 `tab-surface.spec.ts` tests fail, identically when that file is run completely alone, so it is a real break rather than suite contention. The workflow page never leaves its "Start the local server" state, so the Tab-ownership behaviour underneath is never actually exercised. Owned by the tab-surface stream.
- The learning loop has no live Sentry proof yet (no DSN), and Ghost Desktop does not emit walk outcomes although it drives the same walk.
- Browserbase credentials are present but have not been live-rehearsed. Composio, AI Gateway and OpenAI are not configured; all current Composio demo effects are simulated.
- `GHWorkflowCoordinator` is not yet connected to the desktop app’s main capture/overlay/Tab pipeline.
- `DEMO.md` and the final results screen are missing. (The invoice-loop fallback video is now recorded: `docs/media/stage6-loop.webm`.)

## Next milestone

Lock the new live Jev proof into the judging story, then complete the existing invoice-loop proof:

1. Add a Sentry Node project DSN, produce one walk that goes wrong, and confirm its scrubbed event plus replay attachment.
2. ~~Add one loaded-extension e2e from `/reset` through two manual invoice examples and the proposal.~~ **Done 2026-09-20.**
3. ~~Exercise preview across the remaining 48 items, complete 47 safe items, hold one for review, and record `docs/media/stage6-loop.webm`.~~ **Done 2026-09-20**, both in `e2e/tests/stage6-loop.spec.ts` (2 tests, 18.2 s).
3b. Fix or quarantine `tab-surface.spec.ts` so the e2e gate can be green again.
4. Record the live desktop Greenhouse run into `docs/media/` and write `DEMO.md` around it.

Only after that vertical slice is stable: connect OpenAI to a visible, code-verified ambiguity-resolution or drafting step; write `DEMO.md`; rehearse; then consider live Browserbase/Composio or the native breadth proof.

## Verified baseline

- Build: pass.
- Typecheck: pass.
- JS/TS unit tests: 2,586 passed, followed by the checked-in replay eval.
- Browser e2e: 49 passed, 3 failed (52 tests). The 3 are `tab-surface.spec.ts` (71, 102, 113); see above. `stage5-next.spec.ts:187` (presence heartbeat) PASSED in both full runs on 2026-09-20, so it is flaky rather than consistently failing as this file previously recorded - worth pinning down, because a flaky test passes in rehearsal and fails in front of judges.
- Demo smoke: the previous 95-check run passed; it was not rerun after this merge.
- Desktop: 203 passed (the documented 201 was stale).
- Frozen install: pass.
- Live TypeSafe/Jev atomic workflow: pass.
- Tracked secret-pattern scan: clean.

The first e2e run needs:

```bash
pnpm --filter @shabang/e2e exec playwright install chromium
```

## Run the currently working browser demo

```bash
pnpm install
pnpm build
pnpm dev
```

Load `extension/dist` from `chrome://extensions`, open `http://localhost:5173/apply`, focus/scroll the first field into view, and press Tab. The existing `docs/media/stage1-form.webm` shows the expected behavior.


## Safety and operational notes

- Never submit a real form or contact a real recipient during automated testing.
- Fields inside shadow roots are not captured by the extension.
- The debugger fallback is unit-tested but has not been required by the canonical e2e path.
- The native agent needs a user-granted Accessibility permission and has not been included in the root `scripts/verify.sh` gate.
