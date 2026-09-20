# Architecture

Shabang is a native macOS product with an optional loopback service. It has no browser-extension client.

## Runtime flow

~~~text
frontmost macOS app
  → Accessibility tree
  → capture and local safety filtering
  → shared local ranking and profile resolution
  → visible ghost
  → explicit user acceptance, dismissal, or correction
  → local memory + value-free outcome telemetry

optional local server (127.0.0.1)
  → batched form mapping or text drafting
  → response is validated before it can become a ghost
~~~

The local path is always available first. A slow, unavailable, or rejected server response must not block the desktop app or cause it to write.

## Components

| Area | Responsibility |
| --- | --- |
| [desktop](../desktop/README.md) | The macOS menu-bar app. It observes the frontmost app through Accessibility, captures eligible controls, renders ghosts, handles keys, and verifies writes. |
| [desktop/core](../desktop/core/entry.ts) | JavaScriptCore bridge that bundles selected shared TypeScript functions for the native app. |
| [shared](../shared/) | Pure, tested TypeScript for field handling, sensitive-data filtering, answer selection, affordances, ranking, local knowledge, and trace types. |
| [server](../server/) | Optional Node.js service bound to loopback by default. It owns provider credentials, batched form predictions, text drafts, metrics, and Sentry delivery. |
| [demo](../demo/) | Fictional local pages used for development and tests. They are the safe place to rehearse automated behavior. |
| [terminal](../terminal/README.md) | Optional zsh companion. It only inserts a proposed command into the command line; it never executes one. |

## Native pipeline

1. SBAccessibility watches the frontmost accessible window.
2. SBCapture converts eligible accessibility elements into fields and action candidates. Secure, sensitive, disabled, hidden, and unusable controls are discarded before the rest of the pipeline sees them.
3. SBController, SBNextAction, and the JavaScriptCore bridge build local suggestions from the profile, shared answer logic, affordance roles, and local memory.
4. SBServerClient may request one batched form prediction or a streamed text draft. The client sends bounded, route-specific data and treats any failure as a no-op.
5. The overlay renders the current suggestion. The event tap keeps Tab native except for a focused value suggestion; the configured Shabang key accepts other eligible suggestions.
6. SBWriter performs the narrowest supported write and checks the result. Locked or unverified actions do not proceed.

## Safety boundary

The desktop app must never capture, predict, store, or fill password, payment-card, government-ID, or sensitivity-labelled controls. Locked actions are displayed but never activated by the app. The test suite uses local fictional pages; no automated test should submit a real form.

The server is not an authorization boundary for the desktop process; it is a local helper. It rejects foreign hosts and origins, requires JSON for POSTs, and binds to 127.0.0.1 unless explicitly configured otherwise. Do not expose it publicly.

## State and scope

Desktop state is local and private by default. The current implementation keeps distinct profile, settings, learned-answer, form-cache, and role-memory files rather than a single graph database. See [local data](storage.md).

The supported product flow is the native desktop pipeline above. The repository still contains experimental server routes for loops, cloud executors, presence, and vision; some have no active desktop caller. They are documented as implementation status in [the server API note](server-api.md), not advertised as user-facing capabilities.

The former Chrome extension and its Playwright suite are historical code under [attic](../attic/README.md), excluded from the workspace and all supported builds.
