// docs/always-propose.md, the rule that outranks every other heuristic: if Ghost can see anything actionable
// it proposes for it. The confidence threshold changes how a proposal is DRAWN, never whether it exists, and
// the only silences left are the four named `SkipReason`s.
//
// The controller tests here pin the key port to plain Tab (docs/accept-key.md lets an origin take the Ghost
// key instead), so what is under test is the walk, not which key drives it.
import { DEFAULT_SETTINGS, DEMO_PROFILE, ghostTier } from "@ghost/shared";
import type { CapturedField, GhostSettings, Profile } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhostController } from "../src/content/controller";
import type { ControllerDeps } from "../src/content/controller";
import { Overlay } from "../src/content/overlay";
import { TAB_KEYS } from "./keys-port";
import { buildGhostsOffline, lastResort, planForm } from "../src/content/predict";
import type { PredictDeps } from "../src/content/predict";

const RECT = { x: 0, y: 0, width: 200, height: 32 };

function field(partial: Partial<CapturedField> & { signature: string; label: string }): CapturedField {
  return { kind: "text", value: "", rect: RECT, ...partial };
}

function deps(settings: Partial<GhostSettings> = {}, extra: Partial<PredictDeps> = {}): PredictDeps {
  return { profile: DEMO_PROFILE, settings: { ...DEFAULT_SETTINGS, ...settings }, ...extra };
}

describe("ghostTier: the threshold styles a proposal, it never deletes one", () => {
  it("moves a proposal between tiers instead of removing it", () => {
    expect(ghostTier(0.95, 0.7)).toBe("confident");
    expect(ghostTier(0.85, 0.7)).toBe("confident");
    expect(ghostTier(0.8, 0.7)).toBe("guess");
    expect(ghostTier(0.7, 0.7)).toBe("guess");
    expect(ghostTier(0.4, 0.7)).toBe("long-shot");
    // Raising the bar dims what no longer clears it; it is never a reason to show nothing.
    expect(ghostTier(0.95, 0.99)).toBe("long-shot");
    // Something the engine inferred is a guess however good the number looks.
    expect(ghostTier(0.99, 0.7, true)).toBe("guess");
  });
});

describe("the four reasons a control gets no ghost", () => {
  const SENSITIVE = field({ signature: "pw", label: "Password", inputType: "password" });
  const CARD = field({ signature: "card", label: "Card number", autocomplete: "cc-number" });
  const NO_CANDIDATE = field({ signature: "why", label: "Why us?", kind: "textarea" });
  const EMAIL = field({ signature: "email", label: "Email", kind: "email" });
  /** Two fields the mapper can answer: what `shared/src/heuristic.ts` wants before it maps anything at all. */
  const ANCHOR = [field({ signature: "first", label: "First name", autocomplete: "given-name" }), EMAIL];

  it("names `sensitive` for a password or a card, and never proposes for them at any threshold", () => {
    for (const threshold of [0, 0.7, 1]) {
      const plan = planForm([SENSITIVE, CARD, ...ANCHOR], [], deps({ confidenceThreshold: threshold }), "offline");
      expect(plan.skips, `threshold ${threshold}`).toEqual([
        { signature: "pw", reason: "sensitive" },
        { signature: "card", reason: "sensitive" },
      ]);
      expect(plan.ghosts.map((g) => g.signature)).toEqual(["first", "email"]);
    }
  });

  it("names `already-answered` for a field that holds something, whitespace included", () => {
    const taken = field({ signature: "last", label: "Last name", value: "   " });
    const plan = planForm([...ANCHOR, taken, field({ signature: "loc", label: "Current location", value: "Toronto" })], [], deps(), "offline");
    expect(plan.skips).toEqual([
      { signature: "last", reason: "already-answered" },
      { signature: "loc", reason: "already-answered" },
    ]);
  });

  it("names `no-candidate` when the whole chain came up empty for that field", () => {
    const plan = planForm([...ANCHOR, NO_CANDIDATE], [], deps(), "offline");
    expect(plan.skips).toEqual([{ signature: "why", reason: "no-candidate" }]);
  });

  it("never names low confidence: the same fields are proposed for at every threshold", () => {
    const fields = [...ANCHOR, field({ signature: "loc", label: "Current location" })];
    for (const threshold of [0, 0.5, 0.7, 0.86, 0.99, 1]) {
      const plan = planForm(fields, [], deps({ confidenceThreshold: threshold }), "offline");
      expect(plan.skips, `threshold ${threshold}`).toEqual([]);
      expect(plan.ghosts.map((g) => g.signature), `threshold ${threshold}`).toEqual(["first", "email", "loc"]);
    }
  });
});

