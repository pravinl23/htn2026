// An acceptance stands only while the answer does (docs/incremental.md sections 1 and 4).
// Ghost fills a required field, the user selects the text and deletes it, and Submit goes back behind the gate.
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
    <button type="submit" id="submit">Submit application</button>
  </form>`;

let controller: GhostController | null = null;
let overlay: Overlay;
let settings: GhostSettings;

function $<T extends HTMLElement = HTMLInputElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`fixture is missing ${selector}`);
  return el;
}

function host(): HTMLElement {
  return $<HTMLElement>("#ghost-overlay-host");
}

function key(name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
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
    // This form IS the autocomplete case, so Tab accepts (docs/accept-key.md section 1).
    keys: TAB_KEYS,
    ...extra,
  });
  controller.start();
  return controller;
}

async function untilUnmet(count: string): Promise<void> {
  await vi.waitFor(() => expect(host().getAttribute("data-ghost-unmet")).toBe(count));
}

function hasSubmitGhost(c: GhostController): boolean {
  return c.state.ghosts.some((ghost) => ghost.locked);
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS, serverUrl: "" };
  document.body.innerHTML = FORM;
});

afterEach(() => {
  controller?.stop();
  controller = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("an accepted answer that goes away takes its acceptance with it", () => {
  it("withholds Submit again when the user clears a required field Ghost filled", async () => {
    const c = start();
    $("#first").focus();
    key("Tab");
    await vi.waitFor(() => expect(c.state.accepted).toBe(1));
    key("Tab");
    await vi.waitFor(() => expect(c.state.accepted).toBe(2));
    await untilUnmet("0");
    expect($<HTMLInputElement>("#first").value).not.toBe("");
    await vi.waitFor(() => expect(hasSubmitGhost(c)).toBe(true));

    // The user selects the text and deletes it. Nothing else on a plain page announces that.
    const first = $<HTMLInputElement>("#first");
    first.value = "";
    first.dispatchEvent(new Event("input", { bubbles: true }));

    await untilUnmet("1");
    expect(host().getAttribute("data-ghost-gate")).not.toBeNull();
    expect(hasSubmitGhost(c)).toBe(false);
  });

  it("keeps the acceptance while the answer is still there", async () => {
    const c = start();
    $("#first").focus();
    key("Tab");
    await vi.waitFor(() => expect(c.state.accepted).toBe(1));
    key("Tab");
    await vi.waitFor(() => expect(c.state.accepted).toBe(2));
    await untilUnmet("0");

    // A script-made change that leaves a value behind is not a cleared field.
    const last = $<HTMLInputElement>("#last");
    last.value = "Someone else";
    last.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() => expect(host().getAttribute("data-ghost-unmet")).toBe("0"));
    expect(hasSubmitGhost(c)).toBe(true);
  });
});
