# Jev computer-use runner

Ghost now has an end-to-end browser agent built from the same safety primitives as the Tab walk. It follows the fast loop demonstrated by [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)—one compact state and one dynamic operation/target decision per step—and the observe → choose → act → check structure in [savka777/jev-use](https://github.com/savka777/jev-use). It does not copy either project or import another agent runtime. Ghost keeps its existing DOM capture, private local profile mapping, verified writer, lock rules, drafts and overlay.

## Run the demo

```bash
pnpm build
pnpm dev
```

Load `extension/dist`, open `http://localhost:5173/apply`, press **Alt+Shift+J**, and run:

> Fill every field that has a safe local value; leave consent untouched and stop before Submit application

Expected result: the profile-backed fields and available generated essays are filled; password/government-id traps are absent from the agent state; resume and consent stay untouched; Submit receives no click or submit event. The panel ends with the provider, last confidence, latency and verified-action count.

Automated paths:

```bash
# Deterministic, no external keys or effects
pnpm build
pnpm --dir e2e exec playwright test tests/agent-demo.spec.ts

# Live provider on a separate port; the server reads the gitignored root .env
PORT=8790 pnpm --filter @ghost/server start
GHOST_AGENT_SERVER_URL=http://127.0.0.1:8790 \
  pnpm --dir e2e exec playwright test tests/agent-demo.spec.ts
```

The 2026-09-19 live run used direct TypeSafe/Jev for decisions and Baseten for drafts and passed in 8.3 seconds. The keyless path passed in 2.0 seconds.

## Data boundary

The provider receives:

- the goal;
- origin, query-free path and page title;
- candidate kind, label, short context and required/filled/locked state;
- the closed operations each candidate safely supports;
- recent value-free outcomes.

The provider does not receive profile values, drafted text, current field values, sensitive candidates or opaque DOM signatures. Target ids are replaced by `e1`, `e2`, and so on for the provider call and mapped back only after validation. Chrome's `MessageSender` supplies origin and URL, so page or renderer code cannot spoof them.

## Decision and execution

The operation vocabulary is `FILL`, `SELECT`, `CHECK`, `CLICK`, `WAIT`, `DONE`, `BLOCKED`. The server builds one operation head and compatible speculative target heads. For local value work, only the next DOM-order frontier is offered: ten equally correct field orders should not divide target probability or encourage a navigation before the form is complete. Click targets remain model-routed after value work is exhausted.

Before a mutation, the runner captures again and requires the structural fingerprint to match the state Jev saw. It then verifies that the target is still present, empty, unlocked and compatible with the chosen operation. `executeGhost` rechecks lock and sensitivity, performs the React-safe write or safe click, and verifies the effect. The runner observes again, records whether state changed, stops after three no-progress steps and has a 40-step budget.

Confidence is risk-aware. An uncalibrated mutation uses the user's full threshold. A calibrated `CLICK` retains a 0.55 minimum because it may navigate or change application state. A calibrated local `FILL`/`SELECT`/`CHECK` does not use the unstable combined head score as a second veto: Jev supplies no value and can only permit the single local frontier Ghost, whose mapping and write are independently checked. `WAIT`, `DONE` and `BLOCKED` do not mutate.

With no decision key, the deterministic policy exists for tests and offline demos. It may apply the first locally prepared field action, but it never clicks and never invents a value. It reports `BLOCKED` when a required field has no safe local action unless the goal explicitly says to leave unsupported fields untouched.

## Outcome capture and reviewed learning

Every terminal run produces a `ghost.agent-run.v1` outcome. It contains operations, closed result/reason codes, bounded candidate counts, booleans, provider category and coarse timing/confidence buckets. The schema cannot represent the goal, page identity, labels, target IDs, values, DOM, screenshots, or arbitrary error text. The background worker and server each rebuild it from the same allowlist.

With `SENTRY_DSN`, the server manually sends the scrubbed event to Sentry and attaches blocked runs as replay JSON. Without it, capture is a tested no-op and blocked cases remain available from the process-local `/v1/agent/replays` review queue. Reviewed exports live in `evals/agent-replays/` and run with `pnpm eval:agent-replays`. See [`agent-learning.md`](agent-learning.md) for setup, privacy invariants, export/promotion commands, and the boundary between regression learning and unsafe automatic self-modification.

## What is not done yet

- The first proof is deliberately form-heavy. Add a second scenario with a reversible page click, navigation and a useful wait.
- Record a live fallback video for judging.
- Add a Sentry DSN and verify one real blocked event plus its attachment in the configured project. The no-DSN path, sink adapter, scrubber, route and replay pipeline are tested; live delivery is the only missing piece.
- Extend the same shared runner to the macOS AX adapter. The current native workflow coordinator and native form walker remain separate paths.
- Decide how Composio suggestions enter the same panel after real accounts are connected. External effects must continue through reviewed, single-use confirmation tokens rather than the form runner's local operation path.
