# Ghost build plan

This is the implementation ledger. Check a box only when the item works on its intended user path and its tests pass. A server route or pure helper alone does not make a feature complete; partial work is called out explicitly below.

## Current snapshot — 2026-09-19 19:09 UTC

- **Demoable now:** browser form capture, offline prediction, ghost overlay, Tab/Escape/hold-Tab interaction, verified React-safe writes, sensitive-field exclusion, locked actions, settings/profile editing, and the `/apply` walkthrough.
- **Connected extension path:** server-upgraded form prediction, per-form cache, HUD, streamed ghost text, resume import, learning, metrics, trace/page-fact capture, loop proposal/preview and confirmed execution are implemented.
- **Jev computer use:** `Alt+Shift+J` now runs a value-private observe/decide/verify loop through `/v1/agent/next`. The loaded-extension `/apply` proof passes keyless and with direct TypeSafe/Jev (8.3 s live): safe fields filled, consent untouched, zero Submit attempts.
- **Workflow showcase:** `/workflow/index.html` runs meeting coordination and Slack → GitHub issue stories through one Jev choice per step and simulated Composio execution.
- **Native:** the stable Objective-C host, hot-swappable library, Accessibility harness and 201 tests exist; the atomic `GHWorkflowCoordinator` seam is not connected to the main desktop pipeline.
- **Top priority:** prove the canonical invoice loop in loaded-extension e2e: two demonstrations, preview 48, flag one intentional exception, explicitly confirm once, execute/verify 47, then record the fallback video.
- **Verified baseline:** build and typecheck pass; 2,046 JS/TS unit tests, the replay eval, 201 desktop tests and 35 browser e2e tests pass. The prior 95-check demo smoke run was not repeated after this integration.

Demo profile (fictional, use everywhere, never real data):
Alex Chen, alex.chen.dev@example.com, +1 519 555 0142, Waterloo ON, University of Waterloo, BCS Computer Science, expected graduation April 2028, github.com/alexchen-dev, linkedin.com/in/alexchen-dev, alexchen.dev, authorized to work in Canada: yes, requires sponsorship: no.

---

## Stage 0: Bootstrap

- [x] pnpm workspace with packages `extension`, `server`, `demo`, `e2e`; shared `tsconfig.base.json` (strict); root `.gitignore` (node_modules, dist, .env, test-results, playwright-report) and `.env.example` listing the keys from CLAUDE.md.
- [x] Root scripts: `pnpm dev` (server on 8787 + demo on 5173), `pnpm build` (extension to `extension/dist`), `pnpm test` (all unit tests), `pnpm e2e` (Playwright), `pnpm test:live` (only runs with real keys).
- [x] README.md: one-paragraph pitch, how to run, how to load the extension (`chrome://extensions`, Developer mode, Load unpacked, select `extension/dist`).

**Acceptance:** fresh clone, `pnpm install && pnpm build && pnpm test` all succeed.

## Stage 1: The base, Tab through a form (no AI yet)

- [x] `demo/apply`: realistic job application for a fictional company ("Northwind Robotics, Software Engineering Intern"), about 20 fields: first/last name, email, phone, location, LinkedIn, GitHub, portfolio, school, degree, graduation date, work authorization (select), sponsorship (radio), how did you hear (select), "Why Northwind?" (textarea), "Tell us about a project" (textarea), resume upload (stub), Submit. Built with React controlled inputs so the input-execution path is tested for real. Also `demo/apply-plain` as plain HTML.
- [x] Extension skeleton (MV3): content script on localhost and all http/https pages (with an on/off toggle), background service worker, options page. Keyboard shortcut to toggle Ghost.
- [x] Capture: enumerate visible interactive elements with accessible names (aria-label, aria-labelledby, label[for], wrapping label, placeholder, nearby text), types, options, bounding boxes, and a stable element signature. Unit tests with jsdom fixtures.
- [x] Profile store in `chrome.storage.local`, seeded with the demo profile; options page shows and edits it as JSON.
- [x] Heuristic provider in the extension for now: map field labels to profile facts by keywords.
- [x] Overlay in a shadow DOM root: ghost cursor (SVG pointer) that glides to the target with a CSS transition, highlight ring, gray ghost text positioned inside the field.
- [x] Tab semantics exactly as CLAUDE.md describes (accept and advance, type to override, Esc dismiss, hold Tab to accept all, stop at locks).
- [x] React-safe input execution with verification; `chrome.debugger` fallback from the background worker.
- [x] Locks on submit and other irreversible buttons; never touch password or card fields.
- [x] E2E: load extension, open `/apply`, press Tab repeatedly, assert every field equals the demo profile value, assert Submit was NOT clicked. Record video to `docs/media/stage1-form.webm`.

