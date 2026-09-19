// Stage 2 behaviour of the controller: offline first, then cache -> server once per form, the events
// other modules subscribe to, and the jump pill. Tab semantics themselves live in controller.test.ts.
import { DEFAULT_SETTINGS, DEMO_PROFILE, NONE } from "@ghost/shared";
import type { FormPredictRequest, GhostSettings, Profile } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSignature } from "../src/content/capture";
import { GhostController } from "../src/content/controller";
import type { ControllerDeps } from "../src/content/controller";
import { Overlay } from "../src/content/overlay";
import type { FormAnswer } from "../src/content/predict";
import { createEmitter } from "../src/lib/events";
import type { GhostEmitter, GhostEventMap, GhostEventType } from "../src/lib/events";
import type { ServedAssignment } from "../src/lib/messages";

const FORM = `
  <form id="form">
    <label for="first">First name</label><input id="first" name="firstName" />
    <label for="last">Last name</label><input id="last" name="lastName" />
    <label for="work">Where can we see your work?</label><input id="work" name="work" />
    <label for="sin">Social Insurance Number</label><input id="sin" name="sin" />
    <label for="pw">Payroll password</label><input id="pw" name="payrollPassword" type="password" />
    <button type="submit" id="submit">Submit application</button>
  </form>`;

let controller: GhostController | null = null;
let overlay: Overlay;
let settings: GhostSettings;
let profile: Profile;
let events: GhostEmitter;

function $<T extends HTMLElement = HTMLInputElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`fixture is missing ${selector}`);
  return el;
}

