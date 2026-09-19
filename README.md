# Ghost

**Cursor Tab for your whole computer.** Ghost predicts your next action anywhere in the browser and shows it as a translucent ghost: a ghost cursor gliding onto the field or button you are about to use, and gray ghost text inside the field you are about to fill. Press **Tab** to accept. Open a job application and Tab, Tab, Tab fills the whole form. Do a multi-step task twice and Ghost offers to do the rest.

Built at Hack the North 2026. Instructions for the autonomous builder live in `CLAUDE.md`, the roadmap in `PLAN.md`, the run log in `PROGRESS.md`, and the morning handoff in `MORNING.md`.

## Current status

The browser form-filling path is complete and verified: Ghost can walk the React and plain-HTML job applications with Tab, preserve native keyboard behavior outside the walk, refuse sensitive fields, verify writes, and stop on the locked Submit action. The demo sites, prediction/LLM server, pure loop-learning engine, server-side Browserbase/Composio executors, and native macOS form agent are also implemented and unit-tested.

The headline **"do it twice, Ghost does the rest"** workflow is not connected end to end yet. The Chrome extension still predicts forms locally; it does not record action traces, call the prediction server, show a learned-loop preview, or execute a confirmed loop. Mail/calendar, invoices/sheet, resume extraction, next-action prediction, metrics, and scale-out execution therefore exist as tested components or demo surfaces, not as complete user flows. See `PLAN.md` for the exact boundary.

## Run it

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm build        # builds the extension into extension/dist (and the demo sites)
pnpm dev          # prediction server on :8787, demo sites on :5173, extension rebuild on change
```

Known setup issue: `pnpm install --frozen-lockfile` currently fails because the lockfile still lists `pdfjs-dist` for the extension while `extension/package.json` does not. Reconcile and commit the lockfile before relying on frozen CI installs.

Then load the extension in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/dist` folder.
4. Open http://localhost:5173/apply and press **Tab**.

Toggle Ghost with **Alt+Shift+G** or the toolbar button.

## Test it

```bash
pnpm test         # all pnpm-workspace unit tests (no keys needed; excludes desktop/)
pnpm e2e          # Playwright: loads the built extension into Chromium and drives the demo sites
pnpm test:live    # only runs when real provider keys are present; prints real latency
make -C desktop test  # native macOS agent unit tests (not included in pnpm test)
```

The first Playwright run also needs `pnpm --filter @ghost/e2e exec playwright install chromium`. The standalone demo smoke test expects the preview server to already be running, then runs with `node e2e/scripts/smoke-demo.mjs`.

## Keys

The implemented offline form path and server endpoints have deterministic fallbacks when keys are missing. Copy `.env.example` to `.env` to enable live model providers. There is currently no `.env` in the repository checkout, and the extension does not call the server yet. Never commit `.env`.

## Layout

```
shared/      types and pure logic shared by the extension and the server (field mapping, value resolution, safety rules)
extension/   Chrome MV3 extension (content script, background worker, options page)
server/      Hono prediction service on http://localhost:8787
demo/        local demo sites on http://localhost:5173
e2e/         Playwright tests that load the built extension
desktop/     native macOS menu-bar form agent (separate Makefile build and tests)
docs/        media and diagrams
```
