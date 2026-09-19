# Ghost Desktop: the background agent that makes Ghost work in every browser and app (macOS)

The Chrome extension only covers Chromium browsers. Ghost Desktop is a native menu-bar agent that runs in the background and gives the same experience (ghost text, ghost cursor, Tab to accept, locks) in **any** app that exposes an accessibility tree: Safari, Chrome, Arc, Firefox, Edge, Electron apps, and native apps. It talks to the same local prediction server and reuses the same tested mapping logic.

## Constraints on this machine

- Only the Command Line Tools are installed and their Swift toolchain does not match the SDK, so **Swift does not build here. Use Objective-C (ARC) with clang and a Makefile.** No Xcode project, no SwiftPM, no CocoaPods.
- Verified working with plain clang: `-framework AppKit -framework ApplicationServices -framework JavaScriptCore`.
- Accessibility permission (System Settings -> Privacy & Security -> Accessibility) can only be granted by the user, to `Ghost.app`. Until then every AX call returns `kAXErrorAPIDisabled` (-25211). The app must detect this, show a clear menu-bar state ("Needs Accessibility permission"), call `AXIsProcessTrustedWithOptions` with the prompt option once, and poll until trusted. Nothing else may be attempted while untrusted.
- Ad-hoc signing (`codesign -s - --force --deep`) is fine. A rebuild changes the code hash and macOS may ask for the permission again; say so in the README.

## Layout

```
desktop/
  Makefile            make core | make app | make test | make run | make dump | make clean
  Info.plist          LSUIElement=1 (no Dock icon), bundle id dev.ghost.desktop, NSAppleEventsUsageDescription not needed
  core/build-core.mjs esbuild bundle of @ghost/shared -> build/ghost-core.js (IIFE, global GhostCore)
  core/entry.ts       exports exactly what the native side calls (see "Core bridge")
  src/                Objective-C sources (below)
  tests/              plain executable test runner (no XCTest): exits non-zero on failure
  README.md           build, permission, troubleshooting
build/Ghost.app       output (gitignored)
```

## Modules (`desktop/src`)

| File | Responsibility |
| --- | --- |
| `main.m`, `GHAppDelegate` | Accessory app, `NSStatusItem` menu: enabled toggle, status line (trusted? server? provider, last latency), per-app pause ("Pause in <frontmost app>"), "Open profile.json", "Open demo", "Quit". Global hotkey Alt+Shift+G toggles. |
| `GHField` | Model mirroring `CapturedField`: `signature, label, kind, inputType, options, value, rect (screen coords, top-left origin), locked, context` plus the live `AXUIElementRef`. `-toJSON` produces exactly the `CapturedField` JSON the server and the core expect. |
| `GHAccessibility` | Trust check; observe frontmost app changes (`NSWorkspace`), focused-window and focused-element changes (`AXObserver`), value changes and layout changes (debounced 150 ms). Tree walk of the focused window, breadth-first, bounded (max 1500 nodes, max depth 40, 120 ms budget, abort and keep partial results). For Chromium and Electron apps set `AXEnhancedUserInterface` and `AXManualAccessibility` to true on the application element so the web tree is exposed. |
| `GHCapture` | AX roles to kinds: `AXTextField` text (email/tel/url inferred from label and subrole), `AXTextArea` textarea, `AXComboBox`/`AXPopUpButton` select (options from `AXChildren` of the menu when cheap, else lazily when the ghost becomes current), `AXCheckBox` checkbox, `AXRadioGroup`/`AXRadioButton` one radio field with options, `AXButton`/`AXLink` button/link. Label precedence: `AXTitleUIElement` text, `AXTitle`, `AXDescription`, `AXPlaceholderValue`, `AXHelp`, nearest preceding `AXStaticText` sibling. **Never capture** `AXSecureTextField`, or any element whose label/placeholder/identifier trips `GhostCore.isSensitive` (not even the label). Skip disabled (`AXEnabled` false), hidden, zero-size, and off-window elements. Signature = role, subrole, normalized label, DOM identifier (`AXDOMIdentifier`) when present, index among same-label siblings. Never include values. |
| `GHCore` | JavaScriptCore bridge. Loads `ghost-core.js` once. See "Core bridge". |
| `GHServerClient` | `NSURLSession` to `http://127.0.0.1:8787`: `POST /v1/predict/form` (fact KEYS only, never values), `POST /v1/ghost-text` (SSE parsing, relevant non-sensitive facts only, same filtering rules as the extension), `GET /v1/health`. 3 s timeout, silent offline fallback. Must send `Content-Type: application/json` and no `Origin` header. Per (bundle id + window title host + form signature) in-memory + on-disk cache so repeat visits make zero calls. |
| `GHProfileStore` | `~/Library/Application Support/Ghost/profile.json` and `settings.json` (same shapes as the extension: `Profile`, `GhostSettings`), seeded with the fictional demo profile from the core, file-watched for edits. Files are created with mode 0600. |
| `GHController` | The same state machine as `extension/src/content/controller.ts`: ghost list in reading order (top to bottom, then left to right, using rects), current ghost, accept/advance, dismiss, typing override, focus follow, rescan on AX notifications, never touch fields that already have a value, lock ghost parked last. Pure logic is separated from AX so it is unit-testable with fake fields. |
| `GHEventTap` | `CGEventTap` (session level, head insert) for keyDown. **Consumes Tab only when** Ghost is enabled, the frontmost app is not paused, a current ghost is visible on screen, no modifier keys are held, and the system-wide focused element is the current ghost's element, the element the walk just left, or the window itself. Otherwise the event passes through untouched. Esc dismisses the current ghost (consumed only if something was dismissed). Any other printable key while focus is in a ghosted field dismisses that ghost (typing overrides) and passes through. Auto-repeat Tab = hold-Tab: accept every unlocked, non-pending ghost, stop at the lock. If the tap is disabled by timeout (`kCGEventTapDisabledByTimeout`), re-enable it. The tap callback must return in well under 10 ms: do the write asynchronously on the main queue after consuming the event. |
| `GHWriter` | Accept = focus the element (`AXFocused` true), set `AXValue`, read back and verify. If the value did not stick (common in web views for React inputs) fall back to real typing: select all in the field (`AXSelectedTextRange` over the whole value) then post unicode key events with `CGEventKeyboardSetUnicodeString` in chunks, then verify again. Selects: `AXPress` the popup, choose the matching `AXMenuItem` by title. Checkbox/radio: `AXPress` only when the state differs. **Locked targets are never pressed**; Tab only moves focus to them. Re-check sensitivity immediately before writing. Stop the walk on the first verification failure and show the reason in the HUD. |
| `GHOverlayWindow` | One borderless, transparent, click-through (`ignoresMouseEvents`), non-activating `NSPanel` per screen at `NSScreenSaverWindowLevel - 1`, `collectionBehavior` can-join-all-spaces + full-screen-auxiliary + stationary. Draws with Core Animation layers: gray ghost text clipped to the field rect (system font sized to the field height since AX does not expose fonts; multi-line for text areas), highlight ring, gliding ghost cursor (180 ms ease), Tab keycap, lock badge "Enter to confirm", bottom-right HUD (provider, latency, cache, keystrokes saved). AX rects are top-left origin in global display coordinates: convert per screen. Hide the overlay instantly when the frontmost app or window changes, while the window is moving/resizing, and when the field scrolls (re-query rect on `AXLayoutChanged`/scroll, 60 ms throttle). |

