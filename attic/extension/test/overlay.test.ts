import type { Ghost } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overlay } from "../src/content/overlay";
import type { OverlayState } from "../src/content/overlay";
import { OVERLAY_CSS, PAGE_CSS } from "../src/content/overlay-style";

type Entry = OverlayState["ghosts"][number];

const FORM = `
  <form>
    <label for="first">First name</label><input id="first" placeholder="Jane" />
    <label for="why">Why Northwind?</label><textarea id="why"></textarea>
    <label for="auth">Work authorization</label>
    <select id="auth"><option value="">Select...</option><option value="citizen">Citizen</option></select>
    <fieldset><legend>Sponsorship?</legend>
      <label><input type="radio" name="sponsor" value="yes" id="sponsor-yes" /> Yes</label>
      <label><input type="radio" name="sponsor" value="no" id="sponsor-no" /> No</label>
    </fieldset>
    <label><input type="checkbox" id="news" /> Keep me posted</label>
    <button id="submit" type="submit">Submit application</button>
  </form>`;

function ghost(signature: string, partial: Partial<Ghost> = {}): Ghost {
  return { signature, action: "fill", value: "Alex", displayText: "Alex", confidence: 0.9, locked: false, source: "offline", ...partial };
}

function entry(id: string, status: Entry["status"], partial: Partial<Ghost> = {}): Entry {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture is missing #${id}`);
  return { ghost: ghost(`sig-${id}`, partial), el, status };
}

function hostEl(): HTMLElement {
  const host = document.getElementById("ghost-overlay-host");
  if (!host) throw new Error("overlay host is missing");
  return host;
}

function shadow(): ShadowRoot {
  return overlay.shadow; // the root is closed to the page; the isolated-world object still hands it out
}

function nodeFor(signature: string): HTMLElement | null {
  return shadow().querySelector<HTMLElement>(`.ghost[data-signature="${signature}"]`);
}

function part(selector: string): HTMLElement {
  const el = shadow().querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`overlay is missing ${selector}`);
  return el;
}

let overlay: Overlay;

beforeEach(() => {
  document.body.innerHTML = FORM;
  overlay = new Overlay(document);
});

afterEach(() => {
  overlay.destroy();
});

describe("Overlay host", () => {
  it("creates exactly one host on documentElement with a shadow root the page cannot open", () => {
    overlay.render({ ghosts: [] });
    overlay.render({ ghosts: [entry("first", "current")] });
    const hosts = document.querySelectorAll("#ghost-overlay-host");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.parentElement).toBe(document.documentElement);
    expect(overlay.host).toBe(hosts[0]);
    // Every pending ghost carries a profile value, so page scripts must not be able to walk in and read them.
    expect(hosts[0]?.shadowRoot).toBeNull();
    expect(hosts[0]?.innerHTML).toBe("");
    expect(overlay.shadow.querySelector(".ghost .label")?.textContent).toBe("Alex");
  });

  it("replaces a stale host left behind by an earlier instance", () => {
    const second = new Overlay(document);
    second.render({ ghosts: [entry("first", "current")] });
    expect(document.querySelectorAll("#ghost-overlay-host")).toHaveLength(1);
    expect(document.querySelectorAll("#ghost-overlay-page-style")).toHaveLength(1);
    second.destroy();
  });

  it("never intercepts the pointer and ships reduced-motion styles", () => {
    expect(hostEl().style.pointerEvents).toBe("none");
    expect(hostEl().style.position).toBe("fixed");
    const css = shadow().querySelector("style")?.textContent ?? "";
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("transform 180ms cubic-bezier(.2,.8,.2,1)");
  });

  it("re-attaches itself when the page drops the host", () => {
    hostEl().remove();
    overlay.render({ ghosts: [entry("first", "current")] });
    expect(hostEl().getAttribute("data-ghost-state")).toBe("ready");
  });

  it("destroy removes the host, the page style and every field marker, and render can mount again", () => {
    overlay.render({ ghosts: [entry("first", "current")] });
    expect(document.getElementById("first")?.hasAttribute("data-ghost-hint")).toBe(true);

    overlay.destroy();
    expect(document.getElementById("ghost-overlay-host")).toBeNull();
    expect(document.getElementById("ghost-overlay-page-style")).toBeNull();
    expect(document.querySelectorAll("[data-ghost-hint]")).toHaveLength(0);

    overlay.render({ ghosts: [entry("first", "current")] });
    expect(document.querySelectorAll("#ghost-overlay-host")).toHaveLength(1);
    expect(nodeFor("sig-first")?.textContent).toContain("Alex");
  });
});

