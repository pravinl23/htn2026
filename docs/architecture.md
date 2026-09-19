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
- Buttons and links are captured with kind `button` / `link` and `locked` set from `isElementLocked`.
- Signature must be stable across reloads and must not contain the field's value: `tag|type|name|id|normalized label|index among same-label siblings`, hashed or joined. Never include user-typed content.
- Must work in jsdom (tests) where layout is absent: treat an element as visible when jsdom cannot measure it (`getBoundingClientRect` all zeros AND no `display:none`/`hidden` attribute). Export a `setVisibilityProbe(fn)` test seam if needed.

### `predict.ts`

```ts
export interface PredictDeps { profile: Profile; settings: GhostSettings; }
export function buildGhostsOffline(fields: CapturedField[], deps: PredictDeps): Ghost[];
export function ghostsFromAssignments(fields: CapturedField[], assignments: FieldAssignment[], deps: PredictDeps, source: GhostSource): Ghost[];
```

- Uses `mapFormHeuristically` + `resolveFieldValue` from `@ghost/shared`.
- Drops ghosts below `settings.confidenceThreshold` (confidence = assignment confidence x `confidenceFactor`).
- Never proposes a value for a field that already has a non-empty value (select: non-placeholder option chosen; radio: one checked).
- `needs_text` assignments produce no ghost in Stage 1 (Stage 3 adds streamed free text).
- Locked buttons produce a `click` ghost with `locked: true` ONLY for the last locked button of a form whose other ghosts exist (the "Submit" at the end), so the ghost cursor ends the walk parked on Submit with a lock. Tab never activates it.

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
}
```

- One host element `<div id="ghost-overlay-host">` appended to `document.documentElement`, with a **closed-over open shadow root** (`mode: "open"` so tests can inspect), `pointer-events: none`, `position: fixed; inset: 0; z-index: 2147483647`.
- Ghost text: gray (`rgba(120,120,135,.75)`) text absolutely positioned over the field, copying the field's font, padding, line-height and text-align from `getComputedStyle`; multi-line inside textareas; clipped to the field's box. Selects and radios show the option label as a small gray pill next to or inside the control.
- Ghost cursor: an SVG pointer that glides to the current target with a CSS transition (`transform 180ms cubic-bezier(.2,.8,.2,1)`), plus a soft highlight ring around the current element. A lock badge (padlock SVG + "Enter to confirm") is shown when the current ghost is locked.
- A small "Tab" keycap hint sits at the right edge of the current field.
- Test hooks on the host element (content scripts run in an isolated world, so tests read DOM attributes): `data-ghost-state="idle|ready"`, `data-ghost-count` (pending + current), `data-ghost-current` (signature of the current ghost or empty), `data-ghost-current-locked="true|false"`, `data-ghost-accepted` (count accepted so far).
- Respect `prefers-reduced-motion` (no glide).

### `execute.ts`

```ts
export interface ExecResult { ok: boolean; method: "native" | "click" | "debugger" | "none"; reason?: string }
export function executeGhost(ghost: Ghost, el: HTMLElement): Promise<ExecResult>;
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void;
```

- `fill`: focus, set value through the **native prototype value setter** (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set`), dispatch bubbling `input` then `change`, then verify `el.value === value` on the next microtask/animation frame. React controlled inputs must keep the value.
- `select`: `<select>` uses the native setter + `input` + `change`. Radio groups: find the radio with `value` in the same group and `.click()` it. `check`: `.click()` only when the checked state differs.
- If verification fails, ask the background worker: `chrome.runtime.sendMessage({ type: "ghost:debugger-fill", value })` after focusing and selecting the field's content; verify again. If `chrome.runtime` is unavailable (unit tests), return `{ ok: false, method: "none" }`.
- `click` ghosts that are `locked` are NEVER executed by this module: return `{ ok: false, method: "none", reason: "locked" }`.
- Refuse to touch sensitive elements (re-check with `isElementSensitive` right before writing).
- Mark programmatic events so the controller can tell them from user typing: set `el.dataset.ghostWriting = "1"` during the write and remove it after.

