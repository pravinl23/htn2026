# A vs B: demonstration-learned loops vs atomic workflows

Both approaches are in `main` today. Nothing here is aspirational: every claim carries a `file:line` and every
number is either measured in this repo or cited from where it was measured. Written 2026-09-19 for the team to
decide with before the judging script is frozen.

---

## 1. What each one is

### A — "demonstration-learned loops + Tab walk" (Pravin's stream)

Shabang watches the page you are on. It captures the visible interactive elements, asks the server **one batched
question for the whole form**, and paints translucent ghosts on the fields it can answer; Tab accepts one and
moves to the next, at 0 ms per Tab because every answer is already in memory. Meanwhile it records a
value-light action trace and page facts. When you do the same multi-step routine **twice**, it aligns the two
runs, generalizes the differing values to page-fact locators, synthesizes a JSON program, dry-runs the
remaining items in hidden iframes to fill a preview grid, and runs all of them after **one** explicit
confirmation — stopping at anything irreversible.

> **User-visible promise:** "Do it twice, Shabang does the rest." You never describe the task. You just do it,
> and the third time Shabang offers to finish the other 48.

### B — "atomic workflows" (Samir's and Tahseen's stream)

Shabang looks at whatever app is focused, builds a small privacy-safe description of it (app name, window title,
focused element, a few lines of nearby static text), and sends it to the server. The server filters a catalog
of known actions down to a handful that are appropriate for the current workflow step and the accounts you
have connected, asks Jev **one choice question** — "which of these is the next atomic action?" — and shows the
winner as a suggestion with a human-readable preview. Approving it mints a single-use, server-issued token
bound to a required confirmation mode, and execution goes out through Composio (Gmail, Calendar, GitHub,
Slack, Notion) or comes back as a local directive the client performs and reports on.

> **User-visible promise:** "Shabang knows what you are about to do across your whole Mac, and can do it in the
> apps themselves — not by clicking around, by calling them."

---

## 2. Side by side

