# Ghost architecture and module contracts

This file is the contract between modules. If you change a signature here, change every caller in the same commit.

## Current integration boundary — 2026-09-19

The browser extension currently implements the offline form walk only: `capture -> buildGhostsOffline -> controller -> overlay/execute`. It does not fetch the server, stream free text, record traces, predict next actions or orchestrate loops. The server and shared packages contain those later-stage services/pure engines, and Ghost Desktop independently consumes form prediction and ghost text. Read contracts below as implemented only where a corresponding source module exists; `docs/loops.md` marks the planned extension pieces explicitly.

## Packages

| Package | Role |
| --- | --- |
| `shared/` (`@ghost/shared`) | Types and pure logic used by both the extension and the server: `CapturedField`, `Ghost`, `Profile`, the Jev-shaped decision interface, heuristic field mapping (`mapFieldToFact`), value resolution (`resolveFieldValue`), and the safety rules (`isSensitive`, `isLockedAction`). No DOM, no Node APIs. |
| `extension/` | Chrome MV3 extension built with esbuild (`node build.mjs`) into `extension/dist`. |
| `server/` | Hono prediction service on `http://localhost:8787`. Keys live here, never in the extension. |
| `demo/` | Vite + React demo sites on `http://localhost:5173`. `demo/public/apply-plain/index.html` is framework-free. |
| `e2e/` | Playwright tests that load `extension/dist` into Chromium and drive the demo sites. |
| `desktop/` | Separate Objective-C macOS menu-bar form agent. It has its own Makefile/tests and is not part of the pnpm workspace or root verification gate. |

## Extension content script (`extension/src/content/`)

Data flow: `capture` -> `predict` -> `controller` (owns state, keys) -> `overlay` (draws) + `execute` (writes).

### `capture.ts`

```ts
export function captureFields(root?: ParentNode): CapturedField[];      // DOM order, visible + enabled + not sensitive
export function findElement(signature: string): HTMLElement | null;      // resolves a signature from the last capture
export function accessibleName(el: Element): string;
export function computeSignature(el: Element): string;
export function isElementSensitive(el: Element): boolean;                // wraps shared isSensitive + data-ghost-sensitive/data-sensitive on self or ancestors
export function isElementLocked(el: Element): boolean;                   // wraps shared isLockedAction + data-ghost-lock
```

