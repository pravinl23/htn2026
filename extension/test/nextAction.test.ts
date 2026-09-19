// Click ghosts beyond forms: which candidates leave the page, when a question is asked, and what Tab and Esc do.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ghost, NextCandidate } from "@ghost/shared";
import type { ExecResult } from "../src/content/execute";
import { NEXT_HOST_ID, NEXT_SETTLE_CEILING_MS, NEXT_SETTLE_MS, PRESENCE_PING, collectCandidates, startNextAction } from "../src/content/nextAction";
import type { NextActionDeps, NextActionHandle, NextMessage } from "../src/content/nextAction";

const MAIL_VIEW = `
  <header><a href="/mail" aria-label="Larkspur Mail">Larkspur</a></header>
  <nav aria-label="Message">
    <a id="back" href="/mail">Back to inbox</a>
    <a id="calendar" href="/calendar">Open calendar</a>
  </nav>
  <article><h1>Quick chat Thursday afternoon?</h1><p>Can we meet Thursday afternoon?</p></article>
  <section>
    <h2>Reply to Priya Nair</h2>
    <label for="reply">Reply</label><textarea id="reply" name="reply"></textarea>
    <button type="button" id="send">Send reply</button>
    <label for="pw">Mailbox password</label><input id="pw" type="password" name="password" />
    <label for="card">Card number</label><input id="card" name="cardnumber" autocomplete="cc-number" />
    <button type="button" id="hidden-action" hidden>Archive everything</button>
    <div aria-hidden="true"><button type="button" id="aria-hidden">Snooze</button></div>
    <button type="button" id="disabled" disabled>Forward</button>
    <div data-ghost-ui><button type="button" id="ghost-own">Ghost own control</button></div>
  </section>`;

type Reply = { ok: true; candidateId: string; confidence: number; provider: string; calibrated: boolean; latencyMs: number | null } | null;

let handle: NextActionHandle | null = null;
let sent: NextMessage[] = [];
let pings = 0;
let reply: Reply = null;
let formGhosts = 0;
let enabled = true;
let executed: Array<{ ghost: Ghost; el: HTMLElement }> = [];
let sendClicks = 0;

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`fixture is missing ${selector}`);
  return el;
}

function idOf(label: string): string {
  const candidate = collectCandidates(document).candidates.find((c) => c.label === label);
  if (!candidate) throw new Error(`no candidate labelled ${label}`);
  return candidate.id;
}

function answer(label: string, confidence = 0.75): void {
  reply = { ok: true, candidateId: idOf(label), confidence, provider: "memory", calibrated: false, latencyMs: 3 };
}

function start(over: Partial<NextActionDeps> = {}): NextActionHandle {
  handle = startNextAction({
    formGhosts: () => formGhosts,
    isEnabled: () => enabled,
    getSettings: () => ({ confidenceThreshold: 0.7 }),
    send: async (message) => {
      if (message.type === PRESENCE_PING) {
        pings++;
        return { ok: true };
      }
      sent.push(message as NextMessage);
      return reply;
    },
    isUserEvent: () => true, // jsdom cannot mint trusted events
    isVisible: () => true, // jsdom has no layout
    execute: async (ghost, el): Promise<ExecResult> => {
      executed.push({ ghost, el });
      return { ok: true, method: "click" };
    },
    topFrame: true,
    presencePingMs: 0,
    ...over,
  });
  return handle;
}

function host(): HTMLElement | null {
  return document.getElementById(NEXT_HOST_ID);
}

function shown(): boolean {
  return host()?.getAttribute("data-ghost-next") === "visible";
}

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = MAIL_VIEW;
  (document.activeElement as HTMLElement | null)?.blur?.();
  sent = [];
  pings = 0;
  reply = null;
  formGhosts = 0;
  enabled = true;
  executed = [];
  sendClicks = 0;
  $("#send").addEventListener("click", () => sendClicks++);
});

afterEach(() => {
  handle?.stop();
  handle = null;
  document.getElementById("ghost-loop-host")?.remove();
  vi.useRealTimers();
});