| | **A — loops + Tab walk** | **B — atomic workflows** |
|---|---|---|
| **Where context comes from** | The live DOM. `captureFields` → `CapturedField` (`shared/src/types.ts:18`), plus the action trace (`extension/src/content/trace.ts`) and page facts (`extension/src/content/pageFacts.ts:216`). | Accessibility metadata / a client-built object → `ContextSnapshot` (`shared/src/workflow/types.ts:34`): app name, bundle id, window title, focused element, ≤10 lines of nearby text, connected toolkits, preferences. |
| **What Jev is asked (form)** | `buildFormDecision` (`server/src/providers/formQuestions.ts:85`): **one `choice` question per field** (`f0..fN`), all in one request, sharing one criteria map = profile fact keys + `needs_text` + `none`. State is `{page:{origin}, fields:[{label,kind,name,placeholder,autocomplete,options,context}]}`, clipped to 200 chars / 12 options (`:13-15`). | n/a — B has no form path. |
| **What Jev is asked (next thing)** | `buildNextDecision` (`server/src/providers/nextQuestions.ts:89`): **one** `choice` question. Options are **aliases** `c0..cN` (real signatures never leave the page, `:92-97`), criteria `"${kind}: ${label}"`, plus `none`. State carries recent actions and top-5 episodic memories. | `requestWorkflowPrediction` (`server/src/workflows/predict.ts:33-50`): **one** `choice` question. Options are the **real action ids**; each criterion is a paragraph — `description` + "Appropriate when: `suggestWhen`" + "Exclude when: `excludeWhen`" + "Safety: … confirmation: …" (`:36`). `no_action` arrives as a candidate (`candidates.ts:182`). |
| **Who produces values** | Never Jev. Profile facts resolved in code (`shared/src/resolve.ts`); free text streams from the LLM (`extension/src/content/freeText.ts`); loop values come from page-fact locators, dates/numbers parsed in code (`shared/src/loop/values.ts`). | Never Jev. `preparedArguments` are built deterministically server-side (`server/src/workflows/candidates.ts:79-100`, `arguments.ts`) and are **stripped from the response** (`predict.ts:84`). |
| **Safety / confirmation** | Derived per element from the live DOM: `isLockedAction` (`shared/src/locks.ts:40`) over a 6-category irreversible regex (`:27`), `isSensitive` (`shared/src/sensitive.ts:53`). Batch runs need a server ticket hashed over **exactly what was shown** (`server/src/executors/tickets.ts:29-33`), redeemed once (`routes/execute.ts:127`). | Declared per action in a hand-written catalog: `safety` → `confirmation` via `catalog.ts:11`, 7 tools + 2 locals (`catalog.ts:44-148`). Approval mints a random token bound to (user, workflow, actionId, confirmation **string**) (`store.ts:53-61`); the server rejects a mode that does not match (`routes/workflows.ts:207`). Uses `isSensitive` for snapshot scrubbing (`workflows/context.ts:39,74,104`) but **never** `isLockedAction`. |
| **What executes** | The page itself. Native value setter → re-read → `chrome.debugger` fallback (`extension/src/content/execute.ts:42,68-80`). Loops run in the tab or in hidden same-origin iframes (`loopExecutor.ts`), or server-side via Browserbase / Composio (`server/src/executors/`). | The vendor's API. Composio tool-router session (`workflows/composioClient.ts`), `executeSimulated` with no key (`simulated.ts`), or a `localAction` directive handed back for the client to perform (`routes/workflows.ts:232-234`). |
| **What is verified afterwards** | Every write. `holds(el, value)` after the native setter and again after the debugger path (`execute.ts:68,80`); selects `:92`; checkboxes `:122,128,139`. Per loop step: `value-mismatch` (`loopExecutor.ts:371`), `action-rejected` on a new `role=alert` (`:443`), `navigation-failed` (`:316,450,458`), `item-handled`. | Nothing is re-read. The only hook is `/v1/workflows/local-result`, where the **client asserts** the outcome and the server records `facts:{localActionCompleted:true}` (`routes/workflows.ts:248-268`). The demo client sends `ok: true` unconditionally (`demo/public/workflow/index.html:123`). |
| **Offline / no keys** | Full product, instantly. `buildGhostsOffline` (`extension/src/content/predict.ts:37`) runs `mapFormHeuristically` with no network; the server heuristic is a real keyword mapper with per-rule confidence (`server/src/providers/heuristic.ts`, `shared/src/heuristic.ts`). | Inert. `deterministicChoice` picks the **first** non-`no_action` candidate at a hard-coded **0.92** (`workflows/predict.ts:14-17`) and the model is skipped entirely for the heuristic provider (`:32`). Outside `demo:true`, `connected()` (`candidates.ts:19`) is false without Composio, so the candidate list collapses to `no_action`. `docs/workflows.md:89` states this: "Production no-key requests are inert". |
| **Cross-app reach** | Browser (`http://*/*`, `https://*/*`, `all_frames`, `extension/public/manifest.json`), plus a native macOS agent (`desktop/`) and a zsh ghost (`terminal/`). Reach = anything with a DOM or an AX tree, but knowledge is per-page. | Any focused app via `ContextSnapshot`, and — uniquely — effects in SaaS that has **no UI open at all**. This is the one thing A structurally cannot do. |
| **Latency per user action** | One call per form, then **0 ms per Tab**. Measured: Jev direct 12-field form **649 ms** and **490 ms** (`MORNING.md:26,11`); Baseten K=3+H=1 **p50 1052 ms** (`docs/baseten.md:75`); heuristic **0 ms, 100% accurate, 0 wrong answers above the gate** (`docs/baseten.md:75,88`). Hard deadline 2.5 s, then the heuristic answers (`docs/baseten.md:3`). | One Jev call **per action**, plus an `/approve` and an `/execute` round trip each, plus the Composio call. A 3-step meeting = 9+ round trips. Live confidences recorded (100%, 95%, 88% — `MORNING.md:11`); **no latency figure for B exists anywhere in the repo.** |

