# The knowledge layer: a model of one person, usable on any surface

Binding design, and it supersedes the job-application framing in `docs/profile-sources.md` and `docs/cold-start.md`. Those describe one corner of this: facts you type into forms. The layer has to serve every surface a person uses, in a browser or not: Instagram, LinkedIn, Gmail, YouTube, Wikipedia, Amazon, Spotify, a chess site, System Settings, Notion, Finder, a game launcher. Nothing in the code may name any of them.

## 1. Three kinds of knowledge

| Kind | Question it answers | Shape | Where it comes from |
| --- | --- | --- | --- |
| **Facts** | "What does this person put in a field like this?" | `key -> value` with label, aliases, category, provenance | Contact card, résumé, git remotes, website, what they type |
| **Surfaces** | "What does this person use, and how much?" | `surface -> {visits, lastSeenBucket, typical hours, screen kinds seen}` | Browser history aggregates, the Dock, recent apps, recent documents, app inventory |
| **Habits** | "Here, after that, what do they do next?" | `(surface, screenKind, previousAction, action) -> {taken, ignored, replaced}` | Every proposal accepted or ignored, and every observed user action |

Facts fill fields. Surfaces and habits predict actions. All three live in the one small file (`docs/storage.md`).

## 2. The context key, and why it generalizes

Every prediction asks with the same key, whether it is a web page or a native window:

```ts
interface Context {
  surface: string;        // "youtube.com" or "app:com.apple.systempreferences" — an opaque id, never parsed for meaning
  screenKind: string;     // "feed" | "media" | "list" | "reader" | "commerce" | "settings" | "editor" | "board" | "form" | "unknown"
  previousAction?: string;// the action role taken just before, in this surface or the one before it
  hourBucket: 0..5;       // 4-hour buckets, so "morning mail" is learnable without storing timestamps
  candidates: ActionRef[];// what is on screen now, each with a role guess and an id
}
```

`screenKind` and the candidates' roles come from structure (a media element and a controls cluster, a repeated grid, a settings-style list of labelled rows, a text editor surface), never from the site's identity. The same inference runs over a DOM and over a macOS accessibility tree, so a native window and a web page are the same problem.

Generalization comes from **three levels of prior**, blended in code:

1. **This surface, this screen kind** — "on this site's video screens, this person hits fullscreen".
2. **Any surface, same screen kind** — "on video screens generally, this person hits fullscreen", which is what makes a brand-new site useful immediately.
3. **Shape-only prior** — what anyone would most likely want on a screen of that kind, used when there is no history at all.

A proposal always exists (`docs/always-propose.md`); these levels only decide which candidate leads and how confident the ghost looks.

## 3. Cold start builds all three

Beyond the résumé-ish sources already specified, the scan must populate **surfaces and habits** from what the machine already knows, because a first-run user has no history with Ghost:

- **Browser history aggregates** (all Chromium-family profiles; Safari with permission): per origin, visit counts, hour buckets, and the top origin-to-origin transitions. Counters only.
- **The Dock, login items, recent applications and recent documents**: the apps this person actually lives in, and how recently.
- **Application inventory**: what is installed, so a surface seen for the first time can still be recognized as an app they own.
- Nothing else. No page text, no titles, no URLs beyond origins, no document contents.

That gives Ghost, on its first run, a ranked picture of the ten or twenty surfaces this person uses and when, which is most of what "predict anything" needs.

## 4. Learning never stops

Every proposal outcome updates habits: taken, ignored, or replaced by a different action the user chose instead (the strongest signal of all). Corrections to field values update facts (`docs/answers.md`). Both are counters in the same file, both are capped and prunable, and both are visible and deletable per source.

## 5. The API the predictors use

```ts
rankActions(context, graph): Array<{ id, score, reason, tier }>   // any surface, any client
matchFactsForField(field, graph): Array<{ key, confidence, reason }>
recordOutcome(context, action, outcome): void                     // taken | ignored | replaced
```

The browser ranker (owned by another stream) and the native agent both call `rankActions`; neither needs its own memory. The reason string is user-facing ("you usually do this here", "people usually do this on a screen like this").

## 6. What "proven" means

