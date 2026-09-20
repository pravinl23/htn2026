import { describe, expect, it } from "vitest";
import { PRIOR_MAX, PRIOR_MIN, cartCountFrom, priorWeight, priorsFor } from "../src";
import type { AffordanceRole, PageKind, PriorState } from "../src";
import { candidate, cartPage, gridFeed, productPage, unknownApp } from "./helpers/affordanceFixtures";

const roles = (kind: PageKind, state: PriorState = {}): AffordanceRole[] => priorsFor(kind, state).map((p) => p.role);
const ALL_KINDS: readonly PageKind[] = ["feed", "media", "commerce", "reader", "mail", "form", "app", "unknown"];

describe("media priors follow the state of the player", () => {
  it("proposes play, then fullscreen, then next on a paused video", () => {
    expect(roles("media")).toEqual(["play", "fullscreen", "next", "captions"]);
    expect(priorWeight(priorsFor("media"), "play")).toBe(PRIOR_MAX);
  });

  it("proposes fullscreen first once the video is playing", () => {
    const playing = priorsFor("media", { mediaPlaying: true });
    expect(playing[0]).toEqual({ role: "fullscreen", weight: PRIOR_MAX });
    expect(roles("media", { mediaPlaying: true })).not.toContain("play");
  });

  it("never proposes fullscreen again once the video is already fullscreen", () => {
    expect(roles("media", { mediaPlaying: true, isFullscreen: true })).not.toContain("fullscreen");
    expect(roles("media", { isFullscreen: true })).toEqual(["play", "next", "captions"]);
  });

  it("offers nothing above the gate to someone already watching fullscreen", () => {
    const watching = priorsFor("media", { mediaPlaying: true, isFullscreen: true });
    expect(Math.max(...watching.map((p) => p.weight))).toBeLessThan(PRIOR_MAX);
  });
});

describe("feed priors", () => {
  it("proposes the first item, then search, then more", () => {
    expect(roles("feed")).toEqual(["primary-item", "search", "scroll-more"]);
  });

  it("raises loading more once the user is at the end", () => {
    const end = priorsFor("feed", { atPageEnd: true });
    expect(end.map((p) => p.role)).toEqual(["primary-item", "scroll-more", "search"]);
  });
});

describe("commerce priors follow the cart", () => {
  it("guesses the shopper is about to search when the cart is empty", () => {
    expect(roles("commerce")).toEqual(["search", "primary-item", "cart"]);
    expect(priorWeight(priorsFor("commerce"), "search")).toBe(PRIOR_MAX);
  });

  it("puts the cart first, then checkout, once there is something in it", () => {
    expect(roles("commerce", { cartCount: 2 })).toEqual(["cart", "checkout", "search", "primary-item"]);
  });

  it("treats an unknown cart as an empty one", () => {
    expect(roles("commerce", { cartCount: 0 })).toEqual(roles("commerce"));
  });
});

describe("reader, mail and form priors", () => {
  it("proposes reading on, then going back", () => {
    expect(roles("reader")).toEqual(["scroll-more", "back", "share"]);
  });

  it("stops proposing to read on at the end of the text", () => {
    expect(roles("reader", { atPageEnd: true })).toEqual(["back", "share", "search"]);
  });

  it("proposes opening a message in a mailbox and replying inside one", () => {
    // `compose` sits at the floor, below search. Starting a new message is only useful to somebody who
    // already knows who it is for, which is exactly what Ghost does not know: "new message" then "fill in
    // the recipient" is a chain that ends in a shrug. Reading the one that came in is the thing it can help
    // with, and it can follow that all the way through to a drafted reply.
    expect(roles("mail")).toEqual(["primary-item", "search", "compose"]);
    expect(roles("mail", { readingItem: true })).toEqual(["reply", "back", "compose"]);
  });

  it("puts something waiting to be read above everything else, wherever it is", () => {
    for (const kind of ["mail", "feed", "app", "unknown"] as const) {
      const priors = priorsFor(kind, { hasUnreadItem: true });
      expect(priors[0]?.role).toBe("primary-item");
      expect(priorWeight(priors, "primary-item")).toBe(PRIOR_MAX);
    }
    // Even against the app's own cursor: somebody waiting beats an empty box.
    const both = priorsFor("app", { hasUnreadItem: true, focusedEmptyField: true });
    expect(priorWeight(both, "primary-item")).toBeGreaterThanOrEqual(priorWeight(both, "field"));
  });

  it("follows somebody who started a new message, without ever starting one itself", () => {
    // Two separate rules, and conflating them was the bug. Ghost must not PROPOSE compose: it does not know
    // who you are writing to, so it cannot help with the step after. But once you start a new message
    // yourself, the recipient field is exactly what comes next, so the transition stays.
    expect(priorWeight(priorsFor("mail"), "compose")).toBe(PRIOR_MIN);
    expect(priorWeight(priorsFor("app", { previousRole: "compose" }), "field")).toBeGreaterThan(0);
    // And it leads to the recipient, never to the body: `field` is the only thing compose chains to.
    const chained = priorsFor("app", { previousRole: "compose" }).map((p) => p.role);
    expect(chained).toContain("field");
  });

  it("keeps the terminal action of a form below the fields", () => {
    const form = priorsFor("form");
    expect(form[0]?.role).toBe("field");
    expect(priorWeight(form, "submit")).toBeLessThan(0.6);
  });
});

