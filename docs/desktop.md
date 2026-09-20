# Shabang Desktop: the background agent that makes Shabang work in every browser and app (macOS)

The Chrome extension only covers Chromium browsers. Shabang Desktop is a native menu-bar agent that runs in the background and gives the same experience (ghost text, ghost cursor, Tab to accept, locks) in **any** app that exposes an accessibility tree: Safari, Chrome, Arc, Firefox, Edge, Electron apps, and native apps. It talks to the same local prediction server and reuses the same tested mapping logic.

**Implementation status (2026-09-19):** the native form agent described through the capture/controller/writer/overlay pipeline is implemented and has 167 passing unit tests. Cross-app claims have not been live-rehearsed during the current audit, loop automation is not implemented, and the real-world Greenhouse/file-upload harness is only a plan in `desktop-realworld.md`. Presence deduplication is also incomplete as described below.

## Constraints on this machine

- Only the Command Line Tools are installed and their Swift toolchain does not match the SDK, so **Swift does not build here. Use Objective-C (ARC) with clang and a Makefile.** No Xcode project, no SwiftPM, no CocoaPods.
- Verified working with plain clang: `-framework AppKit -framework ApplicationServices -framework JavaScriptCore`.
- Accessibility permission (System Settings -> Privacy & Security -> Accessibility) can only be granted by the user, to `Shabang.app`. Until then every AX call returns `kAXErrorAPIDisabled` (-25211). The app must detect this, show a clear menu-bar state ("Needs Accessibility permission"), call `AXIsProcessTrustedWithOptions` with the prompt option once, and poll until trusted. Nothing else may be attempted while untrusted.
- Ad-hoc signing (`codesign -s - --force --deep`) is fine. A rebuild changes the code hash and macOS may ask for the permission again; say so in the README.

## Layout

```
desktop/
  Makefile            make core | make app | make test | make run | make dump | make clean
  Info.plist          LSUIElement=1 (no Dock icon), bundle id dev.shabang.desktop, NSAppleEventsUsageDescription not needed
  core/build-core.mjs esbuild bundle of @ghost/shared -> build/shabang-core.js (IIFE, global GhostCore)
  core/entry.ts       exports exactly what the native side calls (see "Core bridge")
  src/                Objective-C sources (below)
  tests/              plain executable test runner (no XCTest): exits non-zero on failure
  README.md           build, permission, troubleshooting
build/Shabang.app       output (gitignored)
```

## Modules (`desktop/src`)

