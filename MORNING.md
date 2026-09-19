# Read this first when you wake up

_Last updated: 2026-09-19 08:25 UTC by the overnight builder (run 1, still running when this was written)._

## Status

- **Stage 0 and Stage 1 are done and pushed.** Tab walks the whole job application (React and plain HTML), types over ghosts, Esc dismisses, hold-Tab stops at the locked Submit, sensitive trap fields stay empty. 26 adversarial review findings were fixed.
- **Server is done and pushed** (Stage 2 server items, Stage 3 `/v1/ghost-text`, Stage 4 `/v1/profile/extract`, `/v1/predict/next`, metrics). Jev's request shape was verified against docs.typesafe.ai and the Vercel AI Gateway docs and pinned by contract tests. Live-verified against xAI (`grok-4.20-non-reasoning`): whole-form decision call about 0.8 to 1.1 s, ghost text first token about 0.5 s.
- **Loop engine pure logic is done and pushed** (`shared/src/trace`, `shared/src/loop`, `shared/src/memory`).
- **Demo sites are done and pushed**: `/apply`, `/apply-plain/`, `/invoices` (50 seeded invoices), `/sheet`, `/mail`, `/calendar`, `/reset`.
- **In flight**: extension to server wiring (one call per form, per-site cache, HUD), streaming ghost text in textareas, resume import, opt-in learning, metrics page. Then Stage 5 (next-action + mail/calendar flow) and Stage 6 (do it twice).
- Tests at last push: shared 354, extension 254, server 182, demo 74, e2e 19. All green.

## Try it in 2 minutes

```bash
cd ~/Projects/htn2026
pnpm install
pnpm build
pnpm dev
```

Then `chrome://extensions` -> Developer mode -> Load unpacked -> `extension/dist`, open http://localhost:5173/apply and press Tab. Watch `docs/media/stage1-form.webm` for what it should look like.

`scripts/verify.sh` runs the full gate (build, typecheck, unit, e2e, secret scan).

## Things only you can do

- Add `AI_GATEWAY_API_KEY` (or `TYPESAFE_API_KEY`) to `.env` to enable Jev. Until then decisions use the heuristic fast path plus the uncalibrated xAI LLM adapter (about 1 s instead of Jev's 70 to 500 ms). Both Jev providers are unit-tested against the documented wire format but have never hit the real API.
- The xAI key you pasted lives only in the gitignored `.env`. It was pasted in a chat, so rotate it after the hackathon. Spend so far is a few cents.
- If the hourly cloud routine is also enabled, it and this local session share `PROGRESS.md` as a lock; check the routine list for runs that stopped early because of it.

## Known issues

- Fields inside open shadow roots (web-component forms) get no ghosts yet.
- The `chrome.debugger` fallback path is implemented but has not been exercised against a site that needs it.

## Videos

- `docs/media/stage1-form.webm`: Tab walking the job application and parking on the locked Submit.
