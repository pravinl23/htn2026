# Ghost architecture and module contracts

This file is the contract between modules. If you change a signature here, change every caller in the same commit.

## Packages

| Package | Role |
| --- | --- |
| `shared/` (`@ghost/shared`) | Types and pure logic used by both the extension and the server: `CapturedField`, `Ghost`, `Profile`, the Jev-shaped decision interface, heuristic field mapping (`mapFieldToFact`), value resolution (`resolveFieldValue`), and the safety rules (`isSensitive`, `isLockedAction`). No DOM, no Node APIs. |
| `extension/` | Chrome MV3 extension built with esbuild (`node build.mjs`) into `extension/dist`. |
| `server/` | Hono prediction service on `http://localhost:8787`. Keys live here, never in the extension. |
| `demo/` | Vite + React demo sites on `http://localhost:5173`. `demo/public/apply-plain/index.html` is framework-free. |
| `e2e/` | Playwright tests that load `extension/dist` into Chromium and drive the demo sites. |

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
- `needs_text` assignments produce no ghost in Stage 1 (Stage 3 adds streamed free text).
- Locked buttons produce a `click` ghost with `locked: true` ONLY for the last locked button of a form whose other ghosts exist (the "Submit" at the end), so the ghost cursor ends the walk parked on Submit with a lock. Tab never activates it. `CapturedField` carries no form id, so "the form's submit" is approximated: locked `button` fields after the last value ghost (all locked buttons when there are none after it), preferring a primary-looking label (submit, send, apply, continue...) and otherwise the last one. Links never get a lock ghost. The lock ghost is always the LAST entry of the returned list.
- `keepLock: true` keeps the lock ghost even when no value ghosts remain. The controller passes it once the walk has accepted something, so a rescan after the last field does not un-park the cursor. With `lockSignature` set, only that button is kept (or nothing): the controller passes the Submit its walk was heading for, so a later view's "Delete all messages" can never inherit the lock ghost.
- Value ghosts are re-checked with the shared `isSensitive` (assignments may come from a server) and skipped when the resolved value equals the current one (an already-correct checkbox).

### `overlay.ts`

```ts
export class Overlay {
  constructor(doc?: Document);
  render(state: OverlayState): void;   // idempotent; called on every state change, scroll and resize
  destroy(): void;
}
export interface OverlayState {
  ghosts: Array<{ ghost: Ghost; el: HTMLElement; status: "pending" | "current" }>;
  hud?: { provider: string; latencyMs: number | null; cache: "hit" | "miss" | "offline"; keystrokesSaved: number };
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

Rescans: a `MutationObserver` on `documentElement` (childList + an attribute allowlist that leaves out `value` and every `data-ghost-*` churn attribute but includes what can reclassify a field: `type`, `autocomplete`, `data-sensitive`, `tabindex`; ignoring our host and page style) triggers a debounced rescan and, while ghosts exist, a `requestAnimationFrame`-throttled re-render. `class` and `style` records only count when their target is or contains a control, so a carousel or progress bar animating through inline style does not re-capture the document forever; scroll (capture, passive) and resize re-render only. URL changes are caught by `popstate`, `hashchange`, the Navigation API (`currententrychange`) when present, and a 500 ms `location.href` poll, because the page's `pushState` cannot be patched from the isolated world. A rescan never runs while a write is in flight. The HUD reports provider `offline-heuristic`, cache `offline`, the capture + predict time as latency, and only shows once there is something to show (ghosts, accepts or an error).

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
  | { type: "ghost:debugger-click"; x: number; y: number; target: string };
export interface DebuggerReply { ok: boolean; error?: string }
export function isGhostMessage(msg: unknown): msg is GhostMessage;
```

Storage keys: `ghost.profile`, `ghost.settings`.

## Background worker (`extension/src/background/`)

- `chrome.commands` `toggle-ghost` and `chrome.action.onClicked` flip `settings.enabled`; badge text shows `ON`/`OFF`.
- `ghost:debugger-fill`: `chrome.debugger.attach({tabId}, "1.3")`, `Input.insertText`, detach. `ghost:debugger-click`: `Input.dispatchMouseEvent` pressed + released. Always detach in `finally`. Reply `{ ok: boolean, error?: string }`.
- Real input lands on whatever is focused or under the point when it finally runs (after a message hop, a worker wake-up and an attach whose infobar reflows the page), so each request is re-validated inside the page with `Runtime.evaluate` right before the input: a fill requires `document.activeElement` to carry the request's `data-ghost-target` token, to be a text field, and to pass the shared sensitive patterns (`SENSITIVE_TEXT_SOURCE`, inlined); a click ignores the message's coordinates, recomputes the point from the tokened element, requires it to be a checkbox or radio that `elementFromPoint` really returns, and checks again after `mouseMoved` that the page did not move. Anything else is refused with a reason.
- An attach that fails with "already attached" detaches once and retries: a worker torn down mid-job leaves its own session behind. When DevTools really holds the tab the retry fails and the error is reported.
- Permissions are `storage` and `debugger` only. Content scripts are injected declaratively, `sender.tab.id` needs no `tabs` permission, and nothing in the extension fetches yet. Stage 2 adds `host_permissions` for the prediction server origin only (`http://localhost:8787/*`).
- On install: seed the demo profile and default settings.

## Options page (`extension/src/options/`)

Plain TypeScript + DOM (no framework). Shows the profile as editable JSON with validation, the settings (enabled, threshold slider 0.5..0.95, server URL, HUD toggle, learning toggle), and a "Reset to demo profile" button.

## E2E conventions (`e2e/`)

- `e2e/fixtures.ts` exports a Playwright `test` with a `context` fixture that launches `chromium.launchPersistentContext` with `--disable-extensions-except` and `--load-extension` pointing at `extension/dist`, `channel: "chromium"` (new headless supports extensions), video recording on, and an `extensionId` fixture read from the service worker URL.
- Tests wait for `#ghost-overlay-host[data-ghost-state="ready"]` instead of sleeping.
- Tests must assert that Submit/Send was NOT triggered: demo pages set `window.__submitted = true` and render `data-testid="submitted"` on submit.
- Never touch a non-localhost URL.
