# Progress log

Each run appends an entry. Newest at the bottom.

Format:

```
## Run N: YYYY-MM-DD HH:MM (UTC) [IN PROGRESS | DONE]
- Worked on: PLAN.md items ...
- Changed: ...
- Tests: unit X passed, e2e Y passed, failures ...
- Blocked or stubbed: ...
- Next: the next unchecked PLAN.md item
```

## Run 0: setup by Pravin [DONE]
- Repo created with CLAUDE.md, PLAN.md, PROGRESS.md, MORNING.md, README.md.
- Next: Stage 0, Bootstrap.

## Run 1: 2026-09-19 06:50 (UTC) [DONE at 08:25 UTC, then stalled]
- Done and pushed: Stage 0; Stage 1 (extension capture/overlay/execute/controller/options/background, 19 e2e, 26 review findings fixed); server (four decision providers, predict/form, predict/next, streaming ghost-text, profile/extract, metrics, security hardening; live-verified against xAI); shared trace/loop/memory logic; demo sites (apply, apply-plain, invoices, sheet, mail, calendar, reset); docs.
- Tests at 08:25 UTC: shared 354, extension 254, server 182, demo 74, e2e 19, all green.
- What went wrong: the laptop was on battery with the lid closed and dropped from 8% to 1%, so macOS cycled through maintenance sleep from about 08:30 to 15:00 UTC. The Stage 2-4 extension workflow and the Stage 6/8 server workflow were interrupted every few minutes and produced nothing. No committed work was lost.

## Run 2: 2026-09-19 15:05–18:10 (UTC) [DONE]
- Added and pushed: native macOS background form agent (`desktop/`, Objective-C); server loop synthesis and scale-out execution routes; Browserbase parallel executor; Composio compile/execution path; confirmation tickets, access controls, cancellation, durability and SSRF hardening.
- What is genuinely integrated: the browser extension still runs the Stage 1 offline form path only. The native agent has its own server form/free-text client and cache. Neither client exposes the learned invoice-loop workflow.
- What remains component-only: `/v1/predict/next`, shared traces/memory/loops, Browserbase, Composio and the invoice/mail demo sites have tests and contracts but no extension orchestration or judging UI. Browserbase/Composio have not been live-verified in this checkout.
- Audit tests at 18:10 UTC: build and typecheck pass; shared 354, extension 254, server 325 passed + 2 skipped, demo 74, e2e 19, demo smoke 95, desktop 167. Tracked secret-pattern scan clean.
- Audit findings: frozen install fails because the lockfile still lists extension `pdfjs-dist`; desktop presence/extension heartbeat is documented but not implemented; `DEMO.md` and the Stage 6 loop video are missing; several planning documents overstated integration.
- Next: implement the canonical invoice-loop vertical slice in the extension (record two runs -> detect/synthesize -> preview 48 with one exception -> confirm -> execute/verify 47 -> result screen), then add e2e, fallback video and one visible OpenAI-powered step.

## Run 3: 2026-09-19 Jev computer-use integration [DONE]
- Added a shared value-free computer-use contract and strict `/v1/agent/next` route. One Jev call selects a closed operation plus a compatible opaque target; the provider never receives profile values or target ids.
- Added the extension browser adapter, provider-independent observe/freshness-check/execute/verify runner, and closed-shadow `Alt+Shift+J` panel. The existing verified writer remains the only mutation path.
- Added a risk-aware frontier: one DOM-order local value target at a time, clicks deferred while safe value work remains, no-key policy forbidden from clicks, locked/sensitive targets refused again at execution.
- Added server, message-boundary, runner, browser-adapter and loaded-extension tests.
- Live verification: direct TypeSafe/Jev + Baseten drafting completed `/apply` in 8.3 s; deterministic keyless run completed in 2.0 s. Both left consent untouched and recorded zero Submit attempts.
- Verification: build and all workspace typechecks pass; 2,029 JS/TS unit tests and all 34 loaded-extension browser tests pass.
- Next: record the live proof, add Sentry outcome/failure capture feeding replay/evals, then add a second page-changing `CLICK`/`WAIT` scenario before returning to the canonical invoice-loop video.