---

## 3. Duplication and conflicts

### 3.1 Two context formats, two normalizers

`CapturedField` (`shared/src/types.ts:18`) is element-shaped: signature, label, kind, rect, options, locked.
`ContextSnapshot` (`shared/src/workflow/types.ts:34`) is app-shaped: application, window title, one focused
element, nearby text. They never meet. Each has its own trimming pass — A's `predictableFields` /
`toWireField` (`extension/src/content/predict.ts:102`) plus server-side `isModelCandidate`
(`server/src/providers/formQuestions.ts:46`), versus B's `normalizeContextSnapshot`
(`server/src/workflows/context.ts:59`) with its own caps (`:3-9`) and its own secret/payment redaction
(`:8-9,15`) that A's path does not have.

A third shape, `NextCandidate` (`server/src/providers/nextQuestions.ts:19`), is the closest thing to a common
currency — `{id, kind, label, locked, context}` — and is a better merge target than either of the other two.

### 3.2 Two confirmation mechanisms, and they are not equally strong

- **A:** `hashJob(mode, job)` = sha256 over `{mode, baseUrl, program, items}` (`server/src/executors/tickets.ts:29-33`).
  The token is issued against that hash at preview and must be presented with a body that hashes **identically**
  (`routes/execute.ts:127`, refusal reasons at `:33-37`). A client that alters the program or the item list
  after the human confirmed is refused. Single-use, 5-minute TTL, max 50 outstanding (`tickets.ts:12,40`).
- **B:** the token is bound to `(userId, workflowId, actionId, confirmation)` (`workflows/store.ts:53-61`). The
  arguments are held server-side so they cannot be swapped — good. But the *confirmation* is a **string the
  client chooses** and the server only checks it equals the required one (`routes/workflows.ts:199-207`). The
  demo proves the hole: a plain Tab sends `current.action.confirmation`, whatever it is, so `review` is
  satisfied without anything being reviewed (`demo/public/workflow/index.html:125`). The token attests that the
  client echoed a word, not that a human saw a preview.

**Conflict:** two token stores, two TTLs (5 min vs 5 min for approvals, 60 s for local completions —
`store.ts:58,77`), two refusal vocabularies, and one of them is materially weaker than the other.

### 3.3 Two Jev call sites with different option-building rules

| | A (form) | A (next) | B (workflow) |
|---|---|---|---|
| Option names | `f0..fN` questions, fact keys as options | **aliased** `c0..cN` (`nextQuestions.ts:92-97`) | **real action ids** (`predict.ts:34`) |
| Criteria text | short fact descriptions (`formQuestions.ts:74`) | `"${kind}: ${label}"` (`:95`) | a paragraph incl. **safety and confirmation words** (`predict.ts:36`) |
| Escape hatch | `none` + `needs_text` (`:75-77`) | `none` (`:98`) | `no_action` as a candidate (`candidates.ts:182`) |
| Skipped when | never | never | `provider.name === "heuristic"` or `candidates.length <= 1` (`predict.ts:32`) |

Three problems. (i) B leaks policy into the prompt: putting "Safety: high-impact; confirmation: explicit" in
the criteria invites the model to reason about permission, which CLAUDE.md's Jev rules say to keep in code.
(ii) B sends real ids where A deliberately aliases. (iii) B's early-out at `predict.ts:32` means the keyless
path never exercises the question that the live path depends on — which is exactly why the e2e asserts
`heuristic` in the meta line (`e2e/tests/workflow-demo.spec.ts:14`).

### 3.4 Two candidate filters

- **A:** `collectCandidates` (`extension/src/content/nextAction.ts:87`) — visible, enabled, non-sensitive,
  inside or within 0.5 viewports of the edge (`:26,101`), nothing inside Shabang's own UI (`:96`), capped at 60
  (`extension/src/lib/loopMessages.ts:167`), closest-first then DOM order (`:104`). Plus `withoutSensitive`
  server-side as defence in depth (`server/src/providers/nextQuestions.ts:80`).
