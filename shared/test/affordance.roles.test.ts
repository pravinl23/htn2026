import { describe, expect, it } from "vitest";
import { classifyAffordance, classifyAll, isGlyphOnly, lockedForRole, normalizeAffordanceText } from "../src";
import type { AffordanceCandidate, AffordanceEvidence, AffordanceRole } from "../src";
import { candidate, cartPage, formPage, gridFeed, otherVideoPage, productPage, videoPage } from "./helpers/affordanceFixtures";

const EVIDENCE_CODES: readonly AffordanceEvidence[] = [
  "accessible-name", "description", "icon-token", "glyph-only", "media-cluster",
  "search-input", "list-item", "price-nearby", "badge-count", "path-pattern", "kind",
];

const roleOf = (c: AffordanceCandidate, context = {}): AffordanceRole => classifyAffordance(c, context).role;
const byId = (page: { candidates: AffordanceCandidate[] }, id: string): AffordanceCandidate => {
  const found = page.candidates.find((c) => c.id === id);
  if (!found) throw new Error(`fixture has no candidate ${id}`);
  return found;
};

describe("icon-only controls", () => {
  const player = videoPage();
  const inPlayer = { hasMediaElement: true };

  it("names a glyph play button from its icon word", () => {
    const play = classifyAffordance(byId(player, "btn:play"), inPlayer);
    expect(play.role).toBe("play");
    expect(play.evidence).toContain("icon-token");
    expect(play.evidence).toContain("glyph-only");
  });

  it("reads the aria-label of an icon button when it has one", () => {
    const full = classifyAffordance(byId(player, "btn:fullscreen"), inPlayer);
    expect(full.role).toBe("fullscreen");
    expect(full.evidence).toEqual(["accessible-name", "media-cluster"]);
  });

  it("classifies a subtitles glyph as captions", () => {
    expect(roleOf(byId(player, "btn:captions"), inPlayer)).toBe("captions");
  });

  it("leaves a nameless, wordless control unknown so the vision fallback can name it", () => {
    const mystery = classifyAffordance(byId(player, "btn:mystery"), inPlayer);
    expect(mystery.role).toBe("unknown");
    expect(mystery.evidence).toEqual(["glyph-only"]);
  });

  it("uses the media cluster to raise a media role", () => {
    const loose = candidate("x", "Next video");
    expect(classifyAffordance(loose, {}).role).not.toBe("next");
    expect(classifyAffordance({ ...loose, insideMediaControls: true }, {}).role).toBe("next");
  });

  it.each([
    ["Play squash on Tuesdays", {}],
    ["Volume of work", {}],
  ])("does not read player words outside a player: %s", (label, context) => {
    expect(roleOf(candidate("x", label), context)).toBe("unknown");
  });

  it("ignores a play-shaped class token outside a player", () => {
    expect(roleOf(candidate("x", "", { classTokens: ["btn", "play-cta"] }))).toBe("unknown");
  });

  it("treats an icon word as corroboration, not a decision, when the control has a real name", () => {
    expect(roleOf(candidate("x", "Download the report", { classTokens: ["icon-share"] }))).toBe("download");
  });
});

describe("search affordances", () => {
  it.each([
    ["type=search", { kind: "field" as const, inputType: "search" }],
    ["role=searchbox", { kind: "field" as const, ariaRole: "searchbox" }],
    ["a search-shaped name", { kind: "field" as const, name: "q", placeholder: "Search" }],
    ["a search placeholder", { kind: "field" as const, placeholder: "Search everything" }],
  ])("classifies a field with %s as search", (_why, over) => {
    expect(roleOf(candidate("f", "", over))).toBe("search");
  });

  it("classifies a button named Search as search", () => {
    expect(roleOf(candidate("b", "Search"))).toBe("search");
  });

  it("does not turn an ordinary text field into search", () => {
    expect(roleOf(candidate("f", "First name", { kind: "field" }))).toBe("field");
  });
});

describe("repeated items", () => {
  const feed = gridFeed();

  it("classifies a list member with no verb as the primary item", () => {
    expect(roleOf(byId(feed, "link:div.grid:0"))).toBe("primary-item");
  });

  it("ranks the first item of a list highest among items", () => {
    const first = classifyAffordance(byId(feed, "link:div.grid:0"));
    const fifth = classifyAffordance(byId(feed, "link:div.grid:5"));
    expect(first.confidence).toBeGreaterThan(fifth.confidence);
    expect(first.evidence).toContain("list-item");
  });

  it("keeps an action inside a row as that action, not as the row", () => {
    const reply = candidate("r", "Reply", { list: { listSignature: "ul.threads", index: 2 } });
    expect(roleOf(reply)).toBe("reply");
  });

  it("reads a price beside a link as a product tile", () => {
    expect(roleOf(candidate("p", "A nice thing", { kind: "link", nearbyPrice: true }))).toBe("primary-item");
  });
});

