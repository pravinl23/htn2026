import { describe, expect, it } from "vitest";
import { inferPageKind, priorsFor } from "../src";
import type { PageKind, PageKindEvidence } from "../src";
import {
  articlePage, candidate, cartPage, formPage, gridFeed, items, mailItem, mailList,
  otherVideoPage, productPage, searchResults, unknownApp, videoPage,
} from "./helpers/affordanceFixtures";
import type { Page } from "./helpers/affordanceFixtures";

const EVIDENCE_CODES: readonly PageKindEvidence[] = [
  "media-element", "media-controls", "media-roles", "repeated-items", "item-roles", "search-affordance",
  "price-signals", "cart-role", "buy-role", "mail-roles", "field-count", "submit-role",
  "text-density", "few-controls", "path-pattern", "app-bundle", "has-controls", "no-candidates",
];

describe("inferPageKind places a page from what it offers", () => {
  it.each<[string, () => Page, PageKind]>([
    ["a player", videoPage, "media"],
    ["another player with different words", otherVideoPage, "media"],
    ["a grid of cards", gridFeed, "feed"],
    ["a list of results", searchResults, "feed"],
    ["a product page", productPage, "commerce"],
    ["a cart", cartPage, "commerce"],
    ["a long article", articlePage, "reader"],
    ["a mailbox", mailList, "mail"],
    ["one open message", mailItem, "mail"],
    ["a form", formPage, "form"],
    ["an app it cannot read", unknownApp, "app"],
  ])("calls %s a %s page", (_name, make, kind) => {
    const guess = inferPageKind(make().signals);
    expect(guess.kind).toBe(kind);
    expect(guess.confidence).toBeGreaterThanOrEqual(0.45);
  });

  it("is confident about a player and honest about a page it cannot read", () => {
    expect(inferPageKind(videoPage().signals).confidence).toBeGreaterThanOrEqual(0.85);
    expect(inferPageKind(unknownApp().signals).confidence).toBeLessThan(0.6);
  });

  it("reports only closed-set evidence codes", () => {
    for (const make of [videoPage, gridFeed, productPage, cartPage, articlePage, mailList, formPage, unknownApp]) {
      for (const code of inferPageKind(make().signals).evidence) expect(EVIDENCE_CODES).toContain(code);
    }
  });

  it("lets a media element win over a page that also repeats items", () => {
    const player = videoPage();
    expect(player.signals.mainRegionRepeats).toBeGreaterThan(0);
    expect(inferPageKind(player.signals).kind).toBe("media");
    expect(inferPageKind({ ...player.signals, hasMediaElement: false, candidates: [] }).kind).not.toBe("media");
  });

  it("treats a grid of priced tiles as a feed of items, whose priors are still right", () => {
    const tiles = [candidate("icon:cart", "", { classTokens: ["icon-cart"] }), ...items(9, "div.tiles", (i) => `Tile ${i}`, { nearbyPrice: true })];
    const guess = inferPageKind({ candidates: tiles, mainRegionRepeats: 9, textDensity: 0.2, pathPattern: "/browse" });
    expect(guess.kind).toBe("feed");
    expect(priorsFor(guess.kind)[0]?.role).toBe("primary-item");
  });

  it("falls back to app for a window that offers controls but says nothing else", () => {
    const guess = inferPageKind({ candidates: unknownApp().candidates, appBundleId: "com.example.editor" });
    expect(guess.kind).toBe("app");
    expect(guess.evidence).toContain("app-bundle");
  });

  it("is unknown with nothing on screen, whatever the path says", () => {
    expect(inferPageKind({ candidates: [] }).kind).toBe("unknown");
    expect(inferPageKind({ candidates: [], pathPattern: "/cart/checkout" }).kind).toBe("unknown");
  });

  it("never decides from the path alone", () => {
    const bare = [candidate("a", "Panel"), candidate("b", "Refresh")];
    for (const pathPattern of ["/watch/:id", "/cart", "/inbox", "/blog/:slug"]) {
      expect(inferPageKind({ candidates: bare, pathPattern }).kind).toBe("app");
    }
  });

  it("does not call a one-field page a form", () => {
    const search = [candidate("f", "", { kind: "field", inputType: "search" }), candidate("b", "Go")];
    expect(inferPageKind({ candidates: search }).kind).not.toBe("form");
  });

  it("needs running text, not just few controls, to call a page a reader", () => {
    const article = articlePage();
    expect(inferPageKind({ ...article.signals, textDensity: 0.2 }).kind).not.toBe("reader");
  });

  it("classifies the same candidates the same way whatever their ids are", () => {
    const page = productPage();
    const renamed = page.candidates.map((c, i) => ({ ...c, id: `zz-${i}` }));
    expect(inferPageKind({ ...page.signals, candidates: renamed }).kind).toBe(inferPageKind(page.signals).kind);
  });
});

describe("what real pages taught it", () => {
  it("calls a page with a cart a shop, even when its header is all Ghost can see", () => {
    const header = [
      candidate("f", "", { kind: "field", ariaRole: "searchbox", placeholder: "Search the store" }),
      candidate("c", "0 items in cart", { kind: "link", classTokens: ["nav-cart"] }),
      candidate("m", "Open all categories menu", { kind: "link" }),
    ];
    expect(inferPageKind({ candidates: header, mainRegionRepeats: 0, pathPattern: "/" }).kind).toBe("commerce");
  });

  it("does not become a feed because the navigation bar repeats", () => {
    const nav = items(7, "UL.nav>LI", (i) => `Category ${i}`);
    const guess = inferPageKind({ candidates: nav, mainRegionRepeats: 0, textDensity: 0.2, pathPattern: "/" });
    expect(guess.kind).not.toBe("feed");
  });
});
