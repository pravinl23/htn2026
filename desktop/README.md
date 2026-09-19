# Ghost Desktop (macOS)

A menu-bar agent that runs in the background and brings Ghost to **every** browser and app that exposes
an accessibility tree: Safari, Chrome, Arc, Firefox, Edge, Electron apps, native apps. Same prediction
server, same mapping rules as the Chrome extension (the shared TypeScript logic runs inside the app through
JavaScriptCore). Design: [`docs/desktop.md`](../docs/desktop.md).

Objective-C (ARC) + clang + a Makefile. No Xcode project, no Swift (the Swift toolchain on this machine
does not match the SDK).

## Current status

The native form agent and its offline/server-upgraded prediction path are implemented and unit-tested (199 native tests): capture, overlay rendering, Tab/Escape state, verified writes, form caching and streamed text drafts. The stable host + hot-swappable library split and the `ghostctl` harness (`trust`, `dump`, `dump-tree`, `autotab`) exist, and the host at `~/Applications/Ghost.app` holds a live Accessibility grant: `ghostctl trust` and `ghostctl dump-tree` have run trusted against a real Greenhouse page in Safari. Not yet done: real-page capture (Safari nests the web area inside its tab group, which the tree walk currently skips), file upload through the open panel, react-select comboboxes, and a recorded end-to-end run. The server now exposes `/v1/presence`; the extension heartbeat is not wired yet, so do not run both clients in the same browser.

## Build: a host that never changes, a library that always can

macOS ties the Accessibility grant of an ad-hoc signed app to its **code hash**. A monolithic app would lose the
grant on every rebuild, so Ghost is two pieces (design: [`docs/desktop-realworld.md`](../docs/desktop-realworld.md) section 1):

| Piece | Built from | Rebuilt |
| --- | --- | --- |
| `build/Ghost.app` (the **host**) | `host/main.m` only: `dlopen` the library, call `GhostMain`. About 60 lines. | **Once.** Its hash carries the grant. |
| `build/libghost.dylib` (+ `build/ghost-core.js` beside it) | every `src/*.m` | As often as you like. It lives OUTSIDE the bundle, so the bundle's seal never changes. |

```sh
pnpm install                 # once, at the repo root (the core bundle borrows the workspace's esbuild)
make -C desktop app          # core + host + lib. The host is built ONLY if build/Ghost.app does not exist yet.
make -C desktop lib          # just the library: the everyday rebuild. Never touches the host.
make -C desktop test         # plain test runner (links the sources, not the dylib), exits non-zero on failure
make -C desktop run          # open -n build/Ghost.app with GHOST_LIB=build/libghost.dylib
make -C desktop install-lib  # copy the library + ghost-core.js to ~/Library/Application Support/Ghost/
```

Other targets: `core`, `host`, `selftest`, `trust`, `dump`, `clean`. `make clean` removes objects, the library and the
tests but **keeps `build/Ghost.app`**. Every `src/*.m` and every `tests/test_*.m` is picked up by wildcard, so a new
module only has to be dropped into the folder.

`make host-force` is the one target that rebuilds the host, and with it **throws the Accessibility grant away**.
Before you ever run it, look at what is there: `codesign -dv --verbose=4 build/Ghost.app 2>&1 | grep CDHash`, and
read `build/HOST_IS_FINAL.txt` if it exists. If that hash is one somebody already granted, do not rebuild: there is
no way to get the same hash back.

Where the host looks for the library, in order: `$GHOST_LIB` (when set, the only candidate), then
`~/Library/Application Support/Ghost/libghost.dylib`, then `libghost.dylib` next to `Ghost.app`, then the path written in
`~/Library/Application Support/Ghost/lib-path.txt` (used when this macOS has no `open --env`). A missing library, or one
without the `GhostMain` symbol, is a clear message on stderr, an alert when there is no terminal, and an
`{ "error": "library not loaded" }` answer when the launch carried `--out`. The library loads `ghost-core.js` from beside
itself first and from the bundle's Resources only as a fallback.

Requirements: macOS 13 or later, the Command Line Tools (`xcode-select --install`), Node 22.

## First run: the Accessibility permission

Ghost reads the fields of the frontmost window and types into them through the macOS Accessibility API.
macOS only allows that for apps the user has approved, and **only you can approve it**:

0. `make -C desktop app` **once**. From here on only ever `make lib`.
1. `make -C desktop run`. A small ghost appears in the menu bar. There is no Dock icon.
2. macOS shows "Ghost would like to control this computer using accessibility features". Click **Open System Settings**
   (or use the menu item **Open Accessibility Settings...**).