## Run 4: 2026-09-19 redacted Sentry outcomes and replay evals [DONE]
- Added a versioned shared outcome schema that cannot represent goals, URLs, labels, target ids, values, DOM or arbitrary errors; it keeps only closed codes, booleans, bounded structural counts and coarse buckets.
- The extension converts terminal Jev updates into best-effort outcomes. Its background worker sanitizes again before the server, and the server validates once more with a 64 KB streamed-body limit.
- Added an opt-in Sentry Node sink with no default integrations, PII or tracing. `beforeSend` discards and reconstructs every event from the validated outcome; blocked runs also get a redacted JSON replay attachment. No DSN is present, so live delivery is not yet verified.
- Added the bounded `/v1/agent/replays` review queue, canonical export/promotion CLI, checked-in seed fixture, and `pnpm eval:agent-replays` regression gate. This is reviewed learning, never automatic production self-modification.
- Final verification: all workspace typechecks; 2,046 JS/TS unit tests; the checked-in replay eval; extension/demo production builds; the 3.9 MB server bundle smoke; and all 35 loaded-extension browser tests passed. The new real blocked-run telemetry path passed in 1.5 seconds.
- Next: add a DSN and verify one Sentry event, then build the second synthetic `CLICK`/navigation/`WAIT` scenario and promote its outcome.

## Run 5: 2026-09-19 merge main, drop the agent runner, retarget the learning loop [DONE]
- Merged `origin/main` (terminal ghost, OpenAI vision, next-action click ghosts + presence heartbeat, desktop Greenhouse fixes). Three trivial conflicts, both sides kept: `package.json`, `extension/src/content/index.ts`, `MORNING.md`.
- Audited the two streams against the code, not the docs: they were complementary, not duplicated. Both build candidates from the same `captureFields()`; only the projections differ. Nothing on main ever called `/v1/agent/next`.
- Removed the `Alt+Shift+J` Jev computer-use runner (~1,059 lines): route, runner, browser adapter, panel, providers, shared contract, e2e. Pravin's form walk is the product and Ghost Desktop drives it through the same `/v1/predict/form`.
- Rebuilt the learning loop on that walk. The label is now the user's own verdict per ghost (accept / escape / type-over), read off the existing controller event bus, so neither the controller nor the predictor knows telemetry exists.
- `ghost.walk-outcome.v1` cannot represent a label, value, signature, URL, origin or title, and a summary that contradicts its proposals is rejected. Only three walks are reviewable: a locked proposal accepted (safety violation), a calibrated confident proposal rejected (calibration failure), or an abandoned walk. Every fixture asserts `lockedAccepted: 0`.
- Renamed the surface: `/v1/walk/outcomes`, `/v1/walk/replays`, `pnpm eval:walk-replays`, `evals/walk-replays/`, `docs/learning-loop.md`.
- Deliberately did NOT adopt `docs/answers.md`'s `questionSignature` (derived from page text) or touch `shared/src/answers/**`, which is Pravin's unimplemented design. The tension is written up in `handoff.md` for him to decide.
- Verification: typecheck passes; 2,386 unit tests plus the replay eval; extension and demo builds; e2e 37 passed / 1 failed. The new loaded-extension walk-telemetry spec passes both paths (abandoned walk becomes a redacted fixture, healthy walk stays out of the queue). The one failure, `stage5-next.spec.ts:187` (extension presence heartbeat), reproduces identically on pristine `origin/main` in a clean worktree, so it is pre-existing and belongs to the presence stream.
- Found two stale doc claims while auditing: desktop is 203 tests, not the documented 201, and PLAN.md's Stretch checkbox for the extension presence heartbeat was wrong until main landed it. Both corrected.
- Next: add a `SENTRY_DSN` and confirm one live scrubbed event, then emit the same envelope from Ghost Desktop.

