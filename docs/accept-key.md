# Which key accepts a ghost, when Tab is already taken

Binding design. Tab is the right key when Ghost is doing what Tab already does: moving through a form and filling it. It is the wrong key almost everywhere else. A video page, a mail client, a code editor, a terminal, a spreadsheet, a rich-text field and countless SPAs all bind Tab themselves, and a "helper" that steals it is a bug.

So Ghost uses **two** keys, and picks between them by evidence rather than by a list of sites.

## 1. The two keys

| Key | When it accepts | Why |
| --- | --- | --- |
| **Tab** | Only when the current ghost is a value for the field that currently has focus | This is the autocomplete case: Tab already means "take this and move on". Nothing is stolen, because Ghost is doing what the key would have done. Tried and reverted (2026-09-20): letting Tab also take a next-action proposal did make Tab work in Messages and Spotify, but Tab is the most overloaded key on the keyboard and a helper that takes it where an app has its own meaning for it is a bug, however convenient the good case looks. |
| **The Ghost key** (`acceptKey` in settings.json: `right-option` by default, or `right-command`) | Always: clicks, media controls, list entries, cross-app suggestions, anything that is not a focused field | A key nobody's page or app binds. Only a LONE tap counts -- down and up inside 300 ms with no other key in between -- and the modifier event is never consumed, so holding it still behaves as a normal modifier and right Option still types accented characters. That is the whole of its conflict surface: none. |

Escape always dismisses. Typing always wins. Holding the Ghost key accepts consecutive ghosts, and still stops at every guess and every locked action.

## 2. Picking the right key without a site list

**What is built today (2026-09-20):** the Ghost key, configurable through `acceptKey`, and the one Tab rule
in the table above. The observe-and-remember policy below is designed and unit-tested in `shared/src/keys`
but **nothing calls it yet** — no origin is marked `tab: taken`, and no habit is written. In practice it is
not needed: Tab is form-only, so there is nothing to observe. The HUD names the key on the current ghost
("1 ghost in Spotify (right ⌥ accepts)"), which is the part of section 4 that exists.

Ghost never assumes. It observes, per origin (browser) or per app (native), and remembers the result in the habits section of `docs/storage.md`:

1. **First ghost on a new origin/app:** Ghost does not intercept Tab at all. It dispatches nothing and watches: if a Tab press is handled by the page (the event comes back `defaultPrevented`, or focus does not move to the next control, or the app consumed it), that origin is marked `tab: taken`.
2. `tab: taken` is sticky for that origin/app, and the Ghost key becomes the only accept key there. The HUD and the ghost's hint chip show which key to press, so the user is never guessing.
3. `tab: free` origins get the familiar Tab behaviour for field ghosts, with the Ghost key working as well.
4. A single user correction overrides the observation: pressing the Ghost key where Tab was expected (or the reverse) is recorded, and three consistent presses flip the origin permanently.
5. Editors, terminals and password managers keep the existing per-app pause: Ghost does not suggest there at all, so the question never arises.

This is the same "observe, then remember" pattern as `docs/answers.md`: no hard-coded site knowledge, one correction teaches it.

## 3. Why the right Option tap

Requirements for the Ghost key: reachable with the hand already on the keyboard, unused by macOS and by common apps, harmless if pressed by accident, and capturable by a `CGEventTap` in the native agent and by a `keydown/keyup` pair in the extension.

The right Option key meets all of them: tapped alone (down and up within 300 ms, no other key in between, no drag) it produces nothing in macOS, and Ghost can consume the tap without ever swallowing a real modifier use. The extension sees the same tap as `Alt` keydown/keyup with no intervening key.

The one alternative built is `acceptKey: "right-command"`, for anyone who would rather keep the accept key
away from the accent modifier entirely. It has the same shape and the same guard: a lone tap, never a chord.

Considered and rejected: `⌥Space` and `⌘'` are bound by real apps; `F19` does not exist on most keyboards;
double-tapping `Shift` misfires when typing fast capitals. Every one of those has a conflict surface that a
lone right-hand modifier tap does not.

## 4. Discoverability

A ghost's hint chip names its key: "Tab" or "⌥ tap". The first three times the Ghost key is the accept key on a new machine, the HUD adds one line: "Press right ⌥ to accept". The options page and the menu bar show the current key and let the user change it in one click. Nothing about this is silent: a suggestion the user cannot accept is worse than no suggestion.
