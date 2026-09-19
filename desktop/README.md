# Ghost Desktop (macOS)

A menu-bar agent that runs in the background and brings Ghost to **every** browser and app that exposes
an accessibility tree: Safari, Chrome, Arc, Firefox, Edge, Electron apps, native apps. Same prediction
server, same mapping rules as the Chrome extension (the shared TypeScript logic runs inside the app through
JavaScriptCore). Design: [`docs/desktop.md`](../docs/desktop.md).

Objective-C (ARC) + clang + a Makefile. No Xcode project, no Swift (the Swift toolchain on this machine
does not match the SDK).

## Current status

`make -C desktop core lib test`: 319 native tests, 0 failures, zero compiler warnings (2026-09-19, after the first live
Safari run and the three fixes it forced).

**Verified LIVE in Safari** (2026-09-19, 18:00-18:20 EDT, granted host `~/Applications/Ghost.app`, real Jev/TypeSafe server,
the real Greenhouse posting `job-boards.greenhouse.io/viamrobotics/jobs/6185046004`, the fictional Alex Chen profile):

- **The whole Tab walk, with nothing but Tab**: `ghostctl autotab 30 --interval 700 --frontmost Safari` posted **11 real Tab
  presses in 13.8 s** and stopped itself with `"stopped": "locked"`, parked on **Submit application** (`Parked on the locked
  action in Safari (Enter confirms)`). **8 accepted**: First Name, Last Name, Email, Phone, LinkedIn Profile, Github, Website
  (AXValue + read-back, 67 to 157 ms each) and **Resume/CV through the real macOS open panel** (Attach, Command+Shift+G, the
  path only in the go-to field, 3.65 s). Nothing was submitted; **Submit was never pressed**, and the harness refuses to Tab
  past a locked ghost.
- **Untouched, as designed**: the US work-authorization question and all four EEO questions (Gender, Hispanic/Latino, Veteran
  Status, Disability Status) were never focused, typed into or opened. The phone widget's Country combobox already had a
  value, so it was refused with `combobox-has-value`.
- **Independently checked afterwards** with `ghostctl dump-tree` (values reduced to their length): First Name 4, Last Name 4,
  Email 25, Phone 15, LinkedIn 36, Github 31, Website 20 characters; the resume widget shows `resume-alex-chen.pdf` and a
  **Remove file** button; every EEO and work-authorization combobox still empty. Saved as
  `docs/media/desktop-greenhouse-autotab.json` and `docs/media/desktop-greenhouse-final-form.json`.
- **Capture**: 31 fields out of 377 nodes in 142 to 248 ms, **complete** (`"partial": false`), form signature stable across
  rescans. `/v1/predict/form` through TypeSafe/Jev: 575 ms the first time (10 assignments), then cache hits (2 ms), so each
  Tab after the first is a 2 ms rescan plus the write.
- Earlier: `ghostctl trust` and `ghostctl dump-tree` (433 nodes, about 0.5 s); that dump is the fixture
  `tests/fixtures/greenhouse-safari-viam.json`.

**What the live run fixed** (each with tests over fakes/fixtures):

1. **The 120 ms capture budget was too small for a real posting.** The controller saw 261 to 278 of 377 nodes, 25 to 27
   fields, lost the bottom of the form (the locked Submit with it) and changed the form signature between rescans. A walk that
   has met an `AXWebArea` now gets `GHCaptureLimits.webAreaTimeBudget` (0.6 s) instead; `maxNodes` still bounds it.
2. **React replaced the First Name input while Ghost wrote into it**, and the write was reported `gone` although the value had
   landed. The controller now takes one fresh capture: the new element either already holds the value (accepted) or is written
   once more. Never for a sequence.
3. **Greenhouse names an attached file late, and then takes Attach and the file input out of the page.** One look right after
   the panel closed called a good upload `upload-not-verified`. The check is now repeated (8 x 0.35 s) and also looks at the
   widget node captured before the upload and at a Remove control where the field was.

