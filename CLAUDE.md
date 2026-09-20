# Shabang: Cursor Tab for your whole computer

## Never read `attic/`

**Do not read, search, index, open or edit anything under `attic/`.** It is kept code that is
deliberately out of scope and out of the build. Reading it burns context on things that will not
ship and will mislead you about what the product is. It is not a workspace package, it is outside
every tsconfig, and nothing in the repo may import from it. `attic/README.md` says what is in there
and why, and that one file is the only thing worth opening — and only if you are deciding whether to
revive something.

## What Shabang is, in one paragraph

The user is on a screen, anywhere: a web page, a native app, a terminal. Shabang proposes the single
thing they are most likely to do next. They press Tab to take it, or they do something else. **Every
outcome is recorded — taken or replaced.** Locally, so Shabang learns this person; and to Sentry, so
the stream of rejected proposals can improve the model for everyone. That loop is the entire
product. If a change does not serve it, it does not belong in the main tree.

## Who you are and how to behave

You are the autonomous builder for this repo. Pravin is asleep. Nobody will answer questions, approve anything, or unblock you. Never stop to ask. If something is blocked, stub it, document it in `MORNING.md`, and move on to the next item.

The single most important rule: **`main` must always contain a working, demoable build.** Small, tested, pushed chunks beat one big unfinished feature.

Read `PROGRESS.md` (what previous runs did) and `MORNING.md` (what Pravin will read when he wakes up) before doing anything. **There is no PLAN.md any more**: the boundary below is the plan, and `MORNING.md`'s "Still open" section is the queue.

**Current boundary (2026-09-20). This section is the product definition:**

1. **Shabang is a native macOS app.** The Chrome extension is in `attic/` and is NOT the product. Do
   not build browser features, do not revive it, do not add a second client. The native agent reads
   the accessibility tree of whatever app is frontmost, so browsers are just one case it already
   handles — and they are the only case an extension could ever have handled.
2. **The invoice loop is dead.** "Do it twice, Shabang does the rest" is no longer the product.
   The stale plans that described it now live in `attic/docs/`; trust this file.
3. The brain (`shared/src/knowledge`, `shared/src/affordance`, `shared/src/coldstart`) is built and
   benchmarked, and `desktop/core/knowledge.ts` consumes it. The desktop's next-action path is
   `GHController -> GHNextAction -> desktop/core/anywhere.ts -> shared/src/affordance`, all in process.
   **`server/src/providers/nextPredict.ts` is NOT on that path at all** — the desktop only ever posts
   `/v1/predict/form` and `/v1/shabang-text` — and it still answers `none` on real pages. Leave it alone
   unless something is actually going to call it.
4. `server/src/observability/walkSink.ts` is the Sentry sink for the rejection stream, and it is wired.
   `/v1/walk/replays` stays near-empty on purpose: `isReviewableWalk` keeps only abandoned walks, locked
   accepts and confident rejections. A healthy accepted walk is a counter and a Sentry event, not a fixture.
5. **`GHVision` is written, unit-tested and called from nowhere.** It is what would name the icon-only
   controls that currently classify `unknown`. Wiring it is the top remaining item.
6. A conversation on screen is read by `GHConversation` and answered through `/v1/shabang-text`'s optional
   `conversation` field. It keys on the accessible-description shape `"<who>, <what>, <when>"` that macOS
   asks messaging apps to publish — not on any app. See `MORNING.md` for what is proven live.

Do not infer that anything else in the target architecture below already exists.

## The product

Shabang predicts your next action **anywhere on your Mac** — a web page, Discord, Slack, System
Settings, Finder, a terminal — and shows it as a translucent "ghost": a ghost cursor gliding onto the
button or field you are about to use, and gray ghost text inside the field you are about to fill.
Pressing **Tab** accepts it. Example: open a job application, the ghost cursor is already sitting on
the first field with your name ghosted in, and Tab, Tab, Tab fills the whole form.

**Every outcome is recorded — taken or replaced.** Locally, so Shabang learns this person, and to
Sentry, so the stream of rejected proposals can improve the model for everyone. A ghost the user
turns down is a labelled training example, and it is the only thing the product learns from.

This is why it is a desktop app and not a browser extension: an extension can never see Discord.

Speed is the whole product. A ghost that takes 3 seconds to appear feels like a slow agent; one that appears instantly feels like Cursor. See "Latency strategy".

## Non-negotiable UX and safety rules

