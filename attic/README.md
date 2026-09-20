# attic — kept, not used

Everything under `attic/` is **out of scope and out of the build**. It is kept because it
works and may be worth reviving, not because anything depends on it.

## Rules

- **No agent should read, search, index, or edit anything in this directory.** It is not
  part of the product and reading it wastes context on code that will not ship.
- Nothing in the repo may import from `attic/`. It is excluded from every tsconfig, the
  build, the test runs and the e2e suite.
- If something here becomes relevant again, move it back out deliberately and wire it up.
  Do not import it in place.

## What Ghost actually is now

The user is on a screen. Ghost proposes the one thing they are most likely to do next,
they press Tab to take it or do something else instead, and **every outcome — taken or
replaced — is recorded**: locally, so Ghost learns this person, and to Sentry, so the
rejection stream can improve the model for everyone.

That loop is the whole product. Anything that is not part of it lives here.

## What was moved here, and why

| Moved | Lines | Why |
| --- | --- | --- |
| `server/src/workflows/**` | ~2,200 | Atomic workflow engine. Dead end to end: its only caller, `GHWorkflowCoordinator`, is not in the desktop Makefile. |
| `server/src/routes/workflows.ts` | 273 | `/v1/workflows/*` and `/v1/composio/*`. Zero clients. |
| `server/src/facts/**` | ~2,400 | Server-side fact scan. Superseded by the local cold-start scan in `shared/src/coldstart` and `desktop/src/GHColdStart.m`, which is the design in `docs/knowledge.md`. |
| `server/src/routes/facts.ts` | 94 | `/v1/facts`, `/v1/facts/scan`. Zero clients. |
| `e2e/tests/compareA.spec.ts`, `compareB.spec.ts` | ~850 | Provider bake-offs. Superseded by `scripts/bench-providers.mjs`. |
| `e2e/tests/stage8-facts.spec.ts` | — | Covers the moved fact routes. |
| **`extension/**`** | **~33,000** | **The Chrome MV3 extension.** Ghost is a native macOS app: an extension can never see Discord, Slack, Finder or System Settings, and the native agent already reads browsers through the same accessibility tree. It also never called the brain — `grep -rn "rankActions\|recordOutcome" extension/src` returned nothing — so it ran the old architecture to the end. |
| **`e2e/**`** | ~4,100 | The Playwright suite existed to load the extension into Chromium. It went with it. The native agent is covered by `pnpm desktop:test` (426 tests). |

**Not moved, deliberately:** `shared/src/facts/**` is a different module and is part of the
brain (`shared/src/knowledge` and `shared/src/coldstart` both import it).
`server/src/executors/access.ts` stays because `routes/vision.ts` depends on it.

The invoice loop ("do it twice, Ghost does the rest") is no longer the product direction.
Its machinery is still in the main tree and is the next candidate for this folder.

## docs/ — moved here 2026-09-20

Documentation for directions the product no longer takes. Same rule as the code: kept because it
records a real decision, not because anything depends on it. Nothing links to these.

| File | Why it is here |
| --- | --- |
| `PLAN.md` | The staged build plan. Superseded by the "Current boundary" section of `CLAUDE.md`, which contradicted it on the two things that mattered (native app, not an extension; no invoice loop). |
| `ROUTINE_PROMPT.md` | The autonomous-run prompt that pointed at `PLAN.md`. |
| `DEMO_WIN_PLAN.md` | Demo plan built around the invoice loop. Its one durable part — the sponsor track positioning — is now `docs/rox.md` and the other sponsor docs. |
| `handoff.md` | A session handoff, long overtaken. |
| `loops.md`, `workflows.md`, `handoff-composio.md` | "Do it twice and it does the rest", atomic workflows, and the Composio executor. No desktop caller. |
| `compare-approaches.md` | Compared two directions the product took neither of. |
| `sentry-audit.md`, `sentry-demo.md` | Point-in-time audit and a redirect stub. Live Sentry material is `SENTRY.md` plus `docs/observability.md`. |

The live docs are listed in `docs/README.md`.
