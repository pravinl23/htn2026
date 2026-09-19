// One owner of Tab per moment: a page that runs its own Tab-driven surface says so, and every Ghost component
// stands down. See extension/src/content/tabSurface.ts and docs/compare-approaches.md §3.6.
import { DEFAULT_SETTINGS, DEMO_PROFILE } from "@ghost/shared";
import type { GhostSettings } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GhostController } from "../src/content/controller";
import { NEXT_HOST_ID, startNextAction } from "../src/content/nextAction";
import type { NextActionHandle } from "../src/content/nextAction";
import { Overlay } from "../src/content/overlay";
import { ghostOptedOut, pageOwnsTab, tabSurfaceActive } from "../src/content/tabSurface";

const FORM = `
  <form id="form">
    <label for="first">First name</label><input id="first" name="firstName" />
    <label for="last">Last name</label><input id="last" name="lastName" />
    <label for="email">Email</label><input id="email" name="email" />
    <button type="submit" id="submit">Submit application</button>
  </form>`;

let controller: GhostController | null = null;
let next: NextActionHandle | null = null;
let settings: GhostSettings;

function tab(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function startController(): GhostController {
  const overlay = new Overlay(document);
  controller = new GhostController({
    overlay,
    getProfile: () => DEMO_PROFILE,
    getSettings: () => settings,
    isUserEvent: () => true, // jsdom cannot mint trusted events
  });
  controller.start();
  return controller;
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS, showHud: false };
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-ghost-tab");
  document.body.innerHTML = FORM;
});

afterEach(() => {
  controller?.stop();
  controller = null;
  next?.stop();
  next = null;
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-ghost-tab");
  document.getElementById(NEXT_HOST_ID)?.remove();
});

describe("reading the page's declaration", () => {
  it("understands the meta tag, the root attribute and the active surface", () => {
    expect(pageOwnsTab(document)).toBe(false);

    document.head.innerHTML = `<meta name="ghost-tab" content="off">`;
    expect(ghostOptedOut(document)).toBe(true);
    expect(pageOwnsTab(document)).toBe(true);

    document.head.innerHTML = `<meta name="ghost-tab" content="OFF">`;
    expect(ghostOptedOut(document)).toBe(true);

    document.head.innerHTML = "";
    document.documentElement.setAttribute("data-ghost-tab", "off");
    expect(ghostOptedOut(document)).toBe(true);
    expect(tabSurfaceActive(document)).toBe(false);

    document.documentElement.setAttribute("data-ghost-tab", "active");
    expect(ghostOptedOut(document)).toBe(false);
    expect(tabSurfaceActive(document)).toBe(true);
    expect(pageOwnsTab(document)).toBe(true);
  });

  it("ignores anything it does not recognize, so a typo never disables Ghost silently", () => {
    document.head.innerHTML = `<meta name="ghost-tab" content="on"><meta name="viewport" content="off">`;
    document.documentElement.setAttribute("data-ghost-tab", "maybe");
    expect(pageOwnsTab(document)).toBe(false);
  });
});

describe("the form walk", () => {
  it("draws nothing and leaves Tab native on an opted-out page", () => {
    document.head.innerHTML = `<meta name="ghost-tab" content="off">`;
    const ghost = startController();
    expect(ghost.state.ghosts).toHaveLength(0);
    expect(tab().defaultPrevented).toBe(false);
    expect((document.querySelector<HTMLInputElement>("#first"))?.value).toBe("");
  });

  it("hands Tab back the moment the page declares its own surface active, and takes it up again after", () => {
    const ghost = startController();
    expect(ghost.state.ghosts.length).toBeGreaterThan(0);

    document.documentElement.setAttribute("data-ghost-tab", "active");
    // The key goes native at once, before any rescan has had a chance to run.
    expect(tab().defaultPrevented).toBe(false);
    ghost.rescan();
    expect(ghost.state.ghosts).toHaveLength(0);

    document.documentElement.removeAttribute("data-ghost-tab");
    ghost.rescan();
    expect(ghost.state.ghosts.length).toBeGreaterThan(0);
    expect(tab().defaultPrevented).toBe(true);
  });

  it("never eats Escape while the page owns Tab", () => {
    const ghost = startController();
    expect(ghost.state.ghosts.length).toBeGreaterThan(0);
    document.documentElement.setAttribute("data-ghost-tab", "active");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  });
});

describe("next-action ghosts", () => {
  it("asks nothing at all while the page owns Tab", async () => {
    document.documentElement.setAttribute("data-ghost-tab", "active");
    const asked: unknown[] = [];
    next = startNextAction({
      formGhosts: () => 0,
      isEnabled: () => true,
      getSettings: () => ({ confidenceThreshold: 0.7 }),
      send: async (message) => {
        asked.push(message);
        return null;
      },
      isUserEvent: () => true,
      isVisible: () => true,
      topFrame: true,
      presencePingMs: 0,
      settleMs: 0,
    });
    await next.predictNow();
    expect(asked).toEqual([]);
    expect(next.ghost).toBeNull();
    expect(document.getElementById(NEXT_HOST_ID)).toBeNull();
  });
});
