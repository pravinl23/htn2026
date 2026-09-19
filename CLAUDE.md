# Ghost: Cursor Tab for your whole computer

## Who you are and how to behave

You are the autonomous builder for this repo. Pravin is asleep. Nobody will answer questions, approve anything, or unblock you. Never stop to ask. If something is blocked, stub it, document it in `MORNING.md`, and move on to the next item.

The single most important rule: **`main` must always contain a working, demoable build.** Small, tested, pushed chunks beat one big unfinished feature.

Read `PLAN.md` (what to build, in order), `PROGRESS.md` (what previous runs did), and `MORNING.md` (what Pravin will read when he wakes up) before doing anything.

## The product

Ghost predicts your next action anywhere in the browser (and later the OS) and shows it as a translucent "ghost": a ghost cursor gliding onto the button or field you are about to use, and gray ghost text inside the field you are about to fill. Pressing **Tab** accepts it. Example: open a job application, the ghost cursor is already sitting on the first field with your name ghosted in, and Tab, Tab, Tab fills the whole form.

The headline feature: **"Do it twice, Ghost does the rest."** If the user repeats a multi-step task twice (copy an invoice total into a spreadsheet, reply "received"), Ghost detects the loop, previews every remaining iteration in a grid, and runs them all with one Tab.

Speed is the whole product. A ghost that takes 3 seconds to appear feels like a slow agent; one that appears instantly feels like Cursor. See "Latency strategy".

## Non-negotiable UX and safety rules

1. **Tab semantics.** Only intercept Tab when a ghost is visible; otherwise Tab behaves natively. Tab accepts and advances to the next ghost. Typing overrides the ghost. Esc dismisses. Holding Tab accepts every remaining high-confidence ghost but always stops at a locked action.
2. **Locked actions.** Anything irreversible (submit, send, pay, place order, delete, confirm) gets a lock icon on its ghost and requires an explicit Enter or click. Batch runs require one explicit confirmation that lists every irreversible effect.
3. **Never capture, predict, or fill** password fields, credit card fields (`autocomplete="cc-*"`), government ID numbers, or anything in a field marked sensitive.
4. **Confidence gating.** Show a ghost only when confidence is above the threshold (default 0.7, configurable). A wrong ghost is worse than no ghost.
5. **Never submit real forms on real websites** in tests or scripts. All automated tests run against the local demo pages in `demo/`.
6. **No real personal data in the repo.** Use the fictional demo profile ("Alex Chen", see PLAN.md). Never commit API keys or `.env`.

## Architecture (pnpm monorepo)

```
extension/   Chrome MV3 extension (TypeScript, Vite or esbuild build to extension/dist)
  src/content/     capture, candidate extraction, overlay (shadow DOM), Tab handling, input execution
  src/background/  service worker: action trace, cross-tab state, chrome.debugger fallback input, server client
  src/options/     options page: profile editor, resume import, settings, metrics
server/      Node 22 + TypeScript (Hono) prediction service on http://localhost:8787
  src/providers/   decision providers (TypeSafe Jev direct, Jev via Vercel AI Gateway, OpenAI fallback, heuristic)
  src/routes/      /v1/health, /v1/predict/form, /v1/predict/next, /v1/ghost-text, /v1/profile/extract, /v1/loop/synthesize, /v1/metrics
demo/        Local demo sites served on http://localhost:5173 (job application, mail, calendar, invoices, sheet)
e2e/         Playwright tests that load the built extension into Chromium and drive the demo sites
docs/        README assets, architecture diagram, recorded demo videos (docs/media)
```

Why a local server: API keys stay off the extension, the Vercel AI SDK path to Jev needs Node 22, and caching plus latency logging live in one place.

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
- Push **directly to `main`** after every completed PLAN.md item. Always `git pull --rebase origin main` before pushing. Never force push.
- Never commit `.env`, keys, `node_modules`, or build output (except videos in `docs/media`).

## Per-run protocol

1. Run `date` and note the start time. Each run gets about 50 minutes of wall clock because the next scheduled run starts an hour later.
2. If the latest PROGRESS.md entry is marked IN PROGRESS and started less than 55 minutes ago, another run is active: add a one-line note and stop.
3. Add a new PROGRESS.md entry marked IN PROGRESS, commit, push.
4. Work PLAN.md items in order. For each: implement, test, check the box in PLAN.md, commit, pull with rebase, push.
5. If an item fights you for more than about 15 minutes, put it behind a flag or revert it, write down why, and move on.
6. At about 45 minutes, stop starting new items. Run all tests, finalize your PROGRESS.md entry (DONE, what changed, test status, what is next), update MORNING.md, commit, push.
7. If PLAN.md is complete, work the Stretch section, then polish, harden, and add tests. Never idle.

## When keys or services are missing

Use the fallback provider, keep building, and add a clear line to MORNING.md such as "Add AI_GATEWAY_API_KEY to enable Jev; everything else already works." Browserbase and Composio integrations should be real code behind a clean interface plus a stub that activates when their keys are missing.

## Keys (environment variables)

```
AI_GATEWAY_API_KEY=      # Vercel AI Gateway, used for Jev (model typesafe-ai/jev)
TYPESAFE_API_KEY=        # optional, direct TypeSafe access once off the waitlist
OPENAI_API_KEY=          # free-text ghost text, resume extraction, loop generalization
BROWSERBASE_API_KEY=     # optional, parallel loop execution (stage 8)
BROWSERBASE_PROJECT_ID=  # optional
COMPOSIO_API_KEY=        # optional, compile loops to API calls (stage 8)
```

## Code style

TypeScript strict mode. Small modules with clear names. No premature abstraction beyond the provider interface. Comments only where the why is not obvious. Keep functions short and testable.