3. In **Privacy & Security -> Accessibility**, switch **Ghost** on.
4. Nothing to restart: Ghost polls every 1.5 s and the menu flips from "Needs Accessibility permission" to "On".

Until step 3 every Accessibility call returns `kAXErrorAPIDisabled` (-25211). Ghost does nothing else in that
state: no capture, no event tap, no overlay.

**Build the host once, grant once, rebuild the library freely.** The grant belongs to the host's code hash, and
`make lib` / `make app` / `make clean` never change it (check: the `CDHash=` line of `codesign -dv --verbose=4
build/Ghost.app` is the same before and after). Only `make host-force` changes it. If the grant is lost anyway (the
menu says "Needs Accessibility permission" although Ghost is listed and switched on): remove Ghost.app from the list
with the **-** button, then add it again with **+**. Toggling is not always enough for an ad-hoc signed app.

Always start Ghost through LaunchServices (`make run`, `tools/ghostctl run`, Finder), never as
`build/Ghost.app/Contents/MacOS/Ghost` from a shell: macOS judges a binary started from a terminal by the
**terminal's** permissions, so it looks untrusted (or trusted) for the wrong reason.

## The menu

| Item | Meaning |
| --- | --- |
| **Enabled** (Alt+Shift+G) | Master switch. Same setting as `settings.json` `enabled`. |
| status line | `Needs Accessibility permission`, `Off`, `On: heuristic only (server offline)`, `On: <provider>, <latency> ms` |
| **Server: ...** | Provider reported by `GET /v1/health`, or `offline` with a short reason (`unreachable`, `timeout`...) |
| **<Browser>: handled by the extension** | Planned coordination state. The UI/client parser exists, but no server presence route or extension heartbeat currently supplies it. |
| **Pause in <app> / Resume in <app>** | Per-app pause, stored in `settings.json` `pausedBundleIds` |
| **Never runs in <app>** | Built-in list: terminals, password managers, Keychain Access, System Settings, Ghost itself |
| **Open profile.json / settings.json / demo / log** | |

## Files

| Path | What |
| --- | --- |
| `~/Library/Application Support/Ghost/profile.json` | `{ "facts": { "firstName": "...", ... }, "pastAnswers": [] }`. Seeded with the fictional demo profile (Alex Chen). Mode 0600. Edit it in any editor: Ghost reloads within a second. A file that is not valid JSON is ignored (the last good profile stays active) and never overwritten. |
| `~/Library/Application Support/Ghost/settings.json` | `enabled`, `confidenceThreshold` (clamped to 0.5...0.99), `serverUrl`, `showHud`, `learningEnabled`, plus `pausedBundleIds`. Mode 0600. |
| `~/Library/Application Support/Ghost/form-cache.json` | Per-window form mappings, so a repeat visit makes zero server calls. Hashed keys, fact **keys** and confidences only, never values. Mode 0600. Safe to delete. |
| `~/Library/Logs/Ghost/desktop.log` | Numbers, names and truncated labels. Never a field value, never a profile value. Rotates at 2 MB. |

## What leaves the process

Only requests to the local prediction server (`settings.serverUrl`, default `http://localhost:8787`):

- `POST /v1/predict/form`: field labels/kinds/options and profile fact **keys**. Never a profile value, never what is
  typed in a field, never a sensitive field (not even its label), never buttons or links.
- `POST /v1/ghost-text`: the question's label and an allowlist of facts (name, school, degree, major, graduation date,
  location, GitHub, website). Email, phone, LinkedIn, work authorization and sponsorship are never sent.
- `GET /v1/health`. The client also attempts `GET /v1/presence`, but that server route is not implemented yet.

With the server down Ghost still works: the keyword heuristic runs in-process.

## ghostctl: the test and debug harness (no mouse)

`tools/ghostctl` wraps `open -n -g build/Ghost.app --args ...`, waits for the `--out` file and prints it. A
LaunchServices launch has no stdout, which is why every answer travels through a file.

```sh
tools/ghostctl trust                               # { "trusted": bool, "pid", "library" }
tools/ghostctl dump --frontmost Safari             # captured fields: labels, kinds, options, rects, locked. NO values.
tools/ghostctl dump-tree --frontmost Safari --depth 60 --out /tmp/tree.json   # raw AX tree, values -> their length
tools/ghostctl autotab 30 --interval 450           # 30 real Tab presses through Ghost, one record per press
tools/ghostctl run | quit | log [LINES] | selftest
```

Options: `--frontmost "App"` (name or bundle id; the run fails with `frontmost-failed` rather than look at the wrong
window), `--delay S`, `--interval MS`, `--depth N`, `--out FILE`, `--timeout S`. Exit status: 0 an answer without an
error, 1 an answer with `"error"`, 2 no answer, 64 usage.