describe("Overlay test hooks", () => {
  it("starts idle and reflects ghosts, current and accepted count", () => {
    const host = hostEl();
    overlay.render({ ghosts: [] });
    expect(host.getAttribute("data-ghost-state")).toBe("idle");
    expect(host.getAttribute("data-ghost-count")).toBe("0");
    expect(host.getAttribute("data-ghost-current")).toBe("");
    expect(host.getAttribute("data-ghost-current-locked")).toBe("false");

    overlay.render({ ghosts: [entry("first", "current"), entry("why", "pending")], accepted: 3 });
    expect(host.getAttribute("data-ghost-state")).toBe("ready");
    expect(host.getAttribute("data-ghost-count")).toBe("2");
    expect(host.getAttribute("data-ghost-current")).toBe("sig-first");
    expect(host.getAttribute("data-ghost-current-locked")).toBe("false");
    expect(host.getAttribute("data-ghost-accepted")).toBe("3");
  });

  it("leaves accepted and error alone when the state omits them, so the controller may own them", () => {
    const host = hostEl();
    host.setAttribute("data-ghost-accepted", "7");
    host.setAttribute("data-ghost-error", "verify-failed");
    overlay.render({ ghosts: [entry("first", "current")] });
    expect(host.getAttribute("data-ghost-accepted")).toBe("7");
    expect(host.getAttribute("data-ghost-error")).toBe("verify-failed");
    expect(part(".hud-error").textContent).toBe("verify-failed");

    overlay.render({ ghosts: [entry("first", "current")], error: null });
    expect(host.hasAttribute("data-ghost-error")).toBe(false);
    expect(part(".hud").getAttribute("data-visible")).toBe("false");
  });

  it("flags a locked current ghost and shows the padlock badge", () => {
    overlay.render({ ghosts: [entry("submit", "current", { action: "click", locked: true, displayText: "Submit application" })] });
    expect(hostEl().getAttribute("data-ghost-current")).toBe("sig-submit");
    expect(hostEl().getAttribute("data-ghost-current-locked")).toBe("true");
    const lock = part(".lock");
    expect(lock.getAttribute("data-visible")).toBe("true");
    expect(lock.textContent).toBe("Enter to confirm");
    expect(lock.querySelector("svg")).not.toBeNull();
    expect(part(".cursor").getAttribute("data-locked")).toBe("true");
    expect(part(".ring").getAttribute("data-locked")).toBe("true");
    expect(shadow().querySelectorAll(".ghost")).toHaveLength(0);

    overlay.render({ ghosts: [entry("first", "current")] });
    expect(part(".lock").getAttribute("data-visible")).toBe("false");
    expect(part(".cursor").getAttribute("data-locked")).toBe("false");
  });
});

