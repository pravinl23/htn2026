# Ghost Desktop (macOS)

A menu-bar agent that runs in the background and brings Ghost to **every** browser and app that exposes
an accessibility tree: Safari, Chrome, Arc, Firefox, Edge, Electron apps, native apps. Same prediction
server, same mapping rules as the Chrome extension (the shared TypeScript logic runs inside the app through
JavaScriptCore). Design: [`docs/desktop.md`](../docs/desktop.md).

Objective-C (ARC) + clang + a Makefile. No Xcode project, no Swift (the Swift toolchain on this machine
does not match the SDK).

## Current status

The native form agent and its offline/server-upgraded prediction path are implemented and have 167 passing tests. This covers capture, overlay rendering, Tab/Escape state, verified writes, form caching and streamed textarea drafts under stubs. It has **not** been included in the root pnpm verification gate or re-run against real browsers/apps with a live Accessibility grant during the 2026-09-19 audit.

Extension/desktop coordination is incomplete: the client contains presence polling, but the server does not expose `/v1/presence` and the extension sends no heartbeat. Do not run both clients in the same browser expecting automatic deduplication. Learned loops, invoice batching, file uploads and the Greenhouse/autotab harness are not native-agent features today.

## Build

```sh
pnpm install                 # once, at the repo root (the core bundle borrows the workspace's esbuild)
make -C desktop core         # @ghost/shared -> desktop/build/ghost-core.js (fails loudly on a missing export)
make -C desktop app          # desktop/build/Ghost.app, ad-hoc signed
make -C desktop test         # plain test runner, exits non-zero on failure
make -C desktop run          # open build/Ghost.app
```

Other targets: `selftest`, `trust`, `dump`, `clean`. Every `src/*.m` and every `tests/test_*.m` is picked up
by wildcard, so a new module only has to be dropped into the folder.

Requirements: macOS 13 or later, the Command Line Tools (`xcode-select --install`), Node 22.

## First run: the Accessibility permission

Ghost reads the fields of the frontmost window and types into them through the macOS Accessibility API.
macOS only allows that for apps the user has approved, and **only you can approve it**:

1. `make -C desktop run`. A small ghost appears in the menu bar. There is no Dock icon.
2. macOS shows "Ghost would like to control this computer using accessibility features". Click **Open System Settings**
   (or use the menu item **Open Accessibility Settings...**).
3. In **Privacy & Security -> Accessibility**, switch **Ghost** on.
4. Nothing to restart: Ghost polls every 1.5 s and the menu flips from "Needs Accessibility permission" to "On".

Until step 3 every Accessibility call returns `kAXErrorAPIDisabled` (-25211). Ghost does nothing else in that
state: no capture, no event tap, no overlay.

**A rebuild can undo the approval.** The app is ad-hoc signed, so its code hash changes with every build and
macOS may treat the new build as a different app. If the menu says "Needs Accessibility permission" although
Ghost is listed and switched on: remove Ghost from the list with the **-** button, then add it again (or toggle
it off and on).

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

## Command-line modes

```sh
build/Ghost.app/Contents/MacOS/Ghost --selftest   # core + mapping on a built-in form, PASS/FAIL. No permission needed.
build/Ghost.app/Contents/MacOS/Ghost --trust      # is this binary trusted for Accessibility? exit 0 / 1
build/Ghost.app/Contents/MacOS/Ghost --dump       # 3 s to focus a window, then its captured fields as JSON (labels only)
```

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
src/main.m           entry point and CLI modes
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
| Menu says "Core bundle missing" | `make -C desktop core app`. |
| "Needs Accessibility permission" after a rebuild | Remove and re-add Ghost under Privacy & Security -> Accessibility (the ad-hoc signature changed). |
| `--dump` prints `AX calls return -25211` | Same: the binary you run must be the approved one (`build/Ghost.app`). |
| No ghosts in Chrome/Arc/Electron | Those apps build their web accessibility tree on demand. Ghost asks for it (`AXEnhancedUserInterface`, `AXManualAccessibility`); give the page a second, or check `--dump`. |
| No ghosts in a browser that has the extension | Intended: the menu shows "<Browser>: handled by the extension". Disable the extension there to let Desktop take over. |
| "Server: offline (unreachable)" | Start it: `pnpm --filter @ghost/server dev`. Ghost keeps working with the in-process heuristic. |
| Menu says "Keyboard tap unavailable" | The system refused the event tap: same permission problem as above. Ghost retries every 5 s; Tab stays native meanwhile. |
| Ghosts show but Tab does nothing | Tab is only Ghost's while focus is in the walk (the ghosted field, the field just left, or the page itself) and the current ghost is on screen. Click the ghosted field. The log (`controller:` / `writer:` lines, never values) says what happened. |
| "Ghost could not fill this field (did-not-hold)" | The app reverted AXValue, AXSelectedText and typed input. The walk stops there by design; the next ghost still works. |
| Alt+Shift+G does nothing | Another app owns the shortcut; the log says `could not register the Alt+Shift+G hotkey`. Use the menu. |
| Two ghosts in the menu bar | A second copy exits on its own; if one is stuck: `pkill -f "Ghost.app/Contents/MacOS/Ghost"`. |