function start(extra: Partial<ControllerDeps> = {}): GhostController {
  overlay = new Overlay(document);
  controller = new GhostController({
    overlay, events,
    getProfile: () => profile,
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

async function tabUntilAccepted(c: GhostController, accepted: number): Promise<void> {
  key("Tab");
  await vi.waitFor(() => expect(c.state.accepted).toBe(accepted));
}

const host = (): HTMLElement => $<HTMLElement>("#ghost-overlay-host");
const hudText = (): string => overlay.shadow.querySelector(".hud")?.textContent ?? "";
const values = (c: GhostController): Array<string | undefined> => c.state.ghosts.map((g) => g.value);
const sig = (selector: string): string => computeSignature($(selector));
const jev = (selector: string, factKey: string, confidence = 0.96): ServedAssignment =>
  ({ signature: sig(selector), factKey, confidence, source: "jev-gateway", calibrated: true });
const answer = (assignments: ServedAssignment[], extra: Partial<FormAnswer> = {}): FormAnswer =>
  ({ assignments, provider: "jev-gateway", cache: "miss", latencyMs: 142, ...extra });

/** A predictor the test resolves by hand, like a server that takes its time. */
function deferredPredictor() {
  const resolvers: Array<(value: FormAnswer | null) => void> = [];
  const predictForm = vi.fn((_request: FormPredictRequest) => new Promise<FormAnswer | null>((resolve) => resolvers.push(resolve)));
  const resolve = async (value: FormAnswer | null, call = resolvers.length - 1): Promise<void> => {
    resolvers[call]?.(value);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { predictForm, resolve };
}

function record<K extends GhostEventType>(type: K): Array<GhostEventMap[K]> {
  const seen: Array<GhostEventMap[K]> = [];
  events.on(type, (payload) => void seen.push(payload));
  return seen;
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS };
  profile = DEMO_PROFILE;
  events = createEmitter();
  document.body.innerHTML = FORM;
});

afterEach(() => {
  controller?.stop();
  controller = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("prediction pipeline", () => {
  it("shows the offline ghosts instantly, before the predictor has said anything", () => {
    const { predictForm } = deferredPredictor();
    const c = start({ predictForm });
    expect(values(c)).toEqual(["Alex", "Chen", undefined]);
    expect(c.state.ghosts.every((g) => g.source === "offline")).toBe(true);
    expect(predictForm).toHaveBeenCalledTimes(1);
    expect(hudText()).toContain("offline-heuristic");
  });

  it("upgrades the list when assignments arrive and reports provider, latency and a cache miss", async () => {
    const { predictForm, resolve } = deferredPredictor();
    const c = start({ predictForm });
    await resolve(answer([jev("#first", "firstName"), jev("#last", "lastName"), jev("#work", "github", 0.93)]));
    expect(values(c)).toEqual(["Alex", "Chen", "https://github.com/alexchen-dev", undefined]);
    expect(c.state.ghosts.slice(0, 3).every((g) => g.source === "server")).toBe(true);
    expect(c.state.currentIndex).toBe(0);
    expect(hudText()).toContain("jev-gateway");
    expect(hudText()).toContain("142 ms");
    expect(hudText()).toContain("miss");
    expect(host().getAttribute("data-ghost-count")).toBe("4");
  });

  it("reports a cache hit and marks the ghosts as cached", async () => {
    const { predictForm, resolve } = deferredPredictor();
    const c = start({ predictForm });
    await resolve(answer([jev("#work", "github")], { cache: "hit", latencyMs: 3 }));
    expect(c.state.ghosts.find((g) => g.signature === sig("#work"))?.source).toBe("cache");
    expect(hudText()).toContain("hit");
    expect(overlay.shadow.querySelector(".item.cache")?.getAttribute("data-cache")).toBe("hit");
  });

  it("sends field descriptions and fact KEYS only: no value, no sensitive field, no button", () => {
    $("#work").value = "typed by the user";
    const { predictForm } = deferredPredictor();
    start({ predictForm });
    const request = predictForm.mock.calls[0]?.[0];
    expect(request?.fields.map((f) => f.label)).toEqual(["First name", "Last name", "Where can we see your work?"]);
    expect(request?.factKeys).toEqual(Object.keys(DEMO_PROFILE.facts));
    expect(request?.formSignature).toMatch(/^form-3-/);
    const raw = JSON.stringify(request);
    expect(raw).not.toContain("typed by the user");
    for (const value of Object.values(DEMO_PROFILE.facts)) if (value.length > 3) expect(raw).not.toContain(value);
  });

  it("leaves the ghost the user is on alone, and never moves focus", async () => {
    const { predictForm, resolve } = deferredPredictor();
    const c = start({ predictForm });
    $("#last").focus();
    expect(c.state.ghosts[c.state.currentIndex]?.value).toBe("Chen");
    await resolve(answer([jev("#first", "fullName"), jev("#last", "fullName"), jev("#work", "github")]));
    expect(values(c)).toEqual(["Alex Chen", "Chen", "https://github.com/alexchen-dev", undefined]);
    expect(c.state.ghosts[c.state.currentIndex]?.value).toBe("Chen");
    expect(document.activeElement).toBe($("#last"));
    c.rescan();
    expect(c.state.ghosts[c.state.currentIndex]?.value).toBe("Chen"); // still pinned on later rescans
  });

  it("leaves a current ghost alone once it has been on screen long enough to be read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { predictForm, resolve } = deferredPredictor();
      const c = start({ predictForm });
      vi.setSystemTime(Date.now() + 2000); // a slow server: the user is about to press Tab on what they see
      await resolve(answer([jev("#first", "fullName")]));
      expect(values(c)[0]).toBe("Alex");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not bring back fields the user accepted, typed over or dismissed", async () => {
    const { predictForm, resolve } = deferredPredictor();
    const c = start({ predictForm });
    await tabUntilAccepted(c, 1); // first name accepted
    const last = $("#last");
    last.value = "Smith";
    last.dispatchEvent(new Event("input", { bubbles: true })); // typed over
    await resolve(answer([jev("#first", "fullName"), jev("#last", "lastName"), jev("#work", "github")]));
    expect($("#first").value).toBe("Alex");
    expect(last.value).toBe("Smith");
    expect(values(c)).toEqual(["https://github.com/alexchen-dev", undefined]);
  });

  it("lets the server remove a ghost the offline mapper got wrong", async () => {
    const { predictForm, resolve } = deferredPredictor();
    const c = start({ predictForm });
    await resolve(answer([jev("#last", NONE, 0.98)]));
    expect(values(c)).toEqual(["Alex", undefined]);
  });

  it("asks once per form signature per page load, never on every rescan", async () => {
    const { predictForm, resolve } = deferredPredictor();
    const c = start({ predictForm });
    c.rescan();
    c.rescan();
    await resolve(answer([jev("#work", "github")]));
    c.rescan();
    expect(predictForm).toHaveBeenCalledTimes(1);

    $("#form").insertAdjacentHTML("afterbegin", `<label for="school">School</label><input id="school" name="school" />`);
    c.rescan();
    c.rescan();
    expect(predictForm).toHaveBeenCalledTimes(2); // a different form is a different question
    expect(predictForm.mock.calls[1]?.[0].formSignature).not.toBe(predictForm.mock.calls[0]?.[0].formSignature);
    expect(values(c)).toContain("https://github.com/alexchen-dev"); // earlier answers still apply meanwhile
  });

  it("caps the number of forms it asks about on one page", () => {
    const { predictForm } = deferredPredictor();
    const c = start({ predictForm });
    for (let i = 0; i < 12; i++) {
      $("#form").insertAdjacentHTML("afterbegin", `<label for="x${i}">Question ${i}</label><input id="x${i}" name="x${i}" />`);
      c.rescan();
    }
    expect(predictForm.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("stays offline, silently, when the server is down or the predictor fails", async () => {
    const down = vi.fn(async () => null);
    const c = start({ predictForm: down });
    await Promise.resolve();
    expect(values(c)).toEqual(["Alex", "Chen", undefined]);
    expect(c.state.error).toBeNull();
    expect(hudText()).toContain("offline-heuristic");
    c.stop();

    const broken = vi.fn(async () => Promise.reject(new Error("Extension context invalidated")));
    const again = start({ predictForm: broken });
    await Promise.resolve();
    expect(values(again)).toEqual(["Alex", "Chen", undefined]);
    expect(again.state.error).toBeNull();
  });

  it("re-gates live when the confidence threshold changes, without asking again", async () => {
    const { predictForm, resolve } = deferredPredictor();
    const c = start({ predictForm });
    await resolve(answer([jev("#work", "github", 0.75)]));
    expect(values(c)).toContain("https://github.com/alexchen-dev");
    settings = { ...settings, confidenceThreshold: 0.8 };
    c.rescan(); // what the content script does on a storage change
    expect(values(c)).toEqual(["Alex", "Chen", undefined]);
    settings = { ...settings, confidenceThreshold: 0.99 };
    c.rescan();
    expect(values(c)).toEqual([]);
    settings = { ...settings, confidenceThreshold: 0.7 };
    c.rescan();
    expect(values(c)).toContain("https://github.com/alexchen-dev");
    expect(predictForm).toHaveBeenCalledTimes(1);
  });

  it("asks again when the fact key set changes, and forgets the old answers", async () => {
    const { predictForm, resolve } = deferredPredictor();
    const c = start({ predictForm });
    await resolve(answer([jev("#work", "github")]));
    const { github: _dropped, ...facts } = DEMO_PROFILE.facts;
    profile = { facts, pastAnswers: [] };
    c.rescan();
    expect(predictForm).toHaveBeenCalledTimes(2);
    expect(predictForm.mock.calls[1]?.[0].factKeys).not.toContain("github");
    expect(values(c)).toEqual(["Alex", "Chen", undefined]);
    expect(hudText()).toContain("offline-heuristic");
  });

  it("ignores an answer that arrives after Ghost was switched off", async () => {
    const { predictForm, resolve } = deferredPredictor();
    const c = start({ predictForm });
    c.stop();
    await resolve(answer([jev("#work", "github")]));
    expect(c.state.ghosts).toEqual([]);
    expect(document.getElementById("ghost-overlay-host")).toBeNull();
  });

  it("does not spend a call on a lone box it has nothing to offer for (a search field)", () => {
    document.body.innerHTML = `<form><label for="q">Search jobs</label><input id="q" name="q" /></form>`;
    const { predictForm } = deferredPredictor();
    start({ predictForm });
    expect(predictForm).not.toHaveBeenCalled();
  });
});

describe("events", () => {
  it("fires ghosts:shown once per new ghost, with where they came from", async () => {
    const shown = record("ghosts:shown");
    const { predictForm, resolve } = deferredPredictor();
    const c = start({ predictForm });
    c.rescan();
    expect(shown).toEqual([{ count: 2, source: "offline" }]);
    await resolve(answer([jev("#first", "firstName"), jev("#work", "github")]));
    expect(shown).toEqual([{ count: 2, source: "offline" }, { count: 1, source: "server" }]);
  });

  it("fires ghost:accepted with the ghost, its captured field and the write time", async () => {
    const accepted = record("ghost:accepted");
    const c = start();
    await tabUntilAccepted(c, 1);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.ghost.value).toBe("Alex");
    expect(accepted[0]?.field.label).toBe("First name");
    expect(accepted[0]?.field.signature).toBe(accepted[0]?.ghost.signature);
    expect(accepted[0]?.ms).toBeGreaterThanOrEqual(0);
  });

  it("fires ghost:dismissed with the reason: escape, typed, refused", async () => {
    const dismissed = record("ghost:dismissed");
    const c = start();
    key("Escape");
    const last = $("#last");
    last.focus();
    last.value = "S";
    last.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dismissed.map((d) => [d.ghost.value, d.reason])).toEqual([["Alex", "escape"], ["Chen", "typed"]]);
    c.stop();

    document.body.innerHTML = FORM;
    const again = start();
    $("#first").value = "Sam"; // appeared after the ghost was made: the write is refused
    key("Tab");
    await vi.waitFor(() => expect(dismissed).toHaveLength(3));
    expect(dismissed[2]?.reason).toBe("refused");
    expect(again.state.accepted).toBe(0);
  });

  it("fires walk:finished once the walk has nothing unlocked left", async () => {
    const finished = record("walk:finished");
    const c = start();
    await tabUntilAccepted(c, 1);
    expect(finished).toHaveLength(0);
    await tabUntilAccepted(c, 2);
    expect(finished).toHaveLength(1);
    key("Tab"); // parked on the lock: over-pressing does not finish twice
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finished).toHaveLength(1);
  });

  describe("user:input", () => {
    function typeInto(el: HTMLInputElement, text: string): void {
      el.focus();
      for (const char of text) {
        el.value += char;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    it("fires once per committed edit, never per keystroke", () => {
      const inputs = record("user:input");
      start();
      const work = $("#work");
      typeInto(work, "alexchen.dev");
      expect(inputs).toHaveLength(0);
      work.dispatchEvent(new Event("change", { bubbles: true }));
      work.blur();
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.value).toBe("alexchen.dev");
      expect(inputs[0]?.field.label).toBe("Where can we see your work?");
      expect(inputs[0]?.el).toBe(work);
    });

    it("also fires on blur when the page swallowed the change event", () => {
      const inputs = record("user:input");
      start();
      typeInto($("#work"), "x");
      $("#work").blur();
      $("#work").focus();
      $("#work").blur(); // nothing edited this time
      expect(inputs.map((i) => i.value)).toEqual(["x"]);
    });

    it("never fires for a sensitive field", () => {
      const inputs = record("user:input");
      start();
      for (const id of ["#sin", "#pw"]) {
        typeInto($(id), "123456789");
        $(id).dispatchEvent(new Event("change", { bubbles: true }));
        $(id).blur();
      }
      expect(inputs).toHaveLength(0);
    });

    it("does not report a chosen file", () => {
      $("#form").insertAdjacentHTML("afterbegin", `<label for="cv">Resume</label><input id="cv" name="cv" type="file" />`);
      const inputs = record("user:input");
      start();
      $("#cv").dispatchEvent(new Event("change", { bubbles: true }));
      expect(inputs).toHaveLength(0);
    });

    it("never fires for Ghost's own writes or for script-made changes", async () => {
      const inputs = record("user:input");
      const c = start({ isUserEvent: (event) => event.type === "keydown" });
      await tabUntilAccepted(c, 1);
      $("#work").value = "set by the page";
      $("#work").dispatchEvent(new Event("input", { bubbles: true }));
      $("#work").dispatchEvent(new Event("change", { bubbles: true }));
      expect(inputs).toHaveLength(0);
    });
  });
});

describe("jump pill", () => {
  const BELOW = 5000;

  function placeAll(y: number): void {
    vi.restoreAllMocks();
    for (const el of document.querySelectorAll<HTMLElement>("#form input, #form button")) {
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(0, y, 200, 32));
      el.scrollIntoView = vi.fn();
    }
  }

  it("appears when ghosts are ready, the current one is off screen and focus is on the body", () => {
    placeAll(BELOW);
    start();
    expect(host().getAttribute("data-ghost-jump")).toBe("true");
    const pill = overlay.shadow.querySelector(".jump");
    expect(pill?.getAttribute("data-visible")).toBe("true");
    expect(pill?.getAttribute("data-direction")).toBe("down");
    expect(pill?.textContent).toContain("2 ghosts ready");
  });

  it("points up when the form is above the viewport", () => {
    placeAll(-BELOW);
    start();
    expect(overlay.shadow.querySelector(".jump")?.getAttribute("data-direction")).toBe("up");
  });

  it("is absent while the current ghost is on screen", () => {
    placeAll(100);
    start();
    expect(host().getAttribute("data-ghost-jump")).toBe("false");
  });

  it("Tab jumps: scrolls to the current ghost and focuses it WITHOUT filling anything", async () => {
    placeAll(BELOW);
    const c = start();
    const event = key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($("#first"));
    expect($("#first").scrollIntoView).toHaveBeenCalled();
    expect($("#first").value).toBe("");
    expect(c.state.accepted).toBe(0);
    expect(c.state.ghosts).toHaveLength(3);
    expect(host().getAttribute("data-ghost-jump")).toBe("false"); // focus is in the form now

    placeAll(100); // the scroll brought the form on screen
    await tabUntilAccepted(c, 1);
    expect($("#first").value).toBe("Alex");
  });

  it("a held Tab that started on the pill never starts filling", async () => {
    placeAll(BELOW);
    const c = start();
    key("Tab");
    placeAll(100);
    const repeats = [key("Tab", { repeat: true }), key("Tab", { repeat: true }), key("Tab", { repeat: true })];
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(repeats.every((event) => event.defaultPrevented)).toBe(true); // focus must not race off natively either
    expect(c.state.accepted).toBe(0);
    expect($("#first").value).toBe("");
  });

  it("leaves Tab native when focus is anywhere but the body", async () => {
    document.body.insertAdjacentHTML("afterbegin", `<input id="search" aria-label="Search the site" />`);
    placeAll(BELOW);
    const c = start();
    $("#search").focus();
    expect(host().getAttribute("data-ghost-jump")).toBe("false");
    const event = key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(event.defaultPrevented).toBe(false);
    expect(c.state.accepted).toBe(0);
    expect(document.activeElement).toBe($("#search"));
  });

  it("leaves Tab native while the pill has not been drawn, even if the ghost just went off screen", async () => {
    placeAll(100);
    const c = start();
    placeAll(BELOW); // no render has happened since: nothing visible says "Tab to jump"
    const event = key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(event.defaultPrevented).toBe(false);
    expect(c.state.accepted).toBe(0);
  });

  it("Escape puts the pill away for this page, still reaches the page, and dismisses no ghost", async () => {
    placeAll(BELOW);
    const c = start();
    const escape = key("Escape");
    expect(escape.defaultPrevented).toBe(false);
    expect(host().getAttribute("data-ghost-jump")).toBe("false");
    expect(c.state.ghosts).toHaveLength(3);
    expect(c.state.dismissed.size).toBe(0);
    const tab = key("Tab");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(tab.defaultPrevented).toBe(false);
    c.rescan();
    expect(host().getAttribute("data-ghost-jump")).toBe("false");
  });

  it("is not offered for the locked Submit", async () => {
    placeAll(100);
    const c = start();
    await tabUntilAccepted(c, 1);
    await tabUntilAccepted(c, 2);
    placeAll(BELOW);
    ($("#submit") as HTMLElement).blur();
    c.rescan();
    expect(c.state.ghosts.map((g) => g.locked)).toEqual([true]);
    expect(host().getAttribute("data-ghost-jump")).toBe("false");
  });
});