**Acceptance:** the e2e passes and the video shows the ghost cursor walking the form.

## Stage 2: Prediction service and Jev

- [x] `server/` with Hono on Node 22: `GET /v1/health` reports the active provider; CORS limited to the extension and localhost.
- [x] Provider interface and all four server providers with the precedence from CLAUDE.md, including timeout/fallback behavior and validation.
- [x] Make the server the extension's primary form predictor while retaining the current in-process heuristic as the offline fallback.
- [x] `POST /v1/predict/form`: input is fields (signature, label, type, options) plus profile fact keys; ONE batched decision call with a choice question per field over `[...factKeys, "needs_text", "none"]`; output is assignments with confidence, provider name, and latency.
- [x] Extension calls the server once per form, caches the mapping per origin plus form signature, and makes zero calls on repeat visits.
- [x] Confidence gating with a threshold setting in the options page.
- [x] Toggleable HUD with provider, latency, cache state, text-generation timing and actions saved.
- [x] Provider adapter tests, exact Jev request contract tests, and key-gated live provider tests.

**Acceptance:** with no keys everything still works through the heuristic provider; with keys the live test passes and logs latency.

## Stage 3: Free-text ghost text

- [x] `POST /v1/ghost-text` (streaming): field label, page context (company, role, visible job description text), relevant profile facts, and past answers; returns a draft in the user's voice. Template fallback with no LLM key.
- [x] Speculative generation: when a form is detected, start generating every free-text field in the background and cache the results.
- [x] Multi-line ghost text inside textareas; Tab accepts the whole draft; typing overrides.
- [x] E2E: textareas get non-empty text on Tab; record latency.

## Stage 4: Resume import and learning

- [x] Server `POST /v1/profile/extract` with LLM and deterministic regex fallback, plus fixture and live tests.
- [x] Options page: paste resume text or upload a PDF and call `POST /v1/profile/extract`; user reviews and saves the proposed facts.
- [x] Opt-in learning: values the user types manually into recognized fields become new facts; answers to essay questions are saved as past answers.
- [x] Fixture-backed extraction mapping tests using the fictional resume in `demo/fixtures/`.

## Stage 5: Next-action prediction beyond forms

- [x] Shared normalized trace types, filtering/shape logic, and episodic-memory retrieval.
- [x] Action trace recorder in the extension/background worker (clicks, typing, navigation, tab switches); sensitive values masked.
- [x] Server `POST /v1/predict/next`: recent actions plus up to 60 candidate elements; one choice question over candidates plus `none`; returns candidate and confidence.
- [ ] Extension client for `/v1/predict/next` and candidate capture.
- [ ] Ghost cursor for clicks on buttons and links; Tab clicks unless locked.
- [x] Connect episodic memory to recorded extension actions. Retrieval is implemented, but `/v1/predict/next` is not yet requested by the extension.
- [x] `demo/mail` and `demo/calendar`: an email asks "can we meet Thursday afternoon?"; a user can open the calendar, pick the free Thursday slot, return to the email, fill the React-controlled reply, and reach locked Send. Ghost orchestration/drafting is not part of this checkbox.
- [ ] E2E for that cross-page flow using only Tab presses (and a final explicit confirm that the test does NOT press).

### Stage 5A: Jev computer-use runner