| File | Responsibility |
| --- | --- |
| `main.m`, `GHAppDelegate` | Accessory app, `NSStatusItem` menu: enabled toggle, status line (trusted? server? provider, last latency), per-app pause ("Pause in <frontmost app>"), "Open profile.json", "Open demo", "Quit". Global hotkey Alt+Shift+G toggles. |
| `GHField` | Model mirroring `CapturedField`: `signature, label, kind, inputType, options, value, rect (screen coords, top-left origin), locked, context` plus the live `AXUIElementRef`. `-toJSON` produces exactly the `CapturedField` JSON the server and the core expect. |
| `GHAccessibility` | Trust check; observe frontmost app changes (`NSWorkspace`), focused-window and focused-element changes (`AXObserver`), value changes and layout changes (debounced 150 ms). Tree walk of the focused window, breadth-first, bounded (max 1500 nodes, max depth 40, 120 ms budget, abort and keep partial results). For Chromium and Electron apps set `AXEnhancedUserInterface` and `AXManualAccessibility` to true on the application element so the web tree is exposed. |
| `GHCapture` | AX roles to kinds: `AXTextField` text (email/tel/url inferred from label and subrole), `AXTextArea` textarea, `AXComboBox`/`AXPopUpButton` select (options from `AXChildren` of the menu when cheap, else lazily when the ghost becomes current), `AXCheckBox` checkbox, `AXRadioGroup`/`AXRadioButton` one radio field with options, `AXButton`/`AXLink` button/link. Label precedence: `AXTitleUIElement` text, `AXTitle`, `AXDescription`, `AXPlaceholderValue`, `AXHelp`, nearest preceding `AXStaticText` sibling. **Never capture** `AXSecureTextField`, or any element whose label/placeholder/identifier trips `GhostCore.isSensitive` (not even the label). Skip disabled (`AXEnabled` false), hidden, zero-size, and off-window elements. Signature = role, subrole, normalized label, DOM identifier (`AXDOMIdentifier`) when present, index among same-label siblings. Never include values. |
| `GHCore` | JavaScriptCore bridge. Loads `shabang-core.js` once. See "Core bridge". |
| `GHServerClient` | `NSURLSession` to `http://127.0.0.1:8787`: `POST /v1/predict/form` (fact KEYS only, never values), `POST /v1/ghost-text` (SSE parsing, relevant non-sensitive facts only, same filtering rules as the extension), `GET /v1/health`. 3 s timeout, silent offline fallback. Must send `Content-Type: application/json` and no `Origin` header. Per (bundle id + window title host + form signature) in-memory + on-disk cache so repeat visits make zero calls. |
| `GHProfileStore` | `~/Library/Application Support/Shabang/profile.json`, `settings.json` and `answers.json` (same shapes as the extension: `Profile`, `GhostSettings`, `LearnedAnswersSnapshot`), seeded with the fictional demo profile from the core, file-watched for edits. Files are created with mode 0600, written atomically (temp file + rename). `answers.json` is never seeded: an absent file IS "nothing learned yet", and a missing, corrupt, truncated or wrong-shaped one reads as an empty store rather than stopping Shabang from proposing. Every malformed entry is dropped on load, the store caps at 500, and nothing in it is ever logged or sent anywhere. |
| `GHController` | The same state machine as `extension/src/content/controller.ts`: ghost list in reading order (top to bottom, then left to right, using rects), current ghost, accept/advance, dismiss, typing override, focus follow, rescan on AX notifications, never touch fields that already have a value, lock ghost parked last. Pure logic is separated from AX so it is unit-testable with fake fields. |
| `GHEventTap` | `CGEventTap` (session level, head insert) for keyDown. **Consumes Tab only when** Shabang is enabled, the frontmost app is not paused, a current ghost is visible on screen, no modifier keys are held, and the system-wide focused element is the current ghost's element, the element the walk just left, or the window itself. Otherwise the event passes through untouched. Esc dismisses the current ghost (consumed only if something was dismissed). Any other printable key while focus is in a ghosted field dismisses that ghost (typing overrides) and passes through. Auto-repeat Tab = hold-Tab: accept every unlocked, non-pending ghost, stop at the lock. If the tap is disabled by timeout (`kCGEventTapDisabledByTimeout`), re-enable it. The tap callback must return in well under 10 ms: do the write asynchronously on the main queue after consuming the event. |
| `GHWriter` | Accept = focus the element (`AXFocused` true), set `AXValue`, read back and verify. If the value did not stick (common in web views for React inputs) fall back to real typing: select all in the field (`AXSelectedTextRange` over the whole value) then post unicode key events with `CGEventKeyboardSetUnicodeString` in chunks, then verify again. Selects: `AXPress` the popup, choose the matching `AXMenuItem` by title. Checkbox/radio: `AXPress` only when the state differs. **Locked targets are never pressed**; Tab only moves focus to them. Re-check sensitivity immediately before writing. Stop the walk on the first verification failure and show the reason in the HUD. |
| `GHOverlayWindow` | One borderless, transparent, click-through (`ignoresMouseEvents`), non-activating `NSPanel` per screen at `NSScreenSaverWindowLevel - 1`, `collectionBehavior` can-join-all-spaces + full-screen-auxiliary + stationary. Draws with Core Animation layers: gray ghost text clipped to the field rect (system font sized to the field height since AX does not expose fonts; multi-line for text areas), highlight ring, gliding ghost cursor (180 ms ease), Tab keycap, lock badge "Enter to confirm", bottom-right HUD (provider, latency, cache, keystrokes saved). AX rects are top-left origin in global display coordinates: convert per screen. Hide the overlay instantly when the frontmost app or window changes, while the window is moving/resizing, and when the field scrolls (re-query rect on `AXLayoutChanged`/scroll, 60 ms throttle). |

## Core bridge (`desktop/core/entry.ts` -> `GhostCore`)

