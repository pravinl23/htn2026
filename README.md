# Shabang

**Cursor Tab for your whole computer.** Shabang predicts your next action anywhere in the browser and shows it as a translucent ghost: a ghost cursor gliding onto the field or button you are about to use, and gray ghost text inside the field you are about to fill. Press **Tab** to accept. Open a job application and Tab, Tab, Tab fills the whole form. Do a multi-step task twice and Shabang offers to do the rest.

Built at Hack the North 2026. Instructions for the autonomous builder live in `CLAUDE.md`, the roadmap in `PLAN.md`, the run log in `PROGRESS.md`, and the morning handoff in `MORNING.md`.

## Current status

The browser form-filling path is complete and verified: Shabang can walk the React and plain-HTML job applications with Tab, preserve native keyboard behavior outside the walk, refuse sensitive fields, verify writes, and stop on the locked Submit action. The extension now upgrades its instant local predictions from the server, caches per form, streams free-text drafts, imports resumes, learns opt-in facts, reports metrics, records safe action traces, detects repeated loops, previews them and runs confirmed visible/background/Browserbase/Composio modes.

Every Tab walk feeds a privacy-safe learning loop. The user's own accept, escape or type-over is the ground truth: the extension emits one value-free outcome per walk, the server can send it to Sentry, walks that went wrong become versioned replay fixtures, and `pnpm eval:walk-replays` checks reviewed expectations. Labels, values, signatures and page identity never cross the wire, and there is no automatic self-modification. Live Sentry delivery is opt-in through `SENTRY_DSN` and is not configured in the current `.env`; see [`docs/learning-loop.md`](docs/learning-loop.md).

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

Toggle Shabang with **Alt+Shift+G** or the toolbar button.


For the atomic macOS/Composio workflow demo, keep the server and demo running and open
`http://localhost:5173/workflow/index.html`. It is side-effect-free and simulated until
`COMPOSIO_API_KEY` is configured, with meeting coordination and Slack → GitHub issue
stories ready for the hackathon demo. See [`docs/workflows.md`](docs/workflows.md).

## Test it

```bash
pnpm test         # all pnpm-workspace unit tests (no keys needed; excludes desktop/)
pnpm e2e          # Playwright: loads the built extension into Chromium and drives the demo sites
pnpm test:live    # only runs when real provider keys are present; prints real latency
pnpm eval:walk-replays  # validate every reviewed redacted walk outcome fixture
make -C desktop test  # native macOS agent unit tests (not included in pnpm test)
```

The first Playwright run also needs `pnpm --filter @ghost/e2e exec playwright install chromium`. The standalone demo smoke test expects the preview server to already be running, then runs with `node e2e/scripts/smoke-demo.mjs`.

## Keys

The implemented offline form path and server endpoints have deterministic fallbacks when keys are missing. Copy `.env.example` to `.env` to enable live model providers. On the audited developer machine, direct TypeSafe/Jev, Baseten, xAI, Browserbase and Composio keys are present; no Sentry DSN is present yet. A live 12-field Jev decision and the complete three-action atomic workflow passed with calibrated TypeSafe/Jev choices. The extension and desktop both use the local server while retaining local fallback. Never commit `.env`.

### Sentry on the demo site

The demo site reports to the Sentry project `ghost-web`: errors, tracing, logs and Session Replay. It reads one build-time variable, `VITE_SENTRY_DSN` (see `demo/.env.example`); a local build also accepts `SENTRY_WEB_DSN` from the repo-root `.env`, which is the name the server already uses. With no DSN the demo initialises no SDK at all - no replay, no spans, no network - so tests and a plain `pnpm dev` stay offline.

What it sends, and only this: a replay with **every input masked** and every password, card and `data-ghost-sensitive` element blocked; two custom spans, `ghost.demo.form-ready` and `ghost.demo.first-ghost`, carrying field counts and durations; and log lines that say a form was ready, a ghost appeared, or that none did. Query strings, request bodies, console breadcrumbs, user identity and any attribute outside the allowlist in `demo/src/observability.ts` are stripped before an event leaves the browser (`pnpm --filter @ghost/demo test`). One gap the SDK does not let us close: rrweb records `location.href` into the replay's meta frame before any callback runs, so a query string typed into the address bar reaches that single field. Do not put a value in a demo URL; the site itself only ever uses `?reset=1`.

## Run Shabang in the background (macOS)

Shabang can start at login and stay out of the way: no terminal, no `pnpm dev`. Two per-user LaunchAgents do it.

| LaunchAgent | What runs | Restart policy |
| --- | --- | --- |
| `dev.ghost.server` | The prediction server on `http://127.0.0.1:8787` (loopback only), as one bundled file: `~/Library/Application Support/Ghost/server/server.mjs`, started by `ghost-server.sh` with an absolute `node` path. No pnpm, tsx or repo needed at run time. | `KeepAlive`, at most one restart every 10 s |
| `dev.ghost.desktop` | Shabang Desktop, the native menu-bar agent (`~/Applications/Ghost.app`) that draws ghosts in Safari, Chrome, Arc, Firefox, Electron and native apps. See `desktop/README.md`. | `RunAtLoad`; restarted after a crash only, so **Quit** in the menu stays quit |

**Install.** Run it yourself (it adds login items, so no agent or CI ever runs it). Never with `sudo`: the script refuses to run as root.

```bash
scripts/install-background.sh --dry-run   # prints every action and the rendered plists, changes nothing
scripts/install-background.sh             # build, install, start
```

