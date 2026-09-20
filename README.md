# Shabang

> A native macOS assistant that suggests the next safe action in the app you are using.

Shabang is a menu-bar app for macOS. It reads the accessibility tree of the frontmost app, draws a translucent ghost over a likely next field or labelled control, and lets you accept a suggestion deliberately. It is designed to work across accessible native and web apps—not through a browser extension. The default general accept key is right Command; Tab accepts only a value suggestion on the focused form field.

The quick start below is sufficient for a development checkout. [SETUP.md](SETUP.md) is a maintainer-oriented clean-machine and troubleshooting guide; read its reset/recovery commands carefully before running them.

This is a Hack the North 2026 prototype, not a signed or notarized production release. It currently requires macOS 13 or later, Accessibility permission, and a Mac with the Command Line Tools installed.

On a new Mac, `./install.sh` does the whole setup: it checks the toolchain, builds, installs the app to `~/Applications`, walks the Accessibility grant, and verifies the result. `./install.sh --check` reports problems without changing anything, and `./install.sh --update` rebuilds after a code change while keeping the permission.

## What it does today

- Uses local heuristics to suggest form values and next actions immediately.
- Can use the loopback-only companion server to improve a form mapping or stream a text draft when an optional provider is configured.
- Learns local, bounded preferences from accepted and rejected suggestions.
- Treats submit, send, pay, delete, confirm, and similar actions as locked: Shabang parks on them but does not activate them.
- Lets you accept a focused form value with Tab. For non-form actions, it uses a configurable lone right-Command tap by default; Escape dismisses and typing wins.
- Includes an optional zsh companion that suggests a shell command but never executes it.

There is **no Chrome extension**. The former browser-extension experiment is isolated in [`attic/`](attic/README.md), outside the workspace, builds, and supported product surface.

## Known limits

Accessibility support differs by application and control. Shabang skips controls it cannot identify, locate, or verify safely. It has not been productized for distribution, and it should not be used to submit a real form or take another irreversible action unattended. Vision-assisted labels are an opt-in experimental desktop capability that needs Screen Recording permission and an OpenAI provider; batch/workflow endpoints are historical server code, not the desktop product.

The product, native bundle, and desktop support directory are named **Shabang**. A few internal server/terminal identifiers still use the historical “ghost” name; they are implementation details, not a second client or browser extension.

## Quick start (development)

Prerequisites: macOS 13+, Node.js 22+, pnpm 10+, and the Xcode Command Line Tools.

```bash
pnpm install
pnpm --filter @shabang/server dev
```

In a second terminal:

```bash
make -C desktop run
```

At first launch, grant **Accessibility** to the generated `Shabang.app` in System Settings → Privacy & Security → Accessibility. The menu-bar item reports whether permission is available and whether the local server is online. `pnpm dev` also starts the local demo site on `http://localhost:5173`, which is the safe place to rehearse form behavior.

For a background installation that starts at login, inspect the exact changes first:

```bash
scripts/install-background.sh --dry-run
scripts/install-background.sh
```

The installer is per-user, never requires `sudo`, installs a loopback server and `Shabang.app`, and keeps secrets in `~/.config/shabang/env` rather than in the repository. See [`desktop/README.md`](desktop/README.md) for installation, permissions, data locations, and removal.

## Development checks

```bash
pnpm typecheck
pnpm test
pnpm desktop:test
pnpm test:terminal
```

`pnpm test:live` is opt-in: it runs only when a supported provider credential is present. It may call a paid external service; do not run it with credentials you do not intend to use.

## Privacy and safety

The desktop app stores its profile, settings, answer memory, and local form cache in `~/Library/Application Support/Shabang/` with private file permissions. Password, payment-card, government-ID, and sensitivity-labelled controls are excluded before prediction, storage, or logging. The companion server listens on `127.0.0.1` by default.

Without a provider key, the app remains on its offline heuristic. With a key, the server may send only the bounded context required by the relevant route to the configured provider. See [`docs/architecture.md`](docs/architecture.md), [`docs/storage.md`](docs/storage.md), [`docs/learning-loop.md`](docs/learning-loop.md), and [`.env.example`](.env.example) before configuring one.

## Repository map

```text
desktop/   Native macOS menu-bar app (Objective-C, clang, JavaScriptCore)
shared/    Pure TypeScript safety, form, knowledge, and affordance logic
server/    Loopback Node.js service for optional predictions, drafts, telemetry, and terminal support
demo/      Local, fictional demo surfaces used for development and tests
terminal/  Optional zsh command-ghost companion
docs/      Current architecture and implementation notes
attic/     Deliberately unsupported historical code, including the former extension
```

## Sponsor tracks

What we used, why it and not something else, the measured numbers, and what went wrong. Each one also
says what *not* to claim.

- [`SENTRY.md`](SENTRY.md) — six Sentry products, and four things Sentry data changed in the code.
- [`docs/typesafe.md`](docs/typesafe.md) — Jev: calibrated confidence in 266 ms, and why our confidence gate means anything.
- [`docs/baseten.md`](docs/baseten.md) — confidence without logprobs: a hedged vote, and why every word of text comes from here.
- [`docs/openai.md`](docs/openai.md) — a useful negative result on calibration, and vision that rarely fires.
- [`docs/rox.md`](docs/rox.md) — no SDK: the agent answered against the five judging criteria.
- [`docs/warp.md`](docs/warp.md) — the terminal companion: real and tested, and honest that it does not render inside Warp.

Raw evidence: [`docs/media/bench-providers.md`](docs/media/bench-providers.md).

## More documentation

- [`docs/README.md`](docs/README.md) — index of every live document.
- [`desktop/README.md`](desktop/README.md) — build, run, install, permissions, and troubleshooting.
- [`docs/architecture.md`](docs/architecture.md) — current product architecture and data flow.
- [`docs/desktop.md`](docs/desktop.md) — native pipeline and safety boundary.
- [`docs/server-api.md`](docs/server-api.md) — loopback service contract; not a public hosted API.
- [`terminal/README.md`](terminal/README.md) — optional zsh integration.

## Before publishing

This repository has no license, contribution policy, security-reporting channel, code of conduct, or release workflow yet. Those are intentional hold points rather than implied permissions: choose a license and maintainers/security contact before asking others to use, redistribute, or contribute to the code. The release audit notes the remaining actions in [`docs/release-readiness.md`](docs/release-readiness.md).
