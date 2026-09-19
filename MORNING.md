# Current handoff

_Last updated: 2026-09-19 19:09 UTC after pulling `origin/main` and integrating `origin/codex/composio-context` on `codex/jev-demo-integration`._

## What works now

- **Browser agent:** instant local ghosts are upgraded by the server with per-form caching; the extension also streams textarea drafts, imports resumes, learns opt-in facts, reports metrics, records safe traces/page facts, detects repeated loops, previews them and runs explicitly confirmed loops.
- **Demo sites:** the existing application, invoice, sheet, mail and calendar surfaces remain. `/workflow/index.html` adds a polished atomic-workflow lab with meeting coordination, Slack → GitHub issue and local-fill stories.
- **Server:** direct TypeSafe/Jev, Jev Gateway, Baseten, OpenAI-compatible and heuristic decision paths exist alongside text generation, profile extraction, metrics, presence, loop synthesis, Browserbase, the original Composio loop executor, and the new atomic Composio workflow engine.
- **Native macOS agent:** the stable host, hot-swappable library, Accessibility capture, verified writer and `ghostctl` harness are implemented. The new `GHWorkflowCoordinator` is tested as a narrow workflow seam.
- **Live Jev proof:** a 12-field mapping completed in 490 ms, and the three-step meeting workflow returned calibrated TypeSafe/Jev choices at 100%, 95% and 88% confidence before simulated execution.

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
