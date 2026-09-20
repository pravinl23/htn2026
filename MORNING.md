# Current handoff

_Last updated: 2026-09-19 21:30 UTC by Pravin's agent after the terminal, vision, next-action and desktop streams landed (build, typecheck, 2,350 unit tests, 36 e2e, 50 terminal pty tests, 316 desktop tests: all green)._

## What works now

- **Browser agent:** instant local ghosts are upgraded by the server with per-form caching; the extension also streams textarea drafts, imports resumes, learns opt-in facts, reports metrics, records safe traces/page facts, detects repeated loops, previews them and runs explicitly confirmed loops.
- **Demo sites:** the existing application, invoice, sheet, mail and calendar surfaces remain. `/workflow/index.html` adds a polished atomic-workflow lab with meeting coordination, Slack → GitHub issue and local-fill stories.
- **Server:** direct TypeSafe/Jev, Jev Gateway, Baseten, OpenAI-compatible and heuristic decision paths exist alongside text generation, profile extraction, metrics, presence, loop synthesis, Browserbase, the original Composio loop executor, and the new atomic Composio workflow engine.
- **Native macOS agent:** the stable host, hot-swappable library, Accessibility capture, verified writer and `ghostctl` harness are implemented. The new `GHWorkflowCoordinator` is tested as a narrow workflow seam.
- **Live Jev proof:** a 12-field mapping completed in 490 ms, and the three-step meeting workflow returned calibrated TypeSafe/Jev choices at 100%, 95% and 88% confidence before simulated execution.

## Who is working on what

Pull (`git pull --rebase origin main`) before you push; update this file when your stream's state changes. Small additive edits only in hot shared files: `server/src/{config,app}.ts`, `server/src/routes/execute.ts`, `docs/server-api.md`, `extension/src/content/{controller,index}.ts`, `extension/src/background/index.ts`, `.env.example`, `PLAN.md`, this file.

| Stream | Owner | Scope | State (19:20 UTC) |
| --- | --- | --- | --- |
| Ghost Desktop on a REAL Greenhouse form (Safari) | Pravin's agents | `desktop/**` | **LIVE on the real Viam Greenhouse form (2026-09-19 18:20 EDT):** 11 Tab presses in 13.8 s filled First/Last name, Email, Phone, LinkedIn, Github, Website (each verified), **attached the fictional resume through the native macOS open panel in 4.1 s** (the page then showed "Remove file"), and stopped parked on the locked "Submit application". Nothing was submitted. Open gap: react-select dropdowns were refused (Country was pre-filled; "How did you hear" refused) - being iterated on now. Evidence: `docs/media/desktop-greenhouse-autotab.json`, `docs/media/desktop-greenhouse-final-form.json` (labels and value LENGTHS only). |
| Composio (loop API mode + atomic workflows) | Tahseen | `server/src/executors/composio*`, `server/src/workflows/**`, see `docs/handoff-composio.md` | Atomic workflow engine merged; live API payload aligned. |
| Integration, invoice-loop proof, docs | Samir | `DEMO_WIN_PLAN.md`, e2e for the loop, `DEMO.md` | See "Next milestone". |
| OpenAI vision fallback (OpenAI API prize) | Pravin's agents | `server/src/routes/vision.ts`, `server/src/vision/**`, `docs/openai.md` | Done, mock-tested (63 tests): `/v1/vision/label` and `/v1/vision/locate`; locks and sensitivity re-derived in code. Needs an `OPENAI_API_KEY` to go live; no client calls it yet. |
| Terminal ghost (zsh, Warp track) | Pravin's agents | `terminal/**`, `server/src/routes/command.ts`, `server/src/command/**` | Done: `source terminal/ghost.zsh`; Jev picks the next command (live: 491 ms, 0.89), Tab inserts, never runs; `pnpm test:terminal` 50 passed. Not in Warp (Warp replaces the line editor). |
| Ghost anywhere: affordances, page kinds, priors, role memory | Pravin's agents | `shared/src/affordance/**` (roles, pageKind, priors, memory) | Done, 161 unit tests, no keys, no network. `classifyAffordance` / `inferPageKind` / `priorsFor` / `predictByRole` + `RoleMemory` are pure and exported from `@ghost/shared`. No site, host or brand is named anywhere in the module or its fixtures. Consumers: the extension DOM ranker (`extension/src/content/nextAction.ts`) and the native agent should classify candidates, infer the page kind, take `priorsFor(kind, state)` and rank with `predictByRole`; `server/src/vision/affordance.ts` already adapts vision labels through the same `classifyAffordance`. Clients should pass the generic hints: `insideMediaControls`, `list {listSignature,index}`, `nearbyPrice`, `badgeCount`, `classTokens`, and `context.mainListSignature` (the MAIN region's list, or null) - without that last one a site's navigation bar classifies as feed items. Proven live (read-only) on two real sites: a real video page playing -> fullscreen 0.70 top; a real shop header with an empty cart -> the search box 0.70; same header with 2 in the cart -> the cart 0.70; a real results grid -> the first result 0.70. |
| Ghost anywhere on the NATIVE agent (macOS) | Pravin's agents | `desktop/core/anywhere.ts`, `desktop/src/GH{Affordance,NextAction,Vision}.*`, `GHCapture` (`capturesUnnamedControls`, `windowNode`), `GHField` (hints + `toCandidateJSONObject`), `GHCore.nextAction`, small hooks in `GHController`/`GHWriter`, `docs/desktop.md` | Done, 34 new desktop tests through the REAL ghost-core.js and fake AX trees. When the form walk has nothing to fill, Ghost proposes the one control the place is for: a playing video -> fullscreen, a paused one -> play, a grid -> the first item (not a nav entry), a shop with 2 in the cart -> the cart (checkout stays locked and can never be the proposal), an empty cart -> the search box (which is FOCUSED, never pressed). Capture now keeps icon-only controls (`unnamed`) and emits `insideMediaControls`, `list {signature,index}`, `nearbyPrice`, `badgeCount`, `hasMediaElement`, `mainListSignature`, `mainRegionRepeats`, `textDensity`, `isFullscreen`, `sensitiveOnScreen`. Role memory in `~/Library/Application Support/Ghost/memory.json` (0600, atomic, corrupt-tolerant): two accepts reorder a place's defaults. `GHVision` crops ONLY the unnamed controls into one strip for `/v1/vision/label` (one call per page view, cached, never from a window with a sensitive field); without Screen Recording it reports "needs Screen Recording" and everything else keeps working. Not yet rehearsed live on a real site. |
| Extension next-action ghosts + presence heartbeat | Pravin's agents | `extension/src/content/nextAction.ts`, `extension/src/background/{nextClient,presence}.ts` | Done: click ghosts from episodic memory + `/v1/predict/next`, form-submitting controls locked, 30 s `/v1/presence` beat; e2e 36 passed. |

