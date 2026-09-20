// Stage 3 behaviour of the controller: essay fields draft speculatively in the background, the ghost grows
// as deltas stream in, Tab accepts the whole draft (waiting for the rest if it must), typing and Esc abort.
import { DEFAULT_SETTINGS, DEMO_PROFILE } from "@ghost/shared";
import type { GhostSettings, Profile } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSignature } from "../src/content/capture";
import { DRAFT_WAIT_MS, GhostController } from "../src/content/controller";
import type { ControllerDeps } from "../src/content/controller";
import { DraftScheduler } from "../src/content/freeText";
import type { OpenTextStream } from "../src/content/freeText";
import { Overlay } from "../src/content/overlay";
import { TAB_KEYS } from "./keys-port";
import { createEmitter } from "../src/lib/events";
import type { GhostEmitter, GhostEventMap } from "../src/lib/events";
import type { GhostTextRequest, TextPortEvent } from "../src/lib/messages";

const PAGE = `
  <main>
    <section data-testid="job-description">
      <h1>Software Engineering Intern</h1>
      <h2>About Northwind Robotics</h2>
      <p>Northwind Robotics builds autonomous mobile robots that move inventory through warehouses and hospitals.</p>
    </section>
    <form id="form">
      <label for="first">First name</label><input id="first" name="firstName" />
      <label for="last">Last name</label><input id="last" name="lastName" />
      <label for="why">Why Northwind?</label><textarea id="why" name="why"></textarea>
      <label for="project">Tell us about a project you are proud of</label><textarea id="project" name="project" maxlength="60"></textarea>
      <label for="tiny">Describe yourself in a word</label><textarea id="tiny" name="tiny" maxlength="10"></textarea>
      <label for="notes">Additional information</label><textarea id="notes" name="notes"></textarea>
      <label for="answer">Explain your security question answer</label><textarea id="answer" name="securityAnswer"></textarea>
      <button type="submit" id="submit">Submit application</button>
    </form>
  </main>`;

const WHY_DRAFT = "I want to build robots that people can rely on. Northwind ships them.";

let controller: GhostController | null = null;
let overlay: Overlay;
let settings: GhostSettings;
let profile: Profile;
let events: GhostEmitter;
let submits = 0;

interface Opened {
  request: GhostTextRequest;
  emit(event: TextPortEvent): void;
  aborted: boolean;
}

function fakeWorker() {
  const opened: Opened[] = [];
  const open: OpenTextStream = (request, onEvent) => {
    const stream: Opened = { request, emit: onEvent, aborted: false };
    opened.push(stream);
    return { abort: () => void (stream.aborted = true) };
  };
  const streamFor = (selector: string): Opened => {
    const stream = opened.find((s) => s.request.fieldSignature === sig(selector));
    if (!stream) throw new Error(`no draft was requested for ${selector}`);
    return stream;
  };
  return { open, opened, streamFor };
}

function $<T extends HTMLElement = HTMLInputElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`fixture is missing ${selector}`);
  return el;
}

const sig = (selector: string): string => computeSignature($(selector));
const done = (text: string, provider = "template"): TextPortEvent => ({ type: "done", text, provider, latencyMs: 4, firstTokenMs: 1 });
const delta = (text: string): TextPortEvent => ({ type: "delta", delta: text });
const ghostFor = (c: GhostController, selector: string) => c.state.ghosts.find((g) => g.signature === sig(selector));
const nodeFor = (selector: string): Element | null =>
  Array.from(overlay.shadow.querySelectorAll(".ghost")).find((node) => node.getAttribute("data-signature") === sig(selector)) ?? null;