- **B:** `getRelevantActions` (`server/src/workflows/candidates.ts:114`) — a hand-written state machine over
  `state.kind`/`state.step` (`:134-172`) gated on `connectedToolkits`, plus `relevantActionIds` hints, capped
  at 8 (`:184`).

These answer the same question ("what could happen next?") from opposite ends and share no code. A knows about
pixels and never about accounts; B knows about accounts and never about pixels.

### 3.5 Two safety lists

`shared/src/locks.ts:27` is a 6-category regex (MONEY / DESTROY / COMMIT / ACCOUNT / CONSENT / OPERATE)
evaluated against live element text, plus `submitsForm` on the live DOM (`nextAction.ts:63`).
`shared/src/sensitive.ts:22` is the never-touch list. B does reuse `isSensitive`, but its lock policy is a
literal field on 9 hand-written catalog entries (`server/src/workflows/catalog.ts:44-148`).

**The gap is concrete:** if B ever returns a `local` directive that clicks something, nothing in B asks
`isLockedAction` about it. A "Send" button reached through B's local path carries whatever `safety` the
catalog author typed, not what the button actually says.

### 3.6 Tab is handled in four places

| Handler | Phase | Gate |
|---|---|---|
| `extension/src/content/controller.ts:428` (form walk) | window, **capture** (`:711`) | visible current ghost, focus in the walk (`:517,528`) |
| `extension/src/content/nextAction.ts:421` (click ghosts) | window, **capture** (`:552-553`) | `gateOpen()` stands down for form ghosts and the loop sheet (`:333-337`) |
| `extension/src/content/loopPanel.ts:279` (preview sheet) | sheet, **capture** (`:304`) | only while `state === "proposed"` |
| `demo/public/workflow/index.html:125` (B's client) | window, **bubble** | none |

A's three are mutually gated and know about each other. B's is not gated and A does not know it exists. The
extension injects into `http://*/*` (`extension/public/manifest.json`), which includes
`localhost:5173/workflow/index.html`, and A's handlers run in the **capture** phase calling
`preventDefault()` + `stopPropagation()` (`nextAction.ts:246-249`) — so when A has a ghost, B's bubble-phase
listener never fires at all.

**Measured, honestly:** I ran this headless three times with the extension loaded on B's page against a
keyless server (heuristic provider, empty episodic memory). **No collision fired.** The three-step meeting
story and the local-fill story both completed identically with and without the extension, and
`#ghost-next-host` was never created — because the memory heuristic returns `none` with an empty store
(`server/src/providers/nextQuestions.ts:130`) and B's page has no form A would ghost. So the conflict is
**latent, not active**: it is guarded only by A having nothing to say, which stops being true the moment a
real Jev provider answers or the user's memory warms up.

### 3.7 B has no extension client at all

`grep -rl workflow extension/src/` returns **nothing**. B's only browser client is the demo page's own inline
script, and `e2e/tests/workflow-demo.spec.ts:1` imports `test` from `@playwright/test`, not from
`../fixtures` — so B's two e2e tests run in a **plain Chromium page with the extension absent**. Everything
A ships in the browser (the overlay, the ghost cursor, lock badges, the HUD, verified writes) is unavailable
to B, and the one place the two would meet is the one place no test looks.

### 3.8 The desktop coordinator is not wired into the walk

`GHWorkflowCoordinator` is referenced by exactly one file: `desktop/tests/test_workflow.m:2`. No
`GHController.m`, `GHEventTap.m` or `GHAppDelegate.m` mentions it. `MORNING.md:33` says the same. It is a
tested seam with nothing plugged into either end.

### 3.9 Smaller ones

- **Docs:** `docs/server-api.md` — the contract document — has **no `/v1/workflows/*` section**. B is
  documented only in `docs/workflows.md` and one prose line at `docs/architecture.md:3`.
- **Access asymmetry:** A's execute routes call `admit()` unconditionally (`routes/execute.ts:101,117`).
  B requires a trusted caller only when Composio is configured and `demo !== true`
  (`routes/workflows.ts:171-174,203-206,223-226`). With no `COMPOSIO_API_KEY`, any `http://localhost:*` page
  can drive B's entire state machine — fine for the lab, but it means B's token path has never run under the
  trust rules A always enforces.
- **Two "did it work" vocabularies:** A's `ExecuteReport`/`StepResult` error codes vs B's
  `StructuredActionResult.errorCode` (`shared/src/workflow/types.ts:104`). Nothing translates between them.

---

## 4. What each should steal from the other

Ranked by demo value per line of diff.

### A ← B, #1: the cross-app action catalog as extra next-action candidates

**Why:** A's next-action prediction can only ever propose something already on screen
(`collectCandidates`, `nextAction.ts:87`). B's catalog is a ready-made list of things that are *not* on
screen. Merging them is the single change that turns "Shabang finishes this page" into "Shabang finishes this
task".

**Diff:** in `background/nextClient.ts`, after `collectCandidates`, append B's candidates mapped into the
existing `NextCandidate` shape:

```ts
// id: "action:gmail.create_draft", kind: "button", label: spec.definition.title,
// locked: spec.definition.confirmation === "explicit", context: spec.definition.suggestWhen
```

They then flow through the **existing** `buildNextDecision` (`nextQuestions.ts:89`) unchanged — same aliasing,
same `none`, one question. One Jev choice ranks "click Reply" against "create the draft in Gmail". An
`action:` id that wins is routed to `/v1/workflows/approve` instead of `executeGhost`.

### A ← B, #2: a server-issued confirmation **mode**, not just a locked/unlocked bit

**Why:** A's lock is binary (`locks.ts:40`). B's three-level `read` / `reversible` / `high-impact`
(`catalog.ts:11`) is the better model, and it is the thing that lets Tab stay cheap for reads while staying
honest for sends.

**Diff:** add `confirmation?: "tab" | "review" | "explicit"` to `Shabang` (`shared/src/types.ts:81`), default
`locked ? "explicit" : "tab"`. `controller.ts:556` (`park`) already implements `explicit`; `review` becomes
"Tab opens the preview, Enter confirms" — the loop panel's exact behaviour (`loopPanel.ts:290-297`), reused.

### B ← A, #1: verify after every write

**Why:** this is A's hardest-won property and B has none of it. `/v1/workflows/local-result` currently
records whatever the client claims (`routes/workflows.ts:258-265`), and the demo always claims success
(`demo/public/workflow/index.html:123`).

**Diff:** the local directive already carries `preparedArguments`. Require the client to send back the
**observed** value and have the server compare it, exactly as `holds(el, value)` does
(`extension/src/content/execute.ts:68`). A mismatch records `ok: false, errorCode: "value-mismatch"` and does
**not** call `advance()` (`routes/workflows.ts:267`). ~15 lines.

### B ← A, #2: derive locks from what is on screen, not from the catalog

**Why:** §3.5. A catalog author's `safety:` field is a guess about a tool; `isLockedAction` is a fact about a
button.

**Diff:** in `getRelevantActions` (`candidates.ts:114`), for any candidate whose target is a visible control,
`confirmation = max(spec.confirmation, isLockedAction({text: label}) ? "explicit" : "tab")`. Escalate only,
never downgrade. Import already exists in the package.

### B ← A, #3: episodic memory as a prior for the choice question

**Why:** B re-derives intent from scratch on every snapshot via regexes (`candidates.ts:12-13`). A already
stores `(state summary → action)` pairs with counts (`shared/src/memory/episodic.ts:22-28`) and has a
calibrated prior: 0.75 once, 0.9 repeated (`:7-8`).

**Diff:** `ContextSnapshot` already has `recentActions` (`workflow/types.ts:41`). Add
`memory?: EpisodicPair[]` and include it in the Jev state at `predict.ts:46` next to `priorResults`. The
question shape does not change.

### B ← A, #4: an instant offline fallback that is actually useful

**Why:** `deterministicChoice` returning the first candidate at a flat 0.92 (`predict.ts:14-17`) is worse
than nothing — it is a confident guess with no evidence, on a surface whose whole safety story is confidence
gating. A's heuristic scores 100% with 0 wrong answers above the gate (`docs/baseten.md:88`).

**Diff:** score candidates by keyword overlap between `visibleText(context)` and
`suggestWhen`/`excludeWhen`, return the real spread, and cap keyless confidence at the medium threshold
(`thresholds.medium`, `routes/workflows.ts:90`) so a keyless run shows an alternative list rather than a
falsely certain single answer.

### B ← A, #5: one confirmation covering a batch, hashed over what was shown

Fold `hashJob` (`tickets.ts:29`) in: hash the rendered preview string and the prepared arguments, not just
the ids. Then B's token means what A's token means.

---

## 5. Recommended unified shape for the judging demo

**Be decisive: A leads the surface. B becomes a candidate source and an execution backend behind it.**

One overlay, one Tab contract, one confidence gate, one preview, one confirmation. The judges should never see
two different UIs for "Shabang thinks you want to do X".

```
         DOM elements  ─┐
                        ├─►  NextCandidate[]  ─►  ONE Jev choice  ─►  one ghost  ─►  Tab
   catalog actions   ─┘      (nextQuestions.ts:89)                     │
   (catalog.ts:44)                                                     ├─ tab      → act now
                                                                       ├─ review   → preview sheet, Enter
                                                                       └─ explicit → locked, Enter or click
                                                                              │
                                              executeGhost (verified)  ◄──────┴──────►  Composio (verified)
```

**Why this way round and not the other:** A owns everything the judges actually look at — the ghost cursor,
gray ghost text, lock badges, the preview grid, the HUD — and it degrades to a working product with zero
keys. B owns the one capability A cannot fake: an effect in an app that is not open. B has no browser client
(§3.7), no latency budget (§2), and is inert without Composio (§2), so it cannot lead. But A caps out at
"Shabang is very good inside this tab", and that is a smaller story than the one we want to tell.

**Smallest set of changes to get there** (in dependency order):

1. **Merge the candidate lists.** A ← B #1. `background/nextClient.ts` appends catalog actions as
   `NextCandidate`s with an `action:` id prefix. No new question, no new route. *~40 lines.*
2. **Add `confirmation` to `Shabang`.** A ← B #2. Three-level mode replaces the boolean at the ghost layer;
   `explicit` reuses `park`, `review` reuses the loop panel's Tab-then-Enter. *~30 lines.*
3. **Route an `action:` win to B.** `nextAction.accept` (`nextAction.ts:469`) branches: DOM candidate →
   `executeGhost`; `action:` candidate → `/v1/workflows/approve` + `/execute`, with the confirmation the
   overlay actually collected. *~50 lines.*
4. **Escalate B's confirmation with `isLockedAction`.** B ← A #2. *~10 lines.*
5. **Make `local-result` verify.** B ← A #1. *~15 lines.*
6. **Retire B's Tab handler.** Delete `demo/public/workflow/index.html:125` and let the extension own Tab on
   that page, or keep the page purely as a fixture and drive it from `fixtures.ts` so the e2e loads the
   extension. Either way, §3.6 stops being latent.
7. **Document `/v1/workflows/*` in `docs/server-api.md`** and make it say which caller is trusted when.

Not in scope for the demo: wiring `GHWorkflowCoordinator` into the native walk. It is a clean seam, it is
tested, and it should stay parked until the browser story is one story.

---

## 6. What would break if we merged them naively

1. **Tab would be stolen on the workflow page.** A's capture-phase handlers with
   `preventDefault()`+`stopPropagation()` (`nextAction.ts:246-249`, bound at `:552-553`) sit in front of B's
   bubble-phase listener (`demo/public/workflow/index.html:125`). Today nothing fires because A has nothing to
   say (§3.6) — turn on a real provider, or let episodic memory warm up, and A silently eats the Tab that B's
   entire demo depends on. **Nothing currently tests this**, because B's e2e runs without the extension
   (`e2e/tests/workflow-demo.spec.ts:1`).
2. **Two confidence scales would be compared as if they were one.** A gates at 0.7
   (`shared/src/types.ts:105`) against calibrated Jev confidence. B gates at 0.75/0.55
   (`routes/workflows.ts:90`) and, keyless, hands out a flat 0.92 (`predict.ts:16`) that means nothing. Merge
   the candidate lists without fixing B's fallback (B ← A #4) and the keyless demo will confidently propose
   the first catalog action on every page.
3. **A locked button could be approved by an ordinary Tab.** B's confirmation is a client-chosen string
   (§3.2). Put B's actions behind A's Tab without escalating via `isLockedAction` (B ← A #2) and Rule 2
   — irreversible needs an explicit Enter or click — is violated by construction.
4. **The trace would learn Shabang's own actions as the user's.** A tags its own writes synthetic within a
   250 ms window (`extension/src/content/trace.ts:19,39`). A Composio effect that changes the page seconds
   later is outside that window, so the loop detector would count Shabang's own work as a user demonstration
   and propose looping it. `detectLoop` ignores synthetic events (`loopWatcher.ts:189`) — but only the ones
   that were tagged.
5. **Two servers' worth of state for one user.** `WorkflowStore` (in-memory, per `userId`,
   `workflows/store.ts:14-18`) and the run registry / ticket office (`executors/runs.ts`,
   `executors/tickets.ts`) both think they own "what is happening right now". A B-action fired mid-loop-run
   would not see `runs.active()` (`routes/execute.ts:125`) and would interleave with the batch.
6. **Sensitive data would take the less-scrubbed path.** B's normalizer redacts bearer tokens, API keys and
   card-length digit runs from free text (`workflows/context.ts:8-9,15`); A's form path does not, because it
   never sends free page text. Route page text through B's candidate builder without
   `normalizeContextSnapshot` and that protection is skipped.
7. **Nobody would know how slow it got.** A logs one latency sample per model call into the metrics page
   (`routes/predict.ts:38-41`). B's routes record **nothing** — no `metrics.recordLatency` anywhere under
   `server/src/workflows/` or in `routes/workflows.ts`. Merge as-is and the p50 we show the judges silently
   stops covering half the calls.

---

## Appendix: what was run for this document (2026-09-19, headless only)

- `pnpm -r --workspace-concurrency=1 test` → **2,350 passed** across 4 packages (74 + 680 + 883 + 713), exit 0.
- Three headless-Chromium probes with `extension/dist` loaded (`chromium.launchPersistentContext`,
  `headless: true`) against an **isolated** keyless server (127.0.0.1:8913) and demo preview (localhost:5197),
  so the live run on 8788 was untouched:
  1. B's three-step meeting story, with and without the extension → identical, extension produced no ghost.
  2. B's local-fill story, with and without the extension → identical; `#reply` filled by B both times.
  3. Taught A a two-step habit on B's own page (two rounds), confirmed 4 episodic pairs were stored
     (`ghost.memory`), then re-ran the first half → **still no ghost**, so still no collision.
- **Not run:** the repository e2e suite (`pnpm e2e`). Port 8788 was held by another agent's active Playwright
  run, and `predictionServer` sets `reuseExistingServer: false` (`e2e/playwright.config.ts`) with
  `E2E_SERVER_URL` hard-coded at `e2e/fixtures.ts:27`, so a second run cannot start without either killing
  theirs or editing shared fixtures. Neither was acceptable. **This is the one claim in this document that
  rests on the last recorded run (36 e2e passing, `MORNING.md:3`) rather than on something I executed.**