## Core bridge (`desktop/core/entry.ts` -> `GhostCore`)

```ts
GhostCore.demoProfile(): Profile
GhostCore.mapForm(fieldsJson: string, factKeysJson: string): string          // FieldAssignment[] via mapFormHeuristically
GhostCore.ghostsFor(fieldsJson, assignmentsJson, profileJson, settingsJson, source): string   // Ghost[]: threshold gating, skip filled fields, resolveFieldValue, lock ghost last (port the rules of extension/src/content/predict.ts into shared-free pure code inside entry.ts or import them if they have no DOM dependency)
GhostCore.isSensitive(probeJson): boolean
GhostCore.isLockedAction(probeJson): boolean
GhostCore.textFacts(profileJson): string                                      // the non-sensitive subset allowed to go to /v1/ghost-text
```

Strings in, strings out (JSON), so the Objective-C side stays thin and the behavior stays identical to the extension and covered by the existing TypeScript tests. `make core` must fail loudly if the bundle is missing an export.

## Safety rules (identical to CLAUDE.md, enforced natively)

1. Tab is consumed only when a ghost is visible and focus is in the walk. Never trap the keyboard. Shift+Tab and modified Tab always pass through.
2. Locked actions (submit, send, pay, delete, confirm...) are never pressed by Ghost. Lock badge + explicit Enter or click by the user.
3. `AXSecureTextField`, card, government ID and sensitive-labelled fields are never captured, predicted, filled, cached or logged.
4. Confidence gating with the shared threshold. A wrong ghost is worse than no ghost.
5. Never log values. Logs go to `~/Library/Logs/Ghost/desktop.log`, with field labels truncated and no values.
6. Password managers, Terminal/iTerm, Keychain Access, System Settings, and any app whose bundle id is in the default pause list are skipped entirely. The user can pause any app from the menu.

## Coexistence with the extension

When the extension is active in a browser, both would draw ghosts. The server gets `POST /v1/presence { client: "extension", browser: "chrome" }` heartbeats (30 s) and `GET /v1/presence`. Ghost Desktop skips a browser whose extension heartbeat is fresher than 90 s, and says so in the menu ("Chrome: handled by the extension").

## CLI modes (for testing without the UI)

- `Ghost.app/Contents/MacOS/Ghost --selftest`: loads the core, runs mapping on a built-in sample form, prints PASS/FAIL. No permissions needed.
- `--dump`: prints the captured fields of the frontmost window as JSON (labels only, no values) after a 3 s delay so the user can focus a browser. Needs the Accessibility permission.
- `--trust`: prints whether the process is trusted and exits 0/1.

## Running in the background at login

- `scripts/install-background.sh` (user runs it; it changes login items): builds the server bundle and `Ghost.app`, copies the app to `~/Applications/Ghost.app`, and writes two LaunchAgents: `dev.ghost.server` (node server bundle, KeepAlive, logs in `~/Library/Logs/Ghost/`) and `dev.ghost.desktop` (the menu-bar agent, RunAtLoad). `scripts/uninstall-background.sh` removes both. The server LaunchAgent reads keys from `~/.config/ghost/env` (mode 0600), never from the repo.
- `server/build.mjs`: esbuild bundle of the server to `server/dist/server.mjs` so the LaunchAgent does not depend on pnpm or tsx.

## Other browsers through the extension

- Chromium family (Chrome, Arc, Brave, Edge, Opera, Vivaldi): the same `extension/dist` folder, Load unpacked.
- Firefox: `pnpm --filter @ghost/extension build:firefox` writes `extension/dist-firefox` (MV3 with `background.scripts`, `browser_specific_settings.gecko.id`, no `debugger` permission; the debugger fallback reports "unsupported").
- Safari: needs full Xcode (`xcrun safari-web-extension-converter extension/dist`). Until then Safari is covered by Ghost Desktop.