**Known live gap**: on the "How did you hear about this opportunity at Viam?" react-select, no option list ever appears in the
AX tree after Ghost types the answer, so the field is **skipped cleanly** (`combobox-no-list`: nothing chosen, nothing left
behind, no stray keys, the walk goes on). Whether the typing reaches the react-select input at all is the next thing to look
at. A list that opens and says "No options" is now recognised as an open list and closed with one Escape
(`combobox-no-matching-option`) instead of waiting out the 1.5 s timeout.

**Verified only with fakes and the saved fixture** (still not seen live):

- The whole Tab walk over that fixture (`tests/test_integration.m`): capture -> core -> controller -> writer, with a fake
  page that scrolls, a fake react-select, a fake macOS open panel and a fake keyboard (`GHFakeKeyPoster`: the production
  guard logic over a recording sink). Accept order: the first Tab jumps to First Name (scrolled into view, nothing written),
  then First Name, Last Name, Email, Country (combobox: types "Canada", presses "Canada +1", verifies), Phone, Resume/CV
  (one Tab: Attach, Command+Shift+G, the path typed only into the go-to field, Return, Return on Upload, the page and a fresh
  capture show the file name), LinkedIn Profile, Github, Website, "How did you hear" (Hack the North), and it ends parked on
  the locked Submit application, focused, never pressed.
- Choosing an option in a combobox (live, the only two comboboxes Ghost was allowed to touch were refused: one already had a
  value, the other never showed a list).
- Hold-Tab stops at an upload or combobox ghost without starting it (one fresh press starts it) and never accepts a pending
  draft; any untagged key while the panel or a list is driven aborts the sequence and the keys pressed meanwhile are dropped;
  an upload the widget does not show is a failure; a combobox without the answer is skipped and left as it was.
- The jump: Tab on the page with the current ghost off screen scrolls it into view and writes nothing; a page that scrolls
  smoothly is read again before Ghost gives up; a page that refuses gets the Tab back, and Tab stays native afterwards.
- `GHPageContext` (company, role, posting text) feeds `/v1/ghost-text` for text areas and long questions (stub server).
- Profile file facts (`resumePath`, `coverLetterPath`) are validated on load; `profile.example.json` loads through the store.
- Review fixes (fakes only): every step of a walk re-reads live focus (a queued Tab, a held Tab, the end of a draft wait),
  and only the first step of a fresh press hands its Tab back; focus is moved on after a write only while it is still where
  the write left it, and a lock gets keyboard focus only straight from the user's Tab (never after a draft wait or a
  sequence). During a write Tab is queued only while focus is in the walk (another app or field keeps its Tab). Every key
  post re-reads focus and the app after its guard and asks the driver's user-key flag last. The combobox and popup Escapes
  only go to a list or menu that is really open. Turning Ghost off or losing the permission cancels an upload or combobox
  sequence at once. The open panel's Upload button is read from a fresh panel. Tree walks outside the capture have a
  wall-clock budget and stop at a hung app. Focus whose role cannot be read counts as "somewhere else".

**Checked live in Safari** (the list above): AXPress on Greenhouse's "Attach" really does open the macOS open panel while
Safari stays frontmost, Command+Shift+G focuses its go-to field, the whole upload sequence verifies, AXScrollToVisible
scrolls Safari's page, and the capture budget question is answered (see fix 1).

**Still unchecked**: how WebKit exposes react-select's option list and whether AXPress on an option selects it (the live
posting never showed a list at all); Chrome, Firefox and Arc structures. The server exposes `/v1/presence`; the extension
heartbeat is not wired yet, so do not run both clients in the same browser. Note that `autotab --frontmost Safari` only
makes sure **Safari** is in front, not which tab: check the page with `ghostctl dump` right before a run.

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
make -C desktop install-lib  # a harness-free library + ghost-core.js, read-only, into a 0700 ~/Library/Application Support/Ghost/
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
itself first and from the bundle's Resources only as a fallback, and only the exact file it was built with: `make lib`
embeds its SHA-256, and a different `ghost-core.js` is not loaded (rebuild with `make -C desktop core lib`).
`DESKTOP_CORE_PATH` is honoured by the test runner only.

