# Current handoff

_Last updated: 2026-09-19 18:10 UTC after a repository-wide code, documentation and test audit._

## What works now

- **Browser form demo:** the Chrome MV3 extension captures fields, predicts from the local heuristic, renders the closed-shadow overlay, accepts with Tab, supports typing override/Escape/hold-Tab, verifies React-controlled writes, excludes sensitive and hidden fields, and parks on locked Submit. React and plain-HTML application demos both pass e2e.
- **Demo sites:** `/apply`, `/apply-plain/`, `/invoices`, `/invoices/:id`, `/sheet`, `/mail`, `/mail/:id`, `/calendar` and `/reset` are implemented and polished. The standalone smoke script passes 95 checks, including storage sync, programmatic React fills and mobile layouts.
- **Server:** form and next-action prediction, four decision providers, streaming ghost text, profile extraction, metrics, verified loop synthesis, confirmation tickets, Browserbase execution and Composio compilation/execution are implemented and unit-tested. Missing keys select deterministic/simulated fallbacks.
- **Shared logic:** trace normalization, repeat detection, loop alignment/generalization, value transforms, program planning, safety and episodic memory are implemented with extensive adversarial tests.
- **Native macOS agent:** the Objective-C menu-bar form agent is implemented with AX capture, overlay, event tap, verified writer, server/cache client and settings. `make -C desktop test` passes 167 tests.

## What does not work end to end yet

- The Chrome extension does **not** call the prediction server. Its HUD correctly reports `offline-heuristic`; there is no per-form client cache or streamed textarea drafting in the extension.
- The extension does **not** record actions or page facts, call `/v1/predict/next`, detect repeated routines, show a loop preview/confirmation panel, or execute loops. The invoice and mail/calendar sites are demo surfaces only.
- Browserbase and Composio are server implementations with mocks/simulated fallbacks. They have not been exercised with live credentials in this checkout, and no extension UI can select them.
- No `.env` is present, so OpenAI/Jev/Browserbase/Composio are not live here.
- Desktop expects `/v1/presence`, but the server has no presence route and the extension sends no heartbeat. Do not run desktop and extension together until coordination exists.
- `docs/desktop-realworld.md` describes planned Greenhouse/file-upload/autotab work, not current behavior.
- `DEMO.md`, the invoice-loop fallback video and the final results screen are missing.

## Next milestone

Build the canonical invoice-loop vertical slice before adding more examples:

1. Record two real invoice-to-sheet runs as normalized, sensitive-safe traces and page facts.
2. Run the existing detector and synthesizer; offer the remaining 48 items.
3. Preview extracted values, irreversible effects and confidence. Include one intentional incomplete/ambiguous invoice and leave it unchecked.
4. Require one explicit confirmation, execute 47 safe items through real DOM controls, verify every write and stop on mismatch.
5. Finish on `47 completed · 1 needs review · 0 unconfirmed sends`.
6. Add one e2e from `/reset` through the final sheet, run it three times, and record `docs/media/stage6-loop.webm`.

Only after that vertical slice is stable: connect OpenAI to a visible, code-verified ambiguity-resolution or drafting step; write `DEMO.md`; rehearse; then consider live Browserbase/Composio or the native breadth proof.

## Verified baseline

- Build: pass.
- Typecheck: pass.
- JS/TS unit tests: 1,007 passed; 2 additional server tests skipped.
- Extension e2e: 19 passed.
- Demo smoke: 95 passed.
- Desktop: 167 passed.
- Tracked secret-pattern scan: clean.

The first e2e run needs:

```bash
pnpm --filter @ghost/e2e exec playwright install chromium
```

Known setup debt: `pnpm install --frozen-lockfile` fails because `pnpm-lock.yaml` still declares `pdfjs-dist` for the extension while `extension/package.json` does not.

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
