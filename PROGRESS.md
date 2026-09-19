# Progress log

Each run appends an entry. Newest at the bottom.

Format:

```
## Run N: YYYY-MM-DD HH:MM (UTC) [IN PROGRESS | DONE]
- Worked on: PLAN.md items ...
- Changed: ...
- Tests: unit X passed, e2e Y passed, failures ...
- Blocked or stubbed: ...
- Next: the next unchecked PLAN.md item
```

## Run 0: setup by Pravin [DONE]
- Repo created with CLAUDE.md, PLAN.md, PROGRESS.md, MORNING.md, README.md.
- Next: Stage 0, Bootstrap.

## Run 1: 2026-09-19 06:50 (UTC) [DONE at 08:25 UTC, then stalled]
- Done and pushed: Stage 0; Stage 1 (extension capture/overlay/execute/controller/options/background, 19 e2e, 26 review findings fixed); server (four decision providers, predict/form, predict/next, streaming ghost-text, profile/extract, metrics, security hardening; live-verified against xAI); shared trace/loop/memory logic; demo sites (apply, apply-plain, invoices, sheet, mail, calendar, reset); docs.
- Tests at 08:25 UTC: shared 354, extension 254, server 182, demo 74, e2e 19, all green.
- What went wrong: the laptop was on battery with the lid closed and dropped from 8% to 1%, so macOS cycled through maintenance sleep from about 08:30 to 15:00 UTC. The Stage 2-4 extension workflow and the Stage 6/8 server workflow were interrupted every few minutes and produced nothing. No committed work was lost.

## Run 2: 2026-09-19 15:05–18:10 (UTC) [DONE]
- Added and pushed: native macOS background form agent (`desktop/`, Objective-C); server loop synthesis and scale-out execution routes; Browserbase parallel executor; Composio compile/execution path; confirmation tickets, access controls, cancellation, durability and SSRF hardening.
- What is genuinely integrated: the browser extension still runs the Stage 1 offline form path only. The native agent has its own server form/free-text client and cache. Neither client exposes the learned invoice-loop workflow.
- What remains component-only: `/v1/predict/next`, shared traces/memory/loops, Browserbase, Composio and the invoice/mail demo sites have tests and contracts but no extension orchestration or judging UI. Browserbase/Composio have not been live-verified in this checkout.
- Audit tests at 18:10 UTC: build and typecheck pass; shared 354, extension 254, server 325 passed + 2 skipped, demo 74, e2e 19, demo smoke 95, desktop 167. Tracked secret-pattern scan clean.
- Audit findings: frozen install fails because the lockfile still lists extension `pdfjs-dist`; desktop presence/extension heartbeat is documented but not implemented; `DEMO.md` and the Stage 6 loop video are missing; several planning documents overstated integration.
- Next: implement the canonical invoice-loop vertical slice in the extension (record two runs -> detect/synthesize -> preview 48 with one exception -> confirm -> execute/verify 47 -> result screen), then add e2e, fallback video and one visible OpenAI-powered step.

## Run 3: 2026-09-19 Jev computer-use integration [DONE]
- Added a shared value-free computer-use contract and strict `/v1/agent/next` route. One Jev call selects a closed operation plus a compatible opaque target; the provider never receives profile values or target ids.
- Added the extension browser adapter, provider-independent observe/freshness-check/execute/verify runner, and closed-shadow `Alt+Shift+J` panel. The existing verified writer remains the only mutation path.
- Added a risk-aware frontier: one DOM-order local value target at a time, clicks deferred while safe value work remains, no-key policy forbidden from clicks, locked/sensitive targets refused again at execution.
- Added server, message-boundary, runner, browser-adapter and loaded-extension tests.
- Live verification: direct TypeSafe/Jev + Baseten drafting completed `/apply` in 8.3 s; deterministic keyless run completed in 2.0 s. Both left consent untouched and recorded zero Submit attempts.
- Verification: build and all workspace typechecks pass; 2,029 JS/TS unit tests and all 34 loaded-extension browser tests pass.
- Next: record the live proof, add Sentry outcome/failure capture feeding replay/evals, then add a second page-changing `CLICK`/`WAIT` scenario before returning to the canonical invoice-loop video.