It builds the server bundle (`pnpm --filter @ghost/server bundle`, i.e. `node server/build.mjs` -> `server/dist/server.mjs`) and `make -C desktop app`, copies the bundle to `~/Library/Application Support/Ghost/server/`, copies `Ghost.app` to `~/Applications/` **only if it is not there yet**, runs `make -C desktop install-lib`, writes the two plists to `~/Library/LaunchAgents/`, and loads them with `launchctl bootout` (errors ignored) followed by `launchctl bootstrap gui/$UID`. Options: `--server-only`, `--desktop-only`, `--launch-via-open`, `--render-to DIR` (render and lint the plists into a directory, touch nothing else).

**Permission (once, by hand).** System Settings -> Privacy & Security -> Accessibility -> switch **Shabang** on (`~/Applications/Ghost.app`). Shabang notices within two seconds; nothing to restart. No script here grants, resets or edits privacy permissions. macOS ties the grant of an ad-hoc signed app to its exact code, which is why the installer **never overwrites an existing `~/Applications/Ghost.app`**: the app is a tiny stable host, and updates arrive through `libghost.dylib` next to your profile (`docs/desktop-realworld.md`, section 1):

```bash
make -C desktop install-lib && launchctl kickstart -k gui/$(id -u)/dev.ghost.desktop
```

The agent starts the binary inside `Ghost.app` directly. A launchd job is its own "responsible process" for macOS privacy checks (unlike a binary started from a terminal, which is attributed to the terminal), and macOS identifies it by the enclosing bundle, so the grant you give `Ghost.app` applies; launchd also owns the real process, so stopping and crash restarts work. If a future macOS still reports "Needs Accessibility permission" after the grant, reinstall with `--launch-via-open`, which starts the app through LaunchServices (`/usr/bin/open -W -n`) exactly like a double click.

**Keys.** The background server never reads the repo's `.env`. On the first install, `~/.config/ghost/env` (mode 0600, directory 0700) is created from the lines of `.env` whose names are on a fixed allowlist (`XAI_API_KEY`, `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, `BASETEN_*`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `COMPOSIO_API_KEY`, `GHOST_PUBLIC_DEMO_URL`); nothing is echoed and an existing file is never overwritten. The wrapper exports it as data (it is never evaluated as shell), so no key appears in a plist or in `launchctl print`. With no keys Shabang runs on the offline heuristic. After editing the file: `launchctl kickstart -k gui/$(id -u)/dev.ghost.server`.

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

**Coexistence with the extension.** The extension and Shabang Desktop share the one server on `:8787`. The extension sends a presence heartbeat every 30 s; Shabang Desktop skips any browser whose heartbeat is fresher than 90 s and says so in its menu ("Chrome: handled by the extension"), so you never get two ghosts on one field. Browsers without the extension (Safari, Firefox) and native apps are handled by Shabang Desktop. While the background server is loaded it owns port 8787: `pnpm dev` cannot start a second one, and `pnpm e2e` would reuse it (with your real keys) instead of the offline heuristic. For development, unload it first:

```bash
launchctl bootout gui/$(id -u)/dev.ghost.server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.ghost.server.plist   # back on
```

**Privacy.** Everything runs on your Mac and the server listens on loopback only. What leaves the machine is what the configured model provider needs: field labels and the *names* of your profile facts for mapping (never their values), and for free-text answers only the relevant non-sensitive facts. Password, card, government ID and sensitive-labelled fields are never captured, predicted, filled, cached or logged. Locked actions (submit, send, pay, delete) are never pressed by Shabang. Your profile lives in `~/Library/Application Support/Ghost/profile.json` (mode 0600) and nothing is written to the repo. Pause Shabang for any app from the menu-bar icon, or toggle it with Alt+Shift+G.

## Terminal ghost

Shabang also predicts your next shell command in zsh and shows it as gray text after the cursor: after `git add -A` the line already says `git commit -m ""`, Tab puts it on the line with the cursor inside the quotes, and Enter stays yours (Shabang never runs anything). Tab keeps completing as before whenever no ghost is visible; Right arrow at the end of the line also accepts; Esc dismisses.

```bash
pnpm --filter @ghost/server start                          # the server on :8787 (or the background LaunchAgent above)
echo 'source /path/to/htn2026/terminal/ghost.zsh' >> ~/.zshrc  # add it yourself, after plugins that bind Tab
```

The server builds candidates in code (what followed your last command before, git-aware next steps like `git push` when the branch is ahead, a rerun after a failed test, `package.json` scripts and `Makefile` targets) and asks Jev to pick one in a single call (measured 491 ms, confidence 0.89 for `git commit -m ""` after `git add -A`); without a key a local heuristic answers. Only the directory's basename is sent, secret-looking history lines are dropped in the shell and again on the server, destructive commands (`rm -rf`, force pushes, `sudo`, `DROP TABLE`, ...) are never suggested, and a server that is down is a silent no-op. Works in iTerm2 and Terminal.app; Warp replaces zsh's line editor, so ZLE plugins (this one and zsh-autosuggestions alike) do not render there. Details, privacy and compatibility: [`terminal/README.md`](terminal/README.md). Test it with `pnpm test:terminal`.

## Layout

```
shared/      types and pure logic shared by the extension and the server (field mapping, value resolution, safety rules)
extension/   Chrome MV3 extension (content script, background worker, options page)
server/      Hono prediction service on http://localhost:8787
demo/        local demo sites on http://localhost:5173
e2e/         Playwright tests that load the built extension
desktop/     native macOS menu-bar form agent (separate Makefile build and tests)
terminal/    zsh plugin that ghosts your next shell command (ghost.zsh) and its pty tests
docs/        media and diagrams
```