### Security: the grant covers any code the host loads

The Accessibility grant belongs to `Ghost.app`, and the host loads whatever library it finds: `$GHOST_LIB`, then the
user-writable lookup paths above, and (ad-hoc signed, no hardened runtime) `DYLD_INSERT_LIBRARIES` too. So **any process
running as you can borrow the grant**: read every window, post keystrokes. Until the host is rebuilt with a Developer ID,
the hardened runtime, library validation and no `GHOST_LIB` (do that together with the next re-grant that is needed
anyway; it cannot be done without one):

- Switch Ghost off in System Settings -> Privacy & Security -> Accessibility when you are not developing with it, and
  never install it on a shared or untrusted machine.
- `make install-lib` builds the installed copy **without the harness** (no `--dump`, `--dump-tree`, `--autotab`, no
  request folder), installs it and `ghost-core.js` read-only (0444) into a 0700 folder it checks is yours without an ACL,
  removes `lib-path.txt`, refuses when `launchctl getenv` has `GHOST_LIB`, `DYLD_INSERT_LIBRARIES` or `DESKTOP_CORE_PATH`
  or when a `libghost.dylib` sits next to `~/Applications/Ghost.app`, and prints the library's CDHash and the core's SHA-256.
- The library only loads the `ghost-core.js` it was built with (its SHA-256 is compiled in): that JavaScript is where the
  fact allowlist and the wire filters live.
- These checks catch misconfiguration only. `GHOST_LIB` or `DYLD_INSERT_LIBRARIES` set by another process still get past
  them, and the developer library (`make lib`, used with `GHOST_LIB` and `tools/ghostctl`) keeps the harness, which any
  process running as you can drive through its request folder or `open -n Ghost.app --args ...`.

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
| `~/Library/Application Support/Ghost/profile.json` | `{ "facts": { "firstName": "...", ... }, "pastAnswers": [] }`. Seeded with the fictional demo profile (Alex Chen). Mode 0600. Edit it in any editor: Ghost reloads within a second. A file that is not valid JSON is ignored (the last good profile stays active) and never overwritten. Optional `resumePath` / `coverLetterPath`: see `profile.example.json` below. |
| `desktop/profile.example.json` | Documented example: the fictional demo profile plus `"resumePath": "~/Projects/htn2026/demo/fixtures/resume-alex-chen.pdf"` (the fictional resume in this repo; adjust for your checkout). File facts are validated on every load: an absolute path (`~/` expanded) to an existing, readable, regular pdf/doc/docx/rtf/txt/odt/pages file under 25 MB, no `..`, no control characters; anything else is dropped and the log names only the key and a reason code. Paths never leave the machine, and the HUD shows the file name only. |
| `~/Library/Application Support/Ghost/settings.json` | `enabled`, `confidenceThreshold` (clamped to 0.5...0.99), `serverUrl`, `showHud`, `learningEnabled`, plus `pausedBundleIds`. Mode 0600. |
| `~/Library/Application Support/Ghost/form-cache.json` | Per-window form mappings, so a repeat visit makes zero server calls. Hashed keys, fact **keys** and confidences only, never values. Mode 0600. Safe to delete. |
| `~/Library/Logs/Ghost/desktop.log` | Numbers, names and truncated labels. Never a field value, never a profile value. Rotates at 2 MB. |

## What leaves the process

Only requests to the local prediction server (`settings.serverUrl`, default `http://localhost:8787`):