```ts
GhostCore.demoProfile(): Profile
GhostCore.mapForm(fieldsJson: string, factKeysJson: string): string          // FieldAssignment[] via mapFormHeuristically
GhostCore.ghostsFor(fieldsJson, assignmentsJson, profileJson, settingsJson, source, optionsJson?): string
GhostCore.upgradeGhosts(fieldsJson, servedJson, profileJson, settingsJson, source, optionsJson?): string
GhostCore.proposeAnswers(fieldsJson, profileJson, answersJson, settingsJson): string   // one AnswerProposal per field
GhostCore.recordCorrection(fieldJson, value, answersJson, nowIso?): string             // { answers, counter, changed, class, refusal?, questionKey? }
GhostCore.gateFor(fieldsJson, ghostsJson, optionsJson?): string                        // WalkGate: what is unmet and why
GhostCore.isSensitive(probeJson): boolean
GhostCore.isLockedAction(probeJson): boolean
GhostCore.formRequest(fieldsJson, factKeysJson, origin, formSignature): string
GhostCore.cleanAssignments(assignmentsJson): string
GhostCore.isPlaceholder(value, label): boolean
GhostCore.textFacts(profileJson): string                                      // the non-sensitive subset allowed to go to /v1/ghost-text
GhostCore.textPastAnswers(profileJson, label): string
GhostCore.defaultSettings(): string
```

`optionsJson` on `ghostsFor` / `upgradeGhosts` is `{ keepLock?, lockSignature?, answers?, accepted?, company? }`:
`answers` is the `answers.json` snapshot (a JSON string or the object), `accepted` the signatures the user has
already taken in this walk, `company` the posting's company (stripped from a learned answer's key so it carries
to the next site).

## Answering every question, and the gate (`docs/answers.md`, `docs/incremental.md`)

Both engines are the SHARED ones (`shared/src/answers/**`, `shared/src/form/**`), so the desktop agent and the
Chrome extension answer the same form the same way. `desktop/core/predict.ts` only adds what the desktop has:

- **Shabang proposes something for every question**: a profile fact, then an answer the user gave before, then a
  conservative inference, then the most neutral option. A protected question (gender, race, veteran, disability)
  is answered with the form's OWN "prefer not to answer" option, which is `answerProtectedWithDecline` in
  `settings.json` and is on by default; set it to `false` to leave those questions to the user entirely.
- **A guess is always visible**: the ghost carries `guess`, `needsReview`, `answerClass`, `answerSource`,
  `reason` and `questionKey`. The overlay draws a dotted amber rule under ghost text and a "guess" chip on a
  pill, the HUD says why, and **hold-Tab stops at the first guess** (`lastStep.outcome == "needs-press"`,
  `reason == "guess"`). One deliberate press takes it.
- **Lazy selects** (react-select: the options do not exist until the list opens) are asked in the shape their
  class can answer -- a decline option for a protected question, Yes/No for a declaration, plain text for
  anything else -- and the ghost carries the intended answer as text. A protected one carries
  `lazyMatch: "decline"` instead: `GHComboBoxDriver` then picks whichever option MEANS "prefer not to answer"
  (`GHMatchDeclineOption`, the native port of the shared `isDeclineOption`) and **types nothing at all**, so no
  wording of Shabang's ever lands in a demographic field. A list with no way to decline is left exactly as it was.
- **The gate**: a terminal action (Submit, Send, Pay, Continue) is proposed ONLY when every required field
  before it is filled or already accepted. Otherwise there is no Submit ghost at all -- no cursor, no lock badge
  -- and the HUD and the menu-bar line read "2 required fields still empty: Country". A pending ghost meets
  nothing, so a held Tab can never fill a required field with a guess and unlock Submit in the same breath.
  Requiredness comes from `AXRequired` and from a `*` / `(required)` marker beside the label (`GHCapture`), and
  the shared `isRequired` applies the `(optional)` veto on top.
- **Learning a correction**: with `learningEnabled` on, `GHController` compares each captured field's value with
  the one the previous capture reported and treats a change Shabang did not write as the user's own answer. There
  is no key logging: the evidence is what the page reports. The correction goes through
  `GhostCore.recordCorrection` and is written to `answers.json` atomically, keyed by the QUESTION
  (site-independent), so the same question is answered from it on every site afterwards. Values that look like
  secrets, sensitive fields and unreadable questions are refused by the core. Learned answers, protected values
  and declarations never leave the machine: `/v1/predict/form` still receives fact KEYS only, and EEO questions
  are not even mentioned to it.

