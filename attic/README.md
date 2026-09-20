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

**Not moved, deliberately:** `shared/src/facts/**` is a different module and is part of the
brain (`shared/src/knowledge` and `shared/src/coldstart` both import it).
`server/src/executors/access.ts` stays because `routes/vision.ts` depends on it.

The invoice loop ("do it twice, Ghost does the rest") is no longer the product direction.
Its machinery is still in the main tree and is the next candidate for this folder.