function start(worker: ReturnType<typeof fakeWorker>, extra: Partial<ControllerDeps> = {}): GhostController {
  overlay = new Overlay(document);
  controller = new GhostController({
    overlay, events,
    getProfile: () => profile,
    getSettings: () => settings,
    isUserEvent: () => true, // jsdom cannot mint trusted events
    // Tab, pinned: this file is about the walk, not about which key an origin takes (docs/accept-key.md).
    keys: TAB_KEYS,
    drafts: new DraftScheduler({ open: worker.open }),
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

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function tabUntilAccepted(c: GhostController, accepted: number): Promise<KeyboardEvent> {
  const event = key("Tab");
  await vi.waitFor(() => expect(c.state.accepted).toBe(accepted));
  return event;
}

/** Accepts the two name fields; the walk then stands on the first essay ghost (or the Submit lock). */
async function fillNames(c: GhostController): Promise<void> {
  await tabUntilAccepted(c, 1);
  await tabUntilAccepted(c, 2);
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS };
  profile = DEMO_PROFILE;
  events = createEmitter();
  submits = 0;
  document.body.innerHTML = PAGE;
  $<HTMLFormElement>("#form").addEventListener("submit", (event) => {
    event.preventDefault();
    submits++;
  });
});

afterEach(() => {
  controller?.stop();
  controller = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("speculative generation", () => {
  it("starts every essay field at once on the first scan, before any Tab, and only once however often it rescans", () => {
    const worker = fakeWorker();
    const c = start(worker);
    expect(worker.opened.map((s) => s.request.fieldLabel)).toEqual(["Why Northwind?", "Tell us about a project you are proud of"]);
    expect(c.state.accepted).toBe(0);
    for (let i = 0; i < 4; i++) c.rescan();
    expect(worker.opened).toHaveLength(2);
    // Nothing is offered before there is text, so the ghost list is what Stage 1 showed.
    expect(c.state.ghosts.map((g) => g.value)).toEqual(["Alex", "Chen", undefined]);
  });

  it("skips what should not be drafted: a generic textarea, a maxlength too small for prose, a sensitive field", () => {
    const worker = fakeWorker();
    start(worker);
    const asked = worker.opened.map((s) => s.request.fieldLabel).join("|");
    expect(asked).not.toMatch(/Additional information|in a word|security/i);
  });

  it("sends page context and the allowlisted facts, and never email, phone or work authorization", () => {
    const worker = fakeWorker();
    start(worker);
    const { request } = worker.streamFor("#why");
    expect(request.pageContext).toMatchObject({ company: "Northwind Robotics", role: "Software Engineering Intern" });
    expect(request.pageContext.description).toContain("autonomous mobile robots");
    expect(Object.keys(request.facts).sort()).toEqual(["degree", "firstName", "fullName", "github", "graduationDate", "lastName", "location", "major", "school", "website"]);
    expect(JSON.stringify(worker.opened.map((s) => s.request))).not.toMatch(/example\.com|555 0142|workAuthorization|requiresSponsorship|linkedin/);
    expect(worker.streamFor("#project").request.maxChars).toBe(60);
    expect(worker.streamFor("#why").request).not.toHaveProperty("maxChars");
  });

  it("still drafts when the user's threshold is above the fixed draft confidence", () => {
    // docs/always-propose.md: the threshold styles a proposal, it never cancels the work that makes one.
    settings = { ...DEFAULT_SETTINGS, confidenceThreshold: 0.85 };
    const worker = fakeWorker();
    const c = start(worker);
    expect(worker.opened.length).toBeGreaterThan(0);
    for (const ghost of c.state.ghosts.filter((g) => g.source === "llm")) {
      expect(ghost.tier).toBe("long-shot");
      expect(ghost.guess).toBe(true);
    }
  });

  it("stays on the Stage 1 ghosts when the server cannot be reached", () => {
    const worker = fakeWorker();
    const c = start(worker);
    for (const stream of worker.opened) stream.emit({ type: "error", error: "server unreachable" });
    expect(c.state.ghosts).toHaveLength(3);
    expect(c.state.error).toBeNull();
    expect(overlay.host.getAttribute("data-ghost-count")).toBe("3");
    expect(overlay.host.hasAttribute("data-ghost-error")).toBe(false);
  });

  it("stops every stream and forgets the drafts when Ghost is switched off", () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    c.stop();
    expect(worker.opened.every((s) => s.aborted)).toBe(true);
    worker.streamFor("#why").emit(done(WHY_DRAFT)); // a stream that talks after its port closed changes nothing
    expect(c.state.ghosts).toEqual([]);
  });
});

describe("the draft ghost", () => {
  it("appears in DOM order with the first delta, grows with each one, and stops being pending when the stream is done", async () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    expect(c.state.ghosts.map((g) => g.signature)).toEqual([sig("#first"), sig("#last"), sig("#why"), sig("#submit")]);
    expect(ghostFor(c, "#why")).toMatchObject({ action: "fill", source: "llm", pending: true, confidence: 0.8, locked: false, displayText: "I want " });
    expect(c.state.currentIndex).toBe(0); // a draft arriving never moves the walk
    expect(nodeFor("#why")?.getAttribute("data-mode")).toBe("multiline");
    expect(nodeFor("#why")?.getAttribute("data-streaming")).toBe("true");

    worker.streamFor("#why").emit(delta("to build robots"));
    expect(ghostFor(c, "#why")?.displayText).toBe("I want to build robots");
    await vi.waitFor(() => expect(nodeFor("#why")?.querySelector(".label")?.textContent).toBe("I want to build robots"));

    worker.streamFor("#why").emit(done(WHY_DRAFT));
    expect(ghostFor(c, "#why")).toMatchObject({ value: WHY_DRAFT, displayText: WHY_DRAFT });
    expect(ghostFor(c, "#why")?.pending).toBeUndefined();
    expect(nodeFor("#why")?.querySelector(".label")?.textContent).toBe(WHY_DRAFT);
    expect(nodeFor("#why")?.hasAttribute("data-streaming")).toBe(false);
  });

  it("does not re-capture the page for every token: one rescan when the ghost joins, none for later deltas", () => {
    const worker = fakeWorker();
    const c = start(worker);
    const rescan = vi.spyOn(c, "rescan");
    worker.streamFor("#why").emit(delta("I "));
    for (let i = 0; i < 25; i++) worker.streamFor("#why").emit(delta("really "));
    worker.streamFor("#why").emit(done(WHY_DRAFT));
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it("Tab accepts the whole finished draft, counts its keystrokes and reports it as an llm ghost", async () => {
    const worker = fakeWorker();
    const c = start(worker);
    const accepted: Array<GhostEventMap["ghost:accepted"]> = [];
    events.on("ghost:accepted", (payload) => void accepted.push(payload));
    worker.streamFor("#why").emit(delta("I want "));
    worker.streamFor("#why").emit(done(WHY_DRAFT));
    await fillNames(c);
    expect(document.activeElement).toBe($("#why"));
    const tab = await tabUntilAccepted(c, 3);
    expect(tab.defaultPrevented).toBe(true);
    expect($<HTMLTextAreaElement>("#why").value).toBe(WHY_DRAFT);
    expect(c.state.keystrokesSaved).toBe("Alex".length + "Chen".length + WHY_DRAFT.length);
    expect(accepted.at(-1)?.ghost).toMatchObject({ source: "llm", value: WHY_DRAFT });
    expect(submits).toBe(0);
  });

  it("respects maxlength: the ghost and the filled text are cut back to a whole sentence inside the limit", async () => {
    const worker = fakeWorker();
    const c = start(worker);
    const long = "I built a telemetry replayer for robots. It cut the time to reproduce navigation bugs from days to minutes.";
    worker.streamFor("#project").emit(delta(long));
    expect(ghostFor(c, "#project")?.displayText.length).toBeLessThanOrEqual(60);
    worker.streamFor("#project").emit(done(long));
    expect(ghostFor(c, "#project")?.value).toBe("I built a telemetry replayer for robots.");
    worker.streamFor("#why").emit({ type: "error", error: "stream ended early" });
    await fillNames(c);
    await tabUntilAccepted(c, 3);
    expect($<HTMLTextAreaElement>("#project").value).toBe("I built a telemetry replayer for robots.");
  });

  it("takes a half-written ghost away again when its stream fails", () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    expect(ghostFor(c, "#why")).toBeDefined();
    worker.streamFor("#why").emit({ type: "error", error: "stream ended early" });
    expect(ghostFor(c, "#why")).toBeUndefined();
    expect(c.state.error).toBeNull();
  });

  it("template drafts take the same path: deltas, then done, provider shown in the HUD with both latencies", () => {
    const worker = fakeWorker();
    let now = 0;
    const c = start(worker, { drafts: new DraftScheduler({ open: worker.open, now: () => now }) });
    expect(overlay.shadow.querySelector(".hud-text")?.hasAttribute("hidden")).toBe(true);
    now = 12;
    worker.streamFor("#why").emit(delta("I want "));
    now = 48;
    worker.streamFor("#why").emit(done(WHY_DRAFT, "template"));
    expect(ghostFor(c, "#why")?.source).toBe("llm");
    const row = overlay.shadow.querySelector(".hud-text");
    expect(row?.hasAttribute("hidden")).toBe(false);
    expect(row?.textContent).toContain("template");
    expect(row?.textContent).toContain("12 ms");
    expect(row?.textContent).toContain("48 ms");
  });
});

describe("Tab while the draft is still streaming", () => {
  it("waits for the rest, shimmering, then fills the FINAL text; never the half that was on screen", async () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    await fillNames(c);
    const tab = key("Tab");
    expect(tab.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(nodeFor("#why")?.getAttribute("data-waiting")).toBe("true"));
    expect($<HTMLTextAreaElement>("#why").value).toBe("");
    expect(c.state.accepted).toBe(2);

    worker.streamFor("#why").emit(delta("to build"));
    worker.streamFor("#why").emit(done(WHY_DRAFT));
    await vi.waitFor(() => expect(c.state.accepted).toBe(3));
    expect($<HTMLTextAreaElement>("#why").value).toBe(WHY_DRAFT);
    expect(overlay.shadow.querySelector('[data-waiting="true"]')).toBeNull();
  });

  it("gives up after four seconds without writing anything; a later Tab on the finished draft fills it", async () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    await fillNames(c);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    key("Tab");
    await vi.advanceTimersByTimeAsync(DRAFT_WAIT_MS - 1);
    expect(nodeFor("#why")?.getAttribute("data-waiting")).toBe("true");
    await vi.advanceTimersByTimeAsync(2);
    vi.useRealTimers();
    await vi.waitFor(() => expect(nodeFor("#why")?.hasAttribute("data-waiting")).toBe(false));
    expect($<HTMLTextAreaElement>("#why").value).toBe("");
    expect(ghostFor(c, "#why")?.pending).toBe(true);
    expect(c.state.error).toBeNull();

    worker.streamFor("#why").emit(done(WHY_DRAFT));
    await tabUntilAccepted(c, 3);
    expect($<HTMLTextAreaElement>("#why").value).toBe(WHY_DRAFT);
  });

  it("Escape during the wait cancels it: the draft is dismissed, its stream aborted, nothing is written", async () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    await fillNames(c);
    key("Tab");
    await vi.waitFor(() => expect(nodeFor("#why")?.getAttribute("data-waiting")).toBe("true"));
    expect(key("Escape").defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(ghostFor(c, "#why")).toBeUndefined());
    expect(worker.streamFor("#why").aborted).toBe(true);
    worker.streamFor("#why").emit(done(WHY_DRAFT));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect($<HTMLTextAreaElement>("#why").value).toBe("");
    expect(c.state.dismissed.has(sig("#why"))).toBe(true);
  });

  it("typing during the wait wins: the user's text stays and the draft never lands on top of it", async () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    await fillNames(c);
    key("Tab");
    await vi.waitFor(() => expect(nodeFor("#why")?.getAttribute("data-waiting")).toBe("true"));
    type($<HTMLTextAreaElement>("#why"), "My own words");
    worker.streamFor("#why").emit(done(WHY_DRAFT));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect($<HTMLTextAreaElement>("#why").value).toBe("My own words");
    expect(worker.streamFor("#why").aborted).toBe(true);
    expect(c.state.accepted).toBe(2);
  });

  it("a held Tab never accepts a pending draft: the hold stops there, swallowed, without starting a wait", async () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    await tabUntilAccepted(c, 1);
    key("Tab", { repeat: true });
    await vi.waitFor(() => expect(c.state.accepted).toBe(2));
    for (let i = 0; i < 6; i++) expect(key("Tab", { repeat: true }).defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(nodeFor("#why")?.hasAttribute("data-waiting")).toBe(false);
    expect($<HTMLTextAreaElement>("#why").value).toBe("");
    // Even a draft that finishes mid-hold waits for a fresh, deliberate press.
    worker.streamFor("#why").emit(done(WHY_DRAFT));
    expect(key("Tab", { repeat: true }).defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect($<HTMLTextAreaElement>("#why").value).toBe("");
    document.activeElement?.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
    await tabUntilAccepted(c, 3);
    expect($<HTMLTextAreaElement>("#why").value).toBe(WHY_DRAFT);
  });

  it("a held Tab stops at a finished draft, and a fresh press takes it", async () => {
    // A draft is written FOR the user, not known about them: 0.8 is under the confident tier, so the hold
    // stops there and asks to be read before Submit (docs/always-propose.md, docs/answers.md section 3).
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(done(WHY_DRAFT));
    worker.streamFor("#project").emit({ type: "error", error: "stream ended early" });
    await tabUntilAccepted(c, 1);
    const draft = c.state.ghosts.find((g) => g.source === "llm");
    expect(draft).toMatchObject({ tier: "guess", guess: true });

    for (let i = 0; i < 6; i++) key("Tab", { repeat: true });
    // However long the hold runs, it never writes the draft: it parks on it so the user reads it first.
    await vi.waitFor(() => expect(c.state.ghosts.some((g) => g.source === "llm")).toBe(true));
    expect($<HTMLTextAreaElement>("#why").value).toBe("");

    // The user looked, then pressed Tab themselves: the whole draft lands, and the walk parks on Submit.
    document.activeElement?.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
    for (let i = 0; i < 4 && c.state.ghosts.some((g) => !g.locked); i++) {
      const before = c.state.accepted;
      key("Tab");
      await vi.waitFor(() => expect(c.state.accepted).toBeGreaterThan(before));
    }
    expect($<HTMLTextAreaElement>("#why").value).toBe(WHY_DRAFT);
    expect(c.state.ghosts.map((g) => g.locked)).toEqual([true]);
    expect(submits).toBe(0);
  });
});

