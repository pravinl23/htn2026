// The hard cases for docs/always-propose.md, the rule that outranks every other heuristic: if Ghost can see
// anything actionable it proposes for it, and the confidence threshold only changes how that proposal is DRAWN.
//
// extension/test/always-propose.test.ts pins the tier table and the four SkipReasons at the unit level. This
// file drives the WHOLE browser pipeline instead -- real capture, real planning, real overlay, real key
// handling -- over the pages that have nothing to go on: unlabelled icon buttons, a form whose labels match
// nothing in the profile, a dropdown whose options match no fact, a video page, a page with one link, and the
// one page where silence is correct (every field on it is sensitive).
//
// Every page here is synthetic and local. Nothing in this file talks to a server, and e2e/tests/stage10-always-
// propose.spec.ts runs the same six pages in a real Chromium with the built extension loaded.
//
// The key port is pinned to plain Tab (docs/accept-key.md section 2 lets an origin take the Ghost key instead)
// so what is under test is the proposal and the walk, never which key drives them.
import { DEFAULT_SETTINGS, DEMO_PROFILE } from "@ghost/shared";
import type { CapturedField, Ghost, GhostSettings, Profile } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFields } from "../src/content/capture";
import { GhostController } from "../src/content/controller";
import type { ControllerDeps } from "../src/content/controller";
import { Overlay } from "../src/content/overlay";
import { TAB_KEYS } from "./keys-port";
import { planForm } from "../src/content/predict";

// ---------------------------------------------------------------------------
// The six pages. Five of them give Ghost nothing it knows; one of them is the honest silence.
// ---------------------------------------------------------------------------

/** A toolbar of icons: no labels, no names, no text of any kind. Nothing here can be matched to a fact. */
const ICON_BUTTONS = `
  <div id="toolbar">
    <button id="icon-1" type="button"><svg viewBox="0 0 16 16"><path d="M1 1h14v14H1z"></path></svg></button>
    <button id="icon-2" type="button"><svg viewBox="0 0 16 16"><path d="M8 1v14"></path></svg></button>
    <button id="icon-3" type="button"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"></circle></svg></button>
  </div>`;

/** A real form, properly labelled, about something the profile has never heard of. */
const STRANGE_FORM = `
  <form id="order">
    <label for="tolerance">Sprocket tolerance</label><input id="tolerance" name="sprocketTolerance" />
    <label for="finish">Flange colour</label><input id="finish" name="flangeColour" />
    <label for="batch">Widget batch code</label><input id="batch" name="widgetBatch" />
    <button id="order-submit" type="submit">Submit order</button>
  </form>`;

/** One dropdown whose options match no fact and offer no neutral choice ("Other", "N/A", "Prefer not to say"). */
const STRANGE_DROPDOWN = `
  <form id="finishing">
    <label for="coating">Preferred sprocket finish</label>
    <select id="coating" name="coating">
      <option value="">Select an option</option>
      <option value="matte">Matte</option>
      <option value="gloss">Gloss</option>
      <option value="brushed">Brushed</option>
    </select>
  </form>`;

/** A player: one video and three unlabelled controls. The video is not a control and is never proposed for. */
const VIDEO_PAGE = `
  <main>
    <video id="clip" width="320" height="180"></video>
    <div id="controls">
      <button id="play" type="button"><svg viewBox="0 0 16 16"><path d="M3 2l11 6-11 6z"></path></svg></button>
      <button id="mute" type="button"><svg viewBox="0 0 16 16"><path d="M2 6h3l4-3v10L5 10H2z"></path></svg></button>
      <button id="expand" type="button"><svg viewBox="0 0 16 16"><path d="M1 1h6M1 1v6"></path></svg></button>
    </div>
  </main>`;

/** Nothing on the page but one link. */
const ONE_LINK = `<main><p>That is all there is here.</p><a id="onward" href="/next">Continue reading</a></main>`;

/**
 * The one page where showing nothing is right: every field on it is sensitive, and a sensitive field is never
 * captured, never proposed and never filled (CLAUDE.md rule 3). That is a privacy rule, not a confidence rule,
 * which is why it survives a threshold of 0.
 */
const SENSITIVE_ONLY = `
  <form id="checkout">
    <label for="pw">Password</label><input id="pw" name="password" type="password" />
    <label for="card">Card number</label><input id="card" name="cardNumber" autocomplete="cc-number" />
    <label for="cvc">Security code</label><input id="cvc" name="cvc" autocomplete="cc-csc" />
    <button id="pay" type="submit">Pay now</button>
  </form>`;

