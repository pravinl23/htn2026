// The walk with a gate on it (docs/incremental.md): no Submit ghost while a required field is empty, the
// HUD says which one, Tab at the end of the walk goes there, and a held Tab always stops at a guess.
import { DEFAULT_SETTINGS, DEMO_PROFILE } from "@ghost/shared";
import type { GhostSettings } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostController } from "../src/content/controller";
import type { ControllerDeps } from "../src/content/controller";
import { Overlay } from "../src/content/overlay";
import { TAB_KEYS } from "./keys-port";

const FORM = `
  <form id="form">
    <label for="first">First name</label><input id="first" name="firstName" required />
    <label for="last">Last name</label><input id="last" name="lastName" required />
    <label for="us">Are you legally authorized to work in the United States?</label>
    <select id="us" name="usAuthorization" required>
      <option value="">Select an option</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
    <label for="why">Why Northwind?</label><textarea id="why" name="why" required></textarea>
    <button type="submit" id="submit">Submit application</button>
  </form>`;

let controller: GhostController | null = null;
let overlay: Overlay;
let settings: GhostSettings;
let submits = 0;

function $<T extends HTMLElement = HTMLInputElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`fixture is missing ${selector}`);
  return el;
}

function host(): HTMLElement {
  return $<HTMLElement>("#ghost-overlay-host");
}

function gateLine(): string {
  return overlay.shadow.querySelector<HTMLElement>(".hud-gate")?.textContent ?? "";
}

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
    // Tab, pinned: this file is about the walk, not about which key an origin takes (docs/accept-key.md).
    keys: TAB_KEYS,
    ...extra,
  });
  controller.start();
  return controller;
}

async function tabUntilAccepted(c: GhostController, accepted: number): Promise<void> {
  key("Tab");
  await vi.waitFor(() => expect(c.state.accepted).toBe(accepted));
}

/** Everything Ghost can fill: first name, last name, and the conservative guess at US authorization. */
async function walk(c: GhostController): Promise<void> {
  for (let n = 1; n <= 3; n++) await tabUntilAccepted(c, n);
  await untilUnmet("1"); // the walk re-gates once it stops writing
}

/** The gate is recomputed on a debounced rescan, so the count catches up a moment after the last write. */
async function untilUnmet(count: string): Promise<void> {
  await vi.waitFor(() => expect(host().getAttribute("data-ghost-unmet")).toBe(count));
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS };
  submits = 0;
  document.body.innerHTML = FORM;
  document.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submits++;
  });
});

afterEach(() => {
  controller?.stop();
  controller = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the gated walk", () => {
  it("proposes no Submit while required fields are empty, and reports the gate on the host", () => {
    const c = start();
    expect(c.state.ghosts.some((g) => g.locked)).toBe(false);
    expect(host().getAttribute("data-ghost-gate")).toBe("blocked");
    expect(host().getAttribute("data-ghost-unmet")).toBe("4");
  });

  it("says in the HUD how many are missing and names the first one, without a value", () => {
    start();
    expect(gateLine()).toBe("4 required fields still empty: First name");
    expect(gateLine()).not.toContain("Alex");
  });

  it("marks the guess it cannot know, and a held Tab stops there instead of filling it", async () => {
    const c = start();
    const guess = c.state.ghosts.find((g) => g.signature.includes("us"));
    expect(guess).toMatchObject({ guess: true, answerClass: "declaration", value: "no" });

    $("#first").focus();
    for (let n = 1; n <= 2; n++) await tabUntilAccepted(c, n); // first and last name go in
    key("Tab", { repeat: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The hold halted at the guess: nothing was written into the select, and the ghost is still there.
    expect(c.state.accepted).toBe(2);
    expect($<HTMLSelectElement>("#us").value).toBe("");
    expect(host().getAttribute("data-ghost-guess")).toBe("true");
  });

  it("sends Tab at the end of the walk to the first unfilled required field, not to Submit", async () => {
    const c = start();
    $("#first").focus();
    await walk(c);
    expect(c.state.ghosts).toHaveLength(0);
    expect(host().getAttribute("data-ghost-gate")).toBe("blocked");
    expect(host().getAttribute("data-ghost-unmet")).toBe("1");

    key("Tab");
    expect(document.activeElement).toBe($("#why"));
    expect(submits).toBe(0);
  });

  it("brings the Submit ghost back the moment the last required field is answered", async () => {
    const c = start();
    $("#first").focus();
    await walk(c);

    const why = $<HTMLTextAreaElement>("#why");
    why.focus();
    why.value = "Robots that ship.";
    why.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(c.state.ghosts).toHaveLength(1));

    expect(host().getAttribute("data-ghost-gate")).toBe("allowed");
    expect(host().getAttribute("data-ghost-unmet")).toBe("0");
    expect(c.state.ghosts[0]).toMatchObject({ action: "click", locked: true });

    // Rule 2: the locked ghost only ever takes focus. Tab never presses it.
    key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe($("#submit"));
    expect(submits).toBe(0);
  });
});
