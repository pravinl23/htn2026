# Ghost anywhere: predicting the next action on any page or app

Binding design. Ghost must feel the same on YouTube, Amazon, Gmail, Figma, Finder or a job form. Nothing in this document names a website. Everything is derived from what a page or window *offers*.

## 1. The problem with label ranking

Today a candidate is `{ id, kind, label, locked, context }` and a model ranks labels. That fails exactly where "anywhere" starts:

- **Icon-only controls.** A video player's fullscreen button, a cart glyph, a kebab menu: no text in the DOM, no `AXTitle` in the accessibility tree. A label ranker has nothing to rank.
- **Per-item signatures.** Every video, product and message has its own signature, so "after opening a video I go fullscreen" never transfers to the next video.
- **No sense of place.** A feed, a player, a cart and a document want completely different defaults, and a flat candidate list hides that.

## 2. Affordances, not labels

`shared/src/affordance/**` (pure, no DOM, no AX) turns raw candidates into typed affordances.

```ts
export type AffordanceRole =
  | "primary-item"   // the first/next item of a feed, grid, list or search result
  | "search"         // a search input or the control that opens one
  | "play" | "pause" | "fullscreen" | "next" | "previous" | "skip" | "mute" | "captions" | "speed"
  | "cart" | "checkout" | "buy" | "quantity" | "wishlist"
  | "compose" | "reply" | "send" | "save" | "download" | "share"
  | "more" | "menu" | "settings" | "close" | "back" | "forward" | "scroll-more"
  | "field" | "submit" | "unknown";

export type PageKind = "feed" | "media" | "commerce" | "reader" | "mail" | "form" | "app" | "unknown";
```

Evidence used (all generic): the accessible name, the icon's `aria-label`/`AXDescription`, the control's position inside a `<video>`'s controls container or an `AXGroup` whose descendants include a media element, a `role=search`/`type=search`/placeholder that says search, a grid or list of repeated items (the list detector we already have for loops), a URL path pattern, the presence of a price-shaped string near a control, a badge count on an icon, and the window/app identity on the native side. Each mapping returns a confidence, never a hard rule.

`inferPageKind(candidates, signals)` is the same idea one level up: a page with a media element and a controls cluster is `media`; a page whose main region is a repeated grid is `feed`; price strings plus a cart affordance is `commerce`; a long text region with few controls is `reader`.

## 3. Priors by place, memory by role

Two prediction sources, combined in code before anything is asked of a model:

1. **Priors.** Per `PageKind`, an ordered list of roles people usually want next: `media` → `play`, then `fullscreen`, then `next`; `feed` → `primary-item`, then `search`, then `scroll-more`; `commerce` with a non-empty cart → `cart`, then `checkout` (locked); `reader` → `scroll-more`, then `back`. Priors are weak (0.55 to 0.7) and never beat memory.
2. **Role-keyed memory.** The episodic store gains a second key: `(pageKind, previous role, affordance role)` alongside the existing signature key. This is what makes "I always go fullscreen after starting a video" transfer to a video it has never seen, and "I always click the cart after adding" transfer between shops. Signature memory stays for exact repeats on one page.

The model (Jev) still makes the final choice over the filtered candidates, now labelled with their role and the page kind in the state, plus `none`. Code decides what is even offered; the model picks; code verifies and executes. Ghost ALWAYS proposes the top candidate; the threshold only decides how it is drawn (`docs/always-propose.md`). A prior alone is enough on a page it has never seen.

## 4. Naming what has no name (OpenAI vision)

When a candidate has no accessible name and its role is still `unknown` after the heuristics, Ghost crops that control from a screenshot and asks `POST /v1/vision/label` (already built: OpenAI Responses API, strict JSON, code re-derives locks and sensitivity). The returned label feeds the same affordance mapping, so one vision call can turn a row of icon buttons into `play`, `fullscreen`, `captions`.

Rules: at most one vision call per page view, batched over up to 40 boxes, cached by a hash of the box geometry plus the page's path pattern, never for a page with a sensitive field on screen, and never blocking: the ghost appears from heuristics first and upgrades when the labels arrive. No key, no vision: everything still works, just blind to icons.

## 5. What the user sees

Same Tab. On YouTube the ghost cursor sits on the video you would click; once it is playing, the next Tab is fullscreen. On a shop, after adding an item, it waits on the cart; checkout gets the lock and needs a real click. In a document it offers the next natural step rather than a random button. Anything irreversible keeps its lock, Escape dismisses, typing wins, and a wrong guess costs one Tab.

## 6. Learning

Every accept and every ignore updates the role-keyed memory (accepted raises, dismissed lowers, a different control clicked instead records that role). This is the same correction loop as `docs/answers.md`, so both feed the one telemetry shape in section 6 of that document.

## 7. Where it runs

- `shared/src/affordance/**`: taxonomy, page-kind inference, priors, role-keyed memory helpers. Pure and unit-tested. The extension ranker (owned by Codex-Universal) and the native agent both import it.
- Native (`desktop/`): capture maps AX roles and descriptions into affordances, drives the vision fallback, and renders the same ghosts.
- Extension: consumes the shared module through its existing candidate builder.
