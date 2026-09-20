// Synthetic pages for the "Ghost anywhere" tests. Every label here is generic UI English: no site, product or
// brand name appears in any fixture, because no rule in shared/src/affordance may depend on one.
import type { AffordanceCandidate, PageSignals } from "../../src";

export function candidate(id: string, label: string, over: Partial<AffordanceCandidate> = {}): AffordanceCandidate {
  return { id, kind: "button", label, locked: false, ...over };
}

/** n repeated items of one list, the way the loop engine's list detector reports them. */
export function items(n: number, listSignature: string, label: (i: number) => string, over: Partial<AffordanceCandidate> = {}): AffordanceCandidate[] {
  return Array.from({ length: n }, (_, index) =>
    candidate(`link:${listSignature}:${index}`, label(index), { kind: "link", list: { listSignature, index }, ...over }),
  );
}

export interface Page {
  candidates: AffordanceCandidate[];
  signals: PageSignals;
}

function page(candidates: AffordanceCandidate[], signals: Omit<PageSignals, "candidates">): Page {
  return { candidates, signals: { ...signals, candidates } };
}

/** A player: icon-only controls, one of them named, one of them nameless, plus a rail of related items. */
export function videoPage(): Page {
  return page(
    [
      candidate("btn:play", "", { classTokens: ["player-button", "player-play-button"], insideMediaControls: true }),
      candidate("btn:fullscreen", "Full screen", { classTokens: ["player-button"], insideMediaControls: true }),
      candidate("btn:captions", "", { classTokens: ["player-button", "player-subtitles-button"], insideMediaControls: true }),
      candidate("btn:mystery", "", { classTokens: ["player-button"], insideMediaControls: true }),
      candidate("btn:next", "Next video", { insideMediaControls: true }),
      ...items(6, "ul.related", (i) => `A twenty minute talk, part ${i + 1}`),
      candidate("field:search", "", { kind: "field", inputType: "search", placeholder: "Search" }),
    ],
    { hasMediaElement: true, mainRegionRepeats: 6, textDensity: 0.1, pathPattern: "/watch/:id" },
  );
}

/** A second player with different ids, labels and icon words: role memory must transfer to it. */
export function otherVideoPage(): Page {
  return page(
    [
      candidate("c1", "", { classTokens: ["mp-icon", "mp-play-control"], insideMediaControls: true }),
      candidate("c2", "Enter full screen", { classTokens: ["mp-icon"], insideMediaControls: true }),
      candidate("c3", "Mute", { insideMediaControls: true }),
      ...items(3, "div.up-next", (i) => `Episode ${i + 4}`),
    ],
    { hasMediaElement: true, mainRegionRepeats: 3, textDensity: 0.1, pathPattern: "/v/:id" },
  );
}

/** A grid of repeated cards with a search box and a load-more control. */
export function gridFeed(): Page {
  return page(
    [
      candidate("field:search", "", { kind: "field", inputType: "search", placeholder: "Search" }),
      ...items(12, "div.grid", (i) => `A card about something, number ${i + 1}`),
      candidate("btn:more", "Show more"),
      candidate("btn:menu", "", { classTokens: ["icon", "icon-hamburger"] }),
    ],
    { mainRegionRepeats: 12, textDensity: 0.2, pathPattern: "/home" },
  );
}

/** A list of results for a query the user already typed. */
export function searchResults(): Page {
  return page(
    [
      candidate("field:q", "", { kind: "field", name: "q", placeholder: "Search" }),
      ...items(10, "ol.results", (i) => `Result number ${i + 1}`),
      candidate("btn:next-page", "Next page"),
    ],
    { mainRegionRepeats: 10, textDensity: 0.35, pathPattern: "/search" },
  );
}