describe("typing and Escape", () => {
  it("typing over a streaming draft dismisses the ghost and aborts that field's stream only", () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    worker.streamFor("#project").emit(delta("I built "));
    type($<HTMLTextAreaElement>("#why"), "N");
    expect(ghostFor(c, "#why")).toBeUndefined();
    expect(worker.streamFor("#why").aborted).toBe(true);
    expect(worker.streamFor("#project").aborted).toBe(false);
    expect(ghostFor(c, "#project")).toBeDefined();
    worker.streamFor("#why").emit(done(WHY_DRAFT));
    c.rescan();
    expect(ghostFor(c, "#why")).toBeUndefined();
    expect($<HTMLTextAreaElement>("#why").value).toBe("N");
  });

  it("typing before the first token aborts the stream too, so no ghost ever shows up under the user's text", () => {
    const worker = fakeWorker();
    const c = start(worker);
    type($<HTMLTextAreaElement>("#why"), "M");
    expect(worker.streamFor("#why").aborted).toBe(true);
    worker.streamFor("#why").emit(delta("I want "));
    $<HTMLTextAreaElement>("#why").value = "";
    c.rescan();
    expect(ghostFor(c, "#why")).toBeUndefined();
  });

  it("Escape dismisses the current draft ghost for this page and aborts its stream", async () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    await fillNames(c);
    expect(key("Escape").defaultPrevented).toBe(true);
    expect(ghostFor(c, "#why")).toBeUndefined();
    expect(worker.streamFor("#why").aborted).toBe(true);
    c.rescan();
    expect(ghostFor(c, "#why")).toBeUndefined();
  });
});

