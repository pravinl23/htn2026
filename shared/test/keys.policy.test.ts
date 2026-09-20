import { describe, expect, it } from "vitest";
import {
  ACCEPT_KEY_REASON_TEXT, DEFAULT_ACCEPT_KEY, EXPLICIT_HINT, ACCEPT_KEY_HINTS, TAB_HINT, UNKNOWN_SITE,
  acceptKeyFor, canHoldToAccept, ghostKeyHint, holdStopReason, isFieldGhost, siteKey,
} from "../src";
import type { AcceptKeyGhost, AcceptKeyInput, AcceptKeyId, SiteKeyState, TabState } from "../src";

const fieldGhost: AcceptKeyGhost = { action: "fill" };
const selectGhost: AcceptKeyGhost = { action: "select" };
const checkGhost: AcceptKeyGhost = { action: "check" };
const clickGhost: AcceptKeyGhost = { action: "click" };

/** The everyday case: a form field ghost, focus already in that field. */
function ask(state: SiteKeyState, over: Partial<AcceptKeyInput> = {}) {
  return acceptKeyFor({ origin: "https://jobs.example.com", ghost: fieldGhost, focusIsOnGhostField: true, siteState: state, ...over });
}

describe("acceptKeyFor: Tab is earned, never assumed", () => {
  it("uses Tab on a form whose origin was watched and left Tab alone", () => {
    const choice = ask({ tab: "free" });
    expect(choice.key).toBe("tab");
    expect(choice.hint).toBe(TAB_HINT);
    expect(choice.reason).toBe("tab-free");
    expect(choice.probeTab).toBe(false);
  });

  it("NEVER steals Tab on the first ghost of a site it has never watched", () => {
    const choice = ask({});
    expect(choice.key).toBe("ghost-key");
    expect(choice.reason).toBe("tab-untested");
  });

  it("asks the client to watch that first Tab press instead of taking it", () => {
    expect(ask({ tab: "unknown" }).probeTab).toBe(true);
    expect(ask({ tab: "free" }).probeTab).toBe(false);
    expect(ask({ tab: "taken" }).probeTab).toBe(false);
  });

  it("hands Tab back to a site that was seen handling it (the preventDefault case)", () => {
    const choice = ask({ tab: "taken" });
    expect(choice.key).toBe("ghost-key");
    expect(choice.reason).toBe("tab-taken");
    expect(choice.hint).toBe(ACCEPT_KEY_HINTS[DEFAULT_ACCEPT_KEY]);
  });

  it("treats a missing site state exactly like an unwatched one", () => {
    expect(acceptKeyFor({ origin: "https://a.example", ghost: fieldGhost, focusIsOnGhostField: true }).key).toBe("ghost-key");
    expect(acceptKeyFor({ origin: "https://a.example", ghost: fieldGhost, focusIsOnGhostField: true, siteState: null }).probeTab).toBe(true);
  });
});

describe("acceptKeyFor: only a value for the focused field may use Tab", () => {
  it("uses the Shabang key for a click ghost even where Tab is free", () => {
    const choice = ask({ tab: "free" }, { ghost: clickGhost });
    expect(choice.key).toBe("ghost-key");
    expect(choice.reason).toBe("click-ghost");
  });

  it("uses the Shabang key when the ghosted field does not have focus", () => {
    const choice = ask({ tab: "free" }, { focusIsOnGhostField: false });
    expect(choice.key).toBe("ghost-key");
    expect(choice.reason).toBe("focus-elsewhere");
  });

  it("counts fill, select and check as field ghosts and click as not", () => {
    expect([fieldGhost, selectGhost, checkGhost].map(isFieldGhost)).toEqual([true, true, true]);
    expect(isFieldGhost(clickGhost)).toBe(false);
  });

  it("gives select and check ghosts Tab on a free site, like a fill", () => {
    expect(ask({ tab: "free" }, { ghost: selectGhost }).key).toBe("tab");
    expect(ask({ tab: "free" }, { ghost: checkGhost }).key).toBe("tab");
  });

  it("reports the click reason before the focus reason, since a click has no field to focus", () => {
    expect(ask({ tab: "free" }, { ghost: clickGhost, focusIsOnGhostField: false }).reason).toBe("click-ghost");
  });
});