## Run 6: 2026-09-20 01:05 (UTC) [DONE at 01:45 UTC]
- Worked on: the last unchecked Stage 6 item, the loaded-extension invoice-loop e2e. Checked it off.
- Added `e2e/tests/stage6-loop.spec.ts`: from `/reset`, two invoices performed by hand (real clicks, real typing, real navigation), Ghost proposes the remaining 48, the preview fills with all four extracted values for every one of them, ONE invoice is held back, ONE explicit Tab+Enter confirmation runs the rest, 47 complete. 2 tests, 18.2 s.
- The held-back item is chosen as the largest total in the batch, which is both a deterministic pick and the invoice a person would actually stop on. The spec then asserts it is the ONLY one of the 50 left unlogged and unreplied, and that every other row reached the sheet exactly as previewed.
- The spec also asserts the batch changed nothing before the confirmation, that the confirmation text names the irreversible effect and its count (47, not 48), and that no row reported a failure.
- Recorded `docs/media/stage6-loop.webm` (1.3 MB).
- Extracted the loop driver `compareA.spec.ts` carried inline into `e2e/loop.ts` and pointed both specs at it: compareA shrank by ~6.4 KB and still passes. `panelEval` now takes a serializable argument, because a function sent to a closed shadow root over CDP closes over nothing.
- Second test in the spec initially failed for a good reason: I asserted the overlay reaches `data-ghost-state="ready"` on an invoice page. It does not, and should not - an invoice page has no fields, so Ghost reports `idle` with zero ghosts. The test now asserts that stronger, truer property: Ghost stands down entirely there and 20 Tab presses send no reply.
- Tests: build pass, typecheck pass, 2,586 unit tests pass (demo 74, extension 883, server 906, shared 723) plus the walk-replay eval. Browser e2e 49 passed / 3 failed.
- The 3 failures are `tab-surface.spec.ts` (71, 102, 113) and are NOT mine: they fail identically when that file is run completely alone with fresh servers. The workflow page never leaves its "Start the local server" state, so every assertion that waits for it times out and the Tab-ownership behaviour underneath is never exercised. Reported to its owner in the war room; deliberately not fixed here.
- Correction to the previous run's note: `stage5-next.spec.ts:187` (presence heartbeat) PASSED in both full runs today. It is flaky, not consistently failing as Run 5 and MORNING.md recorded.
- Next: `tab-surface` needs fixing or quarantining before main can go green on e2e, then `DEMO.md` around the invoice-loop and desktop Greenhouse proofs.

## Run 7: 2026-09-20 02:28 (UTC) [DONE]
- Worked on: unify local form correction learning, generic Fast Lane/Jev context, Sentry outcomes, and replay evals on `codex/sentry-learning-loop`.
- Connected the shared answer engine to the real extension. Manual text/select/radio/checkbox answers persist under `ghost.answers`; storage updates reach open tabs; learned questions are excluded from server/Jev requests; guesses are visibly reviewable and stop held Tab; Options has a Learned tab with forget controls.
- Added a local Greenhouse/Amazon/Airbnb-shaped fixture and loaded-extension e2e: one trusted correction transfers through different question wording and site-specific radio values, with Submit untouched.
- Kept generic action recall fast: merged the Fast Lane branch, which answers locally and passes bounded relevant examples to Jev in `state.memory` only as asynchronous refinement. LLM free text remains speculative/background.
- Rebuilt Sentry around one process initializer and one outbound scrubber. Fixed nested outcome normalization (`normalizeDepth: 6`) and false-positive capture reporting (successful flush required). A real SDK integration test delivers the scrubbed event plus replay attachment to local fake ingest.
- Added value-free answer metadata to walk outcomes, a policy replay that recomputes behavior, and synthetic semantic learning fixtures. Both are run by `pnpm eval:learning-loop` and the legacy replay command.
- Verification: workspace typecheck and build pass; 2,622 JS/TS unit tests plus 2 replay fixtures pass; browser e2e is 56/56 green. No external Sentry DSN was available, so live project delivery was not claimed.
- War room was read-only as requested. No messages were sent.
- Next: verify one external Sentry event when a DSN is available, connect the shared learned-answer/outcome seams to Ghost Desktop, and write `DEMO.md`.