1. **Tab semantics.** Only intercept Tab when a ghost is visible; otherwise Tab behaves natively. Tab accepts and advances to the next ghost. Typing overrides the ghost. Esc dismisses. Holding Tab accepts every remaining high-confidence ghost but always stops at a locked action.
2. **Locked actions.** Anything irreversible (submit, send, pay, place order, delete, confirm) gets a lock icon on its ghost and requires an explicit Enter or click. Batch runs require one explicit confirmation that lists every irreversible effect.
3. **Never capture, predict, or fill** password fields, credit card fields (`autocomplete="cc-*"`), government ID numbers, or anything in a field marked sensitive.
4. **Confidence gating.** Show a ghost only when confidence is above the threshold (default 0.7, configurable). A wrong ghost is worse than no ghost.
5. **Never submit real forms on real websites** in tests or scripts. All automated tests run against the local demo pages in `demo/`.
6. **No real personal data in the repo.** Use the fictional demo profile ("Alex Chen", seeded on first run; see `desktop/profile.example.json`). Never commit API keys or `.env`.

## Architecture (pnpm monorepo)

```
desktop/     THE PRODUCT. Objective-C macOS agent (own Makefile: `pnpm desktop`, `pnpm desktop:test`)
  src/GHAccessibility  adopts the frontmost app and reads its accessibility tree. App-agnostic:
                       the only hardcoded lists are a SAFETY PAUSE list (Terminal, Keychain,
                       System Settings, password prompts) and a Chromium AX quirk
  src/GHCapture        candidates + hints (roles, list signature, badge counts, media controls)
  src/GHNextAction     next-action proposal; src/GHAffordance role classification
  src/GHWriter         verified writes; GHOverlay* the ghost the user actually sees
  src/GHColdStart      the local scan that seeds the graph from this Mac
  core/knowledge.ts    the bridge to the shared brain (rankActions / recordOutcome)
shared/      The brain, and the only place prediction logic lives
  src/knowledge/   rankActions, recordOutcome, screenKind, habits, cold-start seeding
  src/affordance/  roles, page kinds, priors, role memory
  src/coldstart/   local scan extractors and the sensitivity filter
server/      Node 22 + TypeScript (Hono) prediction service on http://localhost:8787
  src/providers/   decision providers (TypeSafe Jev direct, Jev via Gateway, Baseten, LLM, heuristic)
  src/observability/  Sentry: tracing, logs, metrics, profiling, and walkSink (the rejection stream)
  src/routes/      /v1/health, /v1/predict/form, /v1/predict/next, /v1/shabang-text, /v1/walk/outcomes, /v1/metrics
demo/        Local demo sites on http://localhost:5173. Kept as the SAFE test surface: rule 5 below
             says never drive a real site in an automated test, so the native agent rehearses here
terminal/    zsh line-editor ghost (`source terminal/ghost.zsh`)
docs/        architecture notes and recorded demo videos (docs/media)
attic/       kept, not used. Never read it. See attic/README.md
```

`SENTRY.md` at the repo root is the pitching reference: the six products in use, how to prove each
one live, how Sentry data actually changed the code, what not to claim, and the setup traps.

Run the server on **Node 22**, not 23: `@sentry/profiling-node` ships prebuilt binaries for LTS
(even majors) only, so on 23 profiling silently reports off and you lose a Sentry product.

Why a local server: API keys stay off the client, the Vercel AI SDK path to Jev needs Node 22, and caching plus latency logging live in one place.

## Decision providers (how prediction works)

All prediction goes through one interface, roughly `decide(state, questions) -> answers`, mirroring Jev's request shape so swapping providers is trivial. Provider precedence, chosen at server start and reported by `GET /v1/health`:

1. `TYPESAFE_API_KEY` set: TypeSafe direct (`@typesafe-ai/sdk`, or `POST https://api.typesafe.ai/v1/systemone`).
2. `AI_GATEWAY_API_KEY` set: Jev through Vercel AI Gateway with the Vercel AI SDK (`experimental_evaluate` from `ai`, model string `typesafe-ai/jev`, AI SDK 7.0.105 or later, Node 22 or later).
3. `OPENAI_API_KEY` set: OpenAI structured-output adapter that returns the same answer shape (its confidence is not calibrated; mark it as such in logs).
4. Nothing set: deterministic heuristic provider (label keyword matching, tab order, proximity). All automated tests use this or a mock, so tests never need keys.

### Jev facts you must respect

- Jev returns typed decisions, not text. Three question types: `noul` (yes/no probability), `choice` (pick one of the options you define, returns `choice`, `probabilities`, `confidence`), `score` (position on a scale you describe). Through the Vercel AI SDK the yes/no type is called `boolean` and TypeSafe's confidence is in `result.providerMetadata.typesafe.confidence`.
- A request is `{ model: "jev-latest", state, questions }`. State can be a string, object, or array of text. Refer to parts of the state with backticked paths like `fields[3].label`.
- **Ask everything at once.** All questions in one request are answered in parallel, and extra questions barely add latency. A whole form is ONE call. Never loop one call per field.
- A choice question allows up to 255 options. Add a `none` option whenever the list might not cover the input.
- Jev reads text only (no images), cannot write text, and is bad at math, counting, and dates. Use it to pick, never to generate. Free text comes from the LLM. Dates and numbers are parsed in code.
- Keep state small and relevant. Accuracy drops when state is full of irrelevant content, so filter candidates in code first.
- Latency is roughly 70 to 500 ms measured from the US West Coast. Rate limit is currently 1,200 requests per minute. Batch and cache.
- Before writing Jev integration code, install TypeSafe's agent skill if you can (`npx skills add typesafe-ai/skills --skill typesafe-ai`) and follow it. Agents commonly invent request fields; do not.