- **Untrusted:** every mode answers `{ "error": "not trusted", "trusted": false }` at once. Nothing waits out a delay,
  nothing prompts, nothing hangs.
- **`autotab`** posts real, untagged Tab events, so they pass through Ghost's own event tap exactly like yours. Before
  every press it re-reads the walk and stops with `inactive`, `locked`, `count`, `no-ghost`, `stalled` (three presses in
  a row Ghost did not consume) or `timeout`. It **refuses to press Tab while the current ghost is locked**
  (`"stopped": "locked"`, `"lockedLabel"`), and Tab is the only key the harness can post at all: never Return, Enter
  or Space. Each step records `ghost`, `action`, `consumed`, `outcome`, `verified`, `ms`.
- **`dump-tree`** never contains an AXValue: `valueLength` stands in for it, and secure or sensitive-looking fields
  get `"sensitive": true` and not even a length. Page text (AXStaticText) is kept so labels stay readable; anything
  that looks like an e-mail address or a phone number becomes `[redacted:N]`.
- **A running agent answers.** A second `open -n` instance shares nothing with the agent in the menu bar, so `dump`,
  `dump-tree` and `autotab` are handed to it as a JSON file in `~/Library/Application Support/Ghost/harness/requests/`
  and it writes `--out`. With no agent running they run in the launched process (`autotab` then starts the whole
  pipeline for the length of the run). Paused apps (terminals, password managers...) answer `paused-app`.
- Every run appends a line to `~/Library/Logs/Ghost/desktop.log`: mode, id, app, counts. Never a value.

`Ghost --selftest` is the one mode that is fine to run directly (`tools/ghostctl selftest`): it needs no permission.

Environment: `GHOST_LOG_STDERR=1` mirrors the log to stderr, `GHOST_NO_PROMPT=1` skips the permission dialog at
launch, `DESKTOP_CORE_PATH=/path/ghost-core.js` loads another core bundle (the tests use it).

## Layout

```
core/entry.ts        the GhostCore bridge: strings in, JSON strings out
core/predict.ts      port of the pure rules of extension/src/content/predict.ts (see "Keeping in step")
core/build-core.mjs  esbuild bundle + verification in a bare VM (no DOM, no Node)
src/GHField          shared model of one captured element (CapturedField + the live AXUIElementRef)
src/GHCore           JavaScriptCore bridge, typed wrappers, fails closed on the safety probes
src/GHProfileStore   profile.json / settings.json, 0600, file watching, pause list
src/GHServerClient   predict/form, ghost-text (SSE, delegate based), health, presence, form cache
src/GHLog            file log
src/GHAccessibility  trust, frontmost app, AXObserver -> one debounced "needs rescan", pause list, Chromium/Electron web tree
src/GHCapture        AX tree of the focused window -> GHFields (reading order, labels, signatures, sensitive exclusion)
src/GHWalkState      PURE walk state machine + the Tab / Escape rule (GHDecideTab, GHDecideEscape)
src/GHController     capture -> offline ghosts -> cache/server upgrade (once per form) -> drafts over SSE -> overlay; accept queue
src/GHEventTap       session-level CGEventTap on its own thread; reads a lock-free snapshot, consumes only Ghost's Tab/Escape
src/GHWriter         the accept path: AXValue -> verify -> AXSelectedText -> real typing -> verify; AXPress for choices; never a lock
src/GHOverlay*       click-through panels, Core Animation drawing, pure view-model
src/GHAppDelegate    status item (live), trust polling, hotkey, drives the pipeline through GHDesktopPipeline
src/GHHarness        --trust / --dump / --dump-tree / --autotab: request encoding, file channel, tree redaction, Tab-only poster
src/GhostMain.m      `int GhostMain(int, const char **)`: the library's one exported entry point (agent, harness, selftest)
host/main.m          the host: dlopen + GhostMain and nothing else. Do not edit: a rebuilt host loses the grant
tools/ghostctl       shell wrapper around the harness
tests/               GHTest.h (tiny macros), main.m (runner), test_*.m
tools/               overlay-demo (make overlay-demo / overlay-demo-offscreen)
```

## How a Tab travels

1. `GHController` rescans on (debounced) AX notifications: capture, offline ghosts from the core, render. It then
   publishes a snapshot (8 flags: active, has a current ghost, visible, locked, pending, focus in the walk, focus on a
   field, write in flight) into one atomic word.