- `POST /v1/predict/form`: field labels/kinds/options and profile fact **keys**. Never a profile value, never what is
  typed in a field, never a sensitive field (not even its label), never buttons or links, never an EEO / demographic
  question (by label, section or answer options) and never a demographic fact key (`gender`, `veteranStatus`,
  `dateOfBirth`...). The `origin` is `app://<bundle id>/<page host>`, or `app://<bundle id>` alone: never anything from a
  window title.
- `POST /v1/ghost-text`: the question's label and an allowlist of facts (name, school, degree, major, graduation date,
  location, GitHub, website). Email, phone, LinkedIn, work authorization and sponsorship are never sent. Up to three past
  answers, only to questions similar to this one (the extension's rule), never one to a sensitive, EEO or
  work-authorization question and never one containing an e-mail address or a phone number. For text areas and long
  questions also the posting's company, role and up to 2000 characters of its description (page text, never an input's
  value).
- `GET /v1/health`. The client also attempts `GET /v1/presence`, but that server route is not implemented yet.

With the server down Ghost still works: the keyword heuristic runs in-process.

## ghostctl: the test and debug harness (no mouse)

`tools/ghostctl` wraps `open -n -g build/Ghost.app --args ...`, waits for the `--out` file and prints it. A
LaunchServices launch has no stdout, which is why every answer travels through a file.

```sh
tools/ghostctl trust                               # { "trusted": bool, "pid", "library" }
tools/ghostctl dump --frontmost Safari             # captured fields: labels, kinds, options, rects, locked. NO values.
tools/ghostctl dump-tree --frontmost Safari --depth 60 --out ~/tree.json     # raw AX tree, values -> their length
tools/ghostctl autotab 30 --interval 450           # 30 real Tab presses through Ghost, one record per press
tools/ghostctl run | quit | log [LINES] | selftest
```

Options: `--frontmost "App"` (name or bundle id; the run fails with `frontmost-failed` rather than look at the wrong
window), `--delay S`, `--interval MS`, `--depth N`, `--out FILE`, `--timeout S`. Exit status: 0 an answer without an
error, 1 an answer with `"error"`, 2 no answer, 64 usage. `--out` must be a `.json` name in an existing directory of
yours (never `/tmp`, never through a link): the answer is written 0600 through a private temporary file and a rename, an
old answer is removed only when it is a plain file, and nothing else at that path (a directory, a link) is ever touched.
Without `--out`, ghostctl uses `$TMPDIR` (per user), else `~/Library/Application Support/Ghost/harness`.

- **Untrusted:** every mode answers `{ "error": "not trusted", "trusted": false }` at once. Nothing waits out a delay,
  nothing prompts, nothing hangs.
- **`autotab`** posts real, untagged Tab events, so they pass through Ghost's own event tap exactly like yours. Before
  every press it re-reads the walk and stops with `inactive`, `locked`, `count`, `no-ghost`, `stalled` (three presses in
  a row Ghost did not consume) or `timeout`. It **refuses to press Tab while the current ghost is locked**
  (`"stopped": "locked"`, `"lockedLabel"`), and Tab is the only key the harness can post at all: never Return, Enter
  or Space. Each step records `ghost`, `action`, `consumed`, `outcome`, `verified`, `ms`.
