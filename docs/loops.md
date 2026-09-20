# Action trace, next-action prediction, and "Do it twice, Shabang does the rest"

Design and implementation status for PLAN.md Stages 5 and 6.

## Current implementation boundary — 2026-09-19

- **Implemented:** shared trace types/normalization/shape logic, episodic memory, repeat detection, alignment, source matching, loop synthesis/program planning and adversarial tests; server `/v1/predict/next` and `/v1/loop/synthesize`; server-side parallel/API executor infrastructure.
- **Not implemented:** extension trace/page-fact capture, background trace persistence, next-action requests, click ghosts beyond the form walk, loop proposal/preview/confirmation UI, visible/background loop execution and Stage 5/6 e2e.
- The detailed client behavior below remains the target contract until those extension modules exist. Statements about what "the content script" or "background worker" does in Sections 1, 2, 3.4 and 3.5 are plans, not current behavior.

## 1. Action trace (Stage 5 — shared types implemented, extension recorder planned)

```ts
// shared/src/trace/types.ts
export type TraceEventType = "click" | "input" | "select" | "check" | "navigate" | "tabswitch" | "submit";

export interface TraceTarget {
  signature: string;        // capture.ts signature
  label: string;            // accessible name (never a sensitive field: those are not recorded at all)
  kind: FieldKind;
  locked: boolean;
  /** Set when the element sits inside a repeated list/table: a stable selector for the list and the item's index and key text. */
  list?: { listSignature: string; index: number; itemKey: string };
  /** Grid coordinates when the target is a cell in a table/grid (row/col indexes and the column header text). */
  cell?: { row: number; col: number; colHeader: string };
}

export interface TraceEvent {
  t: number;                // epoch ms
  tabId: number;
  type: TraceEventType;
  origin: string;
  /** Pathname with volatile segments generalized: /invoices/INV-1042 -> /invoices/:id (digits, uuids, ids with digits). */
  pathPattern: string;
  url: string;              // origin + pathname only, never query strings or fragments
  target?: TraceTarget;
  /** Final value of an input/select (one event per field edit, emitted on change/blur, not per keystroke). Masked as "•••" if the field became sensitive. */
  value?: string;
}
```

- The content script records; the background worker owns the trace (ring buffer of 400 events in `chrome.storage.session`, survives worker sleep, cleared on browser restart). Nothing is sent to the server except the last 20 normalized events for `/v1/predict/next`, and only while Shabang is enabled.
- Shabang's own programmatic actions (`data-ghost-writing`, executor clicks) are tagged `synthetic: true` and ignored by the loop detector's "did the user do it twice" rule but recorded for episodic memory.
- Never record anything from sensitive elements (not even that an event happened on them).

### Page facts (needed for generalizing values)

When a page settles (and on rescan), the content script extracts **page facts**: visible labeled values that a user could plausibly copy.

```ts
// shared/src/trace/pageFacts.ts
export interface PageFact { locator: FactLocator; label: string; text: string }
export type FactLocator =
  | { by: "testid" | "data-field" | "id"; value: string }
  | { by: "label"; value: string }                      // dt/dd, th/td, "Label: value" pairs, aria-labelledby
  | { by: "css"; value: string };                       // last resort, short structural selector
```

Sources in priority order: `[data-field]`/`[data-testid]` elements with short text, `<dt>/<dd>` pairs, two-column table rows, `label: value` text lines, headings. Max 80 facts per page, text <= 200 chars, skip anything sensitive-looking (`isSensitive` on the label). The background keeps the latest facts per (tab, pathPattern) and a short history per URL so the generalizer can look up "where did this typed value come from".

**List sizes** travel inside the same `ghost:page-facts` report (no separate round trip: when the second run ends, the list tab usually shows an item page and could not answer). Per repeated list, first in the report: `{ locator: { by: "css", value: <listSignature> }, label: "ghost:list-length", text: "<item count>" }` and optionally `label: "ghost:list-handled", text: "0,1,7"` (items already showing a handled marker). The trace store keeps them apart from ordinary facts (`traceStore.listInfo`), so they never reach the generalizer or the server. Without a total, no loop is proposed; the next facts report retries.

## 2. Next-action prediction (Stage 5: server implemented, extension client in progress)