describe("collectCandidates", () => {
  it("offers visible buttons, links and fields, never sensitive, hidden, disabled or Ghost's own controls", () => {
    const { candidates, elements } = collectCandidates(document);
    const labels = candidates.map((c) => c.label);
    expect(labels).toEqual(["Larkspur Mail", "Back to inbox", "Open calendar", "Reply", "Send reply"]);
    expect(candidates.find((c) => c.label === "Open calendar")).toMatchObject({ kind: "link", locked: false });
    expect(candidates.find((c) => c.label === "Reply")).toMatchObject({ kind: "field", locked: false });
    expect(candidates.find((c) => c.label === "Send reply")).toMatchObject({ kind: "button", locked: true });
    expect(elements.get(idOf("Open calendar"))).toBe($("#calendar"));
    const json = JSON.stringify(candidates);
    for (const never of ["password", "Card", "Archive", "Snooze", "Forward", "Ghost own"]) expect(json).not.toContain(never);
  });

  it("never carries a field's value", () => {
    $<HTMLTextAreaElement>("#reply").value = "Thursday 2:30 works for me";
    expect(JSON.stringify(collectCandidates(document))).not.toContain("2:30");
  });

  it("covers app-style controls beyond native forms", () => {
    document.body.innerHTML = `
      <div role="tab" aria-label="Activity"></div>
      <div role="menuitem" aria-label="Move to folder"></div>
      <div role="switch" aria-label="Dark mode"></div>
      <div role="treeitem" aria-label="Projects"></div>
      <div role="link" aria-label="Open dashboard"></div>
      <div onclick="void 0" aria-label="Custom action"></div>
      <details><summary>Advanced settings</summary></details>`;
    const candidates = collectCandidates(document).candidates;
    expect(candidates.map((candidate) => [candidate.label, candidate.kind])).toEqual([
      ["Activity", "button"],
      ["Move to folder", "button"],
      ["Dark mode", "button"],
      ["Projects", "button"],
      ["Open dashboard", "link"],
      ["Custom action", "button"],
      ["Advanced settings", "button"],
    ]);
  });

  it("keeps at most 60, in DOM order", () => {
    document.body.innerHTML = Array.from({ length: 80 }, (_, i) => `<button type="button">Action ${i}</button>`).join("");
    const { candidates } = collectCandidates(document);
    expect(candidates).toHaveLength(60);
    expect(candidates[0]?.label).toBe("Action 0");
  });
});