/** One product, a cart glyph carrying a count, and the two irreversible controls a shop always has. */
export function productPage(): Page {
  return page(
    [
      candidate("icon:cart", "", { classTokens: ["header-icon", "icon-cart"], badgeCount: 2 }),
      candidate("field:search", "", { kind: "field", inputType: "search", placeholder: "Search the store" }),
      candidate("select:qty", "Quantity", { kind: "field", ariaRole: "combobox" }),
      candidate("btn:add", "Add to cart", { nearbyPrice: true }),
      candidate("btn:buy", "Buy now", { nearbyPrice: true }),
      candidate("btn:wishlist", "Save for later"),
      ...items(4, "ul.similar", (i) => `Another one like it ${i + 1}`, { nearbyPrice: true }),
    ],
    { mainRegionRepeats: 4, textDensity: 0.3, pathPattern: "/product/:id" },
  );
}

/** The cart itself: rows with prices, a checkout button, and per-row destructive controls. */
export function cartPage(): Page {
  return page(
    [
      candidate("icon:cart", "", { classTokens: ["header-icon", "icon-cart"], badgeCount: 3 }),
      ...items(3, "ul.cart-lines", (i) => `Line item ${i + 1}`, { nearbyPrice: true }),
      candidate("btn:remove-0", "Remove"),
      candidate("btn:delete-0", "Delete this line"),
      candidate("select:qty-0", "Quantity", { kind: "field", ariaRole: "combobox" }),
      candidate("btn:checkout", "Proceed to checkout", { nearbyPrice: true }),
    ],
    { mainRegionRepeats: 3, textDensity: 0.2, pathPattern: "/cart" },
  );
}

/** A long piece of running text with almost no controls. */
export function articlePage(): Page {
  return page(
    [
      candidate("btn:menu", "", { classTokens: ["icon-hamburger"] }),
      candidate("btn:share", "Share"),
      candidate("btn:continue", "Continue reading"),
      candidate("link:back", "Back to all posts", { kind: "link" }),
    ],
    { mainRegionRepeats: 0, textDensity: 0.85, pathPattern: "/blog/:slug" },
  );
}

/** A mailbox: a list of rows plus the controls only a mailbox has. */
export function mailList(): Page {
  return page(
    [
      candidate("btn:compose", "Compose"),
      candidate("field:search", "", { kind: "field", inputType: "search", placeholder: "Search mail" }),
      ...items(12, "ul.threads", (i) => `A message about the thing, ${i + 1}`),
      candidate("btn:archive", "Archive"),
    ],
    { mainRegionRepeats: 12, textDensity: 0.4, pathPattern: "/inbox" },
  );
}

/** One open message: the main region shows an item, not a list. */
export function mailItem(): Page {
  return page(
    [
      candidate("btn:reply", "Reply"),
      candidate("btn:send", "Send"),
      candidate("link:back", "Back to inbox", { kind: "link" }),
      candidate("field:body", "Message", { kind: "field" }),
    ],
    { mainRegionRepeats: 1, textDensity: 0.55, pathPattern: "/inbox/:id" },
  );
}

/** Something Ghost cannot place: generic controls, no list, no media, no prices, no fields. */
export function unknownApp(): Page {
  return page(
    [
      candidate("btn:a", "Panel"),
      candidate("btn:b", "Refresh"),
      candidate("btn:c", "Toggle grid"),
      candidate("btn:d", "Options"),
    ],
    { mainRegionRepeats: 0, textDensity: 0.15, pathPattern: "/workspace/:id" },
  );
}

/** The old world: a form. It must keep classifying as a form now that everything else exists. */
export function formPage(): Page {
  return page(
    [
      candidate("field:first", "First name", { kind: "field" }),
      candidate("field:last", "Last name", { kind: "field" }),
      candidate("field:email", "Email", { kind: "field" }),
      candidate("field:phone", "Phone", { kind: "field" }),
      candidate("field:why", "Why do you want this role?", { kind: "field" }),
      candidate("btn:submit", "Submit application"),
    ],
    { mainRegionRepeats: 0, textDensity: 0.25, pathPattern: "/apply" },
  );
}