/** A form Ghost DOES know, for the lock, the hold and rule 9. "Robin" is already in the first field. */
const KNOWN_FORM = `
  <form id="apply">
    <label for="first">First name</label><input id="first" name="firstName" value="Robin" />
    <label for="last">Last name</label><input id="last" name="lastName" />
    <label for="email">Email</label><input id="email" name="email" type="email" />
    <label for="style">Preferred working style</label>
    <select id="style" name="workingStyle">
      <option value="">Select an option</option>
      <option value="remote">Remote</option>
      <option value="hybrid">Hybrid</option>
      <option value="onsite">On-site</option>
    </select>
    <button id="apply-submit" type="submit">Submit application</button>
  </form>`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let controller: GhostController | null = null;
let overlay: Overlay;
let settings: GhostSettings;
let clicks: string[] = [];
let submits = 0;

function mount(html: string): void {
  document.body.innerHTML = html;
  document.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submits++;
  });
  // Every button and link on every page reports being pressed, so "proposed but never pressed" is provable.
  for (const el of document.querySelectorAll<HTMLElement>("button, a[href]")) {
    el.addEventListener("click", (event) => {
      event.preventDefault();
      clicks.push(el.id);
    });
  }
}

function start(html: string, extra: Partial<ControllerDeps> = {}): GhostController {
  mount(html);
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

function restart(html: string): GhostController {
  controller?.stop();
  controller = null;
  return start(html);
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

/**
 * A rendered frame. Which key accepts the ghost on screen is recomputed on every render, and the controller
 * renders on an animation frame, so a press sent inside the same tick as a focus change is still a native one.
 */
async function frame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 32));
}

/** Puts the caret where the user would have it, and lets the walk notice. */
async function focus(id: string): Promise<void> {
  document.getElementById(id)?.focus();
  await frame();
}

/** One press, then everything it queued (the write, the rescan, the render) settles. */
async function press(name = "Tab", init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = key(name, init);
  await frame();
  return event;
}

/** A key held down: one fresh press, then repeats until the walk stops taking them. */
async function hold(times = 6): Promise<void> {
  await press();
  for (let i = 0; i < times; i++) await press("Tab", { repeat: true });
}

function host(): HTMLElement {
  const el = document.getElementById("ghost-overlay-host");
  if (!el) throw new Error("the overlay host is missing");
  return el;
}

function hostAttr(name: string): string {
  return host().getAttribute(name) ?? "";
}

/** The HUD row that carries a long shot's reason. Empty string when it is hidden. */
function hudWhy(): string {
  const row = overlay.shadow.querySelector<HTMLElement>(".hud-why");
  return !row || row.hidden ? "" : (row.textContent ?? "");
}

/**
 * The chip drawn on a value ghost ("guess", "check this", or nothing). A CLICK ghost has no text node at all
 * (the overlay draws the cursor and the ring for it), so this answers null there and the tier is read from
 * the host instead.
 */
function chipFor(signature: string): string | null {
  const node = overlay.shadow.querySelector<HTMLElement>(`.ghost[data-signature="${signature}"]`);
  return node ? (node.querySelector<HTMLElement>(".chip")?.textContent ?? "") : null;
}

function tierNodeFor(signature: string): string | null {
  const node = overlay.shadow.querySelector<HTMLElement>(`.ghost[data-signature="${signature}"]`);
  return node ? node.getAttribute("data-tier") : null;
}

function input(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`fixture is missing input #${id}`);
  return el;
}

function select(id: string): HTMLSelectElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`fixture is missing select #${id}`);
  return el;
}

/**
 * What the plan says about the controls it did NOT propose for, over the page as it stands. Straight from the
 * pure layer, because the named reason is the point: `grep SkipReason` has to find every silence there is.
 */
function skipsFor(profile: Profile = DEMO_PROFILE): Record<string, string> {
  const fields: CapturedField[] = captureFields(document);
  const plan = planForm(fields, [], { profile, settings }, "offline");
  return Object.fromEntries(plan.skips.map((skip) => [skip.signature, skip.reason]));
}

/** The named reason for the one control whose signature carries `id`. */
function skipped(reasons: Record<string, string>, id: string): string | undefined {
  return Object.entries(reasons).find(([signature]) => signature.split("|").includes(id))?.[1];
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS };
  clicks = [];
  submits = 0;
});

