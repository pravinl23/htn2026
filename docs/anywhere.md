# Next-action suggestions

Shabang’s native next-action path is designed for accessible macOS windows, not for a list of named websites. When there is no active form walk, the app ranks the labelled controls it can safely see and shows at most one suggestion.

## Signals used today

The shared affordance module classifies accessible controls into generic roles such as search, play, fullscreen, reply, send, save, download, cart, menu, settings, field, and submit. It also infers broad screen kinds from structure: form, feed/list, media, commerce, reader, mail, app, or unknown.

The native app combines:

1. explicit safety rules, including locked irreversible actions;
2. the accessibility role, label, position, list/media hints, and screen structure;
3. generic role priors; and
4. local role-memory from earlier accepted or rejected suggestions.

This path is local and deterministic. A server model is not the decision maker for the current desktop next-action flow.

## Interaction and safety

The current suggestion is a ghost cursor/ring over a visible accessible control. A lone right-Command tap accepts it by default; Tab remains reserved for focused form-value ghosts. Escape dismisses it. Submit, send, pay, delete, confirm, and similar controls remain locked and are never activated by Shabang.

The app does not pretend an inaccessible or unlabelled control has a reliable meaning. It skips candidates it cannot locate safely. The server-side vision API and native vision helper are experimental and are not a completed way to support icon-only controls.

## Local learning

The app records role-level outcomes locally, so repeated acceptance can reorder a future suggestion for a similar screen. This is bounded local memory, not automatic code or model retraining. See [local data](storage.md) and [learning telemetry](learning-loop.md).
