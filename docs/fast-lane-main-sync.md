# Fast Lane integration record

Branch: `codex/universal-next-action`

Main merged: `origin/main` at `9d5a82e` via merge commit `36def16`

This file records the choices made while combining main's learning/safety work with the generic next-action work on this branch. It is intentionally a decision log, not a claim that every future Sentry-backed memory feature is complete.

## Brought in from main

- **Sentry walk outcomes and replay evaluations.** Kept `ghost.walk-outcome.v1`, `/v1/walk/outcomes`, the server-side Sentry sink/scrubber, replay fixtures, and the extension `WalkOutcomeReporter`. This is the durable, privacy-safe learning/diagnostic path for form walks.
- **Answer engine and learned-answer store.** Kept `shared/src/answers/**` unchanged. It owns field-answer classification, conservative guesses, question signatures, and corrected answer storage.
- **Required-field and loop safety gates.** Kept `shared/src/form/**`, `shared/src/loop/safety.ts`, and the corresponding extension gates so generic prediction cannot bypass incomplete required fields or confirmation rules.
- **Page-owned Tab surfaces.** Kept `tabSurface.ts` and its gate in `nextAction.ts`. Editors and applications that explicitly own Tab remain in control.
- **Walk telemetry privacy boundary.** Sentry receives only the validated, value-free outcome envelope. Its final `beforeSend` scrubber rebuilds the event instead of trusting ambient SDK scope.
- **Native/Desktop and documentation work.** All files merged from main remain present; this branch does not replace the native macOS implementation.

## Kept from this branch

- **Generic semantic candidate ranking.** Search, commerce, media, dialogs, main content and repeated result cards compete by semantic/structural salience instead of raw DOM order. This is necessary on Amazon-, YouTube- and app-style pages with large headers.
- **Broad interactive capture.** App controls such as tabs, menu items, switches, tree items, custom labelled controls and summaries remain eligible through the existing capture layer.
- **SPA mutation rescans.** A bounded observer waits for hydration but cannot postpone prediction beyond 1.2 seconds. Main's one-shot 300 ms timer missed controls added after initial load.
- **Repeated-group memory.** Value-free list shapes let a learned preference for a result/card transfer when item labels change.
- **Recent same-site behavior.** Exact state memory is tried first; a compatible recent action on the same origin is the fallback. Origin evidence prevents cross-site leakage.
- **Safe best-effort guesses.** Unknown pages still receive a low-confidence suggestion. Locked actions remain focus-only, so guessing never turns Tab into submit, send, purchase, delete or confirmation.
- **Non-empty-field progression.** Completed text inputs leave the candidate pool, preventing Ghost from getting stuck on the same search field.
- **Local search values.** Search-like values are retained only in `chrome.storage.local`, scoped by origin, and never included in `/v1/predict/next` or telemetry.

## Hybrid decisions

- **Instant local answer; asynchronous model upgrade.** The next-action client now answers from local memory or the local ranker without waiting 800–2500 ms. A calibrated server result warms a bounded five-minute cache and may improve the next rescan. Uncalibrated cold-start server heuristics never erase a learned local habit.
- **One Fast Lane memory contract.** `FastLaneMemory` composes the existing persisted state-to-action edge store with private query memory. Runtime callers depend on that contract rather than `chrome.storage` directly.
- **Sentry-ready but never Sentry-blocked.** `FastLaneMemorySink` is the adapter seam for the Sentry stream. Its record schema cannot represent origins, URLs, labels, signatures, state text or typed values, and sink writes are fire-and-forget. The local graph remains the synchronous serving layer; Sentry must never sit between a Tab press and its ghost.
- **Confidence communicates exploration rather than suppressing all guesses.** The Fast Lane can display a low-confidence safe suggestion because the user explicitly asked Ghost to always make a best guess. Irreversible controls still use the independent lock policy.
- **Reliable extension presence after configuration.** Main's extension/desktop heartbeat is retained, with one startup-race fix: if the server setting changes while the first heartbeat is in flight, one fresh beat is queued for the new server. This keeps Desktop from drawing a competing ghost without adding work to the Tab path.

## Internal graph status

No pushed branch contains a separate graph database dependency or service. The existing internal behavioral graph is:

```text
state summary node ──[user chose, count, recency]──> action/affordance node
       │
       └── origin evidence prevents an edge learned on one site from serving another
```

It is persisted as bounded JSON under `ghost.memory`; recent ordered observations live in the session trace. `FastLaneMemory` makes that representation replaceable. A future database or Sentry-derived graph can implement the same interface without changing candidate collection, Tab handling, or the visible Ghost loop.

## Ownership boundary

- Fast Lane next-action ranking and Chrome runtime adapter: this branch.
- Field-answer policy and required-field gates: main's `shared/src/answers/**` and `shared/src/form/**`.
- Sentry ingestion, scrubbing and replay evaluation: main's walk telemetry modules.
- Native macOS affordance/page-kind work: the native agent stream.

## Verification at integration time

- Full workspace typecheck: passed.
- Production extension and demo builds: passed.
- Workspace unit and replay suites: passed (2,607 tests/evaluations before the heartbeat regression test; extension now has 923 passing tests).
- Full Playwright suite: 53/53 passed, including Sentry walk telemetry, page-owned Tab behavior, extension presence, generic next action, and corrected-search learning.

## Live-site hardening after integration

Tested through the user's installed Chrome extension, not the local demo:

- **Google:** cold-start search focus worked and Tab focused the real search box. On a results page, Ghost initially chose the adjacent “Search by voice” utility instead of a result. Generic input-accessory demotion now ranks result content above voice/image/clear controls; Tab navigation to the chosen result was verified live.
- **YouTube:** Ghost focused the real search box, accepted a query, selected a result, and Tab navigated to the watch page. The selected cold-start result remains exploratory until preference history accumulates.
- **LinkedIn:** Ghost rendered on the live feed. “Start a post” was correctly locked and shown as Enter-to-confirm, explaining why Tab intentionally focuses rather than clicks consequential controls.
- **Google Docs:** the form-walk surface could prevent the separate next-action surface from starting. The three content surfaces now start independently, so a failure in form capture or loop UI cannot disable Fast Lane.
- **Dropdowns:** custom comboboxes and `aria-haspopup` controls are captured as openers; visible options/menu items receive recommendation priority; Tab opens native selects through `showPicker()` when available. Escape now immediately asks for the next recommendation instead of leaving Ghost idle.