describe("when a question is asked", () => {
  it("rescans controls that a large SPA hydrates late, with a ceiling for continuous mutations", async () => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    start();
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS - 1);
    document.body.insertAdjacentHTML("beforeend", '<button type="button">Play video</button>');
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS - 1);
    expect(sent).toHaveLength(0);
    // More framework churn resets the quiet timer but cannot postpone past the ceiling.
    document.body.insertAdjacentHTML("beforeend", "<div>recommendations loaded</div>");
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_CEILING_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.candidates.map((candidate) => candidate.label)).toContain("Play video");
  });

  it("asks once the page settles (300 ms), with the page's origin + path and the candidates", async () => {
    vi.useFakeTimers();
    start();
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS);
    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message?.type).toBe("ghost:next-candidates");
    expect(message?.url).toBe(`${location.origin}${location.pathname}`);
    expect(message?.candidates.map((c: NextCandidate) => c.label)).toContain("Open calendar");

    // A user action restarts the wait: one question per settled action, not per event.
    $("h1").dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS / 2);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS - 1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
  });

  it("nothing fires while form ghosts are pending, the loop sheet is open, or Ghost is off", async () => {
    answer("Open calendar");
    start();
    formGhosts = 2;
    await handle?.predictNow();
    expect(sent).toHaveLength(0);

    formGhosts = 0;
    const loopHost = document.createElement("div");
    loopHost.id = "ghost-loop-host";
    loopHost.setAttribute("data-loop-state", "proposed");
    document.documentElement.appendChild(loopHost);
    await handle?.predictNow();
    expect(sent).toHaveLength(0);

    loopHost.setAttribute("data-loop-state", "hidden");
    enabled = false;
    await handle?.predictNow();
    expect(sent).toHaveLength(0);

    enabled = true;
    await handle?.predictNow();
    expect(sent).toHaveLength(1);
    expect(shown()).toBe(true);
  });

  it("form ghosts that show up later take the stage: the click ghost goes away", async () => {
    vi.useFakeTimers();
    answer("Open calendar");
    start();
    await handle?.predictNow();
    expect(shown()).toBe(true);
    formGhosts = 3;
    await vi.advanceTimersByTimeAsync(300);
    expect(shown()).toBe(false);
    expect(handle?.ghost).toBeNull();
  });

  it("does not ask while the user is typing in a field", async () => {
    start();
    $("#reply").focus();
    await handle?.predictNow();
    expect(sent).toHaveLength(0);
  });

  it("shows an exploratory low-confidence guess, but never an id it did not offer", async () => {
    start();
    answer("Open calendar", 0.5);
    await handle?.predictNow();
    expect(shown()).toBe(true);
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    reply = { ok: true, candidateId: "button|delete everything|0", confidence: 0.99, provider: "llm", calibrated: false, latencyMs: 1 };
    await handle?.predictNow();
    expect(shown()).toBe(false);
  });

  it("drops an answer that arrives after the user already did something else", async () => {
    let release: (value: Reply) => void = () => undefined;
    start({ send: (message) => (message.type === PRESENCE_PING ? Promise.resolve({ ok: true }) : new Promise<Reply>((resolve) => (release = resolve))) });
    const pending = handle?.predictNow();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    answer("Open calendar");
    release(reply);
    await pending;
    expect(shown()).toBe(false);
  });
});