Rules:
- Accessible name precedence: `aria-labelledby`, `aria-label`, `label[for]`, wrapping `<label>`, `<legend>` (radio groups), `placeholder`, `title`, nearest preceding text. Strip trailing `*` and "(required)".
- A radio group (same `name` within the same form or root) is captured as ONE field of kind `radio` whose `options` are the radios (`value` plus each radio's own label). `findElement` returns the first radio of the group.
- Skip: `type=hidden`, `disabled`, `readonly`, zero-size or `display:none`/`visibility:hidden` elements, anything inside the Ghost overlay host, and anything sensitive (sensitive fields must not appear in the output at all, not even their label).
- Skip what a person cannot see, because that is where honeypots live (filling one gets the user flagged as a bot, and a hostile page could harvest extra profile facts through it): `opacity:0` on the element or an ancestor (a custom toggle's own opacity is exempt, its label stands in), `aria-hidden="true"` ancestors, a box under 2px in either direction, a collapsed clipping ancestor (`height:0; overflow:hidden`, the sr-only recipe, a closed accordion), text fields with `tabindex="-1"` plus `autocomplete="off"`, everything outside an open `dialog:modal`, and boxes parked off the top-left edge.
- Sensitive detection looks at every naming source and also at context: a bare "Number", "Expiry", "Code" or "Name" under a legend or heading that mentions a card or payment is a card field even without `autocomplete="cc-*"`.
- Links carry no `context` (they never get a ghost and the heading walk is the expensive part of a capture).
- Buttons and links are captured with kind `button` / `link` and `locked` set from `isElementLocked`.
- Signature must be stable across reloads and must not contain the field's value: `tag|type|name|id|normalized label|index among same-label siblings`, hashed or joined. Never include user-typed content.
- Must work in jsdom (tests) where layout is absent: treat an element as visible when jsdom cannot measure it (`getBoundingClientRect` all zeros AND no `display:none`/`hidden` attribute). Export a `setVisibilityProbe(fn)` test seam if needed.

### `predict.ts`

```ts
export interface PredictDeps { profile: Profile; settings: GhostSettings; keepLock?: boolean; lockSignature?: string; }
export function buildGhostsOffline(fields: CapturedField[], deps: PredictDeps): Ghost[];
export function ghostsFromAssignments(fields: CapturedField[], assignments: FieldAssignment[], deps: PredictDeps, source: GhostSource): Ghost[];
export function isPlaceholderChoice(value: string, label: string): boolean;   // "" or "Select an option" style entries
```

- Uses `mapFormHeuristically` + `resolveFieldValue` from `@ghost/shared`.
- Drops ghosts below `settings.confidenceThreshold` (confidence = assignment confidence x `confidenceFactor`).
- Never proposes a value for a field that already has a non-empty value (select: non-placeholder option chosen; radio: one checked). "Non-empty" is `value !== ""`, the same test the controller runs right before a write: whitespace counts as a value, so predict never offers a ghost the controller would refuse.
- A `check` ghost only ever ticks a box. Unticking would undo a choice the page or the user made.
- `needs_text` assignments produce no ghost on their own. With `deps.drafts` (Stage 3, see "Stage 3: free-text drafts") a draftable essay field gets an `llm` fill ghost once its draft has text.
- Locked buttons produce a `click` ghost with `locked: true` ONLY for the last locked button of a form whose other ghosts exist (the "Submit" at the end), so the ghost cursor ends the walk parked on Submit with a lock. Tab never activates it. `CapturedField` carries no form id, so "the form's submit" is approximated: locked `button` fields after the last value ghost (all locked buttons when there are none after it), preferring a primary-looking label (submit, send, apply, continue...) and otherwise the last one. Links never get a lock ghost. The lock ghost is always the LAST entry of the returned list.
- `keepLock: true` keeps the lock ghost even when no value ghosts remain. The controller passes it once the walk has accepted something, so a rescan after the last field does not un-park the cursor. With `lockSignature` set, only that button is kept (or nothing): the controller passes the Submit its walk was heading for, so a later view's "Delete all messages" can never inherit the lock ghost.
- Value ghosts are re-checked with the shared `isSensitive` (assignments may come from a server) and skipped when the resolved value equals the current one (an already-correct checkbox).

### `overlay.ts`

```ts
export class Overlay {
  constructor(doc?: Document);
  render(state: OverlayState): void;   // idempotent; called on every state change, scroll and resize
  setSavedTitle(title: string): void;  // hover text of the HUD's "saved" item (lifetime totals); kept across re-mounts, never mounts
  destroy(): void;
}
export interface OverlayState {
  ghosts: Array<{ ghost: Ghost; el: HTMLElement; status: "pending" | "current"; waiting?: boolean }>;   // waiting: Tab is waiting for the rest of a streaming draft (shimmer)
  hud?: { provider: string; latencyMs: number | null; cache: "hit" | "miss" | "offline"; keystrokesSaved: number;
          text?: { provider: string; firstTokenMs: number | null; totalMs: number | null } };               // the last finished draft, on its own HUD row
  jump?: { count: number; direction: "up" | "down" } | null;   // the jump pill, mirrored to data-ghost-jump="true|false"
  accepted?: number;        // mirrored to data-ghost-accepted; omitted = attribute left alone
  error?: string | null;    // mirrored to data-ghost-error and the HUD error chip; null or "" clears it
}
```

- `overlay.host` exposes the host element. `destroy()` followed by `render()` mounts a fresh host.
- While ghost text is shown the overlay sets `data-ghost-hint` on the field and injects `<style id="ghost-overlay-page-style">` (hides the field's own placeholder). Both go away with the ghost.
- One host element `<div id="ghost-overlay-host">` appended to `document.documentElement`, with a **closed shadow root**, `pointer-events: none`, `position: fixed; inset: 0; z-index: 2147483647`. Closed is a security property, not a style choice: the root holds every predicted profile value before the user accepts anything, and an open root can be read by any page script (`host.shadowRoot.querySelectorAll(".label")`). Our own code and unit tests reach it through `overlay.shadow`, which only exists in the isolated world. Host attributes never carry values either.
- Ghosts are only drawn where the user can see the field: the box is intersected with the viewport and with every clipping ancestor (scroll containers, `overflow:hidden` cards) and clipped with `clip-path`; a field scrolled out of its container, or whose middle is covered by something else (sticky header, modal; `elementFromPoint`), gets no ghost text, pill, ring or cursor. `data-ghost-hint` is only set while ghost text is really drawn, and the injected page style hides both `::placeholder` and `::-webkit-datetime-edit` (the native "---------- ----" of date and month inputs) under it.
- Ghost text: gray (`rgba(120,120,135,.75)`) text absolutely positioned over the field, copying the field's font, padding, line-height and text-align from `getComputedStyle`; multi-line inside textareas; clipped to the field's box. Selects and radios show the option label as a small gray pill next to or inside the control.
- Ghost cursor: an SVG pointer that glides to the current target with a CSS transition (`transform 180ms cubic-bezier(.2,.8,.2,1)`), plus a soft highlight ring around the current element. A lock badge (padlock SVG + "Enter to confirm") is shown when the current ghost is locked.
- A small "Tab" keycap hint sits at the right edge of the current field.
- Test hooks on the host element (content scripts run in an isolated world, so tests read DOM attributes): `data-ghost-state="idle|ready"`, `data-ghost-count` (pending + current), `data-ghost-current` (signature of the current ghost or empty), `data-ghost-current-locked="true|false"`, `data-ghost-accepted` (count accepted so far), `data-ghost-cursor="x,y"` (viewport point the ghost cursor rests on; absent while it is hidden).
- Respect `prefers-reduced-motion` (no glide).

### `execute.ts`

```ts
export interface ExecResult { ok: boolean; method: "native" | "click" | "debugger" | "none"; reason?: string }
export function executeGhost(ghost: Ghost, el: HTMLElement): Promise<ExecResult>;
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void;
```

- `fill`: focus, set value through the **native prototype value setter** (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`), dispatch bubbling `input` then `change`, then verify on the next microtask/animation frame that the write held. React controlled inputs must keep the value. "Held" tolerates the page's own spelling of our value (phone masks, trimming, upper-casing, a dropped country code): letters and digits are compared case-insensitively and one may contain the other. Empty, reverted or unrelated content did not hold.
- `select`: `<select>` uses the native setter + `input` + `change`. Radio groups: find the radio with `value` in the same group and `.click()` it. `check`: `.click()` only when the checked state differs.
- If verification fails, ask the background worker: `chrome.runtime.sendMessage({ type: "ghost:debugger-fill", value, target })` after focusing and selecting the field's content; verify again. `target` is a one-shot random token stamped on the element as `data-ghost-target` for the length of the request, so the worker can prove the focused element is still this one. If `chrome.runtime` is unavailable (unit tests), return `{ ok: false, method: "none" }`.
- `click` ghosts that are `locked` are NEVER executed by this module: return `{ ok: false, method: "none", reason: "locked" }`.
- Refuse to touch sensitive elements (re-check with `isElementSensitive` right before writing).
- Mark programmatic events so the controller can tell them from user typing: set `el.dataset.ghostWriting = "1"` during the write and remove it after.

### `controller.ts`

```ts
export class GhostController {
  constructor(deps: {
    overlay: Overlay; getProfile(): Profile; getSettings(): GhostSettings; doc?: Document;
    isUserEvent?: (event: Event) => boolean;   // default: event.isTrusted. Tests pass () => true (jsdom cannot mint trusted events)
    predictForm?: PredictForm;                 // cache -> server, once per form (Stage 2). Left out: Ghost stays offline
    events?: GhostEmitter;                     // default: the `ghostEvents` singleton from src/lib/events.ts
    drafts?: DraftScheduler;                   // streamed free-text drafts (Stage 3). Left out: essay fields get no ghost
  });
  start(): void;         // capture, predict, render, attach listeners (capture phase on window)
  stop(): void;          // detach everything, forget the walk (dismissals, accepted, keystrokesSaved), overlay.destroy() (host leaves the page)
  rescan(): void;        // immediate; DOM mutations and SPA navigations reach it debounced (150 ms, 600 ms ceiling)
  readonly state: {
    ghosts: Ghost[];            // LIVE ghosts only: accepted and dismissed ones leave the list, the lock ghost is last
    currentIndex: number;       // -1 when nothing is current
    accepted: number;           // accepts in THIS walk: back to 0 on a new page (see rule 6) and on stop()
    dismissed: Set<string>;
    keystrokesSaved: number;    // fill: value length, select/check: 1
    error: string | null;       // never contains profile values (the host attribute is readable by the page)
  };
}
```

Security: key and input events only count when `isUserEvent(event)` (trusted). Otherwise a page could dispatch a synthetic Tab and have Ghost pour the profile into its fields.

Tab semantics (non-negotiable, see CLAUDE.md):
1. Intercept `Tab` **only** when a current ghost is visible **and the user is in the walk**. Otherwise do nothing so Tab behaves natively. Never intercept Shift+Tab or Tab with Ctrl/Alt/Meta, and ignore key events while `event.isComposing`. "Visible" is literal: Tab stays native (no write the user cannot see) when the current ghost's element is entirely outside the viewport, has no box in a document that has layout (display:none, collapsed), fails `checkVisibility` (CSS-only hiding that no mutation reports), or has its middle covered by something else (sticky header, modal, the edge of a scroll container; `elementFromPoint`). The same check runs again right before every queued write. "In the walk" means focus is nowhere (body), on the current ghost's element (any radio of its group), or on the field the walk just left (accepted, dismissed, typed over). In a search box, an essay textarea, a code editor, a web component or a dialog the key is the page's; when native Tab lands on a ghosted field, rule 7 makes that ghost current and the walk continues. On `/apply` the form starts below the fold, so e2e tests scroll the first field into view (or focus it) before pressing Tab.
2. Tab on an unlocked current ghost: `preventDefault` + `stopPropagation`, execute it, mark accepted, make the next pending ghost current, move focus to the next ghost's element (scroll it into view if needed). "Next" is the next unlocked ghost in order, wrapping around to ghosts the user skipped; the lock ghost only becomes current when no unlocked ghost is left. Presses that arrive while a write is in flight are queued (not dropped, not native), so a test may press Tab N times back to back. A queued press owns the hold that follows it, exactly like a press that was accepted right away.
3. Tab on a **locked** current ghost: never activates it. Move focus onto the locked element so an explicit Enter or click activates it, and keep the lock badge visible. Focus already lands on the locked element when the walk reaches it. While focus is on the locked element (or nowhere), every further Tab is swallowed until Escape dismisses the lock ghost (Shift+Tab stays native), so over-pressing Tab is harmless. When the user has moved focus into another control (writing the essay answers after the walk), a fresh Tab press stays native there (rule 1's "in the walk" gate). The lock ghost is only ever the Submit a walk with value ghosts was heading for: focusing the button early never makes it current while unlocked ghosts remain, and a locked button on a later view is never adopted.
4. Holding Tab (`event.repeat`): each repeat accepts the next unlocked ghost; on reaching a locked ghost, focus it and swallow further repeats. Never auto-activate. Repeats only count when the hold began with a press Ghost intercepted (a native Tab hold never starts accepting), repeats that arrive mid-write are dropped, and repeats are swallowed for the rest of the hold when the walk runs out or fails.
5. Typing overrides: a trusted `input` event (not flagged `data-ghost-writing`) on a field with a pending/current ghost dismisses that ghost and advances. An untrusted, unflagged `input` (a page script filled the field) only schedules a rescan.
6. `Escape` dismisses the current ghost (it does not come back for that field on this page load) and advances to the next one. Escape passes the same gate as Tab (rule 1: visible, and the user in the walk), so the page's own modals, menus and players keep their Escape; only `preventDefault` Escape when a ghost was actually dismissed. A new page forgets the walk (dismissals, `accepted`, the remembered Submit, the error) and so does `stop()`. "New page" means origin + pathname changed, or a route-style hash (`#/inbox`, `#!/x`) changed; an anchor jump or a query-string tweak is the same page. When only the lock ghost is left and nothing was accepted, it is dropped too.
7. Focus follows the user: when the user focuses a field that has a pending ghost (any radio of a group counts), that ghost becomes current. Ghost never moves focus on page load.
8. After every accept, verify the write; on failure, stop the walk, leave remaining ghosts pending, and surface the reason in the HUD (`data-ghost-error` on the host). The failed ghost itself is dismissed so Tab cannot get stuck on it; the error clears on the next successful accept.
9. Never create ghosts for fields that already have a value, and never overwrite user-entered text. The element is re-checked right before each write; a field that gained a value in the meantime is dismissed (so the refused ghost cannot come straight back and trap Tab), not overwritten. A trusted `input` on a field that has no ghost at that moment (the user unticks a box Ghost ticked, or types where nothing was offered) dismisses that field's signature too.

Rescans: a `MutationObserver` on `documentElement` (childList + an attribute allowlist that leaves out `value` and every `data-ghost-*` churn attribute but includes what can reclassify a field: `type`, `autocomplete`, `data-sensitive`, `tabindex`; ignoring our host and page style) triggers a debounced rescan and, while ghosts exist, a `requestAnimationFrame`-throttled re-render. `class` and `style` records only count when their target is or contains a control, so a carousel or progress bar animating through inline style does not re-capture the document forever; scroll (capture, passive) and resize re-render only. URL changes are caught by `popstate`, `hashchange`, the Navigation API (`currententrychange`) when present, and a 500 ms `location.href` poll, because the page's `pushState` cannot be patched from the isolated world. A rescan never runs while a write is in flight. The HUD only shows once there is something to show (ghosts, accepts or an error); what it reports is described under "Stage 2: prediction pipeline".

### `index.ts`

Loads settings and profile from `chrome.storage.local` (through `src/lib/storage.ts`), starts the controller when `settings.enabled`, reacts to `chrome.storage.onChanged` (enable/disable starts/stops; any other settings or profile change rescans) and to the `ghost:toggle` runtime message (re-reads settings from storage, which is the source of truth; the background currently relies on storage alone and does not broadcast). Skips pages where `location.protocol` is not http/https and guards against double injection with a global flag in the isolated world. A disabled Ghost removes its overlay host from the page entirely.

The content script runs in every frame (`all_frames: true`): embedded application forms (Greenhouse, Lever, Ashby) live in iframes. Each frame has its own controller and overlay, frames smaller than 200x80 (ad slots, tracking pixels) are skipped, and only the top document shows the HUD. The debugger fallback stays top-frame only (its guards run in the top document and refuse anything else). Known gap: fields inside shadow roots (web-component forms such as Salesforce LWC) are not captured yet.

`lifecycle.ts` polls `chrome.runtime.id` once a second. After an extension reload or update the old content script is orphaned (no storage or runtime event ever reaches it again, so it could not be switched off); it then stops the controller, removes the overlay and releases the page.

## Extension shared lib (`extension/src/lib/`)

```ts
// storage.ts  (works with chrome.storage.local; falls back to an in-memory map when chrome.* is absent, for unit tests)
export function getProfile(): Promise<Profile>;               // seeds DEMO_PROFILE on first read
export function saveProfile(p: Profile): Promise<void>;
export function getSettings(): Promise<GhostSettings>;         // merges DEFAULT_SETTINGS
export function saveSettings(patch: Partial<GhostSettings>): Promise<void>;
export function onStorageChanged(cb: (changes: { profile?: Profile; settings?: GhostSettings }) => void): () => void;
// messages.ts
export type GhostMessage =
  | { type: "ghost:toggle" }
  | { type: "ghost:debugger-fill"; value: string; target: string }               // target: one-shot token, also stamped on the element as data-ghost-target
  | { type: "ghost:debugger-click"; x: number; y: number; target: string }
  | { type: "ghost:predict-form"; request: FormPredictRequest }                  // reply: ServerResult<FormPrediction>
  | { type: "ghost:health" }                                                     // reply: ServerResult<ServerHealth>
  | { type: "ghost:metrics"; batch: MetricsBatch };                              // reply: MetricsReply (Stage 4 + 7, see below)
// Free-text drafts do not use messages: one chrome.runtime Port named TEXT_PORT ("ghost:text") per draft, see Stage 3.
export interface DebuggerReply { ok: boolean; error?: string }
export function isGhostMessage(msg: unknown): msg is GhostMessage;
```

Storage keys: `ghost.profile`, `ghost.settings`, `ghost.formCache` (Stage 2, see below), `ghost.metrics` (Stage 7, see "Stage 4 + 7: learning and metrics").

## Background worker (`extension/src/background/`)

- `chrome.commands` `toggle-ghost` and `chrome.action.onClicked` flip `settings.enabled`; badge text shows `ON`/`OFF`.
- `ghost:debugger-fill`: `chrome.debugger.attach({tabId}, "1.3")`, `Input.insertText`, detach. `ghost:debugger-click`: `Input.dispatchMouseEvent` pressed + released. Always detach in `finally`. Reply `{ ok: boolean, error?: string }`.
- Real input lands on whatever is focused or under the point when it finally runs (after a message hop, a worker wake-up and an attach whose infobar reflows the page), so each request is re-validated inside the page with `Runtime.evaluate` right before the input: a fill requires `document.activeElement` to carry the request's `data-ghost-target` token, to be a text field, and to pass the shared sensitive patterns (`SENSITIVE_TEXT_SOURCE`, inlined); a click ignores the message's coordinates, recomputes the point from the tokened element, requires it to be a checkbox or radio that `elementFromPoint` really returns, and checks again after `mouseMoved` that the page did not move. Anything else is refused with a reason.
- An attach that fails with "already attached" detaches once and retries: a worker torn down mid-job leaves its own session behind. When DevTools really holds the tab the retry fails and the error is reported.
- Permissions are `storage` and `debugger` only. Content scripts are injected declaratively, `sender.tab.id` needs no `tabs` permission. The worker is the only part of the content-script path that fetches (`serverClient.ts`, Stage 2); the prediction server answers CORS for `chrome-extension://*`, so no `host_permissions` are needed for it.
- `chrome.runtime.onConnect`: `ghost:text` ports stream free-text drafts (`textStream.ts`, see "Stage 3: free-text drafts").
- On install: seed the demo profile and default settings.

## Options page (`extension/src/options/`)

Plain TypeScript + DOM (no framework). Shows the profile as editable JSON with validation, the settings (enabled, threshold slider 0.5..0.95, server URL, HUD toggle, learning toggle), and a "Reset to demo profile" button.

Tabs (`index.ts`): Profile, Import resume, Metrics, Settings. A section is `{ id, title, mount(panel) }`; `sections.ts` fires `SECTION_SHOWN` (`ghost:section-shown`) on a panel each time its tab opens. `mount` must never await the network: `body[data-ready="true"]` has to appear with the server down.

- **Every string from storage, the server or a resume reaches the DOM through `textContent` or `.value`, never `innerHTML`.** No inline scripts or styles, no eval, no remote URLs (MV3 CSP).
- **Server calls (`server.ts`)**: the options page is the one place that fetches the prediction server directly instead of through the background worker (it is an extension page: no page CSP, nothing hostile observing). `fetchHealth`, `fetchMetrics`, `extractProfile` take `{ fetch?, serverUrl?, timeoutMs? }`, default to `settings.serverUrl`, send `Content-Type: application/json` on POST, and throw `ServerError` (`offline` | `http` | `invalid`). Offline reads "Cannot reach the Ghost server at <url>. Start the server with pnpm dev."
- **Profile tab** (`profile-section.ts`, `profile-editor.ts`): a Fields view (one key/value row per fact with the `FACT_DESCRIPTIONS` hint, add/remove, past answers with delete) and the raw JSON view share one draft, the JSON text. `collectFacts(rows)` in `validate.ts` rejects blank, malformed (`FACT_KEY`), duplicate and sensitive-looking names; a view that does not validate cannot be left. "Reset to demo profile" needs two clicks.
- **Import resume** (`resume-section.ts`, `resume-merge.ts`, `src/lib/pdfText.ts`): pasted text, a `.txt`, or a PDF read in the page with pdf.js. `build.mjs` copies `pdf.min.mjs` and `pdf.worker.min.mjs` from `pdfjs-dist` into `dist`; they are loaded from the extension origin on first use (`import(chrome.runtime.getURL(...))`), text only (`useWasm: false`, no fonts, 12 pages, 20,000 chars, 10 MB). `readResumeFile(file, deps?)` never throws: when pdf.js fails it returns `{ ok: false, error: "Could not read this PDF. Paste the resume text instead." }`. `POST /v1/profile/extract` answers go through `buildReviewRows(currentFacts, proposed)`: canonical keys first and checked, `extra.*` unchecked, unchanged rows disabled, sensitive-looking or malformed keys and non-strings dropped. `mergeReviewRows(profile, rows)` writes only checked rows. The resume text is never stored.
- **Metrics** (`metrics-section.ts`, `metrics-math.ts`, `reliability-chart.ts`): reads `GET /v1/metrics` and the storage key `ghost.metrics` (written by the content script / background, read-only here, may be absent): `{ ghostsShown, ghostsAccepted, keystrokesSaved, clicksSaved, calibration: Array<{ c: number, a: 0|1 }> }` (max 1000 pairs). Local counters and pairs win when present (the server's copy is in memory); latency (p50/p95 per route + provider) and cache hit rate come from the server. `reliabilityBuckets(pairs)` always returns 10 buckets (`[0,0.1) ... [0.9,1]`); the chart is inline SVG (diagonal, one focusable dot per non-empty bucket, table view, no chart library). Refreshes every 5 s while the tab and the document are visible.
- **Onboarding** (`onboarding.ts`, `status-pill.ts`): a first-run card above the tabs (Tab / Esc / hold-Tab / lock semantics, privacy promises, link to `http://localhost:5173`), dismissed state in the storage key `ghost.onboarded`, reopened from the footer. The masthead pill polls `/v1/health` every 10 s and on settings changes: `<provider> · calibrated|not calibrated`, or `offline: using built-in heuristic`.

## E2E conventions (`e2e/`)

- `e2e/fixtures.ts` exports a Playwright `test` with a `context` fixture that launches `chromium.launchPersistentContext` with `--disable-extensions-except` and `--load-extension` pointing at `extension/dist`, `channel: "chromium"` (new headless supports extensions), video recording on, and an `extensionId` fixture read from the service worker URL.
- Tests wait for `#ghost-overlay-host[data-ghost-state="ready"]` instead of sleeping.
- Tests must assert that Submit/Send was NOT triggered: demo pages set `window.__submitted = true` and render `data-testid="submitted"` on submit.
- Never touch a non-localhost URL.
- Prediction server: `playwright.config.ts` starts a second `webServer`, the keyless server on `http://127.0.0.1:8788` (`KEYLESS_SERVER_ENV`: `GHOST_DECISION_PROVIDER=heuristic`, `GHOST_TEXT_PROVIDER=template`, every key blanked), with `reuseExistingServer: false`. Never 8787, never a reused process: a developer server may hold real keys. A busy 8788 fails the run.
- The `context` fixture writes `ghost.settings` from the service worker BEFORE any page loads, and only once install seeding has created the key (`saveSettings({})` is a read-modify-write and would otherwise put the default URL back). Two fixture options feed it: `serverUrl` (default `OFFLINE_SERVER_URL`, `http://127.0.0.1:9`: an unsafe port in Chromium, so the fetch fails at once and no server on the machine can ever be reached) and `settings` (any other `GhostSettings` patch). Specs that want the server say `test.use({ serverUrl: E2E_SERVER_URL })`. `patchSettings`, `readStorage`, `writeStorage`, `removeStorage` and `readAllStorage` go through the `worker` fixture.
- Ghost counts depend on whether a prediction server answers. Without one (every spec that does not opt in: Stage 1, hardening) essay textareas get no ghost and `/apply` shows 14 + the locked Submit = 15 (`OFFLINE_GHOSTS`). With one, `#why-northwind` and `#project` get draft ghosts: 17 ghosts (`SERVER_GHOSTS`), 16 Tab presses to the lock. `e2e/apply.ts` holds the form helpers the server specs share; `stage1-form.spec.ts` keeps its own copies as the offline oracle.
- The closed shadow root is read through the DevTools protocol, not through page-readable hooks: `overlayEval(page, fn)` (`DOM.getDocument` with `pierce`, then `Runtime.callFunctionOn` on the shadow root) backs `readHud`, `readGhostText` and `readToast`. Page script still cannot do this, and `extension-loads.spec.ts` keeps proving it.
- Server-side proof: `serverCalls(route)` sums the `/v1/metrics` latency series of a route (the heuristic's and the server cache's), so "exactly one form call" and "zero calls on reload" are before/after differences. A test that needs the server to die (`stage2-server.spec.ts`) spawns its own keyless server on 8789 with `tsx` directly (no `--env-file`, own process group) and stops it in fixture teardown.
- Videos: `saveVideo(page, name)` copies the recording to `docs/media/<name>` only when that file does not exist yet, or when `GHOST_RECORD=1`; a video over 3 MB fails the test. Waits marked "video only" pace the recording and guard nothing.

## Stage 2: prediction pipeline, events, jump pill

Data flow: `capture` -> offline ghosts on screen (0 ms) -> `predictForm` (per-site cache, then the worker, then the server) -> `upgradeGhosts` -> the same `adopt`/`render` as any rescan.

### `src/lib/messages.ts` (additions)

```ts
export type ServerResult<T> = { ok: true; data: T } | { ok: false; error: string };   // error is a short code, never content
export interface ServedAssignment extends FieldAssignment { source?: string; calibrated?: boolean }
export interface FormPrediction { assignments: ServedAssignment[]; provider: string; calibrated: boolean; latencyMs: number | null; fallbackFrom?: string }
export interface ServerHealth { provider: string; calibrated: boolean; textProvider: string; model?: string; version?: string }
export function toWireField(raw: unknown): CapturedField | null;             // value-capable kinds only, no `value`, zero rect, never a sensitive field
export function sanitizeFormRequest(raw: unknown): FormPredictRequest | null; // allowlist rebuild inside the server's limits (100 fields, 64 keys, 50 options)
export function cleanAssignments(raw: unknown): ServedAssignment[];
export function parseFormPrediction(raw: unknown): FormPrediction | null;
export function parseHealth(raw: unknown): ServerHealth | null;
```

### `src/background/serverClient.ts`

```ts
export const REQUEST_TIMEOUT_MS = 3000;
export function predictForm(rawRequest: unknown, deps?: ServerClientDeps): Promise<ServerResult<FormPrediction>>;   // POST /v1/predict/form
export function checkHealth(deps?: ServerClientDeps): Promise<ServerResult<ServerHealth>>;                          // GET /v1/health
export function isServerMessage(msg: unknown): msg is ServerMessage;
export function handleServerMessage(message: ServerMessage, sender: { origin?: string; url?: string }, deps?: ServerClientDeps): Promise<ServerResult<...>>;
```

- `background/index.ts` routes `ghost:predict-form` and `ghost:health` here after the `sender.id === chrome.runtime.id` check. Content scripts never fetch the server themselves: a page CSP cannot block the worker and the page cannot observe it.
- The body is rebuilt with `sanitizeFormRequest`, `origin` is replaced by the origin Chrome reports for the asking frame, and `factKeys` are intersected with the keys of the stored profile. Only `origin`, `formSignature`, value-free `fields` and fact KEYS can leave; a profile VALUE cannot, not even from a compromised content script.
- `serverUrl` comes from settings on every call. Error codes: `no-server-url`, `bad-request`, `timeout` (3 s), `unreachable`, `http-<status>`, `bad-response`.

### `src/lib/formCache.ts`

```ts
export function formSignature(fields: CapturedField[]): string;   // "form-<n>-<hash>" over the ordered `signature#kind` of the wire fields
export function factKeysId(factKeys: string[]): string;           // hash of the sorted key set
export function readCachedForm(origin, signature, factKeys, now?): Promise<CachedForm | null>;
export function saveCachedForm(origin, signature, factKeys, { assignments, provider }, now?): Promise<void>;
export function clearFormCache(): Promise<void>;
```

One storage key, `ghost.formCache`: `{ "<origin> <formSignature>": { assignments, provider, savedAt, usedAt, facts } }`. It holds field signatures and fact KEYS, never a value. LRU by `usedAt`, capped at 200 forms. An entry saved for another fact key set, or older than its TTL (30 days; 1 day when `provider` is `heuristic`, so adding a key later still upgrades the site), is dropped on read. Everything read back is re-validated. Falls back to memory without `chrome.storage`.

### `predict.ts` (additions)

```ts
export function usableFactKeys(profile: Profile): string[];
export function predictableFields(fields: CapturedField[]): CapturedField[];   // toWireField over the capture, at most 100
export function upgradeGhosts(fields, served: ServedAssignment[], deps: PredictDeps, source: GhostSource): Ghost[];
export interface FormAnswer { assignments: ServedAssignment[]; provider: string; cache: "hit" | "miss"; latencyMs: number }
export type PredictForm = (request: FormPredictRequest) => Promise<FormAnswer | null>;   // null = stay offline; never rejects
export function createFormPredictor(deps: { readCache; saveCache; askServer }): PredictForm;
```

- `createFormPredictor`: cache hit -> answer with `cache: "hit"` and ZERO server calls; miss -> `askServer` once, save, `cache: "miss"`. A reply with `fallbackFrom` is used but not saved. `content/index.ts` wires it to `formCache` and `chrome.runtime.sendMessage({ type: "ghost:predict-form" })`.
- `upgradeGhosts` merges per field: no server answer -> the offline assignment stays (`source: "offline"`); otherwise the server's answer wins, EXCEPT that an assignment with `calibrated !== true` (the llm adapter, the server's heuristic) never replaces an offline ghost that is more confident about a different fact (`none` included). Gating is the same `settings.confidenceThreshold`, read on every rescan, so a storage change re-gates live.

### Controller rules (Stage 2)

10. Offline ghosts are shown by the first rescan, before any message is sent. `predictForm` is asked at most once per form signature per page load (never on a rescan of a form already asked about), at most 6 forms per page load, and not at all for a lone field without an offline ghost (a search box). Server down, slow or wrong: nothing changes and nothing is reported as an error.
11. When an answer arrives its assignments are remembered per field signature and an ordinary rescan rebuilds the list, so accepted, dismissed and typed-over fields stay gone and focus never moves. The current ghost is pinned to its offline version (for as long as it lives) when the user is on it: focus is on its element, the walk has started, or it has been on screen for more than 400 ms. A changed fact key set forgets every answer and asks again. An answer that arrives after `stop()` is dropped.
12. HUD: `provider` is the answer's provider (or `offline-heuristic`), `cache` is `hit` | `miss` | `offline`, latency is what the user waited (cache read or round trip; capture + predict time while offline), plus keystrokes saved. `settings.showHud` toggles it.
13. Jump pill (`jump.ts`: `offscreenDirection`, `focusOnBody`, `jumpLabel`). Shown when the current unlocked ghost is entirely outside the viewport (it has a box, none of it on screen) and focus is on the body: "14 ghosts ready · Tab to jump" at the bottom center with a down or up arrow, `data-ghost-jump="true"` on the host. While the pill is drawn AND its condition still holds, a fresh Tab is intercepted: it scrolls the current ghost into view and focuses it, fills nothing, and the rest of that hold is swallowed. This keeps rule 1: the pill is the visible ghost. Escape puts the pill away until the next page; that Escape is not swallowed (no ghost was dismissed). A covered field (sticky header, modal) never gets a pill: Tab stays native there.

### `src/lib/events.ts`

```ts
export const ghostEvents: GhostEmitter;                         // the content script's singleton; only the controller emits
export function createEmitter(): GhostEmitter;                  // on(type, handler) -> unsubscribe, emit(type, payload), clear()
export interface GhostEventMap {
  "ghosts:shown": { count: number; source: "offline" | "cache" | "server" };   // value ghosts new to this page, counted once each
  "ghost:accepted": { ghost: Ghost; field: CapturedField; ms: number };        // ms: the write, verification included
  "ghost:dismissed": { ghost: Ghost; reason: "escape" | "typed" | "refused" }; // refused: rule 9, or a write that did not hold
  "user:input": { field: CapturedField; value: string; el: HTMLElement };      // trusted edits, on change or blur, never per keystroke
  "walk:finished": undefined;                                                   // something was accepted and nothing unlocked is left
}
```

Subscribe with `ghostEvents.on(...)` instead of editing `controller.ts`. `user:input` never fires for a field capture left out (sensitive fields are never captured), for Ghost's own writes, or for script-made changes. A subscriber that throws is logged and skipped. Payloads carry profile values and live elements: they stay in the isolated world and must never be forwarded to the page.

## Stage 3: free-text drafts

Data flow: `planForm` names the essay fields -> `DraftScheduler` (content) opens one `ghost:text` port per field, three at a time -> `textStream.ts` (worker) POSTs `/v1/ghost-text` and relays the SSE deltas -> the controller grows an `llm` fill ghost in place -> the overlay draws it multi-line inside the textarea -> Tab writes the whole draft. The template provider (no key) streams through exactly the same path.

### `src/lib/messages.ts` (text)

```ts
export const TEXT_PORT = "ghost:text";                       // one Port per draft; disconnecting it aborts the stream
export interface GhostTextRequest { fieldLabel; fieldSignature; maxChars?; pageContext: TextPageContext; facts: Record<string,string>; pastAnswers: Array<{ question; answer }> }
export type TextPortEvent = { type: "delta"; delta } | { type: "done"; text; provider; latencyMs; firstTokenMs } | { type: "error"; error };   // done/error are terminal
export const TEXT_FACT_KEYS;                                  // fullName, firstName, lastName, school, degree, major, graduationDate, location, github, website
export function textFacts(facts): Record<string, string>;    // the allowlist, minus values that read as an email address or a phone number
export function hasContactValue(text: string): boolean;
export function sanitizeTextRequest(raw: unknown): GhostTextRequest | null;   // the worker's allowlist rebuild, inside the server's limits
```

Email, phone, address, LinkedIn, work authorization, sponsorship and referral source never reach the text route: the content script builds `facts` from the allowlist and the worker rebuilds the whole body again (`sanitizeTextRequest`), dropping unknown fields, sensitive labels, and past answers that quote contact details or answer a sensitive question.

### `src/background/textStream.ts`

```ts
export const MAX_STREAMS_PER_TAB = 3;
export function createSseParser(onData: (data: string) => void): { push(chunk: string): void; flush(): void };
export function toPortEvent(data: string): TextPortEvent | null;
export function createTextStreamHub(deps: { extensionId; fetch?; getServerUrl?; maxPerTab? }): { onConnect(port): void; active(tabId): number };
```

- `background/index.ts` registers ONE `chrome.runtime.onConnect` listener. A port is served only when `port.name === TEXT_PORT` and `port.sender.id === chrome.runtime.id`; only its first `{ type: "start", request }` message counts.
- The open port keeps the MV3 worker alive while it streams. `onDisconnect` (typing, Escape, navigation, tab closed) aborts the fetch; a 30 s ceiling aborts a stuck one. At most three streams per tab run at once (all frames of the tab together); the rest queue and inherit a freed slot, and a queued stream whose port went away is dropped.
- Errors are short fixed strings (`invalid request`, `server unreachable`, `server answered <status>`, `stream ended early`, `aborted`): never the failure text, which can carry the URL or the body.

### `content/pageContext.ts`

`extractPageContext(doc): { company?, role?, description? }`, read once per page and only when a draft is about to be requested. Role: schema.org `JobPosting.title`, a "Role at Company" heading or title, the first visible `h1`, `og:title`, `document.title`. Company: `JobPosting.hiringOrganization`, `og:site_name`, an "About <Company>" `h2`/`h3` (never "About the role/you/us"), "Role at Company". Description (<= 2000 chars, cut at a word): visible text of `[data-testid="job-description"]`, `[itemprop="description"]`, `main article`, `article`, `main`, `[role="main"]`, skipping forms and every control (a textarea's text is the user's), `nav`/`footer`/`aside`, scripts, hidden and `aria-hidden` subtrees, `contenteditable`, and anything under `data-ghost-sensitive`/`data-sensitive`. All of it is untrusted: control, zero-width and bidi characters are stripped, email addresses and phone numbers are removed, and it only ever travels as JSON string values.

### `content/freeText.ts`

```ts
export class DraftScheduler {
  constructor(deps: { open: OpenTextStream; maxConcurrent?: number /* 3 */; now?: () => number });
  subscribe(listener: ((signature: string, change: "text" | "done" | "failed") => void) | null): void;
  want(job: { signature; limit?; build(): GhostTextRequest | null }): void;   // once per signature per page load, at most 8 per page
  has(signature): boolean;
  get(signature): { text: string; pending: boolean } | undefined;              // undefined before the first token, after a failure or an abort
  abort(signature): void;                                                      // stops the stream; the field is never drafted again on this page
  settled(signature, timeoutMs): Promise<"done" | "failed" | "timeout">;
  reset(): void;                                                               // new page or stop(): every stream stops, every draft is forgotten
  stats(): { provider; firstTokenMs; totalMs } | null;                         // the last finished draft as the user waited for it (queueing excluded)
}
export function buildTextRequest(field, profile, pageContext, limit?): GhostTextRequest | null;
export function similarPastAnswers(label, pastAnswers, max = 3);               // Jaccard word overlap >= 0.25, closest first
export function clipDraft(raw, limit, pending): string;                        // maxlength: a finished draft is cut back to a whole sentence (or word)
export const openTextPort: OpenTextStream;                                     // chrome.runtime.connect({ name: TEXT_PORT })
```

The final `done.text` replaces whatever was streamed: the server swaps in its template when a streamed draft fails its safety check.

### `predict.ts` (Stage 3)

```ts
export const LLM_CONFIDENCE = 0.8;
export interface PredictDeps { ...; drafts?: { get(signature): { text: string; pending: boolean } | undefined } }
export function planForm(fields, served, deps, source): { ghosts: Ghost[]; textFields: CapturedField[] };   // upgradeGhosts(...) is planForm(...).ghosts
export function draftableFields(fields, assignments, deps): CapturedField[];
```

A field is draftable when its merged assignment is `needs_text`, it is an empty, labelled, non-sensitive `textarea` or `text` field, `LLM_CONFIDENCE` clears `settings.confidenceThreshold`, the `needs_text` confidence clears the threshold (a calibrated answer) or `max(threshold, 0.85)` (our heuristic, the llm adapter: a real prompt such as "Why ...?" or "Tell us about ...", not just any textarea), and at least two fields of the form map to profile facts. The last rule keeps drafts, and the page text they send, to forms of the user's own details: a comment box, a chat input or a mail composer is never drafted. A draftable field with draft text becomes `{ action: "fill", source: "llm", confidence: 0.8, value: text, displayText: text, pending?: true }` in DOM order, before the lock ghost.

### Controller rules (Stage 3)

14. Speculative generation: every rescan hands `planForm().textFields` to `drafts.want`, so all essay fields start drafting on the first scan, while the user is still on the first field. `want` is idempotent; a field with a `maxlength` under 20 is skipped, otherwise `maxlength` travels as `maxChars` and the draft is clipped to it again before it is shown or written.
15. The first text of a field triggers one immediate rescan (the ghost joins the list in DOM order, the current ghost and focus do not move); later deltas replace the ghost in place and re-render on the next frame, with no capture per token. `failed` takes a half-written ghost away again, silently: no server, no draft, no error.
16. Tab on a draft that is still `pending`: the press is Ghost's, the ghost shimmers (`waiting`), and the controller waits up to `DRAFT_WAIT_MS` (4 s) for the stream to finish, then writes the FINAL text. Out of time, failed, typed over or escaped: nothing is written, queued presses are dropped, and the ghost, if it is still there, waits for another Tab. Escape during the wait dismisses the draft. A HELD Tab never accepts a pending draft: the hold halts there for good (swallowed), even if the draft finishes mid-hold.
17. Typing in the field (with or without a ghost yet), Escape and a refused write all `drafts.abort(signature)`: the port disconnects, the worker aborts the fetch, and that field is not drafted again on this page load. A new page and `stop()` call `drafts.reset()`.
18. "In the walk" (rule 1) also covers focus on the Submit the walk parked on: a draft that arrives after the walk reached the lock becomes current (rule 2) and the next Tab accepts it. A Submit the user focused on their own, before the walk got there, keeps its native Tab.
19. HUD: a second row `draft via <provider> · first token <ms> · total <ms>` for the last finished draft.

### Overlay (multi-line)

The multi-line label IS the textarea's text box: same border-box size, font, line-height, letter and word spacing, `word-break`, `tab-size`, padding plus border, plus the width of a classic scrollbar when the textarea reserves one, with `white-space: pre-wrap; overflow-wrap: break-word`, so lines break where the textarea will break them. The Tab keycap is absolutely positioned (bottom right) and takes no width from the text. The label is clipped to the box like the textarea's scroll box; when the draft is taller (`scrollHeight > clientHeight`, measured only when the text or the box changed: the one layout read after a write) `data-overflow="true"` fades the bottom edge with a mask. `data-streaming="true"` while `ghost.pending`, `data-waiting="true"` (shimmer) while Tab waits. A streaming draft reuses its node: the field is only looked up again when the element changes (or a radio group's value does).

## Stage 4 + 7: learning and metrics

Both are subscribers of `ghostEvents`; the controller knows about neither. `content/index.ts` wires them in `startSubscribers` and stops them when the content script is retired.

### `content/servedLedger.ts`

`createServedLedger(max = 500)` -> `{ note(assignments), get(signature), clear() }`, and `observePredictions(predictForm, ledger)`: the same `PredictForm`, whose answers (cache or server) are remembered per field signature. Learning reads the mapping from it, metrics reads `calibrated`.

### `content/learning.ts` (opt-in: `settings.learningEnabled`, default false)

```ts
export const LEARN_MIN_CONFIDENCE = 0.85, LEARN_DEBOUNCE_MS = 400, MAX_PAST_ANSWERS = 50, MAX_ANSWER_CHARS = 2000;
export function decideLearning(input: { field; value; mapping: FieldAssignment | null; profile; enabled }): { kind: "fact"; key; value } | { kind: "answer"; question; answer } | null;
export function pickMapping(offline?: FieldAssignment, served?: ServedAssignment): FieldAssignment | null;
export function looksSecret(value): boolean;            // 13 to 19 digits passing Luhn, or exactly 9 digits, anywhere in the text (spaces, dots, dashes ignored)
export function sameValue(a, b): boolean;               // letters + digits, case-insensitive, one may contain the other (4+ chars)
export function factValueFor(key, raw): string | null;  // shape checks per key; graduationDate only as YYYY-MM[-DD] (MM/YYYY is converted)
export function mergePastAnswer(list, entry): PastAnswer[];   // dedupe by normalizeQuestion, newest wins and goes last, oldest fall off past 50
export class Learner { constructor(deps: LearnerDeps); start(); stop(); flush(): Promise<void> }
```

- Listens to `user:input` (typed and committed: change or blur) and to `ghost:accepted` of an `llm` draft. Each is debounced per field signature (400 ms, the last value wins), flushed on `pagehide`, dropped by `stop()`.
- Mapping: `mapFormHeuristically` over a fresh `captureFields(document)` (the whole form, so a lone email box is a login and maps to nothing) with every canonical key (`FACT_DESCRIPTIONS`) plus the profile's own, then `pickMapping` against the ledger: a confident served fact wins, two confident answers naming different facts cancel each other, and only a calibrated served `none` overrides the heuristic.
- `decideLearning` holds every NEVER: learning disabled; no mapping, `none`, or confidence below 0.85 (also for `needs_text`, so only real prompts are saved); `isSensitive` on label, name, id, placeholder, autocomplete, input type or the section context (the live element is re-checked with `isElementSensitive` as well); a value that `looksSecret`; a fact key that is malformed or itself reads sensitive. Facts only come from typed kinds (`text`, `email`, `tel`, `url`, `number`, `date`, `month`): a select's or radio's value is the site's code. A value that is the same thing as the profile's (`sameValue`) is not an update.
- Writes go through `updateProfile(mutate)` in `lib/storage.ts`, and the decision is made again inside it against what storage holds at that moment. Past answers are `{ question: label, answer, origin, savedAt (ISO) }`; an identical answer is not rewritten.
- `content/learnToast.ts`: `new LearnToast({ root: () => overlay.shadow | null })`, `show({ text, onUndo })`, `hide()`. One chip, bottom left, inside the overlay's CLOSED shadow root, for `TOAST_MS` (6 s): "Ghost learned: <fact key>" or "Ghost saved this answer" plus Undo. It shows the KEY, never the value; the button is `tabindex="-1"`, cancels `mousedown` (focus stays in the form) and only honours trusted clicks. Undo restores the previous value (or removes the key / puts the replaced answer back) and only when storage still holds what was learned.

### `content/metricsReporter.ts`

```ts
export const REPORT_INTERVAL_MS = 5000;
export class MetricsReporter { constructor(deps: { events; send; isCalibrated?; loadTotals?; onTotals?; intervalMs?; win? }); start(); stop(); flush(); pending(): MetricsBatch }
export function savedTitle(totals: MetricsCounters): string;   // "Lifetime: 12,345 keystrokes and 67 clicks saved · 80 of 100 ghosts accepted"
export const sendMetricsToWorker: SendMetrics;                 // chrome.runtime.sendMessage({ type: "ghost:metrics", batch })
```

- `ghosts:shown` -> `ghostsShown`; `ghost:accepted` -> `ghostsAccepted`, `keystrokesSaved` (fill: value length) or `clicksSaved` (select, check: 1), and a pair `a: 1`; `ghost:dismissed` with `escape` or `typed` -> a pair `a: 0`. `refused` and a page that simply closed produce nothing. The locked Submit ghost is never judged.
- One timer from the first unsent event: a batch every 5 s, plus one on `pagehide`. At most 200 pairs per message; a batch the worker did not take is kept (bounded) and retried. Numbers and the ghost's source only: no label, signature or value.
- `cal` is true only for a `server` or `cache` ghost whose ledger assignment has `calibrated === true` (a pinned offline ghost is not Jev's number).
- `onTotals` gets stored lifetime + in flight + unsent; `index.ts` feeds it to `overlay.setSavedTitle(...)`, the `title` of the HUD's "saved" item. That item is the one hoverable spot of the overlay (`pointer-events: auto` while it has a title).

### `lib/messages.ts` and `lib/storage.ts` (metrics, profile)

```ts
export type MetricsCounters = Record<"ghostsShown" | "ghostsAccepted" | "keystrokesSaved" | "clicksSaved", number>;
export interface MetricsPair { c: number; a: 0 | 1; s: string; cal: boolean }   // s: the ghost's source (offline | server | cache | llm)
export interface MetricsBatch { counters: MetricsCounters; pairs: MetricsPair[] }   // deltas
export interface MetricsReply { ok: boolean; totals?: MetricsCounters }
export function sanitizeMetricsBatch(raw: unknown): MetricsBatch | null;   // whole counters <= 100,000, <= 200 well-formed pairs, null when empty
// storage.ts
export function updateProfile(mutate: (current: Profile) => Profile | null): Promise<Profile | null>;   // serialized read-modify-write
export function getMetrics(): Promise<StoredMetrics>;                     // MetricsCounters & { calibration: MetricsPair[] }
export function addMetrics(batch: MetricsBatch): Promise<StoredMetrics>;  // serialized; calibration capped at MAX_CALIBRATION_PAIRS (1000), newest kept
```

`ghost.metrics` is `{ ghostsShown, ghostsAccepted, keystrokesSaved, clicksSaved, calibration: Array<{ c, a, s, cal }> }`: the shape the options page reads, with `s` and `cal` as extra fields it may filter on.

### `background/metrics.ts`

`isMetricsMessage`, `handleMetricsMessage(message, deps?)`, `recordMetrics(raw, deps?)`, `forwardToServer(batch, deps?)`, `toServerEvent(batch)`. The worker is the ONE writer of `ghost.metrics` (tabs and frames cannot lose each other's counts): it rebuilds the batch (`sanitizeMetricsBatch`), adds it with `addMetrics`, and replies with the lifetime totals. In parallel, best effort and never retried, it POSTs `/v1/metrics/event` with `{ counters, calibration: [{ confidence, accepted }] }` holding ONLY the `cal` pairs (3 s deadline; nothing is sent when the server would refuse the body as empty). Routed in `background/index.ts` after the same `sender.id` check as every other message.

## Shared heuristic, option matching and safety patterns (`shared/src/`)

"A wrong ghost is worse than no ghost." The signatures did not change (`mapFieldToFact`, `mapFormHeuristically`, `resolveFieldValue`, `matchOption`, `isSensitive`, `isLockedAction`); what they promise did. The labelled corpus lives in `shared/test/heuristic.realworld.test.ts`.

### `heuristic.ts`

- Each rule has a **standard** pattern, an optional **loose** pattern, a **veto** and a **doubt** pattern, and the field **kinds** it may land in. Confidence tiers: standard phrasing >= 0.9 (`Current location` stays at 0.85), a standard phrasing found only in `name`/`id`/`placeholder` scores 0.08 lower, loose phrasing 0.72 to 0.85, doubt 0.6 (whose detail, or which polarity: "Work email", "authorized to work **without** sponsorship"), anything vetoed or unknown is `none` at 0.6.
- Kinds: names, location and city only on `text`; email on `text`/`email`; phone on `text`/`tel`; LinkedIn, GitHub, website on `text`/`url`; school, degree, major, country, province also on `select`; graduation date on `text`/`number`/`month`/`date`/`select`; the yes/no facts (`workAuthorization`, `requiresSponsorship`) only on `select`/`radio`/`checkbox`; `referralSource` on `text`/`select`/`radio`. Nothing else ever maps onto a checkbox or radio, through a label, a hint or an `autocomplete` token.
- A **confident none** (>= 0.9, which also makes the server skip the model for that field): buttons, links, files, consent checkboxes (0.99), demographic and EEO questions by label, identifier or an anchored section heading (0.99), search boxes (`type=search`, a "Search ..." label, `search`/`query`/`q`/`filter` in name, id or placeholder: 0.95). Every other `none` stays at 0.6 so a model can still weigh in.
- The applicant's own details (names, email, phone, links, place) are `none` when the label or an identifier names another party (reference, emergency contact, recruiter, manager, company...) or the section heading **starts with** one (headings are matched from their start only, because the nearest heading is often a job title). Place facts and a bare `Name` are `none` under an Education or Experience heading. The email fact is `none` for newsletter, job-alert and sign-in fields (label, identifier or heading) and for `autocomplete="username"`.
- `name`/`id` identifiers only count when they say nothing beyond the fact plus filler words: `job_application[first_name]` and `urls[LinkedIn]` map, `email_coupon` and `last_login` do not.
- The `type=email`/`type=tel` fallback is 0.8 only when the label is empty or not ASCII; next to a readable label that matched nothing ("To", "Send to") it is 0.6 or `none`.
- `needs_text`: textareas, minus prompts that want a fact a model does not have (pay, dates, counts, addresses, references). A one-line input only when the label is an open prompt longer than 20 characters; closed questions ("What is your current title?", "Do you ...?") are `none`.
- `mapFormHeuristically` adds two form-level passes that `mapFieldToFact` cannot make: a form whose only mapped fact is `email` maps nothing (newsletter box, login), and a loosely matched field yields when the same fact already has a standard match ("Website" + "Link").

### `resolve.ts`

- `matchOption` compares whole words, never substrings (the state code "AR" is not inside "Ontario"); an option that is only part of the fact must carry most of its keywords ("University" is not "University of Waterloo"); keyword overlap is measured against the larger set, stopwords ignored ("University of Toronto" is not "University of Waterloo"); yes/no is read from the option's first word or a `1`/`0`/`true`/`false` value; and two options that fit equally well resolve to `null` instead of the first.
- `resolveFieldValue` refuses a value that cannot belong in the input type (no `@` for `email`, no digits for `tel`, prose for `url`), since assignments may come from a model.

### `sensitive.ts` and `locks.ts`

- `isSensitive` also covers: date of birth, maiden name, security/challenge questions and answers, memorable words, bank, branch, transit and institution numbers, sort code, BSB, IFSC, CLABE, SWIFT/BIC, PIN code, CVN/CVD and card verification wording, "valid thru", national identity numbers (Aadhaar, NRIC, CPF, TFN, NHS, Medicare, PAN). `secret` and `swift` are now word-bound (not "Secretary", not "Swift experience"), and `MM/YYYY` next to education words is a date hint rather than a card expiry (`MM/YY` always is). `SENSITIVE_TEXT_SOURCE` uses lookbehind: it is for V8 (`new RegExp(source, "i")`), which is where it runs.
- `isLockedAction` also locks consent (agree, accept, allow, authorize, approve, reject, decline), account actions (register, sign up, create account, join, enroll, log out), money (subscribe, upgrade, start trial, deposit, refund, bid, book), destructive verbs (erase, purge, empty trash, clear all, reset, deactivate, revoke, uninstall, cancel/close + object), operations (merge, deploy, release, push, revert, run, execute, restart) and bare "Yes"/"OK". It no longer locks view-only controls ("Remove filter", "Clear all filters", "Reset zoom", "Apply filters") or look-alikes ("Post code", "Emergency contacts", "Autocomplete"). When unsure it still locks.