2. `GHEventTap` runs on its own thread. For a key-down it reads that word, runs `GHDecideTab` (pure, in
   `GHWalkState.m`) and either returns the event untouched or consumes it and tells the controller on the main queue.
   It never calls AX. Shift+Tab, modified Tab, a hold that started as a native Tab, focus in a control outside the
   walk, a current ghost that is not on screen: all native. Events Ghost posts itself carry a magic
   `kCGEventSourceUserData` and are ignored.
3. The controller re-reads where focus is (the snapshot can be a few ms old). If the user has left the walk in the
   meantime, the Tab is handed back to the app (a tagged synthetic Tab). Otherwise `GHWriter` re-checks the element
   (secure? sensitive? has a value? still there?), writes, reads back, and the walk advances or stops with a reason.
4. A locked ghost is never pressed: focus moves onto it, the rest of the hold is swallowed, Enter is the user's.

The typing fallback never sends a control character: a line break in a draft is typed as a space, because an Enter in
the wrong field submits a form.

## Keeping in step with the extension

`core/predict.ts` is a copy of the pure part of `extension/src/content/predict.ts` (threshold gating, skip filled
fields, placeholder choices, sensitivity re-check, tick-only checkboxes, lock ghost last, `upgradeGhosts`). It stays
separate because the native bridge runs the shared rules through JavaScriptCore while the extension operates on DOM
elements. When a rule changes there, change it here; `tests/test_core.m` pins each rule through the real bundle in JavaScriptCore.
`textFacts` and `formRequest` in `core/entry.ts` are currently Desktop-only server-client policies. The Chrome extension has no equivalent client yet; extract these policies into shared code when adding one.

## Tests

`make test` builds `build/ghost-tests` and runs it with `DESKTOP_CORE_PATH` pointing at the fresh bundle.
`build/ghost-tests core_` runs only the tests whose name contains `core_`. Nothing in the suite needs the
Accessibility permission, a network or the real `~/Library`: the server client runs against a stub `NSURLProtocol`
and the store in a temp directory.

Writing one:

```objc
#import "GHTest.h"
GH_TEST(thing_does_what_it_says) {
    GH_ASSERT(condition);
    GH_ASSERT_EQUAL_OBJECTS(actual, (@[ @1, @2 ]));   // wrap literals that contain commas
}
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `core: FAILED: esbuild not found` | `pnpm install` at the repo root. |
| Menu says "Core bundle missing" | `make -C desktop core lib` (the library reads `ghost-core.js` from beside itself). |
| "Needs Accessibility permission" after a rebuild | `make lib` cannot cause this; somebody rebuilt the host (`make host-force`, or deleted `build/Ghost.app`). Remove Ghost.app with **-** and re-add it with **+** under Privacy & Security -> Accessibility. |
| `ghostctl trust` says `"trusted": false` | The grant belongs to another code hash. Compare `codesign -dv --verbose=4 build/Ghost.app` with the copy you granted; then remove and re-add as above. |
| `Ghost: libghost.dylib not found` / `has no GhostMain symbol` | `make -C desktop lib`. The message lists every path the host tried; `GHOST_LIB=/abs/path` overrides them all. |
| `ghostctl` prints `no answer ... after Ns` | The host never started. `tools/ghostctl log`, and check that `build/Ghost.app` exists (`make -C desktop app`). |
| `"error": "agent-not-responding"` | A Ghost that predates the harness is running. `tools/ghostctl quit`, then `tools/ghostctl run`. |
| No ghosts in Chrome/Arc/Electron | Those apps build their web accessibility tree on demand. Ghost asks for it (`AXEnhancedUserInterface`, `AXManualAccessibility`); give the page a second, or check `tools/ghostctl dump`. |
| No ghosts in a browser that has the extension | Intended: the menu shows "<Browser>: handled by the extension". Disable the extension there to let Desktop take over. |
| "Server: offline (unreachable)" | Start it: `pnpm --filter @ghost/server dev`. Ghost keeps working with the in-process heuristic. |
| Menu says "Keyboard tap unavailable" | The system refused the event tap: same permission problem as above. Ghost retries every 5 s; Tab stays native meanwhile. |
| Ghosts show but Tab does nothing | Tab is only Ghost's while focus is in the walk (the ghosted field, the field just left, or the page itself) and the current ghost is on screen. Click the ghosted field. The log (`controller:` / `writer:` lines, never values) says what happened. |
| "Ghost could not fill this field (did-not-hold)" | The app reverted AXValue, AXSelectedText and typed input. The walk stops there by design; the next ghost still works. |
| Alt+Shift+G does nothing | Another app owns the shortcut; the log says `could not register the Alt+Shift+G hotkey`. Use the menu. |
| Two ghosts in the menu bar | A second copy exits on its own; if one is stuck: `pkill -f "Ghost.app/Contents/MacOS/Ghost"`. |