describe("acceptKeyFor: paused apps are never asked the question", () => {
  const pausedApp = { appId: "com.example.editor", paused: true } as const;

  it("uses the Shabang key and never probes in a paused app", () => {
    const choice = acceptKeyFor({ appId: pausedApp.appId, ghost: fieldGhost, focusIsOnGhostField: true, siteState: { paused: true } });
    expect(choice.key).toBe("ghost-key");
    expect(choice.reason).toBe("paused");
    expect(choice.probeTab).toBe(false);
  });

  it("stays paused whatever the Tab flag says, so a terminal never loses Tab", () => {
    for (const tab of ["unknown", "free", "taken"] as TabState[]) {
      const choice = acceptKeyFor({ appId: "com.example.terminal", ghost: fieldGhost, focusIsOnGhostField: true, siteState: { tab, paused: true } });
      expect(choice.key).toBe("ghost-key");
      expect(choice.probeTab).toBe(false);
    }
  });

  it("outranks the user's Tab-everywhere setting", () => {
    const choice = ask({ paused: true, tabEverywhere: true });
    expect(choice.key).toBe("ghost-key");
    expect(choice.reason).toBe("paused");
  });
});

describe("acceptKeyFor: the user's own settings", () => {
  it("honours Tab everywhere, the old behaviour, even on an unwatched site", () => {
    const choice = ask({ tabEverywhere: true });
    expect(choice.key).toBe("tab");
    expect(choice.reason).toBe("tab-everywhere");
    expect(choice.probeTab).toBe(false);
  });

  it("honours Tab everywhere for a click ghost too", () => {
    expect(ask({ tabEverywhere: true }, { ghost: clickGhost }).key).toBe("tab");
  });

  it("honours the Shabang key everywhere, on a site whose Tab is known to be free", () => {
    const choice = ask({ tab: "free", ghostKeyOnly: true });
    expect(choice.key).toBe("ghost-key");
    expect(choice.reason).toBe("ghost-key-chosen");
    expect(choice.probeTab).toBe(false);
  });

  it("lets the Shabang-key setting outrank the Tab-everywhere one, and both bow to a paused app", () => {
    expect(ask({ ghostKeyOnly: true, tabEverywhere: true }).reason).toBe("ghost-key-chosen");
    expect(ask({ ghostKeyOnly: true, paused: true }).reason).toBe("paused");
  });

  it("names the configured Shabang key in the hint chip", () => {
    const chips: Record<AcceptKeyId, string> = { "right-option": "⌥ tap", "option-space": "⌥Space", "cmd-quote": "⌘'", f19: "F19", "double-shift": "⇧⇧" };
    for (const [id, chip] of Object.entries(chips) as [AcceptKeyId, string][]) {
      expect(ask({ tab: "taken", ghostKey: id }).hint).toBe(chip);
    }
  });

  it("falls back to the default chip for a binding it does not recognize", () => {
    expect(ghostKeyHint("nonsense" as AcceptKeyId)).toBe(ACCEPT_KEY_HINTS[DEFAULT_ACCEPT_KEY]);
    expect(ghostKeyHint(null)).toBe(ACCEPT_KEY_HINTS[DEFAULT_ACCEPT_KEY]);
    expect(ghostKeyHint()).toBe("⌥ tap");
  });
});

describe("acceptKeyFor: locked actions still need a deliberate press", () => {
  const locked: AcceptKeyGhost = { action: "click", locked: true };

  it("shows Enter on a locked ghost, whatever key walked to it", () => {
    const choice = ask({ tab: "free" }, { ghost: locked });
    expect(choice.explicit).toBe(true);
    expect(choice.hint).toBe(EXPLICIT_HINT);
  });

  it("marks an unlocked ghost as not explicit", () => {
    expect(ask({ tab: "free" }).explicit).toBe(false);
    expect(ask({ tab: "taken" }).explicit).toBe(false);
  });

  it("keeps the walking key even for a locked field ghost", () => {
    const choice = ask({ tab: "free" }, { ghost: { action: "fill", locked: true } });
    expect(choice.key).toBe("tab");
    expect(choice.hint).toBe(EXPLICIT_HINT);
  });
});

