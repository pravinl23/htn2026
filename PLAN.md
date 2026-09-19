# Ghost build plan

Work top to bottom. Check a box only when the item works and its tests pass. Push after every checked box.

Demo profile (fictional, use everywhere, never real data):
Alex Chen, alex.chen.dev@example.com, +1 519 555 0142, Waterloo ON, University of Waterloo, BCS Computer Science, expected graduation April 2028, github.com/alexchen-dev, linkedin.com/in/alexchen-dev, alexchen.dev, authorized to work in Canada: yes, requires sponsorship: no.

---

## Stage 0: Bootstrap

- [ ] pnpm workspace with packages `extension`, `server`, `demo`, `e2e`; shared `tsconfig.base.json` (strict); root `.gitignore` (node_modules, dist, .env, test-results, playwright-report) and `.env.example` listing the keys from CLAUDE.md.
- [ ] Root scripts: `pnpm dev` (server on 8787 + demo on 5173), `pnpm build` (extension to `extension/dist`), `pnpm test` (all unit tests), `pnpm e2e` (Playwright), `pnpm test:live` (only runs with real keys).
- [ ] README.md: one-paragraph pitch, how to run, how to load the extension (`chrome://extensions`, Developer mode, Load unpacked, select `extension/dist`).

**Acceptance:** fresh clone, `pnpm install && pnpm build && pnpm test` all succeed.

## Stage 1: The base, Tab through a form (no AI yet)

- [ ] `demo/apply`: realistic job application for a fictional company ("Northwind Robotics, Software Engineering Intern"), about 20 fields: first/last name, email, phone, location, LinkedIn, GitHub, portfolio, school, degree, graduation date, work authorization (select), sponsorship (radio), how did you hear (select), "Why Northwind?" (textarea), "Tell us about a project" (textarea), resume upload (stub), Submit. Built with React controlled inputs so the input-execution path is tested for real. Also `demo/apply-plain` as plain HTML.
- [ ] Extension skeleton (MV3): content script on localhost and all http/https pages (with an on/off toggle), background service worker, options page. Keyboard shortcut to toggle Ghost.
- [ ] Capture: enumerate visible interactive elements with accessible names (aria-label, aria-labelledby, label[for], wrapping label, placeholder, nearby text), types, options, bounding boxes, and a stable element signature. Unit tests with jsdom fixtures.
- [ ] Profile store in `chrome.storage.local`, seeded with the demo profile; options page shows and edits it as JSON.
- [ ] Heuristic provider in the extension for now: map field labels to profile facts by keywords.
- [ ] Overlay in a shadow DOM root: ghost cursor (SVG pointer) that glides to the target with a CSS transition, highlight ring, gray ghost text positioned inside the field.
- [ ] Tab semantics exactly as CLAUDE.md describes (accept and advance, type to override, Esc dismiss, hold Tab to accept all, stop at locks).
- [ ] React-safe input execution with verification; `chrome.debugger` fallback from the background worker.
- [ ] Locks on submit and other irreversible buttons; never touch password or card fields.
- [ ] E2E: load extension, open `/apply`, press Tab repeatedly, assert every field equals the demo profile value, assert Submit was NOT clicked. Record video to `docs/media/stage1-form.webm`.

**Acceptance:** the e2e passes and the video shows the ghost cursor walking the form.

## Stage 2: Prediction service and Jev

- [ ] `server/` with Hono on Node 22: `GET /v1/health` reports the active provider; CORS limited to the extension and localhost.
- [ ] Provider interface and all four providers with the precedence from CLAUDE.md. Heuristic provider moves from the extension to the server (keep a tiny offline fallback in the extension for when the server is down).
- [ ] `POST /v1/predict/form`: input is fields (signature, label, type, options) plus profile fact keys; ONE batched decision call with a choice question per field over `[...factKeys, "needs_text", "none"]`; output is assignments with confidence, provider name, and latency.
- [ ] Extension calls the server once per form, caches the mapping per origin plus form signature, and makes zero calls on repeat visits.
- [ ] Confidence gating with a threshold setting in the options page.
- [ ] Small debug HUD (toggleable): active provider, last latency, cache hit or miss.
- [ ] Tests: provider adapters with mocked HTTP; a contract test that checks the exact Jev request shape; `pnpm test:live` hits the real provider when keys exist and prints latency.

**Acceptance:** with no keys everything still works through the heuristic provider; with keys the live test passes and logs latency.