## Latency strategy (this is the product)

1. **One batched call per form or page**, then Tab walks precomputed answers in memory (0 ms per Tab).
2. **Pick, don't write**: map fields to profile facts with choice questions; only free-text fields go to the LLM.
3. **Speculate ahead**: start generating free text for later fields while the user is on earlier ones.
4. **Cache**: per-site form mappings are stored, so a repeat visit makes zero model calls.
5. **Measure everything**: log per-call latency, show p50 and p95 in the metrics page, and show the last latency plus active provider in a small debug HUD.

## Input execution

Many sites (React, Workday) ignore programmatic value changes. Set values with the native value setter from the element prototype, then dispatch `input` and `change` events, then verify the value stuck. If it did not, fall back to real input through `chrome.debugger` with the Chrome DevTools Protocol (`Input.insertText`, `Input.dispatchMouseEvent`) from the background worker. Always verify after every action and stop on surprises.

## Testing

- **Unit tests** (Vitest) for pure logic: candidate extraction (jsdom fixtures), field-to-fact mapping, sequence alignment, loop synthesis, provider adapters with mocked HTTP.
- **End-to-end tests** (Playwright) that build the extension and launch Chromium with `launchPersistentContext` plus `--disable-extensions-except=<dist>` and `--load-extension=<dist>`, against the local demo sites, using the heuristic or mock provider. If extensions fail to load headless, use `--headless=new`, and if that still fails, run headed under `xvfb-run`.
- **Live tests** (`pnpm test:live`) run only when real keys are present, and log real latency.
- **Record videos** of the main e2e flows (`recordVideo`) into `docs/media/` so Pravin can see progress in the morning.
- Never push with failing tests. If a test is flaky, fix it or quarantine it with a note in PROGRESS.md.

## Git workflow

- Commit small, meaningful chunks with clear messages prefixed by area, like `extension: tab accepts ghost and advances`.
- Push **directly to `main`** after every completed item. Always `git pull --rebase origin main` before pushing. Never force push.
- Never commit `.env`, keys, `node_modules`, or build output (except videos in `docs/media`).

## Per-run protocol

1. Run `date` and note the start time. Each run gets about 50 minutes of wall clock because the next scheduled run starts an hour later.
2. If the latest PROGRESS.md entry is marked IN PROGRESS and started less than 55 minutes ago, another run is active: add a one-line note and stop.
3. Add a new PROGRESS.md entry marked IN PROGRESS, commit, push.
4. Work the top item in `MORNING.md`'s **Still open** list first, then the rest in dependency order. For each: implement, test, commit, pull with rebase, push.
5. If an item fights you for more than about 15 minutes, put it behind a flag or revert it, write down why, and move on.
6. At about 45 minutes, stop starting new items. Run all tests, finalize your PROGRESS.md entry (DONE, what changed, test status, what is next), update MORNING.md, commit, push.
7. If **Still open** is empty, polish, harden, and add tests. Never idle.

## When keys or services are missing

Use the fallback provider, keep building, and add a precise line to MORNING.md that says which live integration is unavailable and which local path still works. Do not say "everything else works" unless the complete user flow has been verified. Browserbase and Composio integrations should remain behind clean interfaces plus stubs when their keys are missing.

## Keys (environment variables)

```
AI_GATEWAY_API_KEY=      # Vercel AI Gateway, used for Jev (model typesafe-ai/jev)
TYPESAFE_API_KEY=        # optional, direct TypeSafe access once off the waitlist
OPENAI_API_KEY=          # free-text ghost text, resume extraction, loop generalization
XAI_API_KEY=             # optional OpenAI-compatible text/decision fallback
BROWSERBASE_API_KEY=     # optional, parallel loop execution (stage 8)
BROWSERBASE_PROJECT_ID=  # optional
COMPOSIO_API_KEY=        # optional, compile loops to API calls (stage 8)
```

`.env.example` is the authoritative full list for executor/account/public-URL configuration.

## Code style

TypeScript strict mode. Small modules with clear names. No premature abstraction beyond the provider interface. Comments only where the why is not obvious. Keep functions short and testable.