describe("commerce affordances", () => {
  const shop = productPage();
  const cart = cartPage();

  it("classifies an add-to-cart button as cart", () => {
    expect(roleOf(byId(shop, "btn:add"))).toBe("cart");
  });

  it("classifies a cart glyph with a badge as cart", () => {
    const icon = classifyAffordance(byId(shop, "icon:cart"));
    expect(icon.role).toBe("cart");
    expect(icon.evidence).toContain("badge-count");
  });

  it("classifies checkout and buy", () => {
    expect(roleOf(byId(cart, "btn:checkout"))).toBe("checkout");
    expect(roleOf(byId(shop, "btn:buy"))).toBe("buy");
  });

  it("keeps a quantity control out of the plain field bucket", () => {
    expect(roleOf(byId(shop, "select:qty"))).toBe("quantity");
  });

  it("classifies save-for-later as wishlist, not save", () => {
    expect(roleOf(byId(shop, "btn:wishlist"))).toBe("wishlist");
  });
});

describe("message and document verbs", () => {
  it.each<[string, AffordanceRole]>([
    ["Compose", "compose"],
    ["New message", "compose"],
    ["Reply all", "reply"],
    ["Send", "send"],
    ["Save", "save"],
    ["Download", "download"],
    ["Export", "download"],
    ["Share", "share"],
  ])("classifies %s as %s", (label, role) => {
    expect(roleOf(candidate("b", label))).toBe(role);
  });
});

describe("navigation and chrome", () => {
  it.each<[string, AffordanceRole]>([
    ["Show more", "scroll-more"],
    ["Load more", "scroll-more"],
    ["Next page", "scroll-more"],
    ["Continue reading", "scroll-more"],
    ["Back to all posts", "back"],
    ["Settings", "settings"],
    ["Options", "settings"],
    ["Close", "close"],
    ["Menu", "menu"],
    ["More actions", "more"],
  ])("classifies %s as %s", (label, role) => {
    expect(roleOf(candidate("b", label))).toBe(role);
  });

  it("classifies a hamburger glyph as the menu", () => {
    expect(roleOf(candidate("b", "", { classTokens: ["icon", "icon-hamburger"] }))).toBe("menu");
  });

  it("treats a bare Next outside a player as the next step of a flow", () => {
    expect(roleOf(candidate("b", "Next"))).toBe("submit");
  });
});

describe("locks (rule 2)", () => {
  it.each(["Proceed to checkout", "Buy now", "Place order", "Delete this line", "Remove", "Submit application", "Send"])(
    "locks %s",
    (label) => {
      const c = candidate("b", label);
      expect(lockedForRole(c, classifyAffordance(c).role)).toBe(true);
    },
  );

  it.each(["Play", "Full screen", "Show more", "Search", "Back to all posts"])("does not lock %s", (label) => {
    const c = candidate("b", label, { insideMediaControls: label === "Play" });
    expect(lockedForRole(c, classifyAffordance(c).role)).toBe(false);
  });

  it("keeps a lock the client already decided", () => {
    expect(lockedForRole(candidate("b", "Anything at all", { locked: true }), "unknown")).toBe(true);
  });

  it("locks an irreversible role even when the control is called something bland", () => {
    expect(lockedForRole(candidate("b", "Go"), "checkout")).toBe(true);
  });

  it("locks the submit button of the form fixture", () => {
    const submit = byId(formPage(), "btn:submit");
    expect(classifyAffordance(submit).role).toBe("submit");
    expect(lockedForRole(submit, "submit")).toBe(true);
  });
});