Measured on Pravin's machine with real keys: Jev direct 12-field form 649 ms (12/12, confidence 0.93 to 1.00); Baseten GLM-5.3-Flash with 3 samples + 1 hedge p50 1052 ms (12/12; ambiguous form 97.5% with zero wrong answers above the 0.7 gate); xAI adapter about 1.3 s with a flat 0.90 confidence; Browserbase session up in 0.5 s and invoice fields extracted from the public demo (https://whitespace-delta.vercel.app) in 3.7 s. Tables: `docs/media/bench-providers*.md`, `docs/baseten.md`.

## What does not work end to end yet

- The canonical 50-invoice story has strong unit coverage but no full loaded-extension Playwright run, intentional one-row exception proof, or fallback video yet.
- `/v1/predict/next` exists, but the extension still does not request next-element predictions beyond its loop machinery.
- Browserbase credentials are present but have not been live-rehearsed. Composio, AI Gateway and OpenAI are not configured; all current Composio demo effects are simulated.
- `GHWorkflowCoordinator` is not yet connected to the desktop app’s main capture/overlay/Tab pipeline.
- `DEMO.md`, the invoice-loop fallback video and the final results screen are missing.

## Next milestone

Turn the implemented invoice-loop machinery into the canonical judging proof before adding more examples:

1. Add one loaded-extension e2e from `/reset` through two manual invoice examples and the proposal.
2. Exercise the real preview panel across the remaining 48 items; make one intentionally incomplete invoice low-confidence and unchecked.
3. Explicitly confirm once, execute and verify 47 safe items, and assert zero unconfirmed sends.
4. Finish on `47 completed · 1 needs review · 0 unconfirmed sends`, repeat it three times and record `docs/media/stage6-loop.webm`.
5. Only then decide whether the atomic workflow lab or real Browserbase/Composio should enter the three-minute judging script.

Only after that vertical slice is stable: connect OpenAI to a visible, code-verified ambiguity-resolution or drafting step; write `DEMO.md`; rehearse; then consider live Browserbase/Composio or the native breadth proof.

## Verified baseline

- Build: pass.
- Typecheck: pass.
- JS/TS unit tests: 2,016 passed.
- Browser e2e: 33 passed, including both atomic-workflow stories.
- Demo smoke: the previous 95-check run passed; it was not rerun after this merge.
- Desktop: 201 passed.
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