describe("Overlay ghosts", () => {
  it("draws ghost text for inputs, multi-line for textareas, pills for select, radio and checkbox", () => {
    overlay.render({
      ghosts: [
        entry("first", "current"),
        entry("why", "pending", { value: "Robots.\nAlso robots.", displayText: "Robots.\nAlso robots." }),
        entry("auth", "pending", { action: "select", value: "citizen", displayText: "Citizen" }),
        entry("sponsor-yes", "pending", { action: "select", value: "no", displayText: "No" }),
        entry("news", "pending", { action: "check", value: "true", displayText: "Yes" }),
      ],
    });
    expect(nodeFor("sig-first")?.getAttribute("data-mode")).toBe("text");
    expect(nodeFor("sig-first")?.getAttribute("data-status")).toBe("current");
    expect(nodeFor("sig-first")?.querySelector(".label")?.textContent).toBe("Alex");
    expect(nodeFor("sig-first")?.querySelector(".keycap")?.textContent).toBe("Tab");
    expect(nodeFor("sig-why")?.getAttribute("data-mode")).toBe("multiline");
    expect(nodeFor("sig-why")?.querySelector(".label")?.textContent).toBe("Robots.\nAlso robots.");
    expect(nodeFor("sig-why")?.getAttribute("data-status")).toBe("pending");
    expect(nodeFor("sig-auth")?.getAttribute("data-mode")).toBe("pill");
    expect(nodeFor("sig-sponsor-yes")?.getAttribute("data-mode")).toBe("pill");
    expect(nodeFor("sig-sponsor-yes")?.querySelector(".label")?.textContent).toBe("No");
    expect(nodeFor("sig-news")?.getAttribute("data-mode")).toBe("pill");
  });

  it("shows the cursor and ring only while a ghost is current", () => {
    overlay.render({ ghosts: [entry("first", "pending")] });
    expect(part(".cursor").getAttribute("data-visible")).toBe("false");
    expect(part(".ring").getAttribute("data-visible")).toBe("false");

    overlay.render({ ghosts: [entry("first", "current")] });
    expect(part(".cursor").getAttribute("data-visible")).toBe("true");
    expect(part(".ring").getAttribute("data-visible")).toBe("true");
    expect(part(".cursor").querySelector("svg path")).not.toBeNull();
    expect(part(".cursor").style.transform).toContain("translate(");
  });

  it("glides only when the current ghost changes, never on the first appearance", () => {
    overlay.render({ ghosts: [entry("first", "current"), entry("why", "pending")] });
    expect(part(".cursor").classList.contains("still")).toBe(true);

    overlay.render({ ghosts: [entry("why", "current")] });
    expect(part(".cursor").classList.contains("still")).toBe(false);
    expect(part(".ring").classList.contains("still")).toBe(false);
  });

  it("copies the field's font and padding onto the ghost text", () => {
    const input = document.getElementById("first") as HTMLInputElement;
    input.style.fontSize = "17px";
    input.style.fontFamily = "Courier";
    input.style.paddingLeft = "12px";
    input.style.borderLeftWidth = "2px";
    input.style.borderLeftStyle = "solid";
    overlay.render({ ghosts: [entry("first", "current")] });
    const style = nodeFor("sig-first")?.style;
    expect(style?.fontSize).toBe("17px");
    expect(style?.fontFamily).toBe("Courier");
    expect(style?.paddingLeft).toBe("14px");
  });

  it("hides the field's placeholder under ghost text and restores it when the ghost goes away", () => {
    const input = document.getElementById("first") as HTMLInputElement;
    overlay.render({ ghosts: [entry("first", "current"), entry("auth", "pending", { action: "select", value: "citizen" })] });
    expect(input.hasAttribute("data-ghost-hint")).toBe(true);
    expect(document.getElementById("auth")?.hasAttribute("data-ghost-hint")).toBe(false);
    expect(document.getElementById("ghost-overlay-page-style")?.textContent).toContain("::placeholder");

    overlay.render({ ghosts: [] });
    expect(input.hasAttribute("data-ghost-hint")).toBe(false);
  });

  it("does not draw over a field that already has a value", () => {
    const input = document.getElementById("first") as HTMLInputElement;
    overlay.render({ ghosts: [entry("first", "current")] });
    expect(nodeFor("sig-first")?.style.visibility).not.toBe("hidden");

    input.value = "Sam";
    overlay.render({ ghosts: [entry("first", "current")] });
    expect(nodeFor("sig-first")?.style.visibility).toBe("hidden");
  });

  it("skips ghosts whose element left the document", () => {
    const stale = entry("first", "current");
    stale.el.remove();
    expect(() => overlay.render({ ghosts: [stale] })).not.toThrow();
    expect(nodeFor("sig-first")).toBeNull();
    expect(part(".cursor").getAttribute("data-visible")).toBe("false");
    expect(hostEl().getAttribute("data-ghost-count")).toBe("1");
  });
});