- [x] Shared closed operation/candidate/history contract and strict server/extension validation.
- [x] `POST /v1/agent/next`: one Jev call chooses an operation and compatible target; opaque ids and values are withheld from the provider.
- [x] Browser adapter and runner: observe, freshness-check, execute through the existing writer, verify state change, stop on no progress/step budget/invalid target.
- [x] Closed-shadow command panel on **Alt+Shift+J**, with provider, latency, confidence and stop reason.
- [x] Loaded-extension e2e for the full safe `/apply` run; deterministic and live TypeSafe/Jev paths both pass.
- [ ] Add a second action-heavy/page-changing scenario so `CLICK`, navigation and `WAIT` are demonstrated, not just value operations.
- [x] Send strictly redacted agent failure/outcome envelopes through an opt-in Sentry sink and turn blocked outcomes into reviewable replay/eval cases. The no-DSN path and scrubber are tested; live delivery awaits a project DSN. Production failures never rewrite prompts or policy automatically.
- [ ] Record a fallback video of the live Jev run and add it to the judging script.

## Stage 6: Do it twice, Ghost does the rest

- [x] `demo/invoices`: an inbox of 50 invoice emails, each opening an invoice view with vendor, invoice number, date, total; `demo/sheet`: a simple spreadsheet grid; each email has a "Reply received" action.
- [x] Pure loop detector: find a repeated action subsequence (3 or more steps) that occurred twice; reject redos and noise.
- [x] Pure aligner/generalizer: infer the iterator, constants, variable sources and transforms; output a JSON program and expose unresolved steps.
- [x] Server `/v1/loop/synthesize`: use the LLM only for unresolved mappings and accept only code-verified answers.
- [x] Preview grid: dry-run extraction for every remaining item, with confidence per row and low-confidence rows flagged.
- [x] Executor: visible/background modes with verification, stop-on-mismatch and one explicit batch confirmation; remote Browserbase/Composio modes route through the server.
- [x] Extensive unit/adversarial tests for loop detection, alignment, synthesis, transforms and refusal behavior.
- [ ] E2E: perform two invoices manually, accept the proposal, preview 48, explicitly confirm, complete 47 safe items, leave one intentional exception for review, and record `docs/media/stage6-loop.webm`.

## Stage 7: Metrics and calibration

- [x] Server-side latency/cache/client-counter aggregation and `/v1/metrics` routes.
- [x] Extension reporting for ghosts shown/accepted, acceptance rate, clicks saved and calibration pairs.
- [x] Calibration log of (confidence, accepted) and a reliability chart on the options metrics section.
- [x] Form HUD with a live per-walk keystrokes-saved counter. Loop-result metrics are still missing.

## Stage 8: Scale-out executors (stub when keys are missing)

- [x] Browserbase parallel executor, validation, cancellation, durability checks, SSRF protection and simulated fallback. Unit-tested only; no credentials/live run in the current checkout.
- [x] Composio compile/execution path for sheet append and Gmail actions, confirmation tickets and simulated fallback. Mock-tested only; the live API contract remains unverified.
- [x] Execution mode selector in the preview grid (visible, background, parallel, API).

## Stage 9: Demo polish

- [ ] `DEMO.md`: a 3-minute judging script and a LinkedIn shot list (clip 1: job application Tab, clip 2: "I did it twice, it did the other 47", clip 3: the calendar flow).
- [ ] Re-record all demo videos into `docs/media/`.
- [ ] README: architecture diagram (Mermaid), setup, keys, metrics, safety model.
- [x] Options-page onboarding, resume import, metrics and settings UI.

## Stretch (only after everything above)

- [ ] Hardening against saved HTML fixtures of real application forms (Greenhouse, Lever, Ashby, Workday) stored in `e2e/fixtures/`. Never submit real forms.
- [ ] Terminal ghost spike: a zsh plugin that predicts the next command from history.
- [x] Native macOS menu-bar form agent in Objective-C: stable host, AX capture, overlay, Tab state machine, verified writer, server prediction/free text, local cache, settings and harness; 201 tests pass.
- [ ] Ghost Desktop on a REAL Greenhouse application in Safari (Pravin's stream): capture into Safari's tab group (done), resume upload through the macOS open panel, react-select comboboxes, EEO and unknown-authorization questions left alone, live `ghostctl autotab` run that ends parked on the locked Submit, recording in `docs/media/`.
- [x] Extension heartbeat and server `/v1/presence` coordination are implemented. Continue real-app compatibility rehearsals with the trusted stable host.
- [ ] YouTube learning spike: turn a tutorial transcript into a step list Ghost can suggest.