Strings in, strings out (JSON), so the Objective-C side stays thin and the behavior stays identical to the extension and covered by the existing TypeScript tests. `make core` must fail loudly if the bundle is missing an export.

## Shabang anywhere: the window is not a form (`docs/anywhere.md`)

Most windows are not forms. When the form walk has nothing to offer, Shabang proposes the one control the window's
own affordances, the kind of place it is and the user's habits say comes next: the video's fullscreen button once
it is playing, the first item of a grid, the search box on a shop, the cart when it has something in it. No rule
anywhere in this path names an app, a bundle id, a host or a brand.

| File | Responsibility |
| --- | --- |
| `GHCapture` (`capturesUnnamedControls`) | A button or link with NO readable name is dropped by default, because the form walk can do nothing with it. With the flag it is kept when it is drawn at a clickable size (12 to 600 pt), marked `unnamed`, and carries its `AXDescription` and DOM class tokens. It can never get a value ghost: the core needs a label to map a fact to a field. |
| `GHAffordance` | One bounded walk of the window (1500 nodes / 0.25 s) that annotates the captured fields with the generic hints the shared layer reads -- `insideMediaControls` (the control shares a small ancestor with a media element or a scrubber), `list { signature, index }` (a repeated sibling structure), `nearbyPrice` (a price-shaped string of any currency drawn within about its own size), `badgeCount` -- and measures the page: `hasMediaElement`, `mainListSignature` (the repeated structure with the largest drawn area, which is what tells a grid from a navigation bar), `mainRegionRepeats`, `textDensity`, `isFullscreen` (the media element fills the window), `sensitiveOnScreen`. Page text is COUNTED for the density and thrown away; no string leaves this walk except a control's own short name, its identifier and its class tokens. |
| `GHNextAction` | Asks `GhostCore.nextAction` (the shared `classifyAffordance` / `inferPageKind` / `priorsFor` / `predictByRole`) and turns the top row into an ordinary unlocked `click` ghost, so the whole existing walk applies unchanged: the overlay draws the cursor on it, Tab accepts, Escape dismisses, typing cancels, and anything irreversible keeps its lock and is never pressed. It refuses any row that does not name a live control of this very capture. |
| `GHRoleMemoryStore` | `~/Library/Application Support/Shabang/memory.json`: counts per `(page kind, previous role, role)` and nothing else -- no label, no value, no app, no site. Mode 0600, written atomically, and a corrupt, truncated or foreign file reads as "nothing learned yet" rather than as a reason to stop proposing. One accept ties the strongest prior, two accepts (0.88) take the lead, every refusal takes 0.15 off. |
| `GHVision` | Naming what has no name (`docs/anywhere.md` section 4). The controls the core could not name are cropped out of a screenshot, laid side by side into ONE small strip and sent to `POST /v1/vision/label`. The strip holds nothing but those controls: no page text, no window title, no surroundings, and the route refuses a window title anyway. At most one call per page view, a cache keyed by the page plus the exact box geometry (any move is a miss), at most 40 boxes, and NOTHING at all from a window with a sensitive field on screen. A returned label the shared rules call irreversible locks the control; one they call sensitive is dropped. A model can lock, never unlock. |

**Screen Recording.** The crop needs the macOS Screen Recording permission, which Shabang may not have; `GHVision`
asks `CGPreflightScreenCaptureAccess` and never prompts. Without it `unavailableReason` is `"needs Screen
Recording"`, one line is logged once, the HUD says so, and everything else keeps working exactly as before --
blind to icon-only controls, which then rely on their identifiers and class tokens alone.

**The gate.** A proposal is drawn only above the user's `confidenceThreshold` (0.7 by default). The strongest
prior of a place Shabang recognizes is exactly 0.7, so a player, a feed, a shop, a mailbox or a document always
yields one proposal the first time it is seen. A window Shabang cannot place (`app` / `unknown`) tops out at 0.66
and deliberately proposes nothing until role memory lifts a role above the gate: rule 4, a wrong ghost is worse
than no ghost. Lower `confidenceThreshold` in `settings.json` to trade that for a ghost on literally every window.

## Safety rules (identical to CLAUDE.md, enforced natively)

