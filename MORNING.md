# Current handoff

_Last updated: 2026-09-19 after the redacted Jev outcome/replay integration pass._

## What works now

- **Browser agent:** instant local ghosts are upgraded by the server with per-form caching; the extension also streams textarea drafts, imports resumes, learns opt-in facts, reports metrics, records safe traces/page facts, detects repeated loops, previews them and runs explicitly confirmed loops.
- **Demo sites:** the existing application, invoice, sheet, mail and calendar surfaces remain. `/workflow/index.html` adds a polished atomic-workflow lab with meeting coordination, Slack → GitHub issue and local-fill stories.
- **Server:** direct TypeSafe/Jev, Jev Gateway, Baseten, OpenAI-compatible and heuristic decision paths exist alongside text generation, profile extraction, metrics, presence, loop synthesis, Browserbase, the original Composio loop executor, and the new atomic Composio workflow engine.
- **Native macOS agent:** the stable host, hot-swappable library, Accessibility capture, verified writer and `ghostctl` harness are implemented. The new `GHWorkflowCoordinator` is tested as a narrow workflow seam.
- **Live Jev proof:** a 12-field mapping completed in 490 ms, and the three-step meeting workflow returned calibrated TypeSafe/Jev choices at 100%, 95% and 88% confidence before simulated execution.
- **Live browser computer-use proof:** the extension's new `Alt+Shift+J` runner completed the `/apply` safety scenario through direct TypeSafe/Jev in 8.3 s. It filled all locally supported fields plus generated prose, left consent untouched and made zero Submit attempts. The same loaded-extension spec passes against the keyless policy in 2.0 s.
- **Reviewed learning loop:** terminal agent runs now produce a strict value-free outcome, pass two sanitization boundaries, optionally reach Sentry, and turn blocked runs into versioned replay cases checked by `pnpm eval:agent-replays`. There is no Sentry DSN on this machine yet, so live delivery remains unverified.

## Who is working on what

Pull (`git pull --rebase origin main`) before you push; update this file when your stream's state changes. Small additive edits only in hot shared files: `server/src/{config,app}.ts`, `server/src/routes/execute.ts`, `docs/server-api.md`, `extension/src/content/{controller,index}.ts`, `extension/src/background/index.ts`, `.env.example`, `PLAN.md`, this file.

| Stream | Owner | Scope | State (19:20 UTC) |
| --- | --- | --- | --- |
| Ghost Desktop on a REAL Greenhouse form (Safari) | Pravin's agents | `desktop/**` | Accessibility granted on `~/Applications/Ghost.app` (rebuild ONLY `libghost.dylib`, never the host). `ghostctl trust` and `dump-tree` verified live on the Viam Greenhouse posting; a redacted fixture is in `desktop/tests/fixtures/greenhouse-safari-viam.json`. Capture now descends into Safari's tab group. Next: resume upload via the macOS open panel, react-select comboboxes, live `autotab` run parked on the locked Submit, recording. |
| Composio (loop API mode + atomic workflows) | Tahseen | `server/src/executors/composio*`, `server/src/workflows/**`, see `docs/handoff-composio.md` | Atomic workflow engine merged; live API payload aligned. |
| Integration, invoice-loop proof, docs | Samir | `DEMO_WIN_PLAN.md`, e2e for the loop, `DEMO.md` | See "Next milestone". |
| OpenAI vision fallback (OpenAI API prize) | Pravin's agents (in progress) | `server/src/routes/vision.ts`, `server/src/vision/**`, `docs/openai.md` | `/v1/vision/label` and `/v1/vision/locate`: OpenAI sees unlabeled/canvas controls, Jev still decides. Mock-tested; needs an `OPENAI_API_KEY` to go live. |
| Terminal ghost (zsh, Warp track) | Pravin's agents (in progress) | `terminal/**`, `server/src/routes/command.ts`, `server/src/command/**` | Predicts the next shell command with Jev; Tab inserts it, never runs it. |
| Extension next-action ghosts + presence heartbeat | Pravin's agents (in progress) | `extension/src/content/nextAction.ts`, `extension/src/background/{nextClient,presence}.ts` | Click ghosts from episodic memory + `/v1/predict/next`; 30 s `/v1/presence` beat so Desktop defers to the extension. |

Measured on Pravin's machine with real keys: Jev direct 12-field form 649 ms (12/12, confidence 0.93 to 1.00); Baseten GLM-5.3-Flash with 3 samples + 1 hedge p50 1052 ms (12/12; ambiguous form 97.5% with zero wrong answers above the 0.7 gate); xAI adapter about 1.3 s with a flat 0.90 confidence; Browserbase session up in 0.5 s and invoice fields extracted from the public demo (https://whitespace-delta.vercel.app) in 3.7 s. Tables: `docs/media/bench-providers*.md`, `docs/baseten.md`.

## What does not work end to end yet

- The canonical 50-invoice story has strong unit coverage but no full loaded-extension Playwright run, intentional one-row exception proof, or fallback video yet.
- `/v1/predict/next` exists, but the extension still does not request next-element predictions beyond its loop machinery.
- The Jev runner's first proof is value-operation-heavy. A second page-changing scenario is still needed to prove `CLICK`, navigation and `WAIT` end to end.
- Browserbase credentials are present but have not been live-rehearsed. Composio, AI Gateway and OpenAI are not configured; all current Composio demo effects are simulated.
- `GHWorkflowCoordinator` is not yet connected to the desktop app’s main capture/overlay/Tab pipeline.
- `DEMO.md`, the invoice-loop fallback video and the final results screen are missing.

## Next milestone

Lock the new live Jev proof into the judging story, then complete the existing invoice-loop proof:

1. Record the live `/apply` Jev run and add its exact `Alt+Shift+J` command to `DEMO.md`.
2. Add a Sentry Node project DSN, produce one synthetic blocked run, and confirm its scrubbed event plus replay attachment.
3. Add one page-changing runner scenario that exercises safe `CLICK`/`WAIT` and still proves zero locked actions; promote its reviewed outcome into the replay corpus.
4. Add one loaded-extension e2e from `/reset` through two manual invoice examples and the proposal.
5. Exercise preview across the remaining 48 items, complete 47 safe items, hold one for review, and record `docs/media/stage6-loop.webm`.

Only after that vertical slice is stable: connect OpenAI to a visible, code-verified ambiguity-resolution or drafting step; write `DEMO.md`; rehearse; then consider live Browserbase/Composio or the native breadth proof.

## Verified baseline

- Build: pass.
- Typecheck: pass.
- JS/TS unit tests: 2,029 passed.
- Browser e2e: 34 passed, including the Jev computer-use proof and both atomic-workflow stories.
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

For the autonomous proof press `Alt+Shift+J` and run: `Fill every field that has a safe local value; leave consent untouched and stop before Submit application`.

## Safety and operational notes

- Never submit a real form or contact a real recipient during automated testing.
- Fields inside shadow roots are not captured by the extension.
- The debugger fallback is unit-tested but has not been required by the canonical e2e path.
- The native agent needs a user-granted Accessibility permission and has not been included in the root `scripts/verify.sh` gate.