- After each user action settles (300 ms debounce) and no form ghosts are pending, the content script sends candidates (visible buttons/links/fields, max 60, filtered in code: in viewport or near it, not in nav chrome unless recently used) plus the last 20 events to `POST /v1/predict/next` (see docs/server-api.md). ONE choice question over candidate ids plus `none`.
- **Episodic memory**: background stores `(stateSummary, action)` pairs where `stateSummary = pathPattern + the last 3 event shape keys` (see 3.1). Top 5 most similar pairs (exact key match first, then Jaccard over tokens) are included in the request as `memory`. The heuristic provider predicts purely from memory: if the same state summary was followed by the same action at least once before, propose it with confidence 0.75 (once) / 0.9 (twice or more).
- Result above threshold becomes a `click` ghost (ghost cursor glides to it). Tab clicks it unless locked. Locked targets only get the lock badge and focus.
- Cross-page values: when a field is focused/empty and its label semantically matches a recent page fact or a recently picked value (e.g. a calendar slot picked on `/calendar`, then a reply box on `/mail`), propose a fill ghost. For the mail/calendar demo the reply draft comes from `/v1/shabang-text` with `pageContext.description` containing the email text and `facts.pickedSlot`.

## 3. Loop engine (Stage 6)

### 3.1 Shape keys

`shapeKey(e) = type | pathPattern | targetShape` where `targetShape` is `label#kind` for ordinary targets, `LIST(listSignature)` for list items (index removed), `CELL(colHeader)` for grid cells (row removed). Values are never part of the key.

### 3.2 Detector: `detectLoop(events: TraceEvent[]): LoopCandidate | null`

- Consider only the user's non-synthetic events of the last 10 minutes on the same tab group.
- Find the longest tandem repeat at the tail of the key sequence: the largest `L >= 3` with `keys[n-2L .. n-L) == keys[n-L .. n)`. Tolerate noise by first dropping consecutive duplicate keys and no-op events (focus-only clicks on the page body, repeated clicks on the same target within 500 ms).
- Reject when the two runs are identical in every detail (same list index, same values): that is a redo, not a loop. Require at least one list-index change or value change.
- Returns `{ length: L, runA: TraceEvent[], runB: TraceEvent[] }`.

### 3.3 Aligner + generalizer: `synthesizeProgram(candidate, factsByUrl): LoopProgram | null`

For each aligned step pair:
- identical target and value: **constant** step.
- list targets with `indexB == indexA + 1` (or a consistent stride): the **iterator**. `iterator = { origin, pathPattern, listSignature, stride, nextIndex: indexB + stride }`. Items already handled are skipped by index, and by a handled marker when the list shows one (item key text present in the destination, or an item state class like "replied").
- grid cell targets where the row advanced by one: **append row** semantic (`row: "next-empty"`), column fixed by `colHeader`.
- input values that differ: find a page fact visited earlier in the same run whose text equals the value (exact, then normalized: trim, case, currency/number formatting, date formats parsed in code). The same locator must explain BOTH runs. Result: `valueFrom: { pathPattern, locator, transform? }`. If no locator explains both runs, the step is unresolved: ask `POST /v1/loop/synthesize` (LLM, only when heuristics fail) and otherwise mark the row low-confidence.
- navigations whose URLs differ only in the id segment are derived from the iterator item (implicit: caused by clicking the item) and carry no separate step.

```ts
export interface LoopProgram {
  id: string;
  name: string;                       // e.g. "Copy invoice fields to sheet and reply"
  iterator: { origin: string; pathPattern: string; listSignature: string; stride: number; nextIndex: number; total?: number };
  steps: LoopStep[];
  irreversible: Array<{ stepIndex: number; description: string }>;   // from locked targets
  confidence: number;
}
export type LoopStep =
  | { op: "open-item" }                                                   // click the iterator's current item
  | { op: "extract"; var: string; from: { pathPattern: string; locator: FactLocator; transform?: "number" | "date-iso" | "trim" } }
  | { op: "goto"; origin: string; pathPattern: string; url: string }      // constant navigation (e.g. the sheet)
  | { op: "fill"; target: StepTarget; value: { var: string } | { const: string } }
  | { op: "click"; target: StepTarget; locked: boolean };
export type StepTarget = { signature?: string; label: string; kind: FieldKind; cell?: { row: "next-empty"; colHeader: string } };
```