describe("Overlay only draws what the user can see", () => {
  const SCROLLER = `
    <div id="scroller" style="height:160px;overflow:auto">
      <label for="first">First name</label><input id="first" />
      <label for="gh">GitHub</label><input id="gh" />
      <label for="auth">Work authorization</label><select id="auth"><option value="">Select...</option></select>
    </div>
    <p id="below">Unrelated paragraph under the scroll box</p>`;

  function place(id: string, top: number, height = 30): void {
    const el = document.getElementById(id);
    if (!el) throw new Error(`fixture is missing #${id}`);
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(0, top, 300, height));
  }

  beforeEach(() => {
    document.body.innerHTML = SCROLLER;
    place("scroller", 100, 160); // visible band: 100..260
    place("first", 120); // fully inside
    place("gh", 245); // bottom half cut off by the scroller's edge
    place("auth", 300); // scrolled out of the box, although still inside the window
  });

  afterEach(() => vi.restoreAllMocks());

  function renderAll(current = "first"): void {
    overlay.render({
      ghosts: ["first", "gh", "auth"].map((id) => entry(id, id === current ? "current" : "pending", id === "auth" ? { action: "select", value: "" } : {})),
    });
  }

  it("clips ghost text to its scroll container and hides what is scrolled out of it", () => {
    renderAll();
    expect(nodeFor("sig-first")?.style.visibility).toBe("");
    expect(nodeFor("sig-first")?.style.clipPath ?? "").toBe("");
    expect(nodeFor("sig-gh")?.style.clipPath).toBe("inset(0px 0px 15px 0px)");
    expect(nodeFor("sig-auth")?.style.visibility).toBe("hidden");
    // The placeholder only steps aside where ghost text is really drawn.
    expect(document.getElementById("first")?.hasAttribute("data-ghost-hint")).toBe(true);
  });

  it("hides the ring and cursor when the current field is scrolled out of its container", () => {
    renderAll("auth");
    expect(part(".ring").getAttribute("data-visible")).toBe("false");
    expect(part(".cursor").getAttribute("data-visible")).toBe("false");
    expect(hostEl().hasAttribute("data-ghost-cursor")).toBe(false);
    renderAll("first");
    expect(part(".cursor").getAttribute("data-visible")).toBe("true");
    expect(hostEl().getAttribute("data-ghost-cursor")).toMatch(/^\d+,\d+$/); // where the pointer rests, for e2e; never a value
  });

  it("hides ghost text under a sticky header or any other cover", () => {
    const cover = document.getElementById("below");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => cover });
    try {
      renderAll();
      expect(nodeFor("sig-first")?.style.visibility).toBe("hidden");
      expect(document.getElementById("first")?.hasAttribute("data-ghost-hint")).toBe(false);
      expect(part(".ring").getAttribute("data-visible")).toBe("false");
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  it("also hides the native date editor text under ghost text, not only ::placeholder", () => {
    expect(PAGE_CSS).toContain("[data-ghost-hint]::placeholder");
    expect(PAGE_CSS).toContain("[data-ghost-hint]::-webkit-datetime-edit");
  });
});

describe("Overlay node reuse", () => {
  it("keeps the same DOM node per signature across renders and updates it in place", () => {
    overlay.render({ ghosts: [entry("first", "current"), entry("why", "pending")] });
    const first = nodeFor("sig-first");
    const why = nodeFor("sig-why");
    const cursor = part(".cursor");

    overlay.render({ ghosts: [entry("first", "pending", { displayText: "Alexander" }), entry("why", "current")] });
    expect(nodeFor("sig-first")).toBe(first);
    expect(nodeFor("sig-why")).toBe(why);
    expect(part(".cursor")).toBe(cursor);
    expect(first?.getAttribute("data-status")).toBe("pending");
    expect(first?.querySelector(".label")?.textContent).toBe("Alexander");
    expect(why?.getAttribute("data-status")).toBe("current");
  });

  it("removes only the nodes whose ghosts are gone", () => {
    overlay.render({ ghosts: [entry("first", "current"), entry("why", "pending")] });
    const why = nodeFor("sig-why");
    overlay.render({ ghosts: [entry("why", "current")] });
    expect(nodeFor("sig-first")).toBeNull();
    expect(nodeFor("sig-why")).toBe(why);
    expect(shadow().querySelectorAll(".ghost")).toHaveLength(1);
  });

  it("re-points a node when the framework swaps the element behind a signature", () => {
    overlay.render({ ghosts: [entry("first", "current")] });
    const node = nodeFor("sig-first");
    const old = document.getElementById("first") as HTMLInputElement;
    const fresh = old.cloneNode(true) as HTMLInputElement;
    fresh.removeAttribute("data-ghost-hint");
    old.replaceWith(fresh);

    overlay.render({ ghosts: [entry("first", "current")] });
    expect(nodeFor("sig-first")).toBe(node);
    expect(fresh.hasAttribute("data-ghost-hint")).toBe(true);
    expect(old.hasAttribute("data-ghost-hint")).toBe(false);
  });

  it("is idempotent: an identical render performs no DOM mutations", () => {
    const state = (): OverlayState => ({
      ghosts: [entry("first", "current"), entry("auth", "pending", { action: "select", value: "citizen" })],
      hud: { provider: "heuristic", latencyMs: 12, cache: "offline", keystrokesSaved: 4 },
      accepted: 1,
    });
    overlay.render(state());

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    const options = { subtree: true, childList: true, attributes: true, characterData: true };
    observer.observe(shadow(), options);
    observer.observe(document.documentElement, options);
    overlay.render(state());
    records.push(...observer.takeRecords());
    observer.disconnect();

    expect(records.map((r) => `${r.type}:${r.attributeName ?? ""}`)).toEqual([]);
  });
});