1. Tab is consumed only when a ghost is visible and focus is in the walk. Never trap the keyboard. Shift+Tab and modified Tab always pass through.
2. Locked actions (submit, send, pay, delete, confirm...) are never pressed by Shabang. Lock badge + explicit Enter or click by the user.
3. `AXSecureTextField`, card, government ID and sensitive-labelled fields are never captured, predicted, filled, cached or logged.
4. Confidence gating with the shared threshold. A wrong ghost is worse than no ghost.
5. Never log values. Logs go to `~/Library/Logs/Shabang/desktop.log`, with field labels truncated and no values.
6. Password managers, Terminal/iTerm, Keychain Access, System Settings, and any app whose bundle id is in the default pause list are skipped entirely. The user can pause any app from the menu.
7. A demographic question is only ever DECLINED. `GHComboBoxDriver` still refuses a demographic combo box for any other answer, whatever the caller asks for, and never types into one.

## What is still open (desktop)

- **Requiredness the AX tree does not expose.** In `desktop/tests/fixtures/greenhouse-safari-viam.json` Safari
  reports `AXRequired` for First Name, Last Name, Email and the work-authorization question only. Country, Phone
  and Resume/CV are required on the live page but carry no marker anywhere in the tree (react-select's hidden
  input, the phone widget and the file-upload group expose nothing), so the gate cannot see them. The page-level
  legend "* indicates a required field" explains the marker and deliberately does NOT make every field required.
- **Two-sentence option sets.** "Have you served?" offering "I am a protected veteran" / "I am not a protected
  veteran" cannot be tied to a profile's "No" by `matchOption`, so Shabang proposes nothing there rather than
  guessing which sentence is meant. A question like that with a decline option is answered by declining.
- **A demographic option set with no decline option** ("How do you identify?" -> Man / Woman / Non-binary) is
  classified `ordinary` by the shared classifier, which only calls an option set protected when a decline option
  sits beside the demographic ones. The desktop keeps its own option-word check so such a question is still never
  mentioned to a server, but the shared classifier is the place to fix it.
- **`learningEnabled` is off by default** (the shared `DEFAULT_SETTINGS`), so corrections are not recorded until
  the user turns it on in `settings.json`.

## Coexistence with the extension

When the extension is active in a browser, both can draw ghosts. The intended design is `POST /v1/presence { client: "extension", browser: "chrome" }` every 30 seconds plus `GET /v1/presence`; Desktop would skip a browser whose heartbeat is fresher than 90 seconds. **This is not implemented end to end:** Desktop has the polling/parser and menu state, but the server has no presence route and the extension sends no heartbeat. Until those pieces exist, disable one client manually before using the other in the same browser.

## CLI modes (for testing without the UI)

- `Shabang.app/Contents/MacOS/Shabang --selftest`: loads the core, runs mapping on a built-in sample form, prints PASS/FAIL. No permissions needed.
- `--dump`: prints the captured fields of the frontmost window as JSON (labels only, no values) after a 3 s delay so the user can focus a browser. Needs the Accessibility permission.
- `--trust`: prints whether the process is trusted and exits 0/1.

## Running in the background at login

- `scripts/install-background.sh` (user runs it; it changes login items): builds the server bundle and `Shabang.app`, copies the app to `~/Applications/Shabang.app`, and writes two LaunchAgents: `dev.ghost.server` (node server bundle, KeepAlive, logs in `~/Library/Logs/Shabang/`) and `dev.shabang.desktop` (the menu-bar agent, RunAtLoad). `scripts/uninstall-background.sh` removes both. The server LaunchAgent reads keys from `~/.config/ghost/env` (mode 0600), never from the repo.
- `server/build.mjs`: esbuild bundle of the server to `server/dist/server.mjs` so the LaunchAgent does not depend on pnpm or tsx.

## Other browsers through the extension

- Chromium family (Chrome, Arc, Brave, Edge, Opera, Vivaldi): the same `extension/dist` folder, Load unpacked.
- Firefox: `pnpm --filter @ghost/extension build:firefox` writes `extension/dist-firefox` (MV3 with `background.scripts`, `browser_specific_settings.gecko.id`, no `debugger` permission; the debugger fallback reports "unsupported").
- Safari: needs full Xcode (`xcrun safari-web-extension-converter extension/dist`). Until then Safari is covered by Shabang Desktop.