describe("the click ghost", () => {
  it("sits on the predicted element with its keycap; Tab on the body clicks it through execute.ts", async () => {
    answer("Open calendar");
    start();
    await handle?.predictNow();
    expect(shown()).toBe(true);
    expect(host()?.getAttribute("data-ghost-next-target")).toBe(idOf("Open calendar"));
    expect(host()?.getAttribute("data-ghost-next-locked")).toBe("false");

    const tab = key("Tab");
    expect(tab.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(executed).toHaveLength(1);
    expect(executed[0]?.el).toBe($("#calendar"));
    expect(executed[0]?.ghost).toMatchObject({ action: "click", locked: false, signature: idOf("Open calendar") });
    expect(shown()).toBe(false);
  });

  it("clicks for real with the default executor, and never a locked target", async () => {
    let calendarClicks = 0;
    document.body.innerHTML = `<button type="button" id="next">Next page</button><button type="button" id="send">Send reply</button>`;
    $("#next").addEventListener("click", () => calendarClicks++);
    $("#send").addEventListener("click", () => sendClicks++);
    answer("Next page");
    start({ execute: undefined });
    await handle?.predictNow();
    key("Tab");
    await Promise.resolve();
    expect(calendarClicks).toBe(1);
    expect(sendClicks).toBe(0);
  });

  it("a locked target is only focused: the lock badge stays, the next Tab is native, it is never clicked", async () => {
    answer("Send reply");
    start({ execute: undefined }); // the real executor would refuse it anyway; Tab must not even try
    await handle?.predictNow();
    expect(host()?.getAttribute("data-ghost-next-locked")).toBe("true");

    const first = key("Tab");
    expect(first.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($("#send"));
    expect(host()?.getAttribute("data-ghost-next-parked")).toBe("true");
    expect(shown()).toBe(true);

    const second = key("Tab");
    expect(second.defaultPrevented).toBe(false);
    expect(shown()).toBe(false);
    expect(sendClicks).toBe(0);
  });

  it("the live DOM's lock wins over an unlocked candidate", async () => {
    answer("Open calendar");
    start();
    await handle?.predictNow();
    $("#calendar").setAttribute("data-ghost-lock", "");
    key("Tab");
    await Promise.resolve();
    expect(executed).toHaveLength(0);
    expect(document.activeElement).toBe($("#calendar"));
  });

  it("a field is focused, never filled", async () => {
    answer("Reply");
    start();
    await handle?.predictNow();
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($("#reply"));
    expect($<HTMLTextAreaElement>("#reply").value).toBe("");
    expect(executed).toHaveLength(0);
  });
});

describe("the Tab gate", () => {
  it("Tab is not intercepted when no ghost is visible", async () => {
    start();
    expect(key("Tab").defaultPrevented).toBe(false);
    answer("Open calendar");
    handle?.stop();
    start({ isVisible: () => false }); // predicted, but scrolled away or covered
    await handle?.predictNow();
    expect(shown()).toBe(false);
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(executed).toHaveLength(0);
  });

  it("Shift, Ctrl, Alt and Meta + Tab are never Ghost's", async () => {
    answer("Open calendar");
    start();
    await handle?.predictNow();
    for (const mod of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) expect(key("Tab", mod).defaultPrevented).toBe(false);
    expect(executed).toHaveLength(0);
  });

  it("focus in another field keeps Tab native (and hides the ghost)", async () => {
    answer("Open calendar");
    start();
    await handle?.predictNow();
    const other = document.createElement("input");
    other.setAttribute("aria-label", "Search mail");
    document.body.appendChild(other);
    other.focus();
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(executed).toHaveLength(0);
  });

  it("a Tab the form walk already took is left alone", async () => {
    answer("Open calendar");
    start();
    await handle?.predictNow();
    const taken = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    expect(executed).toHaveLength(0);
  });

  it("a scripted Tab from the page is never accepted", async () => {
    answer("Open calendar");
    start({ isUserEvent: (event) => event.isTrusted });
    await handle?.predictNow();
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(executed).toHaveLength(0);
  });
});

describe("Escape and other actions", () => {
  it("Escape dismisses, and the same element is not offered again on this page", async () => {
    answer("Open calendar");
    start();
    await handle?.predictNow();
    expect(key("Escape").defaultPrevented).toBe(true);
    expect(shown()).toBe(false);
    await handle?.predictNow();
    expect(sent.at(-1)?.candidates.map((c: NextCandidate) => c.label)).not.toContain("Open calendar");
    expect(shown()).toBe(false);
  });

  it("any other user action cancels it: a click elsewhere, a key", async () => {
    answer("Open calendar");
    start();
    await handle?.predictNow();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(shown()).toBe(false);

    await handle?.predictNow();
    expect(shown()).toBe(true);
    key("ArrowDown");
    expect(shown()).toBe(false);
    expect(executed).toHaveLength(0);
  });

  it("stop() removes the host and every listener", async () => {
    answer("Open calendar");
    start();
    await handle?.predictNow();
    handle?.stop();
    expect(host()).toBeNull();
    expect(key("Tab").defaultPrevented).toBe(false);
  });

  it("switching Ghost off takes the ghost and its host off the page", async () => {
    vi.useFakeTimers();
    answer("Open calendar");
    start();
    await handle?.predictNow();
    expect(shown()).toBe(true);
    enabled = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(host()).toBeNull();
    expect(handle?.ghost).toBeNull();
    expect(key("Tab").defaultPrevented).toBe(false);
  });

  it("frames never predict: one ghost per tab", async () => {
    vi.useFakeTimers();
    start({ topFrame: false });
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS * 2);
    expect(sent).toHaveLength(0);
  });
});

describe("rule 2: whatever submits a form is locked, whatever its label", () => {
  let submits = 0;

  function formWith(control: string): void {
    document.body.innerHTML = `<form id="f"><input name="note" aria-label="Note" />${control}</form><a id="calendar" href="/calendar">Open calendar</a>`;
    submits = 0;
    $("#f").addEventListener("submit", (event) => {
      event.preventDefault();
      submits++;
    });
  }

  for (const [what, control] of [
    ["an <input type=image>", '<input type="image" id="go" alt="Continue" />'],
    ["a <button> with an invalid type (it falls back to submit)", '<button type="bogus" id="go">Continue</button>'],
    ["a <button> with no type inside a form", '<button id="go">Continue</button>'],
    ["an <input type=submit> tied to the form by its form attribute", '</form><input type="submit" id="go" form="f" value="Continue" /><form>'],
  ] as const) {
    it(`${what} goes out locked, and Tab only focuses it: the form is never submitted`, async () => {
      formWith(control);
      const candidate = collectCandidates(document).candidates.find((c) => c.label === "Continue");
      expect(candidate).toMatchObject({ kind: "button", locked: true });
      // Even if a server or memory answered with it unlocked, the live DOM decides.
      reply = { ok: true, candidateId: candidate?.id ?? "", confidence: 0.95, provider: "llm", calibrated: false, latencyMs: 1 };
      start({ execute: undefined });
      await handle?.predictNow();
      expect(host()?.getAttribute("data-ghost-next-locked")).toBe("true");
      expect(key("Tab").defaultPrevented).toBe(true);
      await Promise.resolve();
      expect(document.activeElement).toBe($("#go"));
      expect(key("Tab").defaultPrevented).toBe(false); // parked: native from here
      expect(submits).toBe(0);
    });
  }

  it("a type=button inside a form is not a submitter, so it stays clickable", async () => {
    formWith('<button type="button" id="go">Continue</button>');
    expect(collectCandidates(document).candidates.find((c) => c.label === "Continue")).toMatchObject({ locked: false });
  });
});

describe("rule 1: Tab stays native wherever the user is typing", () => {
  function closedField(): { host: HTMLElement; input: HTMLInputElement } {
    const fieldHost = document.createElement("x-field");
    const root = fieldHost.attachShadow({ mode: "closed" });
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Search");
    root.appendChild(input);
    document.body.appendChild(fieldHost);
    return { host: fieldHost, input };
  }

  it("a field inside a CLOSED shadow root: no question while typing there, and Tab is not taken", async () => {
    const { host: fieldHost, input } = closedField();
    answer("Open calendar");
    start();
    await handle?.predictNow();
    expect(shown()).toBe(true);

    input.focus();
    expect(document.activeElement).toBe(fieldHost); // what the page (and Ghost, without chrome.dom) can see
    fieldHost.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); // retargeted to the host
    fieldHost.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await handle?.predictNow();
    expect(sent).toHaveLength(1); // only the question asked with focus on the body
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(executed).toHaveLength(0);
  });

  it("chrome.dom.openOrClosedShadowRoot lets Ghost see the focused input inside a closed root", async () => {
    const probe = document.createElement("x-probe");
    const root = probe.attachShadow({ mode: "closed" });
    const inner = document.createElement("input");
    root.appendChild(inner);
    probe.tabIndex = 0; // focusable itself, so only the closed-root lookup tells Ghost that focus is in a text field
    document.body.appendChild(probe);
    vi.stubGlobal("chrome", { dom: { openOrClosedShadowRoot: (el: HTMLElement) => (el === probe ? root : null) } });
    try {
      answer("Open calendar");
      start();
      inner.focus();
      await handle?.predictNow();
      expect(sent).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("designMode or a contenteditable body: the page is a text box, so nothing is asked and Tab stays native", async () => {
    answer("Open calendar");
    start();
    await handle?.predictNow();
    expect(shown()).toBe(true);
    document.body.setAttribute("contenteditable", "");
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(executed).toHaveLength(0);
    await handle?.predictNow();
    expect(sent).toHaveLength(1);
    document.body.removeAttribute("contenteditable");

    const doc = document as Document & { designMode: string };
    const before = doc.designMode;
    doc.designMode = "on";
    try {
      await handle?.predictNow();
      expect(sent).toHaveLength(1);
      expect(shown()).toBe(false);
    } finally {
      doc.designMode = before;
    }
  });
});

describe("a late answer never lands under a keyboard user", () => {
  function pending(): (value: Reply) => void {
    let release: (value: Reply) => void = () => undefined;
    start({ send: (message) => (message.type === PRESENCE_PING ? Promise.resolve({ ok: true }) : new Promise<Reply>((resolve) => (release = resolve))) });
    return (value) => release(value);
  }

  it("native Tabs while the answer is on its way: the answer (naming the element now focused) is dropped", async () => {
    const archive = document.createElement("button");
    archive.type = "button";
    archive.textContent = "Archive";
    let archived = 0;
    archive.addEventListener("click", () => archived++);
    document.body.appendChild(archive);
    const release = pending();
    const asked = handle?.predictNow();
    expect(key("Tab").defaultPrevented).toBe(false); // no ghost: native
    expect(key("Tab").defaultPrevented).toBe(false);
    archive.focus(); // where those two native Tabs took focus
    answer("Archive", 0.95);
    release(reply);
    await asked;
    expect(shown()).toBe(false);
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(executed).toHaveLength(0);
    expect(archived).toBe(0);
  });

  it("focus moved by anyone else (a page script) while waiting: dropped too", async () => {
    const release = pending();
    const asked = handle?.predictNow();
    $("#calendar").focus();
    answer("Open calendar");
    release(reply);
    await asked;
    expect(shown()).toBe(false);
    expect(key("Tab").defaultPrevented).toBe(false);
  });

  it("a native Tab also cancels the question a click scheduled: keyboard navigation never asks", async () => {
    vi.useFakeTimers();
    start();
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS); // the arrival question
    const asked = sent.length;
    $("h1").dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS / 2);
    key("Tab");
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS * 3);
    expect(sent).toHaveLength(asked);
  });

  it("a native Tab takes a waiting ghost away, so tabbing onto its element later does not arm it", async () => {
    answer("Open calendar");
    start();
    await handle?.predictNow();
    const search = document.createElement("input");
    search.setAttribute("aria-label", "Search mail");
    document.body.appendChild(search);
    search.focus(); // the ghost waits, hidden
    expect(key("Tab").defaultPrevented).toBe(false);
    $("#calendar").focus(); // where native Tab went
    expect(handle?.ghost).toBeNull();
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(executed).toHaveLength(0);
  });

  it("a target that already has focus and would only be focused (a field, a locked action) never takes Tab", async () => {
    document.body.insertAdjacentHTML("beforeend", '<label><input type="checkbox" id="remember" /> Remember me</label>');
    start();
    $("#remember").focus();
    answer("Remember me");
    await handle?.predictNow();
    expect(shown()).toBe(false);
    expect(key("Tab").defaultPrevented).toBe(false);

    $("#send").focus();
    answer("Send reply");
    await handle?.predictNow();
    expect(shown()).toBe(false);
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(sendClicks).toBe(0);
  });
});