describe("Overlay HUD", () => {
  it("shows provider, last latency, cache state and keystrokes saved", () => {
    overlay.render({ ghosts: [], hud: { provider: "heuristic", latencyMs: 181.6, cache: "hit", keystrokesSaved: 214 } });
    const hud = part(".hud");
    expect(hud.getAttribute("data-visible")).toBe("true");
    expect(hud.textContent).toContain("heuristic");
    expect(hud.textContent).toContain("182 ms");
    expect(hud.textContent).toContain("hit");
    expect(hud.textContent).toContain("214 keys");
    expect(part(".item.cache").getAttribute("data-cache")).toBe("hit");
  });

  it("stays hidden without hud state and shows a dash before the first call", () => {
    overlay.render({ ghosts: [] });
    expect(part(".hud").getAttribute("data-visible")).toBe("false");

    overlay.render({ ghosts: [], hud: { provider: "heuristic", latencyMs: null, cache: "offline", keystrokesSaved: 0 } });
    expect(part(".item.latency").textContent).toContain("—");
  });

  it("surfaces an execution error next to the HUD", () => {
    overlay.render({ ghosts: [entry("first", "current")], error: "verify-failed" });
    expect(hostEl().getAttribute("data-ghost-error")).toBe("verify-failed");
    expect(part(".hud-error").textContent).toBe("verify-failed");
    expect(part(".hud-error").hidden).toBe(false);
  });
});

describe("Overlay jump pill", () => {
  it("shows the count, the hint and the direction, and mirrors it to data-ghost-jump", () => {
    overlay.render({ ghosts: [entry("first", "current")], jump: { count: 14, direction: "down" } });
    const pill = part(".jump");
    expect(pill.getAttribute("data-visible")).toBe("true");
    expect(pill.getAttribute("data-direction")).toBe("down");
    expect(pill.textContent).toContain("14 ghosts ready");
    expect(pill.textContent).toContain("Tab");
    expect(pill.textContent).toContain("to jump");
    expect(hostEl().getAttribute("data-ghost-jump")).toBe("true");

    overlay.render({ ghosts: [entry("first", "current")], jump: { count: 1, direction: "up" } });
    expect(pill.getAttribute("data-direction")).toBe("up");
    expect(pill.textContent).toContain("1 ghost ready");
  });

  it("is hidden when no hint is given", () => {
    overlay.render({ ghosts: [entry("first", "current")], jump: { count: 2, direction: "down" } });
    overlay.render({ ghosts: [entry("first", "current")] });
    expect(part(".jump").getAttribute("data-visible")).toBe("false");
    expect(hostEl().getAttribute("data-ghost-jump")).toBe("false");
    overlay.render({ ghosts: [], jump: null });
    expect(hostEl().getAttribute("data-ghost-jump")).toBe("false");
  });

  it("never carries a profile value", () => {
    overlay.render({ ghosts: [entry("first", "current", { displayText: "Alex", value: "Alex" })], jump: { count: 1, direction: "down" } });
    expect(part(".jump").textContent).not.toContain("Alex");
    expect(hostEl().outerHTML).not.toContain("Alex");
  });
});

