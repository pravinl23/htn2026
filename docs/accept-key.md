# Which key accepts a ghost, when Tab is already taken

Binding design. Tab is the right key when Ghost is doing what Tab already does: moving through a form and filling it. It is the wrong key almost everywhere else. A video page, a mail client, a code editor, a terminal, a spreadsheet, a rich-text field and countless SPAs all bind Tab themselves, and a "helper" that steals it is a bug.

So Ghost uses **two** keys, and picks between them by evidence rather than by a list of sites.

## 1. The two keys

| Key | When it accepts | Why |
| --- | --- | --- |
| **Tab** | When the current ghost is a value for the field that currently has focus, and the page has not been observed to handle Tab itself | This is the autocomplete case: Tab already means "take this and move on". Nothing is stolen, because Ghost is doing what the key would have done. |
| **Tab** | Also when the ghost is an unlocked next-action PROPOSAL and focus is not in a box the user types in | Measured on the running agent: Tab did nothing at all in Messages and Spotify while the Ghost key worked, because focus in a native app sits on a list row or a sidebar and never on the ghost. Tab's own meaning in that spot is "move focus to some other control", which is a weaker version of what the proposal already offers, so taking it costs the user nothing they wanted. Focus in a text box is still theirs. |
| **The Ghost key** (default: a tap of the **right Option key**, configurable) | Always: clicks, media controls, cross-app suggestions, anything that is not a focused field | A key nobody's page or app binds. Tapped alone it does nothing in macOS; held with another key it still behaves as a normal modifier, so nothing is taken away from the user. |

Escape always dismisses. Typing always wins. Holding the Ghost key accepts consecutive ghosts, and still stops at every guess and every locked action.

## 2. Picking the right key without a site list

**What is built today (2026-09-20):** the Ghost key, and the two Tab rules in the table above. The
observe-and-remember policy below is designed and unit-tested in `shared/src/keys` but **nothing calls it
yet** — no origin is marked `tab: taken`, and no habit is written. The HUD names the key on the current
ghost ("1 ghost in Spotify (right ⌥ accepts)"), which is the discoverability part of section 4 that exists.

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

Alternatives available in settings, for people who use right Option for accented characters: `⌥Space`, `⌘'`, `F19`, double-tap `Shift`, or plain Tab everywhere (the old behaviour).

## 4. Discoverability

A ghost's hint chip names its key: "Tab" or "⌥ tap". The first three times the Ghost key is the accept key on a new machine, the HUD adds one line: "Press right ⌥ to accept". The options page and the menu bar show the current key and let the user change it in one click. Nothing about this is silent: a suggestion the user cannot accept is worse than no suggestion.