- **`dump-tree`** never contains an AXValue: `valueLength` stands in for it. A secure or sensitive-looking field is only
  `{ role, "sensitive": true }` (no label, no length, no subtree). Window, document and tab titles are never written
  (the AXWindow title, the AXWebArea title and description, the outer AXTabGroup's), browser chrome outside the page
  (toolbars, tab-bar items, the address field) is `{ role, "omitted": "browser-chrome" }`, and text-entry controls and
  chosen-value widgets (react-select's single value) are not entered. Other page text (AXStaticText) is kept so labels
  stay readable; anything that looks like an e-mail address or a phone number becomes `[redacted:N]`.
- **A running agent answers.** A second `open -n` instance shares nothing with the agent in the menu bar, so `dump`,
  `dump-tree` and `autotab` are handed to it as a JSON file in `~/Library/Application Support/Ghost/harness/requests/`
  and it writes `--out`. With no agent running they run in the launched process (`autotab` then starts the whole
  pipeline for the length of the run). Paused apps (terminals, password managers, and every app on your own pause
  list in `settings.json`) answer `paused-app`. The installed library (`make install-lib`) has no harness at all.
- Every run appends a line to `~/Library/Logs/Ghost/desktop.log`: mode, id, app, counts. Never a value.

`Ghost --selftest` is the one mode that is fine to run directly (`tools/ghostctl selftest`): it needs no permission.

Environment: `GHOST_LOG_STDERR=1` mirrors the log to stderr, `GHOST_NO_PROMPT=1` skips the permission dialog at
launch, `DESKTOP_CORE_PATH=/path/ghost-core.js` loads another core bundle in the test runner only (Ghost itself ignores it).

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
src/GHWriter         the accept path: AXValue -> verify -> AXSelectedText -> real typing -> verify; AXPress for choices; uploads and
                     lazy selects through the drivers below; never a lock
src/GHKeyPoster      the only keyboard: every chunk re-checks the frontmost app and the focused element; can never post Space, Tab, keypad Enter
src/GHOpenPanelDriver  upload: press Attach, drive the macOS open panel (go-to sheet), verify the panel closed and the page names the file
src/GHComboBoxDriver   react-select: type the answer, pick an exact / high-confidence option, verify; else Escape, clean up, skip
src/GHPageContext    company / role / posting text of a job page, for drafts
src/GHOverlay*       click-through panels, Core Animation drawing, pure view-model
src/GHAppDelegate    status item (live), trust polling, hotkey, drives the pipeline through GHDesktopPipeline
src/GHHarness        --trust / --dump / --dump-tree / --autotab: request encoding, file channel, tree redaction, Tab-only poster
src/GhostMain.m      `int GhostMain(int, const char **)`: the library's one exported entry point (agent, harness, selftest)
host/main.m          the host: dlopen + GhostMain and nothing else. Do not edit: a rebuilt host loses the grant
tools/ghostctl       shell wrapper around the harness
profile.example.json the documented example profile (fictional Alex Chen + the fictional resume)
tests/               GHTest.h (tiny macros), main.m (runner), test_*.m; test_integration.m walks the real Greenhouse fixture
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
   After every accept the next ghost is focused and, when the page has it off screen, scrolled into view
   (AXScrollToVisible) before it is drawn.
4. A locked ghost is never pressed: focus moves onto it, the rest of the hold is swallowed, Enter is the user's.
5. **The jump.** When ghosts exist but the current one is off screen (a long job posting above the form) and focus is on
   the page, Tab scrolls it into view and writes nothing; the next Tab accepts. If the page cannot bring it on screen, that
   Tab goes back to the app and later ones stay native: Ghost never traps the key.
6. **Sequences.** An `upload` ghost (one Tab: Attach, then the open panel through `GHOpenPanelDriver`, HUD "Picking
   <file>") and a lazy select on a web combobox (`GHComboBoxDriver`) post keys, always through `GHKeyPoster`, whose guard
   re-reads the frontmost app and the focused element before every chunk. Every untagged key-down the tap sees (the user's)
   aborts a sequence in flight; keys pressed meanwhile are never replayed. Hold-Tab stops at a sequence ghost and never
   starts one. After an upload a fresh capture must show the file name in the upload field or its widget (or a new Remove
   control), else the walk stops with `upload-not-verified`. A combobox without a matching option is closed, cleaned up
   and skipped. Return is only ever posted inside the open panel (go-to field, then Open) or into an open combobox list on
   the highlighted, chosen option.

The typing fallback never sends a control character: a line break in a draft is typed as a space, because an Enter in
the wrong field submits a form. The test runner calls `GHForbidRealKeyEvents()` before the first test, so no code path
under test can post a real key event.

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
