import { DEFAULT_SETTINGS, DEMO_PROFILE } from "@ghost/shared";
import type { GhostSettings } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostController } from "../src/content/controller";
import type { ControllerDeps } from "../src/content/controller";
import { Overlay } from "../src/content/overlay";

const FORM = `
  <form id="form">
    <label for="first">First name</label><input id="first" name="firstName" />
    <label for="last">Last name</label><input id="last" name="lastName" />
    <label for="auth">Are you legally authorized to work in Canada?</label>
    <select id="auth" name="workAuthorization">
      <option value="">Select an option</option>
      <option value="yes">Yes, I am authorized to work in Canada</option>
      <option value="no">No</option>
    </select>
    <fieldset>
      <legend>Will you now or in the future require sponsorship?</legend>
      <label><input type="radio" id="sponsor-yes" name="sponsorship" value="yes" /> Yes</label>
      <label><input type="radio" id="sponsor-no" name="sponsorship" value="no" /> No</label>
    </fieldset>
    <label for="why">Why Northwind?</label><textarea id="why" name="why"></textarea>
    <label for="sin">Social Insurance Number</label><input id="sin" name="sin" />
    <label for="pw">Payroll password</label><input id="pw" name="payrollPassword" type="password" />
    <button type="submit" id="submit">Submit application</button>
  </form>`;

let controller: GhostController | null = null;
let overlay: Overlay;
let settings: GhostSettings;
let submits = 0;
let submitClicks = 0;

function $<T extends HTMLElement = HTMLInputElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`fixture is missing ${selector}`);
  return el;
}

function mountForm(html: string = FORM): void {
  document.body.innerHTML = html;
  document.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submits++;
  });
  document.querySelector("#submit")?.addEventListener("click", () => submitClicks++);
}

function startController(extra: Partial<ControllerDeps> = {}): GhostController {
  overlay = new Overlay(document);
  controller = new GhostController({
    overlay,
    getProfile: () => DEMO_PROFILE,
    getSettings: () => settings,
    isUserEvent: () => true, // jsdom cannot mint trusted events
    ...extra,
  });
  controller.start();
  return controller;
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function releaseTab(): void {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
}

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function host(): HTMLElement {
  return $<HTMLElement>("#ghost-overlay-host");
}

function currentId(c: GhostController): string | undefined {
  const signature = c.state.ghosts[c.state.currentIndex]?.signature;
  return signature === undefined ? undefined : signature.split("|")[3] || signature.split("|")[2];
}

/** Presses Tab and waits until the accept count reaches `accepted`. */
async function tabUntilAccepted(c: GhostController, accepted: number): Promise<KeyboardEvent> {
  const event = key("Tab");
  await vi.waitFor(() => expect(c.state.accepted).toBe(accepted));
  return event;
}

async function walkToLock(c: GhostController): Promise<void> {
  for (let n = 1; n <= 4; n++) await tabUntilAccepted(c, n);
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS };
  submits = 0;
  submitClicks = 0;
  mountForm();
});

