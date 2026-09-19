# Ghost: Demo-Winning Plan

**Objective:** make one unforgettable, dependable 3-minute demo—not a broad automation platform.

## Status at the 2026-09-19 audit

- The 10-second form opener is reliable and fully covered by extension e2e.
- The invoice, sheet, mail and calendar demo surfaces are polished and pass the 95-check browser smoke suite.
- The repeat detector, loop synthesizer and server execution infrastructure exist and are thoroughly unit-tested.
- **The centerpiece is not wired into the extension:** there is no action recorder, learned-loop proposal, preview/confirmation panel, visible/background executor, loop result panel or Stage 6 e2e.
- OpenAI/Jev/Browserbase/Composio are not live in this checkout because no `.env` exists. The scale-out executors are server-side, mock-tested implementations with no extension UI.
- `DEMO.md` and `docs/media/stage6-loop.webm` are missing.

Therefore the next build is the invoice-loop vertical slice below, not another demo surface.

## The story judges should repeat

> "Ghost watches you do two invoice entries, learns the routine, previews the remaining 48, safely completes 47, and holds one messy invoice for review—with Tab as the control surface."

Open with a 10-second proof that Ghost also fills a job application field-by-field. The invoice loop is the main event; it demonstrates learning, reasoning, verification, and safe action at a scale that feels impossible in a weekend.

## Definition of demo-ready

- A fresh local run works with no external API keys via deterministic fallbacks.
- The extension overlays and accepts a job application walkthrough with Tab, ending at a visibly locked Submit button.
- A prepared invoice run can be demonstrated twice manually, then Ghost identifies the pattern, previews the 48 remaining rows, flags one intentional exception, and fills the other 47 correctly after one explicit confirmation.
- The app visibly stops rather than guessing when a value cannot be verified or a row is low-confidence.
- The exact demo path is covered by a single repeatable e2e/smoke test, and a recorded fallback video exists.
- One screen or HUD shows a credible outcome: **47 invoices completed / actions saved / zero unconfirmed sends**.

## Scope: build only these things

### 1. Make the job-application opener flawless

Keep it under 20 seconds.

- Wire the extension to the local server for one batched form prediction, with offline fallback and per-form cache.
- Finish one genuinely useful streaming ghost-text answer for the application textarea; prefetch it on page detection if that is reliable.
- Keep the current safety behavior visible: exclude sensitive fields and park on, never activate, Submit.
- Show a compact HUD: source/provider, latency, cache state, and accepted actions.

**Done when:** reload `/apply`, press Tab through the form, accept one short generated answer, and reach a locked Submit with no manual repair.

### 2. Ship the invoice-loop magic

This is the centerpiece. Use the existing `/invoices` and `/sheet` demos; do not introduce a new product surface.

- Implement the missing extension trace recorder/page-fact capture, then connect the existing repeat detector and program synthesis to a new preview and visible/background executor.
- Script the canonical sequence: enter two invoices manually, return to the invoice list, and let Ghost offer **"I can complete the remaining 48"** (or the actual remaining count).
- Show a preview grid before execution: source invoice, extracted fields, destination row, confidence, and any flagged exceptions.
- Require one explicit batch confirmation. The executor must verify each write and stop clearly on the first mismatch.
- Prefer a deterministic heuristic/synthetic program for the canonical demo over an unreliable LLM-only path. LLM enhancement is welcome only if it cannot make the demo fail.

**Done when:** a clean reset runs two manual examples, previews 48 remaining invoices, leaves one intentional exception for review, executes and verifies the other 47, and finishes with 49 correct sheet rows. Repeat it three times in a row.

### 3. Make safety part of the wow factor

Do not present safety as a disclaimer; make it a product moment.

- The preview states what will change and which effects are irreversible.
- One intentional bad/missing invoice is flagged and skipped or causes a clear stop.
- Submit, Send, passwords, payment fields, and unknown destinations remain blocked.
- Never claim autonomous real-world action; all effects in the demo remain fictional/local unless a fully verified integration is ready.

**Done when:** the demo has a 5–10 second safety beat that makes Ghost feel more trustworthy, not slower.

### 4. Polish the judging package

- Create `DEMO.md` with a timed 3-minute script, exact URLs, reset steps, speaker words, expected screen states, and recovery steps.
- Record a clean 45–60 second fallback video of the invoice loop, plus the existing form clip. Keep both local and easy to open.
- Make the landing/readme pitch match the story above; add one architecture diagram only if it clarifies the local safety/decision/execution boundary.
- Add a simple result panel or HUD with real numbers from the run. Do not invent performance claims.
- For the OpenAI prize: make one OpenAI API feature central (for example, free-text drafting or ambiguity resolution), add a visible fallback, and prepare one sentence plus one concrete commit/test example showing how Codex sped up development.

**Done when:** a teammate unfamiliar with the code can follow `DEMO.md` and run the demo without an engineer narrating setup.

## Explicitly defer

Do not work on these until every definition-of-demo-ready item is true:

- Native macOS/Desktop parity.
- Resume import and passive learning.
- Mail/calendar cross-app flow.
- Browserbase, Composio, or other real cloud/API execution modes; keep the demo executor local and limited to the canonical invoice path.
- More providers, integrations, or platform support.
- Metrics dashboards beyond the few demo-visible counters.
- Generalizing to arbitrary external sites beyond a small hardening fixture set.

## Suggested execution order

1. Reconcile the stale lockfile, then preserve the currently green build/unit/e2e baseline.
2. Wire and harden the deterministic invoice-loop happy path: recorder, page facts, detect and synthesize.
3. Add preview, confirmation, verified execution, result panel and the intentional exception.
4. Run the full happy path three times; add the single end-to-end test and record the fallback clip.
5. Connect one visible OpenAI-powered, code-verified ambiguity-resolution or drafting step and run its live test.
6. Write `DEMO.md`, rehearse, and use extension/server form wiring, native desktop, Browserbase or Composio only as post-centerpiece breadth work.

## Kill criteria

If a feature cannot be made repeatable in 15 minutes, hide it behind a flag or defer it. A reliable, prepared 50-invoice loop beats an impressive-looking multi-app agent that might fail in front of judges.

## Track positioning

- **Main Finalists:** surprising interaction model + visible magic + polished safety.
- **Rox Best AI Agent:** messy inputs, repetition learning, validation, confidence, and safe refusal.
- **OpenAI API Prize:** only after an OpenAI-powered feature and Codex build-process evidence are demonstrably in the product and pitch.
- **Warp Developer Tool:** only if the terminal/developer workflow is completed without compromising the primary demo.