describe("Overlay multi-line drafts (Stage 3)", () => {
  const draft = (text: string, partial: Partial<Ghost> = {}): Entry => entry("why", "current", { value: text, displayText: text, source: "llm", ...partial });

  /** jsdom lays nothing out: give the label the scroll box a real engine would report. */
  function layoutLabel(scrollHeight: number, clientHeight: number): void {
    const label = nodeFor("sig-why")?.querySelector(".label");
    if (!label) throw new Error("the draft has no label yet");
    Object.defineProperty(label, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(label, "clientHeight", { configurable: true, get: () => clientHeight });
  }

  it("grows one node in place as deltas stream in, marked as streaming until the draft is done", () => {
    overlay.render({ ghosts: [draft("I want", { pending: true })] });
    const node = nodeFor("sig-why");
    expect(node?.getAttribute("data-mode")).toBe("multiline");
    expect(node?.getAttribute("data-streaming")).toBe("true");
    overlay.render({ ghosts: [draft("I want to build\nrobots.", { pending: true })] });
    expect(nodeFor("sig-why")).toBe(node);
    expect(node?.querySelector(".label")?.textContent).toBe("I want to build\nrobots.");
    overlay.render({ ghosts: [draft("I want to build\nrobots. Really.")] });
    expect(node?.hasAttribute("data-streaming")).toBe(false);
    expect(shadow().querySelectorAll(".ghost")).toHaveLength(1);
  });

  it("does not look the field up again for every delta: clipping ancestors are read once per element", () => {
    const why = document.getElementById("why") as HTMLElement;
    const parentLookups = vi.spyOn(why, "parentElement", "get");
    overlay.render({ ghosts: [draft("I", { pending: true })] });
    const afterFirst = parentLookups.mock.calls.length;
    for (const text of ["I want", "I want to", "I want to build"]) overlay.render({ ghosts: [draft(text, { pending: true })] });
    expect(parentLookups.mock.calls.length).toBe(afterFirst);
  });

  it("fades the bottom edge only while the draft is taller than the textarea, measured again when the text changes", () => {
    overlay.render({ ghosts: [draft("Short.", { pending: true })] });
    expect(nodeFor("sig-why")?.hasAttribute("data-overflow")).toBe(false);
    layoutLabel(260, 120);
    overlay.render({ ghosts: [draft("Short.", { pending: true })] }); // same text, same box: nothing is measured
    expect(nodeFor("sig-why")?.hasAttribute("data-overflow")).toBe(false);
    overlay.render({ ghosts: [draft("A much longer draft. ".repeat(30), { pending: true })] });
    expect(nodeFor("sig-why")?.getAttribute("data-overflow")).toBe("true");
    layoutLabel(90, 120);
    overlay.render({ ghosts: [draft("Short again.")] });
    expect(nodeFor("sig-why")?.hasAttribute("data-overflow")).toBe(false);
  });

  it("shimmers while Tab waits for the rest of the draft, and stops when the wait is over", () => {
    overlay.render({ ghosts: [{ ...draft("I want", { pending: true }), waiting: true }] });
    expect(nodeFor("sig-why")?.getAttribute("data-waiting")).toBe("true");
    overlay.render({ ghosts: [draft("I want to build robots.")] });
    expect(nodeFor("sig-why")?.hasAttribute("data-waiting")).toBe(false);
  });

  it("hides the draft the moment the textarea holds the user's own text", () => {
    overlay.render({ ghosts: [draft("I want to build robots.")] });
    expect(nodeFor("sig-why")?.style.visibility).not.toBe("hidden");
    (document.getElementById("why") as HTMLTextAreaElement).value = "My own words";
    overlay.render({ ghosts: [draft("I want to build robots.")] });
    expect(nodeFor("sig-why")?.style.visibility).toBe("hidden");
    expect(document.getElementById("why")?.hasAttribute("data-ghost-hint")).toBe(false);
  });

  it("wraps like the textarea: pre-wrap text, a label clipped to the box, and a keycap that takes no room from the text", () => {
    expect(OVERLAY_CSS).toMatch(/\[data-mode="multiline"\] \.label \{[^}]*white-space: pre-wrap/);
    expect(OVERLAY_CSS).toMatch(/\[data-mode="multiline"\] \.keycap \{[^}]*position: absolute/);
    expect(OVERLAY_CSS).toMatch(/\[data-overflow="true"\] \.label \{[^}]*mask-image: linear-gradient\(to bottom/);
    expect(OVERLAY_CSS).toMatch(/\[data-waiting="true"\] \.label \{[^}]*animation: ghost-shimmer/);
  });

  it("shows the last draft's provider, first-token and total latency on their own HUD row", () => {
    const hud = { provider: "jev-gateway", latencyMs: 142, cache: "miss" as const, keystrokesSaved: 8 };
    overlay.render({ ghosts: [], hud });
    expect(part(".hud-text").hidden).toBe(true);
    overlay.render({ ghosts: [], hud: { ...hud, text: { provider: "xai", firstTokenMs: 210.4, totalMs: 1234 } } });
    expect(part(".hud-text").hidden).toBe(false);
    expect(part(".hud-text").textContent).toBe("draft viaxaifirst token210 mstotal1234 ms");
    overlay.render({ ghosts: [], hud: { ...hud, text: { provider: "template", firstTokenMs: null, totalMs: 3 } } });
    expect(part(".hud-text").textContent).toBe("draft viatemplatefirst token—total3 ms");
    overlay.render({ ghosts: [] });
    expect(part(".hud-text").hidden).toBe(true);
  });
});

describe("tiers: how sure a proposal is, drawn (docs/always-propose.md)", () => {
  const HUD = { provider: "offline-heuristic", latencyMs: null, cache: "offline" as const, keystrokesSaved: 0 };

  it("marks the confident, the guess and the long shot on the node and on the host", () => {
    const cases: Array<[Partial<Ghost>, string | null, string]> = [
      [{ tier: "confident" }, "confident", ""],
      [{ tier: "guess", guess: true }, "guess", "guess"],
      [{ tier: "long-shot", guess: true }, "long-shot", "guess"],
    ];
    for (const [partial, tier, chip] of cases) {
      overlay.render({ ghosts: [entry("first", "current", partial)] });
      expect(nodeFor("sig-first")?.getAttribute("data-tier")).toBe(tier);
      expect(hostEl().getAttribute("data-ghost-tier")).toBe(tier);
      expect(nodeFor("sig-first")?.querySelector(".chip")?.textContent).toBe(chip);
    }
  });

  it("says 'check this' rather than 'guess' for an answer it did not guess, and for a declaration", () => {
    overlay.render({ ghosts: [entry("first", "current", { tier: "guess", guess: true, answerSource: "fact" })] });
    expect(nodeFor("sig-first")?.querySelector(".chip")?.textContent).toBe("check this");
    overlay.render({ ghosts: [entry("first", "current", { tier: "guess", guess: true, answerClass: "declaration", answerSource: "guess" })] });
    expect(nodeFor("sig-first")?.querySelector(".chip")?.textContent).toBe("check this");
  });

  it("puts a long shot's reason in the HUD, and nothing else's", () => {
    const why = "no profile fact: the option that claims the least";
    overlay.render({ ghosts: [entry("first", "current", { tier: "long-shot", guess: true, reason: why })], hud: HUD });
    expect(part(".hud-why").hidden).toBe(false);
    expect(part(".hud-why").textContent).toBe(why);
    // An ordinary guess speaks for itself: the chip is enough.
    overlay.render({ ghosts: [entry("first", "current", { tier: "guess", guess: true, reason: why })], hud: HUD });
    expect(part(".hud-why").hidden).toBe(true);
    // And with the HUD switched off nothing about it is drawn.
    overlay.render({ ghosts: [entry("first", "current", { tier: "long-shot", guess: true, reason: why })] });
    expect(part(".hud-why").hidden).toBe(true);
  });

  it("dims a long shot in the stylesheet rather than hiding it", () => {
    expect(OVERLAY_CSS).toContain('.ghost[data-tier="long-shot"]');
    expect(OVERLAY_CSS).not.toContain('.ghost[data-tier="long-shot"] { display: none');
  });
});