describe("a draft that arrives late", () => {
  it("after the walk parked on Submit: the next Tab continues into the draft, and Submit is never activated", async () => {
    const worker = fakeWorker();
    const c = start(worker);
    await fillNames(c);
    expect(document.activeElement).toBe($("#submit"));
    expect(c.state.ghosts.map((g) => g.locked)).toEqual([true]);

    worker.streamFor("#why").emit(delta("I want "));
    worker.streamFor("#why").emit(done(WHY_DRAFT));
    expect(c.state.ghosts[c.state.currentIndex]?.signature).toBe(sig("#why"));
    expect(document.activeElement).toBe($("#submit")); // Ghost never moves focus on its own
    const tab = await tabUntilAccepted(c, 3);
    expect(tab.defaultPrevented).toBe(true);
    expect($<HTMLTextAreaElement>("#why").value).toBe(WHY_DRAFT);
    expect(submits).toBe(0);
  });

  it("a Submit the user focused themselves, before the walk got there, keeps its native Tab", () => {
    const worker = fakeWorker();
    const c = start(worker);
    worker.streamFor("#why").emit(done(WHY_DRAFT));
    $("#submit").focus();
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(c.state.accepted).toBe(0);
  });

  it("a new page aborts the streams of the old one and drafts again for the new view", async () => {
    const worker = fakeWorker();
    start(worker);
    worker.streamFor("#why").emit(delta("I want "));
    history.pushState({}, "", "/another-posting");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(worker.opened.slice(0, 2).every((s) => s.aborted)).toBe(true);
    await vi.waitFor(() => expect(worker.opened).toHaveLength(4));
    history.pushState({}, "", "/");
  });
});
