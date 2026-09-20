# Shabang Desktop

Shabang Desktop is the product: a native macOS menu-bar app that reads the accessibility tree of the frontmost app and renders a safe suggestion in place. It is not a browser extension.

The implementation is Objective-C with ARC and clang. TypeScript code shared with the server is bundled into JavaScriptCore at build time. There is deliberately no Xcode project or Swift dependency.

## Requirements

- macOS 13 or later
- Xcode Command Line Tools (xcode-select --install)
- Node.js 22+ and pnpm 10+ for the shared-core bundle and optional server
- Accessibility permission for the generated or installed Shabang.app

The app bundle and support-directory names are Shabang. A few internal server/terminal identifiers retain the earlier Ghost naming.

## Run from a checkout

~~~bash
pnpm install
pnpm --filter @shabang/server dev  # optional, in one terminal
make -C desktop run                # in another terminal
~~~

Make run builds the shared core, creates the development app bundle if necessary, builds the dynamic library, then opens the app through LaunchServices. The app has useful offline behavior when the local server is unavailable; the server enables optional batched form prediction and text drafting.

On first launch, enable Shabang under System Settings → Privacy & Security → Accessibility. The menu-bar item says “Needs Accessibility permission” until macOS grants it. Accessibility is a user decision; no script grants, resets, or changes that permission.

## Build and test

~~~bash
make -C desktop core       # bundle desktop/core + shared TypeScript into build/ghost-core.js
make -C desktop app        # core + host bundle + dynamic library
make -C desktop test       # native tests; no screen or model credentials required
pnpm desktop:test          # the same native test command
~~~

The tiny host app and the dynamic library are separate on purpose:

- build/Shabang.app is the Accessibility-granted host. Rebuilding it with make host-force changes its code signature and can require permission to be granted again.
- build/libshabang.dylib contains the implementation and can be rebuilt normally.
- make -C desktop install-lib installs a release library, without the debug harness, under ~/Library/Application Support/Shabang/.

Do not use make host-force casually.

## Interaction model

- **Focused form value:** Tab accepts a visible suggestion only when it belongs to the focused field. Otherwise Tab remains the app’s key.
- **Other controls:** a lone right-Command tap accepts by default. settings.json can select right Option instead.
- **Escape** dismisses the current suggestion. Typing replaces it.
- **Locked controls:** submit, send, pay, delete, confirm, and related irreversible controls are never activated by Shabang. It parks focus there for the user to review.
- **Pause:** the menu can pause Shabang for the frontmost app, or disable it globally. Alt-Shift-G toggles it globally.

Shabang verifies writes where the accessibility API permits it and gives up rather than retrying a surprising action. It is intentionally conservative around secure and sensitive controls.

## Data and networking

The app stores private local state in ~/Library/Application Support/Shabang/; see [local data](../docs/storage.md). By default, the companion server listens only on 127.0.0.1:8787. It is optional. When configured with an external provider, the server performs the network call; API keys do not live in the app bundle.

The app uses these active server paths: GET /v1/health, POST /v1/predict/form, POST /v1/ghost-text, POST /v1/walk/outcomes, and GET /v1/presence. The server also contains experimental and historical endpoints. Their existence does not mean the desktop app invokes them.

## Install at login

The repository includes a per-user LaunchAgent installer. Review it before it changes your login items:

~~~bash
scripts/install-background.sh --dry-run
scripts/install-background.sh
~~~

It installs a bundled server under ~/Library/Application Support/Shabang/server/, keeps credentials in ~/.config/ghost/env (mode 0600), and installs ~/Applications/Shabang.app without overwriting an existing host bundle. Logs are in ~/Library/Logs/Shabang/.

To remove it:

~~~bash
scripts/uninstall-background.sh --dry-run
scripts/uninstall-background.sh
~~~

--remove-app also removes the installed app and dynamic library; --purge also removes the profile, settings, keys, and logs. Neither command changes macOS Accessibility permissions.

## Diagnostic harness

desktop/tools/ghostctl exists for development and tests. It can inspect a redacted accessibility tree and exercise safe harness paths, but it is not a supported end-user CLI. Never use it to automate a real submission or another irreversible action.

## Current limitations

Accessibility trees differ substantially among apps and browsers. Unlabelled controls, custom widgets, off-screen elements, file upload dialogs, and rich text editors may not be supported in a given app. The optional OpenAI vision path can label eligible unnamed controls, but requires Screen Recording permission and provider configuration; treat it as experimental rather than a universal compatibility claim. Treat the local demo surfaces as the supported rehearsal environment.