describe("nothing here knows a site", () => {
  it("classifies two structurally identical players the same way", () => {
    const a = classifyAll(videoPage().candidates, { hasMediaElement: true }).map((c) => c.affordance.role);
    const b = classifyAll(otherVideoPage().candidates, { hasMediaElement: true }).map((c) => c.affordance.role);
    expect(a.slice(0, 2)).toEqual(["play", "fullscreen"]);
    expect(b.slice(0, 2)).toEqual(["play", "fullscreen"]);
  });

  it("returns only closed-set evidence codes, never page text", () => {
    for (const page of [videoPage(), gridFeed(), productPage(), cartPage(), formPage()]) {
      for (const { affordance } of classifyAll(page.candidates, { pathPattern: page.signals.pathPattern })) {
        for (const code of affordance.evidence) expect(EVIDENCE_CODES).toContain(code);
      }
    }
  });

  it("keeps confidence inside its band", () => {
    for (const { affordance } of classifyAll(productPage().candidates)) {
      expect(affordance.confidence).toBeGreaterThanOrEqual(0.3);
      expect(affordance.confidence).toBeLessThanOrEqual(0.95);
    }
  });
});

describe("text helpers", () => {
  it("reads class names, identifiers and camel case as words", () => {
    expect(normalizeAffordanceText(["cart_count", "addToCart"])).toBe("cart count add to cart");
    expect(normalizeAffordanceText([undefined, "  ", "A"])).toBe("a");
  });

  it("treats an empty or single-glyph label as glyph-only", () => {
    expect(isGlyphOnly("")).toBe(true);
    expect(isGlyphOnly(" × ")).toBe(true);
    expect(isGlyphOnly("▶")).toBe(true);
    expect(isGlyphOnly("Play")).toBe(false);
  });
});

// Everything below was found by running the module over captures of two real, unmodified sites (a video page and a
// shop) on 2026-09-19. Each case is the generic shape of a false positive that capture produced, never a site rule.
describe("what real pages taught it", () => {
  const player = { hasMediaElement: true };

  it("does not read a design system's class names as icon words", () => {
    // A framework's class list happens to contain "Next"; camel case inside one token is not a word here.
    const advert = candidate("x", "", { classTokens: ["uiButtonShapeNextHost", "uiButtonShapeNextTonal"] });
    expect(roleOf(advert, player)).toBe("unknown");
    expect(roleOf(candidate("x", "", { classTokens: ["player-play-button", "player-button"] }), player)).toBe("play");
  });

  it("does not let a page-wide media context promote a bare hint into a player control", () => {
    const advert = candidate("x", "Our sponsor centre", { classTokens: ["uiButtonShapeNextText"] });
    expect(roleOf(advert, player)).toBe("unknown");
  });

  it("reads Expand as enlarging inside a player and as showing more anywhere else", () => {
    expect(roleOf(candidate("x", "Expand", { classTokens: ["player-expand-button"] }), player)).toBe("fullscreen");
    expect(roleOf(candidate("x", "Expand"))).toBe("more");
  });

  it("never turns an irreversible control inside a list into the list's item", () => {
    const signIn = candidate("x", "Hello, sign in to your account", { kind: "link", list: { listSignature: "DIV.nav>DIV", index: 0 } });
    expect(roleOf(signIn)).not.toBe("primary-item");
    expect(lockedForRole(signIn, classifyAffordance(signIn).role)).toBe(true);
  });

  it("ranks a side list below the main one, and silences it only when told there is no main list", () => {
    const navLink = candidate("x", "Grocery", { kind: "link", list: { listSignature: "UL.nav>LI", index: 4 } });
    expect(roleOf(navLink)).toBe("primary-item");
    expect(roleOf(navLink, { mainListSignature: "UL.nav>LI" })).toBe("primary-item");
    // A DIFFERENT main list means this one ranks lower, not that it disappears. Measured on a real video
    // site: silencing it left forty video links classified `unknown` and a search box as the only offer.
    expect(roleOf(navLink, { mainListSignature: "DIV.results>DIV.item" })).toBe("primary-item");
    const main = classifyAffordance(navLink, { mainListSignature: "UL.nav>LI" }).confidence;
    const aside = classifyAffordance(navLink, { mainListSignature: "DIV.results>DIV.item" }).confidence;
    expect(aside).toBeLessThan(main);
    // `null` is the client stating a fact -- this window has no main list -- and that still silences.
    expect(roleOf(navLink, { mainListSignature: null })).toBe("unknown");
  });

  it("reads a real cart link that carries its count in its own name", () => {
    const cart = candidate("x", "0 items in cart", { kind: "link", classTokens: ["nav-a", "nav-cart"] });
    expect(roleOf(cart)).toBe("cart");
    expect(roleOf(candidate("x", "Pause (k)", { classTokens: ["player-play-button"] }), player)).toBe("pause");
    expect(roleOf(candidate("x", "Mute (m)", { classTokens: ["player-volume-icon"] }), player)).toBe("mute");
  });
});