### `controller.ts`

```ts
export class GhostController {
  constructor(deps: { overlay: Overlay; getProfile(): Profile; getSettings(): GhostSettings; doc?: Document });
  start(): void;         // capture, predict, render, attach listeners (capture phase on window)
  stop(): void;          // detach everything and clear the overlay
  rescan(): void;        // debounce-called on DOM mutations and SPA navigations
  readonly state: { ghosts: Ghost[]; currentIndex: number; accepted: number; dismissed: Set<string> };
}
```

Tab semantics (non-negotiable, see CLAUDE.md):
1. Intercept `Tab` **only** when a current ghost is visible. Otherwise do nothing so Tab behaves natively. Never intercept Shift+Tab or Tab with Ctrl/Alt/Meta, and ignore key events while `event.isComposing`.
2. Tab on an unlocked current ghost: `preventDefault` + `stopPropagation`, execute it, mark accepted, make the next pending ghost current, move focus to the next ghost's element (scroll it into view if needed).
3. Tab on a **locked** current ghost: never activates it. Move focus onto the locked element so an explicit Enter or click activates it, and keep the lock badge visible.
4. Holding Tab (`event.repeat`): each repeat accepts the next unlocked ghost; on reaching a locked ghost, focus it and swallow further repeats. Never auto-activate.
5. Typing overrides: a trusted `input` event (not flagged `data-ghost-writing`) on a field with a pending/current ghost dismisses that ghost and advances.
6. `Escape` dismisses the current ghost (it does not come back for that field on this page load) and advances to the next one. Only `preventDefault` Escape when a ghost was actually dismissed.
7. Focus follows the user: when the user focuses a field that has a pending ghost, that ghost becomes current.
8. After every accept, verify the write; on failure, stop the walk, leave remaining ghosts pending, and surface the reason in the HUD (`data-ghost-error` on the host).
9. Never create ghosts for fields that already have a value, and never overwrite user-entered text.

### `index.ts`

Loads settings and profile from `chrome.storage.local` (through `src/lib/storage.ts`), starts the controller when `settings.enabled`, reacts to `chrome.storage.onChanged` and to the `ghost:toggle` runtime message. Skips pages where `location.protocol` is not http/https.

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
  | { type: "ghost:debugger-fill"; value: string }
  | { type: "ghost:debugger-click"; x: number; y: number };
```

Storage keys: `ghost.profile`, `ghost.settings`.

## Background worker (`extension/src/background/`)

- `chrome.commands` `toggle-ghost` and `chrome.action.onClicked` flip `settings.enabled`; badge text shows `ON`/`OFF`.
- `ghost:debugger-fill`: `chrome.debugger.attach({tabId}, "1.3")`, `Input.insertText`, detach. `ghost:debugger-click`: `Input.dispatchMouseEvent` pressed + released. Always detach in `finally`. Reply `{ ok: boolean, error?: string }`.
- On install: seed the demo profile and default settings.

## Options page (`extension/src/options/`)

Plain TypeScript + DOM (no framework). Shows the profile as editable JSON with validation, the settings (enabled, threshold slider 0.5..0.95, server URL, HUD toggle, learning toggle), and a "Reset to demo profile" button.

## E2E conventions (`e2e/`)

- `e2e/fixtures.ts` exports a Playwright `test` with a `context` fixture that launches `chromium.launchPersistentContext` with `--disable-extensions-except` and `--load-extension` pointing at `extension/dist`, `channel: "chromium"` (new headless supports extensions), video recording on, and an `extensionId` fixture read from the service worker URL.
- Tests wait for `#ghost-overlay-host[data-ghost-state="ready"]` instead of sleeping.
- Tests must assert that Submit/Send was NOT triggered: demo pages set `window.__submitted = true` and render `data-testid="submitted"` on submit.
- Never touch a non-localhost URL.