## Stage 3: Free-text ghost text

- [ ] `POST /v1/ghost-text` (streaming): field label, page context (company, role, visible job description text), relevant profile facts, and past answers; returns a draft in the user's voice. Template fallback with no LLM key.
- [ ] Speculative generation: when a form is detected, start generating every free-text field in the background and cache the results.
- [ ] Multi-line ghost text inside textareas; Tab accepts the whole draft; typing overrides.
- [ ] E2E: textareas get non-empty text on Tab; record latency.

## Stage 4: Resume import and learning

- [ ] Options page: paste resume text or upload a PDF (pdf.js) and call `POST /v1/profile/extract` (LLM) to propose facts; user reviews and saves.
- [ ] Opt-in learning: values the user types manually into recognized fields become new facts; answers to essay questions are saved as past answers.
- [ ] Tests for extraction mapping with a fictional sample resume in `demo/fixtures/`.

## Stage 5: Next-action prediction beyond forms

- [ ] Action trace recorder in the background worker (clicks, typing, navigation, tab switches) as normalized events with element signatures; sensitive values masked.
- [ ] `POST /v1/predict/next`: recent actions plus up to 60 candidate elements; one choice question over candidates plus `none`; returns candidate and confidence.
- [ ] Ghost cursor for clicks on buttons and links; Tab clicks unless locked.
- [ ] Episodic memory: store (state summary, action) pairs; retrieve the most similar past pairs and include them in the decision state.
- [ ] `demo/mail` and `demo/calendar`: an email asks "can we meet Thursday afternoon?"; flow is open calendar, pick the free Thursday slot, return to the email, reply is drafted with that time, Send is locked.
- [ ] E2E for that cross-page flow using only Tab presses (and a final explicit confirm that the test does NOT press).

## Stage 6: Do it twice, Ghost does the rest

- [ ] `demo/invoices`: an inbox of 50 invoice emails, each opening an invoice view with vendor, invoice number, date, total; `demo/sheet`: a simple spreadsheet grid; each email has a "Reply received" action.
- [ ] Loop detector: find a repeated action subsequence (3 or more steps) that occurred twice; align the two runs; separate constant steps from variable ones.
- [ ] Generalizer: infer the iterator (the next unhandled list item) and where each variable value comes from (text on the source page). Output a JSON program. Use the LLM only when heuristics fail.
- [ ] Preview grid: dry-run extraction for every remaining item, with confidence per row and low-confidence rows flagged.
- [ ] Executor: visible mode with the ghost cursor moving; verification after each step; stop on mismatch; one batch confirmation listing irreversible effects.
- [ ] Unit tests for alignment and synthesis on synthetic traces. E2E: perform two invoices manually, accept the proposal, confirm, and assert the sheet has 50 correct rows. Record `docs/media/stage6-loop.webm`.

## Stage 7: Metrics and calibration

- [ ] Counters: ghosts shown, accepted, acceptance rate, keystrokes and clicks saved, p50 and p95 latency.
- [ ] Calibration log of (confidence, accepted) and a reliability chart on a metrics page.
- [ ] Demo HUD with a live "keystrokes saved" counter.

## Stage 8: Scale-out executors (stub when keys are missing)

- [ ] Browserbase executor that runs loop items in parallel cloud browsers (`BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`).
- [ ] Composio compile path that maps known actions (send email, append sheet row) to API tool calls (`COMPOSIO_API_KEY`).
- [ ] Execution mode selector in the preview grid (visible, background, parallel, API).

## Stage 9: Demo polish

- [ ] `DEMO.md`: a 3-minute judging script and a LinkedIn shot list (clip 1: job application Tab, clip 2: "I did it twice, it did the other 47", clip 3: the calendar flow).
- [ ] Re-record all demo videos into `docs/media/`.
- [ ] README: architecture diagram (Mermaid), setup, keys, metrics, safety model.
- [ ] Options page onboarding and a clean settings UI.

## Stretch (only after everything above)

- [ ] Hardening against saved HTML fixtures of real application forms (Greenhouse, Lever, Ashby, Workday) stored in `e2e/fixtures/`. Never submit real forms.
- [ ] Terminal ghost spike: a zsh plugin that predicts the next command from history.
- [ ] macOS spike: a small Swift helper that reads the accessibility tree of the frontmost app.
- [ ] YouTube learning spike: turn a tutorial transcript into a step list Ghost can suggest.