describe("rule 3 by shape", () => {
  it("SSN- and card-shaped link text never becomes a candidate (label, id or context)", () => {
    document.body.innerHTML = `
      <a href="/e/1">123-45-6789</a><a href="/e/2">4111 1111 1111 1111</a>
      <section><h2>Employee 123-45-6789</h2><button type="button">Open record</button></section>
      <a href="/e/3">Open profile</a>`;
    const { candidates } = collectCandidates(document);
    const json = JSON.stringify(candidates);
    for (const never of ["123-45-6789", "4111"]) expect(json).not.toContain(never);
    expect(candidates.map((c) => c.label)).toEqual(expect.arrayContaining(["Open record", "Open profile"]));
  });
});

describe("presence ping", () => {
  it("beats the moment the tab comes back into view or the window regains focus, not 30 s later", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    start({ presencePingMs: 30_000 });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(pings).toBe(0); // still hidden: nothing
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(pings).toBe(1);
    window.dispatchEvent(new FocusEvent("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(pings).toBe(2);
    $("#send").focus(); // an element's focus is not the window coming back
    await vi.advanceTimersByTimeAsync(0);
    expect(pings).toBe(2);
    visibility.mockRestore();
  });

  it("tells the worker every 30 s while the tab is visible and Ghost is on", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    start({ presencePingMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pings).toBe(1);
    enabled = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pings).toBe(1);
    visibility.mockRestore();
  });
});
