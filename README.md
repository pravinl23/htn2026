# Ghost

**Cursor Tab for your whole computer.** Ghost predicts your next action anywhere in the browser and shows it as a translucent ghost: a ghost cursor gliding onto the field or button you are about to use, and gray ghost text inside the field you are about to fill. Press **Tab** to accept. Open a job application and Tab, Tab, Tab fills the whole form. Do a multi-step task twice and Ghost offers to do the rest.

Built at Hack the North 2026. Instructions for the autonomous builder live in `CLAUDE.md`, the roadmap in `PLAN.md`, the run log in `PROGRESS.md`, and the morning handoff in `MORNING.md`.

## Current status

The browser form-filling path is complete and verified: Ghost can walk the React and plain-HTML job applications with Tab, preserve native keyboard behavior outside the walk, refuse sensitive fields, verify writes, and stop on the locked Submit action. The extension now upgrades its instant local predictions from the server, caches per form, streams free-text drafts, imports resumes, learns opt-in facts, reports metrics, records safe action traces, detects repeated loops, previews them and runs confirmed visible/background/Browserbase/Composio modes.

The extension also has a working Jev computer-use loop. Press **Alt+Shift+J**, give it a goal, and it repeatedly observes a value-free page state, asks Jev for one closed-vocabulary operation, freshness-checks the page, executes through Ghost's existing local verified writer, and observes again. Profile values remain local. The loaded-extension proof fills every safe field on `/apply`, including generated prose, leaves consent alone and stops before Submit. It passes both with the deterministic no-key policy and with the configured direct TypeSafe/Jev provider; the live browser scenario completed in 8.3 seconds during the 2026-09-19 verification. See [`docs/jev-agent.md`](docs/jev-agent.md).

The canonical invoice loop is heavily unit-tested, including preview, explicit confirmation, verified background execution and failure handling, but still needs one loaded-extension Playwright run covering the full “do two, preview 48, complete 47, hold one” judging path and its fallback video. The separate atomic workflow lab demonstrates two Jev-selected stories—meeting coordination and Slack → GitHub issue—with simulated Composio execution. Real Composio accounts are not configured, and the native workflow coordinator is a tested seam rather than part of the desktop app’s live pipeline. See `PLAN.md` for the exact boundary.

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

For the autonomous Jev demo, press **Alt+Shift+J** and run:

> Fill every field that has a safe local value; leave consent untouched and stop before Submit application

The ordinary Tab walk becomes passive during the run and resumes afterward. Ghost never supplies consent and never activates the locked Submit action.

For the atomic macOS/Composio workflow demo, keep the server and demo running and open
`http://localhost:5173/workflow/index.html`. It is side-effect-free and simulated until
`COMPOSIO_API_KEY` is configured, with meeting coordination and Slack → GitHub issue
stories ready for the hackathon demo. See [`docs/workflows.md`](docs/workflows.md).

## Test it

```bash
pnpm test         # all pnpm-workspace unit tests (no keys needed; excludes desktop/)
pnpm e2e          # Playwright: loads the built extension into Chromium and drives the demo sites
pnpm test:live    # only runs when real provider keys are present; prints real latency
make -C desktop test  # native macOS agent unit tests (not included in pnpm test)
```

The first Playwright run also needs `pnpm --filter @ghost/e2e exec playwright install chromium`. The standalone demo smoke test expects the preview server to already be running, then runs with `node e2e/scripts/smoke-demo.mjs`.

## Keys

The implemented offline form path and server endpoints have deterministic fallbacks when keys are missing. Copy `.env.example` to `.env` to enable live model providers. On the audited developer machine, direct TypeSafe/Jev, Baseten, xAI and Browserbase are configured. A live 12-field Jev decision and the complete three-action atomic workflow passed with calibrated TypeSafe/Jev choices. The extension and desktop both use the local server while retaining local fallback. Never commit `.env`.

## Run Ghost in the background (macOS)

Ghost can start at login and stay out of the way: no terminal, no `pnpm dev`. Two per-user LaunchAgents do it.

| LaunchAgent | What runs | Restart policy |
| --- | --- | --- |
| `dev.ghost.server` | The prediction server on `http://127.0.0.1:8787` (loopback only), as one bundled file: `~/Library/Application Support/Ghost/server/server.mjs`, started by `ghost-server.sh` with an absolute `node` path. No pnpm, tsx or repo needed at run time. | `KeepAlive`, at most one restart every 10 s |
| `dev.ghost.desktop` | Ghost Desktop, the native menu-bar agent (`~/Applications/Ghost.app`) that draws ghosts in Safari, Chrome, Arc, Firefox, Electron and native apps. See `desktop/README.md`. | `RunAtLoad`; restarted after a crash only, so **Quit** in the menu stays quit |

**Install.** Run it yourself (it adds login items, so no agent or CI ever runs it). Never with `sudo`: the script refuses to run as root.

