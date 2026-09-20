import { describe, expect, it } from "vitest";
import {
  EVIDENCE_SPAN, ROLE_MEMORY_FLOOR, ROLE_MEMORY_ONCE, ROLE_MEMORY_REPEATED, RoleMemory,
  predictByRole, priorsFor, roleConfidence, roleMemoryKey, roleReason,
} from "../src";
import type { PriorState, RankedAffordance, RoleMemorySnapshot, RolePredictionState, RoleStat } from "../src";
import {
  articlePage, cartPage, formPage, gridFeed, mailItem, mailList,
  otherVideoPage, productPage, unknownApp, videoPage,
} from "./helpers/affordanceFixtures";
import type { Page } from "./helpers/affordanceFixtures";

const stat = (accepted = 0, dismissed = 0, replaced = 0): RoleStat => ({ accepted, dismissed, replaced });

function rank(page: Page, state: RolePredictionState, memory: RoleMemory | null = null, priorState: PriorState = {}): RankedAffordance[] {
  const context = { pathPattern: page.signals.pathPattern, hasMediaElement: page.signals.hasMediaElement };
  return predictByRole({ ...state, context }, page.candidates, memory, priorsFor(state.pageKind, priorState));
}

const top = (rows: RankedAffordance[]): RankedAffordance => {
  const first = rows[0];
  if (!first) throw new Error("no ranking");
  return first;
};
const row = (rows: RankedAffordance[], id: string): RankedAffordance => {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
};

describe("RoleMemory", () => {
  it("counts accepts, dismissals and replacements per key", () => {
    const memory = new RoleMemory();
    const key = { pageKind: "media" as const, previousRole: "play" as const, role: "fullscreen" as const };
    memory.record(key, "accepted");
    memory.record(key, "accepted");
    memory.record(key, "dismissed");
    memory.record(key, "replaced");
    expect(memory.stat(key)).toEqual(stat(2, 1, 1));
    expect(memory.size).toBe(1);
  });

  it("keys on the place and on what the user did just before", () => {
    const memory = new RoleMemory();
    memory.record({ pageKind: "media", previousRole: "play", role: "fullscreen" }, "accepted");
    expect(memory.stat({ pageKind: "media", previousRole: "play", role: "fullscreen" }).accepted).toBe(1);
    expect(memory.stat({ pageKind: "media", previousRole: "search", role: "fullscreen" }).accepted).toBe(0);
    expect(memory.stat({ pageKind: "feed", previousRole: "play", role: "fullscreen" }).accepted).toBe(0);
    expect(memory.stat({ pageKind: "media", role: "fullscreen" }).accepted).toBe(0);
  });

  it("treats a missing previous role as the key 'none'", () => {
    expect(roleMemoryKey({ pageKind: "feed", role: "search" })).toBe("feed|none|search");
    expect(roleMemoryKey({ pageKind: "feed", previousRole: "none", role: "search" })).toBe("feed|none|search");
  });

  it("evicts the least recently used key at the cap", () => {
    const memory = new RoleMemory(2);
    memory.record({ pageKind: "feed", role: "search" }, "accepted");
    memory.record({ pageKind: "feed", role: "primary-item" }, "accepted");
    memory.record({ pageKind: "feed", role: "search" }, "accepted");
    memory.record({ pageKind: "feed", role: "compose" }, "accepted");
    expect(memory.size).toBe(2);
    expect(memory.stat({ pageKind: "feed", role: "primary-item" }).accepted).toBe(0);
    expect(memory.stat({ pageKind: "feed", role: "search" }).accepted).toBe(2);
  });

  it("round-trips through JSON", () => {
    const memory = new RoleMemory();
    memory.record({ pageKind: "commerce", previousRole: "cart", role: "checkout" }, "dismissed");
    const restored = RoleMemory.fromJSON(JSON.parse(JSON.stringify(memory.toJSON())) as RoleMemorySnapshot);
    expect(restored.stat({ pageKind: "commerce", previousRole: "cart", role: "checkout" })).toEqual(stat(0, 1, 0));
  });

  it("survives a corrupt snapshot instead of breaking prediction", () => {
    expect(RoleMemory.fromJSON(null).size).toBe(0);
    expect(RoleMemory.fromJSON({ max: Number.NaN, entries: [] } as RoleMemorySnapshot).max).toBeGreaterThan(0);
    const junk = { max: 5, entries: [{ pageKind: "feed", role: "search", stat: { accepted: -3 } }] } as unknown as RoleMemorySnapshot;
    expect(RoleMemory.fromJSON(junk).stat({ pageKind: "feed", role: "search" })).toEqual(stat());
  });

  it("hands out copies, so nothing outside can edit a count", () => {
    const memory = new RoleMemory();
    memory.record({ pageKind: "feed", role: "search" }, "accepted");
    const taken = memory.stat({ pageKind: "feed", role: "search" });
    taken.accepted = 99;
    expect(memory.stat({ pageKind: "feed", role: "search" }).accepted).toBe(1);
  });
});