afterEach(() => {
  controller?.stop();
  controller = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("start", () => {
  it("builds ghosts for profile-backed fields, first one current, Submit parked last and locked", () => {
    const c = startController();
    expect(c.state.ghosts.map((g) => [g.action, g.value, g.locked])).toEqual([
      ["fill", "Alex", false],
      ["fill", "Chen", false],
      ["select", "yes", false],
      ["select", "no", false],
      ["click", undefined, true],
    ]);
    expect(c.state.currentIndex).toBe(0);
    expect(host().getAttribute("data-ghost-state")).toBe("ready");
    expect(host().getAttribute("data-ghost-count")).toBe("5");
    expect(host().getAttribute("data-ghost-current-locked")).toBe("false");
    expect(host().getAttribute("data-ghost-accepted")).toBe("0");
  });

  it("does not steal focus on page load", () => {
    startController();
    expect(document.activeElement).toBe(document.body);
  });

  it("never creates ghosts for sensitive fields, and never writes to them", async () => {
    const c = startController();
    expect(c.state.ghosts.some((g) => /sin|password|payroll/i.test(g.signature))).toBe(false);
    await walkToLock(c);
    expect($("#sin").value).toBe("");
    expect($("#pw").value).toBe("");
  });

  it("creates no ghosts when nothing clears the confidence threshold", () => {
    settings.confidenceThreshold = 0.999;
    const c = startController();
    expect(c.state.ghosts).toEqual([]);
    expect(host().getAttribute("data-ghost-state")).toBe("idle");
    expect(key("Tab").defaultPrevented).toBe(false);
  });
});

describe("Tab", () => {
  it("accepts the current ghost, advances, and moves focus to the next ghost's element", async () => {
    const c = startController();
    const event = await tabUntilAccepted(c, 1);
    expect(event.defaultPrevented).toBe(true);
    expect($("#first").value).toBe("Alex");
    expect(currentId(c)).toBe("last");
    expect(document.activeElement).toBe($("#last"));
    expect(host().getAttribute("data-ghost-accepted")).toBe("1");
    expect(c.state.keystrokesSaved).toBe(4);
  });

  it("walks the whole form: text, select, radio, then parks on the locked Submit without activating it", async () => {
    const c = startController();
    await walkToLock(c);
    expect($("#first").value).toBe("Alex");
    expect($("#last").value).toBe("Chen");
    expect($<HTMLSelectElement>("#auth").value).toBe("yes");
    expect($("#sponsor-no").checked).toBe(true);
    expect($("#sponsor-yes").checked).toBe(false);
    expect($<HTMLTextAreaElement>("#why").value).toBe("");
    expect(c.state.ghosts.map((g) => g.locked)).toEqual([true]);
    expect(document.activeElement).toBe($("#submit"));
    expect(host().getAttribute("data-ghost-current-locked")).toBe("true");
    expect(submits + submitClicks).toBe(0);
  });

  it("queues quick successive presses instead of dropping them or letting them through", async () => {
    const c = startController();
    const events = [key("Tab"), key("Tab"), key("Tab")];
    expect(events.every((e) => e.defaultPrevented)).toBe(true);
    await vi.waitFor(() => expect(c.state.accepted).toBe(3));
    expect($<HTMLSelectElement>("#auth").value).toBe("yes");
  });

  it("is left alone when there is no ghost", () => {
    mountForm(`<form><label for="q">Search</label><input id="q" /><button type="button" id="go">Go</button></form>`);
    const c = startController();
    expect(c.state.ghosts).toEqual([]);
    const event = key("Tab");
    expect(event.defaultPrevented).toBe(false);
  });

  it("never touches Shift+Tab or Tab with Ctrl, Alt or Meta", async () => {
    const c = startController();
    const events = [
      key("Tab", { shiftKey: true }), key("Tab", { ctrlKey: true }), key("Tab", { altKey: true }), key("Tab", { metaKey: true }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
    expect(c.state.accepted).toBe(0);
    expect($("#first").value).toBe("");
  });

  it("ignores keys pressed during IME composition", async () => {
    const c = startController();
    const event = key("Tab", { isComposing: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(event.defaultPrevented).toBe(false);
    expect(c.state.accepted).toBe(0);
  });

  it("ignores script-made (untrusted) Tab presses by default, so a page cannot pull the profile out", async () => {
    const c = startController({ isUserEvent: undefined });
    const event = key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(event.defaultPrevented).toBe(false);
    expect(c.state.accepted).toBe(0);
    expect($("#first").value).toBe("");
  });

  it("behaves natively while the current ghost is scrolled out of the viewport", async () => {
    const c = startController();
    vi.spyOn($("#first"), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 5000, 200, 32));
    const event = key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(event.defaultPrevented).toBe(false);
    expect(c.state.accepted).toBe(0);
  });

  it("does not overwrite a value that appeared after the ghost was made", async () => {
    const c = startController();
    $("#last").value = "Lee"; // set by the page without any event
    await tabUntilAccepted(c, 1);
    key("Tab");
    await vi.waitFor(() => expect(currentId(c)).toBe("auth"));
    expect($("#last").value).toBe("Lee");
    expect(c.state.accepted).toBe(1);
  });

  it("leaves fields that already had a value untouched", async () => {
    mountForm(FORM.replace('id="first" name="firstName"', 'id="first" name="firstName" value="Sam"'));
    const c = startController();
    expect(c.state.ghosts).toHaveLength(4);
    for (let n = 1; n <= 3; n++) await tabUntilAccepted(c, n);
    expect($("#first").value).toBe("Sam");
    expect($("#last").value).toBe("Chen");
  });
});

describe("locked ghosts", () => {
  it("are never executed: Tab only moves focus onto the locked element and keeps the badge", async () => {
    const c = startController();
    await walkToLock(c);
    $("#submit").blur();
    expect(document.activeElement).toBe(document.body);
    const event = key("Tab");
    await vi.waitFor(() => expect(document.activeElement).toBe($("#submit")));
    expect(event.defaultPrevented).toBe(true);
    for (let i = 0; i < 3; i++) expect(key("Tab").defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(submits + submitClicks).toBe(0);
    expect(c.state.ghosts).toHaveLength(1);
    expect(host().getAttribute("data-ghost-current-locked")).toBe("true");
  });

  it("yield to native Tab while the user works in another control, and take over again at the button", async () => {
    const c = startController();
    await walkToLock(c);
    type($<HTMLTextAreaElement>("#why"), "Because robots.");
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(c.state.ghosts).toHaveLength(1);
    $("#submit").focus();
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(submits + submitClicks).toBe(0);
  });

  it("stop a held Tab: repeats accept unlocked ghosts, then get swallowed at the lock", async () => {
    const c = startController();
    await tabUntilAccepted(c, 1);
    for (let n = 2; n <= 4; n++) {
      expect(key("Tab", { repeat: true }).defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(c.state.accepted).toBe(n));
    }
    const extra = Array.from({ length: 10 }, () => key("Tab", { repeat: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(extra.every((e) => e.defaultPrevented)).toBe(true);
    expect(c.state.accepted).toBe(4);
    expect(document.activeElement).toBe($("#submit"));
    expect(submits + submitClicks).toBe(0);
  });

  it("are kept after a rescan once the walk has filled the form", async () => {
    const c = startController();
    await walkToLock(c);
    c.rescan();
    expect(c.state.ghosts.map((g) => g.locked)).toEqual([true]);
    expect(host().getAttribute("data-ghost-current-locked")).toBe("true");
  });
});

describe("held Tab", () => {
  it("does not start accepting when the hold began as a native Tab", async () => {
    const c = startController();
    const event = key("Tab", { repeat: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(event.defaultPrevented).toBe(false);
    expect(c.state.accepted).toBe(0);
  });

  it("drops repeats that arrive while a write is in flight", async () => {
    const c = startController();
    key("Tab");
    for (let i = 0; i < 5; i++) expect(key("Tab", { repeat: true }).defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(c.state.accepted).toBe(1);
    releaseTab();
  });

  it("stops at a visible guess until the user gives it one fresh deliberate Tab", async () => {
    mountForm(`<form>
      <label for="first">First name</label><input id="first" name="firstName" />
      <label for="relocate">Are you willing to relocate?</label>
      <select id="relocate" name="relocate"><option value="">Choose</option><option value="y">Yes</option><option value="n">No</option></select>
      <button type="submit" id="submit">Submit application</button>
    </form>`);
    const c = startController();
    await tabUntilAccepted(c, 1);
    expect(c.state.ghosts[0]?.answer).toEqual({ class: "ordinary", source: "guess", needsReview: true });
    const held = key("Tab", { repeat: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(held.defaultPrevented).toBe(true);
    expect(c.state.accepted).toBe(1);
    expect($<HTMLSelectElement>("#relocate").value).toBe("");
    releaseTab();
    await tabUntilAccepted(c, 2);
    expect($<HTMLSelectElement>("#relocate").value).toBe("y");
  });
});

describe("typing overrides", () => {
  it("dismisses the ghost of the field being typed in and advances", () => {
    const c = startController();
    type($("#first"), "S");
    expect(c.state.dismissed.size).toBe(1);
    expect(currentId(c)).toBe("last");
    expect(c.state.ghosts).toHaveLength(4);
    c.rescan();
    expect(c.state.ghosts).toHaveLength(4); // does not come back, even once the field is empty again
  });

  it("dismisses a pending (not current) ghost without moving the current one", () => {
    const c = startController();
    const last = $("#last"); // browser autofill: a user-made change without focus
    last.value = "L";
    last.dispatchEvent(new Event("input", { bubbles: true }));
    expect(currentId(c)).toBe("first");
    expect(c.state.ghosts).toHaveLength(4);
  });

  it("dismisses a radio group's ghost when the user picks any option", () => {
    const c = startController();
    const yes = $("#sponsor-yes");
    yes.checked = true;
    yes.dispatchEvent(new Event("input", { bubbles: true }));
    expect(c.state.ghosts.some((g) => g.signature.includes("sponsorship"))).toBe(false);
  });

  it("does not treat Ghost's own writes as typing", async () => {
    const c = startController();
    await tabUntilAccepted(c, 1);
    expect(c.state.dismissed.size).toBe(0);
  });
});

describe("Escape", () => {
  it("dismisses the current ghost, advances, and only then prevents default", () => {
    const c = startController();
    const event = key("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(currentId(c)).toBe("last");
    expect(c.state.dismissed.size).toBe(1);
    c.rescan();
    expect(c.state.ghosts).toHaveLength(4);
    expect($("#first").value).toBe("");
  });

  it("is left alone when there is nothing to dismiss", () => {
    mountForm(`<form><label for="q">Search</label><input id="q" /></form>`);
    startController();
    expect(key("Escape").defaultPrevented).toBe(false);
  });

  it("clears a lone Submit ghost once every value ghost was dismissed", () => {
    const c = startController();
    for (let i = 0; i < 4; i++) key("Escape");
    expect(c.state.ghosts).toEqual([]);
    expect(key("Escape").defaultPrevented).toBe(false);
    expect(key("Tab").defaultPrevented).toBe(false);
  });
});

describe("focus follows the user", () => {
  it("makes the focused field's ghost current", async () => {
    const c = startController();
    $<HTMLSelectElement>("#auth").focus();
    expect(currentId(c)).toBe("auth");
    expect(host().getAttribute("data-ghost-current")).toContain("|auth|");
    await tabUntilAccepted(c, 1);
    expect($<HTMLSelectElement>("#auth").value).toBe("yes");
    expect($("#first").value).toBe("");
  });

  it("wraps back to skipped ghosts before parking on Submit", async () => {
    const c = startController();
    $("#sponsor-yes").focus();
    await tabUntilAccepted(c, 1);
    expect($("#sponsor-no").checked).toBe(true);
    expect(currentId(c)).toBe("first");
  });
});

describe("failed writes", () => {
  it("stop the walk, surface the reason, and leave the remaining ghosts pending", async () => {
    const c = startController();
    const first = $("#first");
    first.addEventListener("input", () => (first.value = "")); // the page rejects the write
    key("Tab");
    const held = key("Tab", { repeat: true });
    await vi.waitFor(() => expect(host().getAttribute("data-ghost-error")).toMatch(/verify-failed/));
    expect(held.defaultPrevented).toBe(true);
    expect(key("Tab", { repeat: true }).defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(c.state.accepted).toBe(0);
    expect($("#last").value).toBe("");
    expect(c.state.ghosts).toHaveLength(4);
    expect(host().getAttribute("data-ghost-error")).not.toContain("Alex");
    releaseTab();
    await tabUntilAccepted(c, 1);
    expect($("#last").value).toBe("Chen");
    expect(host().hasAttribute("data-ghost-error")).toBe(false);
  });
});

describe("rescan", () => {
  it("picks up fields added to the DOM, debounced", async () => {
    const c = startController();
    const label = document.createElement("label");
    label.htmlFor = "email";
    label.textContent = "Email";
    const input = document.createElement("input");
    input.id = "email";
    input.type = "email";
    $<HTMLFormElement>("#form").prepend(label, input);
    expect(c.state.ghosts).toHaveLength(5);
    await vi.waitFor(() => expect(c.state.ghosts).toHaveLength(6), { timeout: 1500 });
    expect(currentId(c)).toBe("first"); // the current ghost survives a rescan
  });

  it("ignores the overlay's own DOM churn", async () => {
    const c = startController();
    const spy = vi.spyOn(c, "rescan");
    await tabUntilAccepted(c, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores class and style churn on elements that hold no control (carousels, progress bars)", async () => {
    const c = startController();
    const banner = document.createElement("div");
    document.body.append(banner);
    await vi.waitFor(() => expect(c.state.ghosts).toHaveLength(5));
    await new Promise((resolve) => setTimeout(resolve, 250)); // let the rescan for the insertion itself pass
    const spy = vi.spyOn(c, "rescan");
    for (let frame = 0; frame < 5; frame++) {
      banner.style.transform = `rotate(${frame}deg)`;
      banner.className = `frame-${frame}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spy).not.toHaveBeenCalled();
    $<HTMLFormElement>("#form").className = "step-2"; // this one can show or hide fields
    await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 1500 });
  });

  it("drops the ghost of a field that turns sensitive after the first scan", async () => {
    const c = startController();
    $("#first").setAttribute("autocomplete", "cc-name");
    await vi.waitFor(() => expect(c.state.ghosts).toHaveLength(4), { timeout: 1500 });
    expect(currentId(c)).toBe("last");
    expect($("#first").hasAttribute("data-ghost-hint")).toBe(false);
  });

  it("drops ghosts for fields a script filled in", async () => {
    const c = startController({ isUserEvent: (event) => event.type !== "input" });
    const last = $("#last");
    last.value = "Lee";
    last.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(c.state.ghosts).toHaveLength(4), { timeout: 1500 });
    expect(c.state.dismissed.size).toBe(0);
  });
});

describe("whose key is it", () => {
  const WITH_SEARCH = `<input id="search" aria-label="Search the site" />${FORM}`;

  it("leaves Tab native while the user is in an unrelated control, and takes over once they land on a ghosted field", async () => {
    mountForm(WITH_SEARCH);
    const c = startController();
    $("#search").focus();
    const event = key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(event.defaultPrevented).toBe(false);
    expect(c.state.accepted).toBe(0);
    expect($("#first").value).toBe("");
    expect(document.activeElement).toBe($("#search"));
    $("#last").focus(); // where a native Tab could have taken them
    await tabUntilAccepted(c, 1);
    expect($("#last").value).toBe("Chen");
  });

  it("leaves Tab native inside an essay answer even though a ghost is on screen", async () => {
    const c = startController();
    type($<HTMLTextAreaElement>("#why"), "Because robots.");
    expect(key("Tab").defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(c.state.accepted).toBe(0);
  });

  it("still owns Tab on the field the walk just left (typed over, or dismissed with Escape)", async () => {
    const c = startController();
    type($("#first"), "Sam");
    await tabUntilAccepted(c, 1);
    expect($("#last").value).toBe("Chen");
    expect($("#first").value).toBe("Sam");
  });

  it("leaves Escape to the page while every ghost is off screen", () => {
    const c = startController();
    for (const input of document.querySelectorAll<HTMLElement>("#form input, #form select")) {
      vi.spyOn(input, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 5000, 200, 32));
    }
    expect(key("Escape").defaultPrevented).toBe(false);
    expect(c.state.ghosts).toHaveLength(5);
    expect(c.state.dismissed.size).toBe(0);
  });

  it("leaves Escape to the page while focus is in an unrelated control", () => {
    mountForm(WITH_SEARCH);
    const c = startController();
    $("#search").focus();
    expect(key("Escape").defaultPrevented).toBe(false);
    expect(c.state.ghosts).toHaveLength(5);
  });

  it("treats a collapsed (0x0) field as hidden once the document has real layout", async () => {
    const c = startController();
    vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1024, 768));
    const events = [key("Tab"), key("Escape")];
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.map((e) => e.defaultPrevented)).toEqual([false, false]);
    expect(c.state.accepted).toBe(0);
    expect($("#first").value).toBe("");
  });

  it("stays out of the way while something else covers the current field (sticky header, modal)", async () => {
    const c = startController();
    const header = document.createElement("header");
    document.body.prepend(header);
    vi.spyOn($("#first"), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 200, 32));
    const doc = document as Document & { elementFromPoint?: (x: number, y: number) => Element | null };
    doc.elementFromPoint = () => header;
    try {
      expect(key("Tab").defaultPrevented).toBe(false);
      doc.elementFromPoint = () => $("#first");
      await tabUntilAccepted(c, 1);
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  it("never lets the locked Submit become current while unlocked ghosts remain, even when it takes focus", async () => {
    const c = startController();
    $("#submit").focus();
    expect(currentId(c)).toBe("first");
    c.rescan();
    expect(currentId(c)).toBe("first");
    expect(host().getAttribute("data-ghost-current-locked")).toBe("false");
    expect(key("Tab").defaultPrevented).toBe(false); // on Submit, away from the walk: native, not a trap
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(submits + submitClicks).toBe(0);
  });

  it("keeps a held Tab once a press was queued mid-write", async () => {
    const c = startController();
    key("Tab");
    expect(key("Tab").defaultPrevented).toBe(true); // queued while the first write is in flight
    expect(key("Tab", { repeat: true }).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(c.state.accepted).toBe(2));
    expect(key("Tab", { repeat: true }).defaultPrevented).toBe(true); // the hold still belongs to Ghost
    await vi.waitFor(() => expect(c.state.accepted).toBe(3));
    releaseTab();
  });
});

describe("rule 9: what is already there stays", () => {
  it("offers nothing for a whitespace-only value, and a refused ghost does not come straight back", async () => {
    const c = startController();
    $("#last").value = " "; // appeared after the ghost was made, without any event
    await tabUntilAccepted(c, 1);
    key("Tab");
    await vi.waitFor(() => expect(currentId(c)).toBe("auth"));
    c.rescan();
    expect(c.state.ghosts.some((g) => g.signature.includes("|last|"))).toBe(false);
    expect($("#last").value).toBe(" ");
    await tabUntilAccepted(c, 2); // not trapped: the walk carries on
    expect($<HTMLSelectElement>("#auth").value).toBe("yes");
  });

  it("never re-offers a checkbox the user changed after Ghost ticked it", async () => {
    mountForm(`<form><label><input type="checkbox" id="visa" name="visa" /> I will require visa sponsorship</label>
      <label for="first">First name</label><input id="first" /></form>`);
    const profile = { facts: { requiresSponsorship: "yes", firstName: "Alex" }, pastAnswers: [] };
    const c = startController({ getProfile: () => profile });
    expect(c.state.ghosts.map((g) => [g.action, g.value])).toEqual([["check", "true"], ["fill", "Alex"]]);
    await tabUntilAccepted(c, 1);
    expect($("#visa").checked).toBe(true);
    $("#visa").checked = false; // the user changes their mind: a trusted input on a box that has no ghost any more
    $("#visa").dispatchEvent(new Event("input", { bubbles: true }));
    c.rescan();
    expect(c.state.ghosts.map((g) => g.action)).toEqual(["fill"]);
  });
});

describe("a new view is a new walk", () => {
  const INBOX = `<main><h1>Inbox</h1><button type="button" id="del">Delete all messages</button></main>`;

  afterEach(() => history.replaceState({}, "", "/"));

  async function acceptOne(): Promise<GhostController> {
    const c = startController();
    await tabUntilAccepted(c, 1);
    return c;
  }

  it("does not carry the lock ghost over to a locked button on the next SPA route", async () => {
    const c = await acceptOne();
    history.pushState({}, "", "/inbox");
    document.body.innerHTML = INBOX;
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.waitFor(() => expect(c.state.ghosts).toEqual([]), { timeout: 1500 });
    expect(c.state.accepted).toBe(0);
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe($("#del"));
    expect(document.querySelector("#ghost-overlay-host")?.getAttribute("data-ghost-state")).toBe("idle");
  });

  it("does not adopt a stranger's locked button when the view changes under the same URL", async () => {
    const c = await acceptOne();
    document.body.innerHTML = INBOX;
    await vi.waitFor(() => expect(c.state.ghosts).toEqual([]), { timeout: 1500 });
    expect(key("Tab").defaultPrevented).toBe(false);
  });

  it("starts from scratch after stop() and start()", async () => {
    const c = await acceptOne();
    c.stop();
    document.body.innerHTML = `<button type="submit" id="del">Delete account</button>`;
    c.start();
    expect(c.state.ghosts).toEqual([]);
    expect(c.state.accepted).toBe(0);
    expect(key("Tab").defaultPrevented).toBe(false);
  });

  it("keeps dismissals across an anchor jump or a query tweak, and forgets them on a real route change", async () => {
    const c = startController();
    key("Escape");
    expect(c.state.dismissed.size).toBe(1);
    history.replaceState({}, "", "/?utm=gone#apply");
    window.dispatchEvent(new Event("hashchange"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(c.state.dismissed.size).toBe(1);
    expect(c.state.ghosts).toHaveLength(4);
    history.pushState({}, "", "/step-2");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(c.state.dismissed.size).toBe(0);
    await vi.waitFor(() => expect(c.state.ghosts).toHaveLength(5), { timeout: 1500 });
  });
});

describe("stop", () => {
  it("removes the overlay and hands Tab back to the page", () => {
    const c = startController();
    c.stop();
    expect(document.querySelector("#ghost-overlay-host")).toBeNull();
    expect(document.querySelector("[data-ghost-hint]")).toBeNull();
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(c.state.ghosts).toEqual([]);
  });

  it("can start again afterwards", () => {
    const c = startController();
    c.stop();
    c.start();
    expect(c.state.ghosts).toHaveLength(5);
    expect(host().getAttribute("data-ghost-state")).toBe("ready");
  });
});

describe("HUD", () => {
  it("reports the offline provider and the keystrokes saved", async () => {
    const c = startController();
    await tabUntilAccepted(c, 1);
    const text = overlay.shadow.querySelector(".hud")?.textContent ?? "";
    expect(text).toContain("offline-heuristic");
    expect(text).toContain("offline");
    expect(text).toContain("4 keys");
  });

  it("stays hidden when the setting is off", () => {
    settings.showHud = false;
    startController();
    expect(overlay.shadow.querySelector(".hud")?.getAttribute("data-visible")).toBe("false");
    expect(host().shadowRoot).toBeNull(); // closed: the page cannot read ghost values or the HUD
  });
});