```bash
scripts/install-background.sh --dry-run   # prints every action and the rendered plists, changes nothing
scripts/install-background.sh             # build, install, start
```

It builds the server bundle (`pnpm --filter @ghost/server bundle`, i.e. `node server/build.mjs` -> `server/dist/server.mjs`) and `make -C desktop app`, copies the bundle to `~/Library/Application Support/Ghost/server/`, copies `Ghost.app` to `~/Applications/` **only if it is not there yet**, runs `make -C desktop install-lib`, writes the two plists to `~/Library/LaunchAgents/`, and loads them with `launchctl bootout` (errors ignored) followed by `launchctl bootstrap gui/$UID`. Options: `--server-only`, `--desktop-only`, `--launch-via-open`, `--render-to DIR` (render and lint the plists into a directory, touch nothing else).

**Permission (once, by hand).** System Settings -> Privacy & Security -> Accessibility -> switch **Ghost** on (`~/Applications/Ghost.app`). Ghost notices within two seconds; nothing to restart. No script here grants, resets or edits privacy permissions. macOS ties the grant of an ad-hoc signed app to its exact code, which is why the installer **never overwrites an existing `~/Applications/Ghost.app`**: the app is a tiny stable host, and updates arrive through `libghost.dylib` next to your profile (`docs/desktop-realworld.md`, section 1):

```bash
make -C desktop install-lib && launchctl kickstart -k gui/$(id -u)/dev.ghost.desktop
```

The agent starts the binary inside `Ghost.app` directly. A launchd job is its own "responsible process" for macOS privacy checks (unlike a binary started from a terminal, which is attributed to the terminal), and macOS identifies it by the enclosing bundle, so the grant you give `Ghost.app` applies; launchd also owns the real process, so stopping and crash restarts work. If a future macOS still reports "Needs Accessibility permission" after the grant, reinstall with `--launch-via-open`, which starts the app through LaunchServices (`/usr/bin/open -W -n`) exactly like a double click.

**Keys.** The background server never reads the repo's `.env`. On the first install, `~/.config/ghost/env` (mode 0600, directory 0700) is created from the lines of `.env` whose names are on a fixed allowlist (`XAI_API_KEY`, `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, `BASETEN_*`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `COMPOSIO_API_KEY`, `GHOST_PUBLIC_DEMO_URL`); nothing is echoed and an existing file is never overwritten. The wrapper exports it as data (it is never evaluated as shell), so no key appears in a plist or in `launchctl print`. With no keys Ghost runs on the offline heuristic. After editing the file: `launchctl kickstart -k gui/$(id -u)/dev.ghost.server`.

**Logs and status.** Everything is in `~/Library/Logs/Ghost/` (mode 0600): `server.log`, `server.err.log` (trimmed at 5 MB on each start), `desktop.log` (the agent's own log: labels truncated, never values), `desktop.launchd.log`.

```bash
launchctl print gui/$(id -u)/dev.ghost.server | head -20
curl -s http://127.0.0.1:8787/v1/health
tail -f ~/Library/Logs/Ghost/server.err.log
```

**Uninstall.**

```bash
scripts/uninstall-background.sh               # stop and remove both LaunchAgents and the installed server bundle
scripts/uninstall-background.sh --remove-app  # ... and ~/Applications/Ghost.app plus libghost.dylib
scripts/uninstall-background.sh --purge       # ... and profile.json, settings.json, ~/.config/ghost/env, the logs
```

`--dry-run` works here too. By default your profile, your keys, the logs and `Ghost.app` (with its Accessibility grant) are kept. The Accessibility entry itself is yours to remove in System Settings.

**Coexistence with the extension.** The extension and Ghost Desktop share the one server on `:8787`. The extension sends a presence heartbeat every 30 s; Ghost Desktop skips any browser whose heartbeat is fresher than 90 s and says so in its menu ("Chrome: handled by the extension"), so you never get two ghosts on one field. Browsers without the extension (Safari, Firefox) and native apps are handled by Ghost Desktop. While the background server is loaded it owns port 8787: `pnpm dev` cannot start a second one, and `pnpm e2e` would reuse it (with your real keys) instead of the offline heuristic. For development, unload it first:

```bash
launchctl bootout gui/$(id -u)/dev.ghost.server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.ghost.server.plist   # back on
```

**Privacy.** Everything runs on your Mac and the server listens on loopback only. What leaves the machine is what the configured model provider needs: field labels and the *names* of your profile facts for mapping (never their values), and for free-text answers only the relevant non-sensitive facts. Password, card, government ID and sensitive-labelled fields are never captured, predicted, filled, cached or logged. Locked actions (submit, send, pay, delete) are never pressed by Ghost. Your profile lives in `~/Library/Application Support/Ghost/profile.json` (mode 0600) and nothing is written to the repo. Pause Ghost for any app from the menu-bar icon, or toggle it with Alt+Shift+G.

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
