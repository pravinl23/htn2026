# Native macOS pipeline

Shabang Desktop is an Accessibility-based macOS menu-bar app. It can work with browsers and native apps only to the extent that those apps publish a usable accessibility tree. Browser support is therefore a consequence of the native app, not a separate browser product.

## Build shape

desktop/Makefile produces:

- build/Shabang.app: a small, ad-hoc-signed accessory app that holds the Accessibility grant.
- build/libshabang.dylib: the replaceable implementation.
- build/shabang-core.js: the JavaScriptCore bundle of the shared logic consumed by the library.

The host/library split avoids changing the app bundle during ordinary implementation rebuilds. make host-force deliberately replaces the granted host and may require a new Accessibility approval.

## Capture and prediction

~~~text
AX focused window → capture → local safety filter → local ghosts
                                             ↘ optional server upgrade
~~~

SBCapture handles text fields, text areas, eligible selects/radios/checks, buttons, links, and accessible action candidates. It excludes secure fields and candidates flagged by the shared sensitive-data filter. SBNextAction and desktop/core/anywhere.ts rank accessible labelled controls by affordance and local memory when there is not a form walk to complete.

For a form, desktop/core/predict.ts produces local value suggestions. SBServerClient can replace or enrich them with one request for the form, cached by its safe signature. A text area can request a bounded streamed draft from /v1/ghost-text; a form ghost is never delayed while a draft is being prepared.

## Input and writes

Tab is intercepted only for a visible value ghost on the focused field. A lone tap of right Command is the default general accept key (right Option is configurable in settings.json). Escape dismisses, and user typing wins.

SBWriter writes through the accessibility APIs and verifies the resulting state where possible. File upload and custom selection widgets use narrower drivers and abort if expected focus or verification conditions are not met. The app never activates a locked action—such as submit, send, pay, delete, or confirm.

## Permission, pause, and status

Accessibility permission is checked at launch and while running. Until it is granted, the app exposes only its status/menu; it does not access another app’s tree. The menu supports global enable/disable, pause for the frontmost app, opening local profile/settings/log files, and a developer HUD. Alt-Shift-G toggles enablement.

## Integration status

| Capability | Status |
| --- | --- |
| Native accessible form capture, local suggestions, overlay, deliberate acceptance, and verified writes | Implemented and covered by native tests. |
| Optional loopback form prediction and text drafting | Implemented. Provider access is optional and failure falls back to the local path. |
| Local answer and role-memory persistence | Implemented. |
| Vision labels for eligible unnamed controls | Integrated experimental path; requires Screen Recording permission and OpenAI configuration. It is not a universal control-recognition claim. |
| Batch loops, cloud execution, and atomic workflows | Not part of the supported desktop product. Historical/experimental server code may remain in the tree. |
| Chrome extension | Not a product component; historical code only in attic. |

## Development references

- [desktop build and installation](../desktop/README.md)
- [accept-key behavior](accept-key.md)
- [accessible next-action ranking](anywhere.md)
- [actual local files](storage.md)