describe("falling back rather than giving up", () => {
  const EMPTY: Profile = { facts: {}, pastAnswers: [] };

  it("asks the answer engine when the fact mapper has nothing", () => {
    const question = field({
      signature: "hear", label: "How did you hear about us?", kind: "select",
      options: [{ value: "", label: "Select" }, { value: "li", label: "LinkedIn" }, { value: "o", label: "Other" }],
    });
    const [ghost] = buildGhostsOffline([question], { profile: EMPTY, settings: DEFAULT_SETTINGS });
    expect(ghost).toMatchObject({ signature: "hear", action: "select", value: "o", guess: true });
  });

  it("proposes the option that claims the least when the engine has no neutral one either", () => {
    const question = field({
      signature: "mode", label: "Preferred working style", kind: "select",
      options: [{ value: "r", label: "Remote" }, { value: "h", label: "Hybrid" }, { value: "o", label: "On-site" }],
    });
    const [ghost] = buildGhostsOffline([question], { profile: EMPTY, settings: DEFAULT_SETTINGS });
    expect(ghost).toMatchObject({ signature: "mode", action: "select", guess: true, tier: "long-shot" });
    expect(ghost?.reason).toContain("claims the least");
  });

  it("proposes focusing the first actionable control on a page of nothing but unknown controls", () => {
    const unknown = [
      field({ signature: "menu", label: "", kind: "button" }),
      field({ signature: "play", label: "", kind: "button" }),
      field({ signature: "more", label: "", kind: "link" }),
    ];
    const ghosts = buildGhostsOffline(unknown, { profile: EMPTY, settings: DEFAULT_SETTINGS });
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({ signature: "menu", action: "click", locked: false, guess: true, tier: "long-shot" });
    expect(ghosts[0]?.displayText).toBe("Start here");
  });

  it("never lands the last resort on a lock, on a sensitive field, or on something already answered", () => {
    const fields = [
      field({ signature: "pw", label: "Password", inputType: "password" }),
      field({ signature: "q", label: "Search", value: "robots" }),
      field({ signature: "submit", label: "Submit application", kind: "button", inputType: "submit", locked: true, value: undefined }),
      field({ signature: "filter", label: "Filter", kind: "select", options: [{ value: "a", label: "A" }] }),
    ];
    const ghost = lastResort(fields, { profile: EMPTY, settings: DEFAULT_SETTINGS }, "offline");
    expect(ghost).toMatchObject({ signature: "filter", action: "click", locked: false });
  });

  it("proposes nothing only when the page holds nothing it may act on", () => {
    const onlyLocked = [field({ signature: "pay", label: "Pay now", kind: "button", inputType: "submit", locked: true, value: undefined })];
    expect(lastResort(onlyLocked, { profile: EMPTY, settings: DEFAULT_SETTINGS }, "offline")).toBeNull();
    expect(lastResort([], { profile: EMPTY, settings: DEFAULT_SETTINGS }, "offline")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The walk itself: a held Tab stops at the first guess, and at every lock.
// ---------------------------------------------------------------------------

const FORM = `
  <form id="form">
    <label for="first">First name</label><input id="first" name="firstName" />
    <label for="last">Last name</label><input id="last" name="lastName" />
    <label for="mode">Preferred working style</label>
    <select id="mode" name="workingStyle">
      <option value="">Select an option</option>
      <option value="remote">Remote</option>
      <option value="hybrid">Hybrid</option>
      <option value="onsite">On-site</option>
    </select>
    <button type="submit" id="submit">Submit application</button>
  </form>`;

let controller: GhostController | null = null;
let overlay: Overlay;
let settings: GhostSettings;
let submitClicks = 0;

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function start(extra: Partial<ControllerDeps> = {}): GhostController {
  overlay = new Overlay(document);
  controller = new GhostController({
    overlay,
    getProfile: () => DEMO_PROFILE,
    getSettings: () => settings,
    isUserEvent: () => true, // jsdom cannot mint trusted events
    keys: TAB_KEYS,
    ...extra,
  });
  controller.start();
  return controller;
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS };
  submitClicks = 0;
  document.body.innerHTML = FORM;
  document.querySelector("form")?.addEventListener("submit", (event) => event.preventDefault());
  document.querySelector("#submit")?.addEventListener("click", () => submitClicks++);
});

afterEach(() => {
  controller?.stop();
  controller = null;
  document.body.innerHTML = "";
});

describe("hold-to-accept", () => {
  it("stops at the first guess instead of filling it, and never reaches the lock through one", async () => {
    const c = start();
    // First name and Last name are facts; the working-style dropdown is a guess Ghost cannot know.
    const guessAt = c.state.ghosts.findIndex((g) => g.guess === true);
    expect(guessAt).toBeGreaterThan(0);
    expect(c.state.ghosts[guessAt]?.signature).toContain("mode");

    key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 8; i++) {
      expect(key("Tab", { repeat: true }).defaultPrevented).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // The hold filled what it was sure about and stopped where it was not.
    expect((document.querySelector("#first") as HTMLInputElement).value).toBe("Alex");
    expect((document.querySelector("#mode") as HTMLSelectElement).value).toBe("");
    expect(submitClicks).toBe(0);
  });

  it("stops at every ghost once the threshold puts them all under the confident tier", async () => {
    settings = { ...DEFAULT_SETTINGS, confidenceThreshold: 0.99 };
    const c = start();
    // Nothing is silenced by the high bar: every proposal is still there, drawn as a long shot.
    expect(c.state.ghosts.filter((g) => !g.locked).length).toBeGreaterThan(0);
    expect(c.state.ghosts.filter((g) => !g.locked).every((g) => g.tier === "long-shot")).toBe(true);

    key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 4; i++) {
      key("Tab", { repeat: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // The first press accepted the ghost the user was looking at; the hold got no further.
    expect((document.querySelector("#last") as HTMLInputElement).value).toBe("");
    expect(submitClicks).toBe(0);
  });
});
