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

A before/after benchmark over at least ten **synthetic but realistic** surfaces, none named after a real site in code: photo feed, professional feed, mail list, mail thread, video feed, video player, encyclopedia article, product page, cart, music player, chess board, settings pane, note editor, file browser. For each: with an empty graph, with a cold-start graph, and after five simulated sessions of use, report where the correct action ranked and how often the top proposal was right. That table is the deliverable, not a demo video.