A before/after benchmark over sixteen **synthetic but realistic** screens, none named after a real place in
code: photo feed, professional feed, mail list, mail thread, video feed, video player, encyclopedia article,
product page, cart, music player, chess board, settings pane, note editor, file browser, plus a form and a window
nothing can read. Each is built from STRUCTURE — repeated groups, a media node with a controls cluster, labelled
switch rows, a dominant editable region, equal cells — so the same table would hold for a native window.

One scripted person uses all sixteen. Some are **steady** (the same action every session), some are **noisy**
(usually that action, sometimes something else), and three are **unusual**: the person does something that
contradicts both the shape of the screen and their own habit on screens of that kind. Nothing but learning that
screen can get those three right, which is the whole point of the layer.

Three conditions, measured as **where the action the person wants came in the ranking**:

1. **empty** — a graph that knows nothing. The shape-only prior decides.
2. **cold start** — day one, before Ghost has been taught anything: synthetic history goes through the real
   pipeline (`aggregateHabits` -> `seedFromColdStart`), which only ever learns *per kind of screen*, never per
   place. Nothing in it is keyed to any screen in the table.
3. **after five sessions** — five simulated visits with the ranker in the loop: Ghost proposes, the person takes
   it or does something else, and every outcome is recorded exactly as a client records it.

Run it with `node scripts/bench-knowledge.mjs`; `shared/test/knowledge.benchmark.test.ts` asserts on the same
numbers and fails if any column stops improving.

<!-- benchmark:start -->

| shape | kind | person | candidates | empty | cold start | after 5 sessions |
| --- | --- | --- | --- | --- | --- | --- |
| a picture feed | feed | unusual | 12 | 10 | 10 | 1 |
| a feed of written posts | feed | noisy | 10 | 1 | 1 | 1 |
| a list of messages with one open | list | unusual | 15 | 12 | 12 | 1 |
| one open message thread | reader | unusual | 4 | 4 | 4 | 1 |
| a grid of video thumbnails | feed | noisy | 10 | 1 | 1 | 1 |
| a playing video with a rail beside it | media | steady | 10 | 1 | 1 | 1 |
| a long reference article | reader | steady | 8 | 6 | 1 | 1 |
| one item for sale | commerce | steady | 5 | 1 | 1 | 1 |
| a basket with three lines | commerce | noisy | 9 | 1 | 1 | 1 |
| a music player with a queue | media | noisy | 13 | 1 | 1 | 1 |
| a board of small equal squares | board | steady | 11 | 1 | 1 | 1 |
| a pane of labelled switches | settings | steady | 15 | 9 | 1 | 1 |
| a document being written | editor | steady | 12 | 2 | 1 | 1 |
| a browser of files | list | noisy | 15 | 1 | 1 | 1 |
| a form of labelled fields | form | steady | 9 | 1 | 1 | 1 |
| a window with two nameless controls | unknown | steady | 2 | 1 | 1 | 1 |

| overall | empty | cold start | learned |
| --- | --- | --- | --- |
| top proposal right | 10/16 (63%) | 13/16 (81%) | 16/16 (100%) |
| mean rank of the right action | 3.31 | 2.44 | 1.00 |
| top proposal came from a learned habit | 0/16 | 12/16 | 16/16 |
| top proposal came from the shape alone | 16/16 | 4/16 | 0/16 |

<!-- benchmark:end -->

**The three things this table says.** A screen Ghost has never seen is useful immediately (10/16 from shape
alone). The scan makes it better before the user does anything (13/16, and 12 of the 16 top proposals now come
from something learned about this person rather than from the shape). And five sessions get every screen right,
including the three where this person does something no shape prior would ever guess.

**What it does not say.** Where a screen repeats identical controls — a board of squares, a grid of items — the
layer predicts the KIND of control and the first member of the repeat, not which square; exact repeats are the
episodic loop store's job. A proposal that is never made can never be turned down, so a screen where the person
is inconsistent can oscillate for a while: with ten sessions of the noisiest screen the right action sits at rank
2 before settling back to 1. And the history vocabulary has no word for a settings pane, an editor or a board, so
those three kinds are cold-started the way a native window scan would seed them rather than from browsing.