describe("roleConfidence", () => {
  it("is the prior when there is no history", () => {
    expect(roleConfidence(0.62, stat())).toEqual({ confidence: 0.62, source: "prior" });
  });

  it("reaches the strongest prior band after one accept and takes the lead after two", () => {
    expect(roleConfidence(0.55, stat(1)).confidence).toBe(ROLE_MEMORY_ONCE);
    expect(roleConfidence(0.55, stat(2)).confidence).toBe(ROLE_MEMORY_REPEATED);
    expect(roleConfidence(0.55, stat(1)).source).toBe("memory");
  });

  it("never lowers a strong prior for a role the user accepted once", () => {
    expect(roleConfidence(0.7, stat(1)).confidence).toBe(0.7);
  });

  it("drops a role the user keeps refusing", () => {
    expect(roleConfidence(0.7, stat(0, 1)).confidence).toBeCloseTo(0.55);
    expect(roleConfidence(0.7, stat(0, 2)).confidence).toBeCloseTo(0.4);
    expect(roleConfidence(0.7, stat(0, 5)).confidence).toBe(ROLE_MEMORY_FLOOR);
  });

  it("counts a replacement against the role, but a majority of accepts still wins", () => {
    expect(roleConfidence(0.6, stat(0, 0, 2)).confidence).toBeCloseTo(0.3);
    expect(roleConfidence(0.6, stat(3, 0, 1)).confidence).toBe(ROLE_MEMORY_REPEATED);
    expect(roleConfidence(0.6, stat(2, 2)).confidence).toBe(0.6);
  });

  it("marks a role the place has no opinion about as coming from the affordance alone", () => {
    expect(roleConfidence(0.45, stat(), false).source).toBe("affordance");
  });
});

