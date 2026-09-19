# Ghost Desktop, real-world target: a real Greenhouse application, Tab only

This is THE demo. Not our own demo site: a real Greenhouse job application in Safari or Chrome, driven natively through the macOS Accessibility API.

**Smoke test:** open a real `job-boards.greenhouse.io/<company>/jobs/<id>` posting, put the cursor nowhere in particular, and press Tab repeatedly. Ghost fills every personal field, picks the dropdown answers, drafts the essay answers, presses "Attach" for the resume, picks the resume file in the macOS open panel, and ends parked on **Submit application** with a lock. The user never touches the mouse.

**Hard limits (CLAUDE.md rules 2 and 5):**
- Tab NEVER presses Submit. The walk ends with the ghost cursor parked on Submit and the lock badge; one explicit Enter or click by the human sends it.
- Automated tests and agent-driven runs NEVER submit on a real site. Every real-site run stops at the locked Submit. Do not click Submit, do not press Enter on it, do not synthesize either.
- EEO / demographic questions (gender, race, ethnicity, veteran status, disability) are always left alone (`none`).
- Passwords, SSN/SIN, card fields: never captured (unchanged).

## 1. Stable host + hot-swappable library (so the Accessibility grant survives rebuilds)

macOS ties the Accessibility grant of an ad-hoc signed app to its code hash. Every rebuild would force the user to re-grant. So:

- `Ghost.app/Contents/MacOS/Ghost` becomes a tiny **host** (`desktop/host/main.m`, about 40 lines): it `dlopen`s the library and calls `int GhostMain(int argc, const char **argv)`. Library path: `$GHOST_LIB`, else `~/Library/Application Support/Ghost/libghost.dylib`, else `<bundle>/../libghost.dylib`. The host is built and signed ONCE (`make host`) and then never touched; `make app` must not rebuild or re-sign it when it already exists (`make host-force` does).
- Everything else (all current `desktop/src/*.m`) is compiled into `desktop/build/libghost.dylib` (`make lib`), which lives OUTSIDE the bundle so the bundle's seal never changes. `make install-lib` copies it to `~/Library/Application Support/Ghost/`.
- No hardened runtime, no library validation (ad-hoc signed host), so the dylib loads.
- Always launch through LaunchServices so Ghost is its own TCC "responsible process": `open -n desktop/build/Ghost.app --args <flags>`. A binary started directly from a shell is attributed to the parent terminal/app and will look untrusted. CLI modes therefore take `--out <file>` and write results to a file instead of stdout.

## 2. Test and debug harness (agent-drivable, no mouse)

All of these run inside the trusted host via `open -n ... --args`:

- `--trust --out f`: `{ "trusted": bool }`.
- `--dump --delay 3 --out f.json`: captured fields of the frontmost window (labels, kinds, options, rects, locked; NO values).
- `--dump-tree --delay 3 --depth 60 --out f.json`: raw AX tree (role, subrole, title, description, placeholder, identifier, DOM classes, actions, rect; values redacted to their length) so we can design against what Greenhouse really exposes.
- `--autotab N --interval 450 --out f.json`: with Ghost running normally, post N real Tab key events (NOT tagged synthetic, so they go through the event tap exactly like the user's) and record after each one: current ghost label, action taken, verification result, time. Refuses to continue when the current ghost is locked, and never posts Return/Enter. This is how an agent smoke-tests without touching the keyboard.
- `--frontmost "Safari"`: bring an app forward before dumping or auto-tabbing.
- Every run appends to `~/Library/Logs/Ghost/desktop.log` (no values).

## 3. File upload through the native open panel

Profile gains file facts: `resumePath` (and optional `coverLetterPath`) in `profile.json`, absolute paths, validated to exist and be readable, shown as the file name only.

- Capture: an upload control is an `AXButton`/`AXLink` whose label matches attach / upload / choose file / browse / "Resume/CV" (Greenhouse renders an "Attach" button next to "Resume/CV"; also "Dropbox", "Google Drive", "Enter manually": never pick those), or an `AXButton` with subrole/description "file upload button" (native `<input type=file>`). It becomes a field of kind `file` whose label is the nearest group label ("Resume/CV").
- Ghost: `{ action: "upload", displayText: "resume.pdf", value: <path> }` when the label maps to resume/CV/cover letter and the path exists. Not locked (nothing leaves the machine until Submit).
- Accept (one Tab): `AXPress` the button, wait up to 3 s for the open panel (an `AXSheet` or `AXWindow` with subrole `AXDialog` in the frontmost app containing an "Open"/"Choose"/"Upload" default button), then drive it with keystrokes posted as tagged-synthetic events: Cmd+Shift+G, wait for the "Go to" field, type the absolute path, Return (path resolves), wait for the field to disappear, Return (Open). Verify: the panel closed AND the page now shows the file name near the upload control (rescan; Greenhouse shows the file name and a remove "x"). On any failure: press Escape once to close the panel only if it is still open and it is ours, stop the walk, show the reason in the HUD.
- While the panel is open the overlay shows the ghost file name over the panel and the HUD says "Picking resume.pdf". If the user presses any key themselves, abort the automation (never fight the user).
- Never type a path into anything that is not the open panel's go-to field (check the focused element's role/window before every keystroke burst).

## 4. Real form controls

Greenhouse's current boards are React: text inputs (work with AXValue set or fall back to typing), and **react-select comboboxes** for dropdowns (Country, location autocomplete, "Are you legally authorized...", custom questions).

- Combobox accept: focus it, type the resolved option text (tagged-synthetic typing), wait for the listbox (`AXList`/`AXMenu`/role description "list box") to show options, pick the option whose text best matches (exact, then prefix, then the shared `matchOption` rules through the core) by arrow keys + Return or `AXPress` on the option, verify the displayed value. If no option matches well (score below 0.7), press Escape to close the list and skip the field (no ghost is better than a wrong ghost).
- Options are usually not in the AX tree until the list opens: resolve lazily at accept time, and show the intended answer ("Yes", "Canada") as the ghost pill beforehand, from the fact value.
- Location autocomplete (Google Places style): type the city, wait for suggestions, pick the first suggestion that starts with the typed city, verify.
- Phone country pickers, date pickers: fill the plain text part only when it verifies; otherwise skip.
- Checkbox groups ("How did you hear", consent): consent is never auto-checked.
- Essay questions (`AXTextArea` or long-label text fields): streamed ghost text from `/v1/ghost-text` with page context taken from the AX tree (company = window title / first heading, role = heading, description = static text of the posting, capped at 2000 chars).
- Ordering: reading order; the walk must scroll fields into view (`AXScrollToVisible` action when available, else focus which scrolls the web view) before drawing the ghost and before writing.

## 5. Works in any app

Same pipeline for Safari, Chrome, Arc, Firefox, Edge and native apps. Browser specifics: set `AXEnhancedUserInterface`/`AXManualAccessibility` for Chromium; Safari needs nothing; Firefox exposes its tree by default when an AX client connects. Record in the README which browsers were actually verified.

## 6. Fixtures and tests

- Save redacted raw AX dumps of real forms (Greenhouse in Safari and in Chrome, Lever, Ashby if time) under `desktop/tests/fixtures/*.json` (structure and labels only, never values) and replay them through `GHFakeAXNode` so capture/mapping regressions are caught without a browser.
- Unit tests for: upload detection and the open-panel state machine (with a fake panel + fake key poster), combobox flow, refusal rules (never Return on a locked target, never type outside the go-to field), autotab stop-at-lock.
- A fictional resume PDF for the demo profile lives at `demo/fixtures/resume-alex-chen.pdf`.
