import { describe, expect, it } from "vitest";
import { affordanceRoleOf, affordanceRolesFor, AFFORDANCE_ROLES, MEDIA_ROLES, type AffordanceRole } from "../src/vision/affordance";
import { visionTimeoutMs } from "../src/vision/responses";

/**
 * docs/anywhere.md section 4: a vision label only earns its keep if it lands in the SAME taxonomy as a DOM or AX label.
 * The vocabulary itself belongs to `shared/src/affordance/roles.ts` and is tested there; this file tests the adapter:
 * the kind mapping, the batch pass that lets a player bar's icons see each other, and the hints.
 * No site is named here, or in the module under test.
 */

const roleOf = (label: string, kind = "button"): AffordanceRole => affordanceRoleOf(label, kind);
const box = (label: string, role = "button") => ({ id: label, label, role });
const rolesOf = (labels: string[], hints = {}): string[] => [...affordanceRolesFor(labels.map((l) => box(l)), hints).values()];

describe("a vision label reaches the shared taxonomy", () => {
  it("carries a page's own controls straight through", () => {
    expect(roleOf("Search")).toBe("search");
    expect(roleOf("Add to cart")).toBe("cart");
    expect(roleOf("Checkout")).toBe("checkout");
    expect(roleOf("Buy now")).toBe("buy");
    expect(roleOf("Compose")).toBe("compose");
    expect(roleOf("Reply")).toBe("reply");
    expect(roleOf("Send")).toBe("send");
    expect(roleOf("Download")).toBe("download");
    expect(roleOf("Share")).toBe("share");
    expect(roleOf("Settings")).toBe("settings");
    expect(roleOf("Menu")).toBe("menu");
    expect(roleOf("Load more")).toBe("scroll-more");
    expect(roleOf("Back")).toBe("back");
    expect(roleOf("Submit")).toBe("submit");
    // Nothing on a page but a player is called this, so it needs no player around it.
    expect(roleOf("Fullscreen")).toBe("fullscreen");
  });

  it("maps the vision role enum onto a candidate kind: only a field is a field", () => {
    expect(affordanceRoleOf("Anything", "field")).toBe("field");
    expect(affordanceRoleOf(null, "field")).toBe("field");
    expect(affordanceRoleOf("Quantity", "checkbox")).toBe("quantity");
    expect(affordanceRoleOf("Share", "link")).toBe("share");
    expect(affordanceRoleOf("Nothing recognisable", "menu")).toBe("unknown");
    expect(affordanceRoleOf(undefined)).toBe("unknown");
    expect(affordanceRoleOf("   ")).toBe("unknown");
  });

  it("does NOT assume player vocabulary on its own: 'Play' is not always a video", () => {
    for (const label of ["Play", "Pause", "Mute", "Closed captions", "Previous"]) expect(roleOf(label)).toBe("unknown");
    expect(rolesOf(["Play", "Submit"])).toEqual(["unknown", "submit"]);
  });

  it("resolves a whole player bar, because the batch contains a control only a player has", () => {
    const bar = ["Previous", "Play", "Next", "Volume", "Closed captions", "Playback settings", "Fullscreen"];
    expect(rolesOf(bar)).toEqual(["previous", "play", "next", "mute", "captions", "settings", "fullscreen"]);
    // Exactly the live result: three icon-only controls, named from pixels, landing on three media roles.
    expect(rolesOf(["Play", "Next", "Fullscreen"])).toEqual(["play", "next", "fullscreen"]);
  });

  it("takes the client's media-controls hint when it has one", () => {
    expect(rolesOf(["Play"], { mediaControls: true })).toEqual(["play"]);
    expect(rolesOf(["Play"])).toEqual(["unknown"]);
  });

  it("only ever returns a role from the taxonomy, and never primary-item (that comes from layout)", () => {
    for (const label of ["Play", "Cart", "Anything at all", "", "12345", "→", "Submit", "Cc"]) {
      const role = affordanceRoleOf(label, "button");
      expect(AFFORDANCE_ROLES).toContain(role);
      expect(role).not.toBe("primary-item");
    }
    for (const role of affordanceRolesFor([box("Play"), box("Fullscreen")]).values()) expect(role).not.toBe("primary-item");
  });

  it("keeps the same role strings as the shared module", () => {
    expect(MEDIA_ROLES.every((role) => AFFORDANCE_ROLES.includes(role))).toBe(true);
    expect(MEDIA_ROLES).toContain("fullscreen");
    expect(MEDIA_ROLES).not.toContain("cart");
  });

  it("answers for every box it was given, in order, under its own id", () => {
    const empty = affordanceRolesFor([]);
    expect(empty.size).toBe(0);
    const roles = affordanceRolesFor([{ id: "ax-1", label: null, role: "button" }, { id: "ax-2", label: "Search", role: "field" }]);
    expect([...roles.keys()]).toEqual(["ax-1", "ax-2"]);
    expect(roles.get("ax-1")).toBe("unknown");
    expect(roles.get("ax-2")).toBe("search");
  });
});

describe("visionTimeoutMs: one batched call gets the time its batch needs", () => {
  it("grows with the batch and stops at 24 s", () => {
    expect(visionTimeoutMs(0)).toBe(8_000);
    expect(visionTimeoutMs(3)).toBe(9_200);
    expect(visionTimeoutMs(20)).toBe(16_000);
    expect(visionTimeoutMs(40)).toBe(24_000);
    expect(visionTimeoutMs(4000)).toBe(24_000);
    expect(visionTimeoutMs(-5)).toBe(8_000);
  });
});