describe("priors stay weak, everywhere", () => {
  it.each(ALL_KINDS)("keeps every %s prior inside the documented band", (kind) => {
    const states: PriorState[] = [{}, { mediaPlaying: true }, { isFullscreen: true }, { cartCount: 3 }, { atPageEnd: true }, { readingItem: true }, { hasQuery: true }];
    for (const state of states) {
      for (const prior of priorsFor(kind, state)) {
        expect(prior.weight).toBeGreaterThanOrEqual(PRIOR_MIN);
        expect(prior.weight).toBeLessThanOrEqual(PRIOR_MAX);
      }
    }
  });

  it("orders every list strongest first", () => {
    for (const kind of ALL_KINDS) {
      const weights = priorsFor(kind, { cartCount: 1, mediaPlaying: true }).map((p) => p.weight);
      expect([...weights].sort((a, b) => b - a)).toEqual(weights);
    }
  });

  it("stays quiet on a place it cannot read until memory says otherwise", () => {
    for (const kind of ["app", "unknown"] as const) {
      expect(Math.max(...priorsFor(kind).map((p) => p.weight))).toBeLessThan(PRIOR_MAX);
    }
  });

  it("gives every recognized place exactly one proposal at the gate", () => {
    for (const kind of ["feed", "media", "commerce", "reader", "mail", "form"] as const) {
      expect(priorsFor(kind).filter((p) => p.weight >= PRIOR_MAX)).toHaveLength(1);
    }
  });

  it("reports 0 for a role the place has no opinion about", () => {
    expect(priorWeight(priorsFor("reader"), "checkout")).toBe(0);
  });
});

describe("cartCountFrom", () => {
  it("reads a count off a cart glyph", () => {
    expect(cartCountFrom(productPage().candidates)).toBe(2);
    expect(cartCountFrom(cartPage().candidates)).toBe(3);
  });

  it("is 0 when nothing carries a cart count", () => {
    expect(cartCountFrom(gridFeed().candidates)).toBe(0);
    expect(cartCountFrom(unknownApp().candidates)).toBe(0);
  });

  it("ignores a badge on something that is not a cart", () => {
    expect(cartCountFrom([candidate("b", "Notifications", { badgeCount: 9 })])).toBe(0);
  });
});

describe("the cart count a real shop actually shows", () => {
  it("reads a count out of the cart control's own name", () => {
    expect(cartCountFrom([candidate("x", "0 items in cart", { kind: "link", classTokens: ["nav-cart"] })])).toBe(0);
    expect(cartCountFrom([candidate("x", "3 items in cart", { kind: "link", classTokens: ["nav-cart"] })])).toBe(3);
    expect(cartCountFrom([candidate("x", "Cart 2", { kind: "link" })])).toBe(2);
  });

  it("does not mistake other numbers in a name for a cart count", () => {
    expect(cartCountFrom([candidate("x", "Cart", { kind: "link" })])).toBe(0);
    expect(cartCountFrom([candidate("x", "Save 20% on your basket", { kind: "link" })])).toBe(0);
  });

  it("turns a real shop header into the two proposals the product promises", () => {
    const header = [
      candidate("f", "", { kind: "field", ariaRole: "searchbox", placeholder: "Search the store" }),
      candidate("c", "0 items in cart", { kind: "link", classTokens: ["nav-cart"] }),
    ];
    expect(priorsFor("commerce", { cartCount: cartCountFrom(header) })[0]?.role).toBe("search");
    const full = [header[0]!, candidate("c", "2 items in cart", { kind: "link", classTokens: ["nav-cart"] })];
    expect(priorsFor("commerce", { cartCount: cartCountFrom(full) })[0]?.role).toBe("cart");
  });
});