describe("acceptKeyFor: always names a key", () => {
  it("returns a key, a hint and a reason for every combination of inputs", () => {
    const ghosts: AcceptKeyGhost[] = [fieldGhost, selectGhost, checkGhost, clickGhost, { action: "click", locked: true }, { action: "fill", guess: true }];
    const states: SiteKeyState[] = [
      {}, { tab: "unknown" }, { tab: "free" }, { tab: "taken" }, { paused: true },
      { tabEverywhere: true }, { tab: "taken", ghostKey: "f19" }, { tab: "free", paused: true },
      { ghostKeyOnly: true }, { tab: "free", ghostKeyOnly: true, tabEverywhere: true },
    ];
    let checked = 0;
    for (const ghost of ghosts) {
      for (const siteState of states) {
        for (const focusIsOnGhostField of [true, false]) {
          const choice = acceptKeyFor({ origin: "https://x.example", ghost, focusIsOnGhostField, siteState });
          expect(["tab", "ghost-key"]).toContain(choice.key);
          expect(choice.hint.length).toBeGreaterThan(0);
          expect(ACCEPT_KEY_REASON_TEXT[choice.reason].length).toBeGreaterThan(0);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(120);
  });

  it("gives every reason a sentence the HUD can show", () => {
    for (const text of Object.values(ACCEPT_KEY_REASON_TEXT)) expect(text).not.toBe("");
  });
});

describe("acceptKeyFor: the site it decided for", () => {
  it("reports the app id as the site on the native side", () => {
    expect(ask({ tab: "free" }, { appId: "com.example.Mail" }).site).toBe("app://com.example.mail");
  });

  it("reports the origin in the browser, without the path", () => {
    expect(ask({ tab: "free" }, { origin: "https://mail.example.com/u/0/inbox?q=x" }).site).toBe("https://mail.example.com");
  });

  it("reports the unknown site when it was given neither", () => {
    expect(acceptKeyFor({ ghost: fieldGhost, focusIsOnGhostField: true }).site).toBe(UNKNOWN_SITE);
  });
});

describe("siteKey: nothing but the origin is ever kept", () => {
  it("cuts the path, the query and the fragment", () => {
    expect(siteKey({ origin: "https://shop.example.com/orders/1839/receipt" })).toBe("https://shop.example.com");
    expect(siteKey({ origin: "https://shop.example.com/?token=secret" })).toBe("https://shop.example.com");
    expect(siteKey({ origin: "https://shop.example.com#section" })).toBe("https://shop.example.com");
  });

  it("keeps the port, which is part of an origin", () => {
    expect(siteKey({ origin: "http://localhost:5173/apply" })).toBe("http://localhost:5173");
  });

  it("accepts a bare host and lowercases everything", () => {
    expect(siteKey({ origin: "Mail.Example.COM/inbox" })).toBe("mail.example.com");
  });

  it("prefers the app id when a caller has both", () => {
    expect(siteKey({ origin: "https://a.example", appId: "com.example.App" })).toBe("app://com.example.app");
  });

  it("returns the unknown site for empty or scheme-only input", () => {
    expect(siteKey({})).toBe(UNKNOWN_SITE);
    expect(siteKey({ origin: "   " })).toBe(UNKNOWN_SITE);
    expect(siteKey({ origin: "https:///path" })).toBe(UNKNOWN_SITE);
  });
});

describe("canHoldToAccept: a hold stops where the user must look", () => {
  it("walks through an ordinary confident ghost", () => {
    expect(canHoldToAccept({ action: "fill" })).toBe(true);
    expect(canHoldToAccept({ action: "fill", tier: "confident" })).toBe(true);
    expect(holdStopReason({ action: "fill" })).toBeNull();
  });

  it("stops at a locked action", () => {
    expect(canHoldToAccept({ action: "click", locked: true })).toBe(false);
    expect(holdStopReason({ action: "click", locked: true })).toBe("locked");
  });

  it("stops at a draft that is still being written", () => {
    expect(holdStopReason({ action: "fill", pending: true })).toBe("pending");
  });

  it("stops at a guess, by flag or by tier", () => {
    expect(holdStopReason({ action: "fill", guess: true })).toBe("guess");
    expect(holdStopReason({ action: "select", tier: "guess" })).toBe("guess");
  });

  it("stops at a long-shot, which is drawn but never taken by a hold", () => {
    expect(holdStopReason({ action: "fill", tier: "long-shot" })).toBe("long-shot");
  });

  it("stops at a declaration even when it is not marked a guess", () => {
    expect(holdStopReason({ action: "check", answerClass: "declaration" })).toBe("declaration");
    expect(canHoldToAccept({ action: "check", answerClass: "declaration" })).toBe(false);
  });

  it("walks through ordinary and protected answers", () => {
    expect(canHoldToAccept({ action: "select", answerClass: "ordinary" })).toBe(true);
    expect(canHoldToAccept({ action: "select", answerClass: "protected" })).toBe(true);
  });

  it("reports the lock first when a ghost is both locked and a guess", () => {
    expect(holdStopReason({ action: "click", locked: true, guess: true, pending: true })).toBe("locked");
  });

  it("does not depend on which key is accepting", () => {
    const ghost: AcceptKeyGhost = { action: "fill", guess: true };
    expect(ask({ tab: "free" }, { ghost }).key).toBe("tab");
    expect(ask({ tab: "taken" }, { ghost }).key).toBe("ghost-key");
    expect(canHoldToAccept(ghost)).toBe(false);
  });
});
