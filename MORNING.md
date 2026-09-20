# Current handoff

_Last updated: 2026-09-20 01:50 UTC by Samir's agent after the invoice-loop e2e landed. Build, typecheck and 2,586 unit tests pass; browser e2e is 49 passed / 3 failed (all 3 in `tab-surface.spec.ts`, a real break, see below)._

## What works now

- **Browser agent:** instant local ghosts are upgraded by the server with per-form caching; the extension also streams textarea drafts, imports resumes, learns opt-in facts, reports metrics, records safe traces/page facts, detects repeated loops, previews them and runs explicitly confirmed loops.
- **Demo sites:** the existing application, invoice, sheet, mail and calendar surfaces remain. `/workflow/index.html` adds a polished atomic-workflow lab with meeting coordination, Slack → GitHub issue and local-fill stories.
- **Server:** direct TypeSafe/Jev, Jev Gateway, Baseten, OpenAI-compatible and heuristic decision paths exist alongside text generation, profile extraction, metrics, presence, loop synthesis, Browserbase, the original Composio loop executor, and the new atomic Composio workflow engine.
- **Native macOS agent:** the stable host, hot-swappable library, Accessibility capture, verified writer and `ghostctl` harness are implemented. The new `GHWorkflowCoordinator` is tested as a narrow workflow seam.
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
pnpm --filter @ghost/e2e exec playwright install chromium
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