describe("predictByRole on a page it has never seen", () => {
  it("puts the cursor on play on a paused video", () => {
    const best = top(rank(videoPage(), { pageKind: "media" }));
    expect(best.id).toBe("btn:play");
    // The prior is 0.7; a well-named control is nudged a little above it by EVIDENCE_SPAN, so that two
    // candidates the place ranks equally do not come back as the same number (see withEvidence).
    expect(best.confidence).toBeGreaterThanOrEqual(0.7);
    expect(best.confidence).toBeLessThan(0.7 + EVIDENCE_SPAN);
    expect(best.source).toBe("prior");
    expect(best.reason).toBe("most people start playing on a video page");
  });

  it("moves to fullscreen once the video is playing", () => {
    const rows = rank(videoPage(), { pageKind: "media", previousRole: "play" }, null, { mediaPlaying: true });
    expect(top(rows).id).toBe("btn:fullscreen");
    expect(top(rows).confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("separates candidates the place ranks the same, so a ranking is not just a list", () => {
    // Measured on a real page before this: eight proposals, every one at 0.70, every one with the same
    // reason. Nothing but capture order separated them, and capture order changes on every rescan.
    const rows = rank(gridFeed(), { pageKind: "feed" });
    const sameRole = rows.filter((r) => r.role === "primary-item").map((r) => r.confidence);
    expect(sameRole.length).toBeGreaterThan(1);
    expect(new Set(sameRole).size).toBeGreaterThan(1);
  });

  it("proposes nothing above the gate to someone already watching fullscreen", () => {
    const rows = rank(videoPage(), { pageKind: "media" }, null, { mediaPlaying: true, isFullscreen: true });
    expect(Math.max(...rows.map((r) => r.confidence))).toBeLessThan(0.7);
  });

  it("opens the first card of a feed, not the fifth", () => {
    const rows = rank(gridFeed(), { pageKind: "feed" });
    expect(top(rows).id).toBe("link:div.grid:0");
    expect(rows.findIndex((r) => r.id === "link:div.grid:0")).toBeLessThan(rows.findIndex((r) => r.id === "link:div.grid:4"));
  });

  it("reaches for the search box on a shop with an empty cart", () => {
    const rows = rank(productPage(), { pageKind: "commerce" });
    expect(top(rows).id).toBe("field:search");
  });

  it("waits on the cart once the cart has something in it", () => {
    const rows = rank(productPage(), { pageKind: "commerce" }, null, { cartCount: 2 });
    expect(top(rows).id).toBe("icon:cart");
    expect(top(rows).reason).toBe("most people open the cart on a shop page");
  });

  it("offers checkout on the cart page, locked", () => {
    const rows = rank(cartPage(), { pageKind: "commerce", previousRole: "cart" }, null, { cartCount: 3 });
    const checkout = row(rows, "btn:checkout");
    expect(checkout.role).toBe("checkout");
    expect(checkout.locked).toBe(true);
    expect(rows.filter((r) => r.locked).map((r) => r.id).sort()).toEqual(["btn:checkout", "btn:delete-0", "btn:remove-0"]);
  });

  it("keeps reading a long article and never proposes anything irreversible there", () => {
    const rows = rank(articlePage(), { pageKind: "reader" });
    expect(top(rows).id).toBe("btn:continue");
    expect(rows.some((r) => r.locked)).toBe(false);
  });

  it("opens a message in a mailbox and replies inside one", () => {
    expect(top(rank(mailList(), { pageKind: "mail" })).id).toBe("link:ul.threads:0");
    expect(top(rank(mailItem(), { pageKind: "mail" }, null, { readingItem: true })).id).toBe("btn:reply");
  });

  it("walks the fields of a form and never leads with Submit", () => {
    const rows = rank(formPage(), { pageKind: "form" });
    expect(top(rows).role).toBe("field");
    expect(row(rows, "btn:submit").confidence).toBeLessThan(0.7);
    expect(row(rows, "btn:submit").locked).toBe(true);
  });

  it("stays quiet on a page it cannot place", () => {
    const rows = rank(unknownApp(), { pageKind: "app" });
    expect(Math.max(...rows.map((r) => r.confidence))).toBeLessThan(0.7);
  });

  it("ranks every candidate exactly once and keeps their ids", () => {
    const page = gridFeed();
    const rows = rank(page, { pageKind: "feed" });
    expect(rows).toHaveLength(page.candidates.length);
    expect([...new Set(rows.map((r) => r.id))]).toHaveLength(page.candidates.length);
    expect(rows.map((r) => r.id)).toEqual(rank(page, { pageKind: "feed" }).map((r) => r.id));
  });
});

describe("memory beats priors once there is real history", () => {
  const afterPlay: RolePredictionState = { pageKind: "media", previousRole: "play" };
  const fullscreenKey = { pageKind: "media" as const, previousRole: "play" as const, role: "fullscreen" as const };

  it("does not reorder the place's defaults after a single accept", () => {
    const memory = new RoleMemory();
    memory.record(fullscreenKey, "accepted");
    const rows = rank(videoPage(), afterPlay, memory);
    expect(top(rows).id).toBe("btn:play");
    expect(row(rows, "btn:fullscreen").confidence).toBe(ROLE_MEMORY_ONCE);
  });

  it("overtakes the priors after two accepts, with a reason in the user's own terms", () => {
    const memory = new RoleMemory();
    memory.record(fullscreenKey, "accepted");
    memory.record(fullscreenKey, "accepted");
    const best = top(rank(videoPage(), afterPlay, memory));
    expect(best.id).toBe("btn:fullscreen");
    expect(best.confidence).toBe(ROLE_MEMORY_REPEATED);
    expect(best.source).toBe("memory");
    expect(best.reason).toBe("you usually go fullscreen after starting a video");
  });

  it("transfers to a player it has never seen, with different words and ids", () => {
    const memory = new RoleMemory();
    memory.record(fullscreenKey, "accepted");
    memory.record(fullscreenKey, "accepted");
    const best = top(rank(otherVideoPage(), afterPlay, memory));
    expect(best.id).toBe("c2");
    expect(best.role).toBe("fullscreen");
    expect(best.confidence).toBe(ROLE_MEMORY_REPEATED);
  });

  it("does not leak into another place or another previous action", () => {
    const memory = new RoleMemory();
    memory.record(fullscreenKey, "accepted");
    memory.record(fullscreenKey, "accepted");
    expect(top(rank(videoPage(), { pageKind: "media", previousRole: "search" }, memory)).id).toBe("btn:play");
    expect(top(rank(gridFeed(), { pageKind: "feed", previousRole: "play" }, memory)).id).toBe("link:div.grid:0");
  });

  it("sinks a role the user keeps dismissing, and says so", () => {
    const memory = new RoleMemory();
    const key = { pageKind: "feed" as const, role: "primary-item" as const };
    memory.record(key, "dismissed");
    memory.record(key, "dismissed");
    const rows = rank(gridFeed(), { pageKind: "feed" }, memory);
    expect(top(rows).id).toBe("field:search");
    const item = row(rows, "link:div.grid:0");
    expect(item.confidence).toBeCloseTo(0.4);
    expect(item.reason).toBe("you passed on this before");
    expect(rows.indexOf(item)).toBeGreaterThan(rows.indexOf(row(rows, "btn:more")));
  });

  it("recovers a dismissed role once the user starts accepting it again", () => {
    const memory = new RoleMemory();
    const key = { pageKind: "feed" as const, role: "primary-item" as const };
    memory.record(key, "dismissed");
    for (let i = 0; i < 2; i++) memory.record(key, "accepted");
    expect(top(rank(gridFeed(), { pageKind: "feed" }, memory)).confidence).toBe(ROLE_MEMORY_REPEATED);
  });

  it("learns the cart habit on one shop and applies it on another", () => {
    const memory = new RoleMemory();
    const key = { pageKind: "commerce" as const, previousRole: "cart" as const, role: "cart" as const };
    memory.record(key, "accepted");
    memory.record(key, "accepted");
    const best = top(rank(cartPage(), { pageKind: "commerce", previousRole: "cart" }, memory, { cartCount: 3 }));
    expect(best.id).toBe("icon:cart");
    expect(best.reason).toBe("you usually open the cart after opening the cart");
  });

  it("gives a learned role a reason without a previous action when there is none", () => {
    const memory = new RoleMemory();
    memory.record({ pageKind: "reader", role: "scroll-more" }, "accepted");
    memory.record({ pageKind: "reader", role: "scroll-more" }, "accepted");
    expect(top(rank(articlePage(), { pageKind: "reader" }, memory)).reason).toBe("you usually load more while reading");
  });

  it("never lets a learned role unlock an irreversible control", () => {
    const memory = new RoleMemory();
    const key = { pageKind: "commerce" as const, previousRole: "cart" as const, role: "checkout" as const };
    for (let i = 0; i < 3; i++) memory.record(key, "accepted");
    const best = top(rank(cartPage(), { pageKind: "commerce", previousRole: "cart" }, memory, { cartCount: 3 }));
    expect(best.id).toBe("btn:checkout");
    expect(best.locked).toBe(true);
  });

  it("explains a role the place has no opinion about without pretending it is a habit", () => {
    const rows = rank(productPage(), { pageKind: "commerce" });
    const wishlist = row(rows, "btn:wishlist");
    expect(wishlist.source).toBe("affordance");
    expect(wishlist.reason).toBe("you can save this for later here");
  });

  it("draws every reason from the closed role vocabulary, never from the page", () => {
    const state: RolePredictionState = { pageKind: "commerce", previousRole: "search" };
    const memory = new RoleMemory();
    memory.record({ ...state, role: "cart" }, "accepted");
    for (const page of [videoPage(), gridFeed(), productPage(), cartPage(), mailList(), articlePage(), unknownApp()]) {
      for (const r of rank(page, state, memory)) {
        const generated = [
          roleReason(r.role, state, "prior"),
          roleReason(r.role, state, "affordance"),
          roleReason(r.role, state, "memory", stat(2)),
          roleReason(r.role, state, "memory", stat(0, 2)),
        ];
        expect(generated).toContain(r.reason);
      }
    }
  });

  it("cannot put a label into a reason, however distinctive the label is", () => {
    const page = gridFeed();
    const odd = page.candidates.map((c) => ({ ...c, label: `${c.label} Zygomatic flange 8821` }));
    for (const r of predictByRole({ pageKind: "feed" }, odd, null, priorsFor("feed"))) {
      expect(r.reason).not.toMatch(/zygomatic|8821/i);
    }
  });
});