### 3.4 Preview grid (planned)

When a loop is detected, Shabang shows a bottom sheet: "You did this twice. Shabang can do the remaining N." with a grid: one row per remaining item, one column per variable, extracted by **dry run**: load each item URL in a pool of 4 hidden same-origin iframes, wait for the locator, read the text, apply the transform. Each row has a confidence (1.0 exact locator hit, 0.6 fallback locator, 0 missing) and low-confidence rows are flagged and unchecked by default. The footer lists every irreversible effect with counts (e.g. "Send reply 'Received' x 48") and has ONE confirmation control. Tab focuses the confirm button; only an explicit Enter or click on it starts the run (it is a locked action).

### 3.5 Executor (extension visible/background modes planned; server parallel/API modes implemented)

- The background worker owns the run state (`chrome.storage.session`): program, item queue, per-item status, mode. Content scripts ask "is there an active run for this tab?" on load and execute the steps for their page, so runs survive full page navigations.
- Modes: `visible` (ghost cursor moves, about 120 ms per step, real navigation in the tab), `background` (hidden iframes; used by default for > 10 items so 48 items finish in seconds), `parallel` (Browserbase, Stage 8), `api` (Composio, Stage 8).
- After each step verify (value stuck, row appended, item marked handled). Stop the whole run on the first mismatch and show which item failed; never retry an irreversible step.
- Irreversible steps run only after the batch confirmation and are counted in the final report.
- A run can be cancelled with Esc at any time.

**How it is built** (`background/loopRunner.ts`, `content/loop{Content,Driver,Executor,Surface}.ts`, shared rules in `lib/loopRouting.ts`):
- **Pull protocol.** The page asks (`ghost:loop-step-request` with its path pattern), runs the one step it gets, reports (`ghost:loop-step-result`), and finds the next step in the reply. A fresh content script just asks again. In background mode the list tab's content script does the asking and runs the steps in hidden same-origin frames (one per item, one per constant page such as `/sheet`, loaded once).
- **Locked steps have a commit point.** A locked order is *armed* only when it answers a request sent from the step's own page. The executor refuses an unarmed or unconfirmed locked step; the worker refuses its result. An armed step that is asked for again means its result was lost: the run fails with `irreversible-unverified` instead of clicking twice (in a visible run, a page that moved on counts as the click's effect).
- **Reserved variables** ride in `LoopStepOutcome.extracted`: `@itemUrl` (the page open-item opened, origin + pathname) and `@row|<pathPattern>` (the row the item's first `next-empty` fill picked; its other cells reuse it). A frame or a locked step only ever runs on the exact `@itemUrl`, never on "some page with that pattern".
- **Report first, then navigate.** In the real tab, open-item and link clicks that only navigate report their outcome before clicking, because a full page load would end the script with the result unsent. The next step verifies the page it lands on. In frames such links are skipped: frames are loaded by url.
- **Verification.** Extracted values must be non-empty and equal to what the confirmed preview showed (`value-changed`); fills must stick (`value-mismatch`); an item that already shows a handled marker is never opened (`item-handled`); a new `role=alert` after a click is a refusal (`action-rejected`). Everything the run's tab records during a run is tagged synthetic by the worker.

## 4. Demo sites

- `/invoices`: inbox of 50 invoice emails (deterministic seeded data: vendor, invoice number `INV-1xxx`, date, total). Clicking one opens `/invoices/:id` with the invoice fields rendered as `<dl>` with `data-field` attributes and a "Reply: received" button (locked, marks the email as replied in localStorage; NOT a real send). Replied and logged states are visible in the inbox list.
- `/sheet`: spreadsheet grid (columns Vendor, Invoice #, Date, Total, 60 rows) persisted in localStorage and synced across tabs/iframes via the `storage` event. Cells are inputs; `window.__sheet` exposes the rows for tests.
- `/mail` + `/mail/:id` and `/calendar`: the "can we meet Thursday afternoon?" demo surface. Calendar shows a week with busy blocks and one free Thursday afternoon slot; picking it stores `pickedSlot` in localStorage. The textarea is compatible with programmatic fills and **Send is locked**, but Shabang does not yet navigate the flow or draft the reply.
- All demo state resets with `/reset` or `?reset=1` so e2e runs are deterministic.