afterEach(() => {
  controller?.stop();
  controller = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Every hard page proposes something
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  html: string;
  /** The control the proposal is expected to land on. */
  on: string;
}

const HARD_PAGES: Case[] = [
  { name: "a toolbar of unlabelled icon buttons", html: ICON_BUTTONS, on: "icon-1" },
  { name: "a form whose labels match nothing in the profile", html: STRANGE_FORM, on: "tolerance" },
  { name: "a dropdown whose options match no fact", html: STRANGE_DROPDOWN, on: "coating" },
  { name: "a video and three icon controls", html: VIDEO_PAGE, on: "play" },
  { name: "a page with a single link", html: ONE_LINK, on: "onward" },
];

describe("a page Ghost knows nothing about still gets a proposal", () => {
  for (const page of HARD_PAGES) {
    it(`proposes on ${page.name}`, () => {
      const c = start(page.html);
      expect(c.state.ghosts.length, "silence is only correct when there is nothing to act on").toBeGreaterThan(0);
      expect(hostAttr("data-ghost-state")).toBe("ready");
      // It landed on something the user can act on, and said so as a guess rather than as a fact.
      const current = c.state.ghosts[c.state.currentIndex];
      expect(current?.signature).toContain(page.on);
      expect(current?.guess).toBe(true);
      expect(current?.tier).toBe("long-shot");
      expect(current?.locked ?? false).toBe(false);
      expect(hostAttr("data-ghost-guess")).toBe("true");
      expect(hostAttr("data-ghost-tier")).toBe("long-shot");
      // A long shot carries its reason where the user can read it (docs/always-propose.md, the tier table).
      expect(current?.reason ?? "").not.toBe("");
      expect(hudWhy()).toBe(current?.reason);
    });
  }

  it("proposes the option that claims the least when a dropdown matches nothing, chipped as a guess", () => {
    const c = start(STRANGE_DROPDOWN);
    const ghost = c.state.ghosts[0] as Ghost;
    expect(ghost).toMatchObject({ action: "select", value: "matte", answerSource: "guess", guess: true, tier: "long-shot" });
    expect(chipFor(ghost.signature)).toBe("guess");
    expect(tierNodeFor(ghost.signature)).toBe("long-shot");
    // Proposing is not doing: the select still holds its placeholder until a key is pressed.
    expect(select("coating").value).toBe("");
  });

  it("never proposes for the video itself: only controls are proposed for", () => {
    const c = start(VIDEO_PAGE);
    expect(c.state.ghosts.every((g) => !g.signature.includes("clip"))).toBe(true);
    expect(c.state.ghosts).toHaveLength(1);
  });

  it("names `no-candidate` for the strange form's fields rather than dropping them silently", () => {
    const c = start(STRANGE_FORM);
    const reasons = skipsFor();
    // Each labelled field nothing can answer is accounted for by name, and the reason is never "too unsure".
    for (const id of ["tolerance", "finish", "batch"]) expect(skipped(reasons, id), id).toBe("no-candidate");
    expect(Object.values(reasons).includes("low-confidence" as never)).toBe(false);
    // And the page is still not silent: the walk offers the first field as a place to start.
    expect(c.state.ghosts).toHaveLength(1);
    expect(c.state.ghosts[0]?.action).toBe("click");
  });
});

// ---------------------------------------------------------------------------
// 2. The threshold styles a proposal; it never deletes one
// ---------------------------------------------------------------------------

describe("the confidence threshold changes how a proposal is drawn, never whether it exists", () => {
  const THRESHOLDS = [0, 0.5, 0.7, 0.86, 0.99, 1];

  for (const page of [...HARD_PAGES, { name: "a form Ghost does know", html: KNOWN_FORM, on: "last" }]) {
    it(`keeps every proposal on ${page.name} at every threshold`, () => {
      const baseline = start(page.html).state.ghosts.map((g) => g.signature);
      expect(baseline.length).toBeGreaterThan(0);
      for (const confidenceThreshold of THRESHOLDS) {
        settings = { ...DEFAULT_SETTINGS, confidenceThreshold };
        const c = restart(page.html);
        expect(c.state.ghosts.map((g) => g.signature), `threshold ${confidenceThreshold}`).toEqual(baseline);
      }
    });
  }

  it("dims a fact instead of deleting it when the bar is raised above it", () => {
    settings = { ...DEFAULT_SETTINGS, confidenceThreshold: 0.99 };
    const c = start(KNOWN_FORM);
    const email = c.state.ghosts.find((g) => g.signature.includes("email"));
    expect(email, "the email fact is still proposed at a 0.99 threshold").toBeDefined();
    expect(email?.value).toBe(DEMO_PROFILE.facts.email);
    expect(email?.tier).toBe("long-shot");
    expect(email?.guess).toBe(true); // hold-to-accept must stop at it, because the user set the bar there
    expect(tierNodeFor(email?.signature ?? "")).toBe("long-shot");
  });

  it("draws the same fact as a confident ghost, with no chip, at the default threshold", () => {
    const c = start(KNOWN_FORM);
    const email = c.state.ghosts.find((g) => g.signature.includes("email"));
    expect(email?.tier).toBe("confident");
    expect(email?.guess).toBeUndefined();
    expect(chipFor(email?.signature ?? "")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. The one correct silence
// ---------------------------------------------------------------------------

describe("a page whose only fields are sensitive", () => {
  it("shows nothing at all, at every threshold, and that is the right answer", () => {
    for (const confidenceThreshold of [0, 0.7, 1]) {
      settings = { ...DEFAULT_SETTINGS, confidenceThreshold };
      const c = restart(SENSITIVE_ONLY);
      expect(c.state.ghosts, `threshold ${confidenceThreshold}`).toEqual([]);
      expect(hostAttr("data-ghost-state")).toBe("idle");
    }
  });

  it("never even captures the sensitive fields, so nothing downstream can propose for them", () => {
    start(SENSITIVE_ONLY);
    const captured = captureFields(document).map((field) => field.signature);
    for (const id of ["pw", "card", "cvc"]) {
      expect(captured.some((signature) => signature.split("|").includes(id)), id).toBe(false);
    }
    // All that is left of the page is the irreversible button, which is never a proposal on its own.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("pay");
    expect(skipsFor()).toEqual({ [captured[0] as string]: "no-candidate" });
  });

  it("never writes to a sensitive field and never presses the irreversible button, however long the key is held", async () => {
    start(SENSITIVE_ONLY);
    await focus("pw");
    await hold();
    expect(input("pw").value).toBe("");
    expect(input("card").value).toBe("");
    expect(input("cvc").value).toBe("");
    expect(clicks).toEqual([]);
    expect(submits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Proposing is not doing: the hold, the lock, and what is already there
// ---------------------------------------------------------------------------

describe("hold-to-accept", () => {
  it("stops at the first guess: the facts are filled, the guessed dropdown is not", async () => {
    const c = start(KNOWN_FORM);
    const guessAt = c.state.ghosts.findIndex((g) => g.guess === true);
    expect(guessAt).toBeGreaterThanOrEqual(0);
    expect(c.state.ghosts[guessAt]?.signature).toContain("style");

    await focus("last");
    await hold();

    // The hold walked THROUGH what Ghost knows and stopped at the first thing it does not.
    expect(input("last").value).toBe("Chen");
    expect(input("email").value).toBe(DEMO_PROFILE.facts.email);
    expect(select("style").value, "the guess is where the hold stopped").toBe("");
    expect(clicks).toEqual([]);
    expect(submits).toBe(0);
  });

  it("stops at the long shot on a page it knows nothing about: nothing is clicked by a held key", async () => {
    start(ICON_BUTTONS);
    // Repeats only. A fresh press is the user accepting what they are looking at; a HOLD may never reach a guess.
    for (let i = 0; i < 6; i++) await press("Tab", { repeat: true });
    expect(clicks).toEqual([]);
  });

  it("stops at every ghost once a raised threshold puts them all under the confident tier", async () => {
    settings = { ...DEFAULT_SETTINGS, confidenceThreshold: 0.99 };
    const c = start(KNOWN_FORM);
    expect(c.state.ghosts.filter((g) => !g.locked).every((g) => g.tier === "long-shot")).toBe(true);

    await focus("last");
    await hold();
    // The first press took the ghost the user was on; every repeat after it was swallowed.
    expect(input("last").value).toBe("Chen");
    expect(input("email").value).toBe("");
    expect(submits).toBe(0);
  });
});

describe("locked actions", () => {
  it("are proposed and walked to, and never pressed", async () => {
    const c = start(KNOWN_FORM);
    const lock = c.state.ghosts.find((g) => g.locked);
    expect(lock?.signature, "the walk ends parked on Submit").toContain("apply-submit");
    expect(lock?.displayText).toBe("Submit application");

    // Walk the whole form by hand: every value ghost, then press on at the lock.
    await focus("last");
    for (let i = 0; i < 6; i++) await press();
    // Every value ghost was taken by a deliberate press, and the walk then parked on the button.
    expect(c.state.accepted).toBeGreaterThanOrEqual(3);
    expect(hostAttr("data-ghost-current")).toContain("apply-submit");
    expect(hostAttr("data-ghost-current-locked")).toBe("true");
    expect(clicks, "Submit is proposed, never pressed").toEqual([]);
    expect(submits).toBe(0);
  });

  it("is never what a page's last resort lands on", () => {
    const c = start(`
      <form id="only-danger">
        <p>Nothing here but the one thing Ghost may not press.</p>
        <button id="delete-all" type="submit">Delete everything</button>
      </form>`);
    expect(c.state.ghosts).toEqual([]);
    expect(hostAttr("data-ghost-state")).toBe("idle");
  });
});

describe("rule 9: a field that already has a value", () => {
  it("is never proposed for and never overwritten by the walk", async () => {
    const c = start(KNOWN_FORM);
    expect(c.state.ghosts.some((g) => g.signature.includes("first"))).toBe(false);
    expect(skipped(skipsFor(), "first")).toBe("already-answered");

    await focus("last");
    await hold();
    expect(input("first").value).toBe("Robin");
  });
});
