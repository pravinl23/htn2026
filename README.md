# Ghost

**Cursor Tab for your whole computer.** Ghost predicts your next action anywhere in the browser and shows it as a translucent ghost: a ghost cursor gliding onto the field or button you are about to use, and gray ghost text inside the field you are about to fill. Press **Tab** to accept. Open a job application and Tab, Tab, Tab fills the whole form. Do a multi-step task twice and Ghost offers to do the rest.

Built at Hack the North 2026. Instructions for the autonomous builder live in `CLAUDE.md`, the roadmap in `PLAN.md`, the run log in `PROGRESS.md`, and the morning handoff in `MORNING.md`.

## Run it

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm build        # builds the extension into extension/dist (and the demo sites)
pnpm dev          # prediction server on :8787, demo sites on :5173, extension rebuild on change
```

Then load the extension in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/dist` folder.
4. Open http://localhost:5173/apply and press **Tab**.

Toggle Ghost with **Alt+Shift+G** or the toolbar button.

## Test it

```bash
pnpm test         # all unit tests (no keys needed)
pnpm e2e          # Playwright: loads the built extension into Chromium and drives the demo sites
pnpm test:live    # only runs when real provider keys are present; prints real latency
```

## Keys

Everything works with no keys through the deterministic heuristic provider. Copy `.env.example` to `.env` to enable model providers. Never commit `.env`.

## Layout

```
shared/      types and pure logic shared by the extension and the server (field mapping, value resolution, safety rules)
extension/   Chrome MV3 extension (content script, background worker, options page)
server/      Hono prediction service on http://localhost:8787
demo/        local demo sites on http://localhost:5173
e2e/         Playwright tests that load the built extension
docs/        media and diagrams
```
