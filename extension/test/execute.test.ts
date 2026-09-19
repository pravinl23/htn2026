import type { Ghost } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeGhost, radioGroup, setNativeValue } from "../src/content/execute";
import { TARGET_TOKEN } from "../src/lib/messages";

function ghost(partial: Partial<Ghost>): Ghost {
  return { signature: "sig", action: "fill", displayText: "", confidence: 0.9, locked: false, source: "offline", ...partial };
}

function mount<T extends HTMLElement = HTMLElement>(html: string, selector: string): T {
  document.body.innerHTML = html;
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`fixture is missing ${selector}`);
  return el;
}

/**
 * Mimics React's value tracker: the instance shadows `value`, remembers what was assigned through
 * it, and the change handler only fires when the DOM value differs from that memory.
 */
function trackLikeReact(node: HTMLInputElement, onChange: (value: string) => void): void {
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (!native?.get || !native.set) throw new Error("jsdom is missing the native value descriptor");
  const { get, set } = native;
  let tracked = node.value;
  Object.defineProperty(node, "value", {
    configurable: true,
    get(this: HTMLInputElement) {
      return get.call(this) as string;
    },
    set(this: HTMLInputElement, next: string) {
      tracked = String(next);
      set.call(this, next);
    },
  });
  node.addEventListener("input", () => {
    const now = get.call(node) as string;
    if (now === tracked) return;
    tracked = now;
    onChange(now);
  });
}

function stubChrome(sendMessage: (msg: unknown) => Promise<unknown>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(sendMessage);
  vi.stubGlobal("chrome", { runtime: { sendMessage: spy } });
  return spy;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setNativeValue", () => {
  it("reaches a React-style tracked input where a plain assignment is swallowed", () => {
    const input = mount<HTMLInputElement>(`<input id="first" />`, "#first");
    const onChange = vi.fn();
    trackLikeReact(input, onChange);

    input.value = "Plain";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();

    setNativeValue(input, "Alex");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("Alex");
    expect(input.value).toBe("Alex");
  });

  it("uses the matching prototype for textareas and selects", () => {
    const area = mount<HTMLTextAreaElement>(`<textarea id="why"></textarea>`, "#why");
    setNativeValue(area, "line one\nline two");
    expect(area.value).toBe("line one\nline two");

    const select = mount<HTMLSelectElement>(`<select id="s"><option value="a">A</option><option value="b">B</option></select>`, "#s");
    setNativeValue(select, "b");
    expect(select.selectedIndex).toBe(1);
  });
});

describe("executeGhost: fill", () => {
  it("fills a tracked input, fires React's change path and verifies", async () => {
    const input = mount<HTMLInputElement>(`<label for="first">First name</label><input id="first" />`, "#first");
    const onChange = vi.fn();
    trackLikeReact(input, onChange);

    const result = await executeGhost(ghost({ value: "Alex" }), input);

    expect(result).toEqual({ ok: true, method: "native" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("Alex");
    expect(document.activeElement).toBe(input);
  });

  it("dispatches bubbling input then change, flagged as ghost writing only during the write", async () => {
    const input = mount<HTMLInputElement>(`<form><label>Email <input id="email" type="email" /></label></form>`, "#email");
    const seen: Array<{ type: string; bubbles: boolean; flagged: boolean }> = [];
    for (const type of ["input", "change"]) {
      document.addEventListener(type, (event) => {
        const flagged = (event.target as HTMLElement).dataset.ghostWriting === "1";
        seen.push({ type: event.type, bubbles: event.bubbles, flagged });
      }, { once: true });
    }

    const result = await executeGhost(ghost({ value: "alex.chen@example.com" }), input);

    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      { type: "input", bubbles: true, flagged: true },
      { type: "change", bubbles: true, flagged: true },
    ]);
    expect(input.dataset.ghostWriting).toBeUndefined();
    expect(input.hasAttribute("data-ghost-writing")).toBe(false);
  });

  it("fills a textarea with multi-line text", async () => {
    const area = mount<HTMLTextAreaElement>(`<label for="why">Why Northwind?</label><textarea id="why"></textarea>`, "#why");
    const result = await executeGhost(ghost({ value: "Robots.\r\nAlso robots." }), area);
    expect(result).toEqual({ ok: true, method: "native" });
    expect(area.value).toBe("Robots.\nAlso robots.");
  });

  it.each([
    ["a phone mask that drops the country code", "+1 519 555 0142", (v: string) => v.replace(/\D/g, "").slice(-10).replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3"), "(519) 555-0142"],
    ["an upper-casing postal code field", "n2l 3g1", (v: string) => v.toUpperCase(), "N2L 3G1"],
    ["a trimming field", "Waterloo, ON", (v: string) => v.replace(/,\s*/, ", ").trim(), "Waterloo, ON"],
  ])("accepts the page's own spelling of our value: %s", async (_name, value, mask, shown) => {
    const input = mount<HTMLInputElement>(`<input id="masked" aria-label="Contact detail" />`, "#masked");
    input.addEventListener("input", () => setNativeValue(input, mask(input.value)));
    const sendMessage = stubChrome(async () => ({ ok: true }));

    const result = await executeGhost(ghost({ value }), input);

    expect(result).toEqual({ ok: true, method: "native" });
    expect(input.value).toBe(shown);
    expect(sendMessage).not.toHaveBeenCalled(); // no debugger attach (and no infobar) for a write that worked
  });

  it("does not accept unrelated content the page put there instead", async () => {
    const input = mount<HTMLInputElement>(`<input id="swap" aria-label="City" />`, "#swap");
    input.addEventListener("input", () => setNativeValue(input, "Please choose from the list"));
    const result = await executeGhost(ghost({ value: "Toronto" }), input);
    expect(result).toEqual({ ok: false, method: "none", reason: "verify-failed" });
  });

  it("returns ok:false with method none when the page rejects the value and chrome is absent", async () => {
    const input = mount<HTMLInputElement>(`<input id="stubborn" aria-label="City" />`, "#stubborn");
    input.addEventListener("input", () => setNativeValue(input, ""));

    const result = await executeGhost(ghost({ value: "Toronto" }), input);

    expect(result).toEqual({ ok: false, method: "none", reason: "verify-failed" });
    expect(input.dataset.ghostWriting).toBeUndefined();
  });

  it("falls back to the debugger through the background worker when verification fails", async () => {
    const input = mount<HTMLInputElement>(`<input id="stubborn" aria-label="City" />`, "#stubborn");
    let rejecting = true;
    input.addEventListener("input", () => rejecting && setNativeValue(input, ""));
    const sendMessage = stubChrome(async (msg) => {
      expect(input.dataset.ghostWriting).toBe("1");
      expect(input.getAttribute("data-ghost-target")).toBe((msg as { target: string }).target);
      rejecting = false;
      setNativeValue(input, "Toronto");
      return { ok: true };
    });

    const result = await executeGhost(ghost({ value: "Toronto" }), input);

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ type: "ghost:debugger-fill", value: "Toronto", target: expect.stringMatching(TARGET_TOKEN) });
    expect(result).toEqual({ ok: true, method: "debugger" });
    expect(input.dataset.ghostWriting).toBeUndefined();
    expect(input.hasAttribute("data-ghost-target")).toBe(false); // the token only lives for the request
  });

  it("reports the background error when the debugger fallback fails too", async () => {
    const input = mount<HTMLInputElement>(`<input id="stubborn" aria-label="City" />`, "#stubborn");
    input.addEventListener("input", () => setNativeValue(input, ""));
    stubChrome(async () => ({ ok: false, error: "debugger busy" }));

    const result = await executeGhost(ghost({ value: "Toronto" }), input);

    expect(result).toEqual({ ok: false, method: "debugger", reason: "debugger busy" });
  });

  it("survives a sendMessage that throws (invalidated extension context)", async () => {
    const input = mount<HTMLInputElement>(`<input id="stubborn" aria-label="City" />`, "#stubborn");
    input.addEventListener("input", () => setNativeValue(input, ""));
    stubChrome(async () => {
      throw new Error("Extension context invalidated.");
    });

    const result = await executeGhost(ghost({ value: "Toronto" }), input);

    expect(result).toEqual({ ok: false, method: "debugger", reason: "Extension context invalidated." });
  });

  it("refuses disabled, read-only and non-text targets without touching them", async () => {
    const readOnly = mount<HTMLInputElement>(`<input id="ro" aria-label="School" readonly value="keep" />`, "#ro");
    expect(await executeGhost(ghost({ value: "UWaterloo" }), readOnly)).toEqual({ ok: false, method: "none", reason: "not-editable" });
    expect(readOnly.value).toBe("keep");

    const file = mount<HTMLInputElement>(`<input id="cv" type="file" aria-label="Resume" />`, "#cv");
    expect(await executeGhost(ghost({ value: "resume.pdf" }), file)).toEqual({ ok: false, method: "none", reason: "unsupported" });

    const detached = document.createElement("input");
    expect(await executeGhost(ghost({ value: "Alex" }), detached)).toEqual({ ok: false, method: "none", reason: "detached" });
  });
});

describe("executeGhost: sensitive fields", () => {
  const cases: Array<[string, string]> = [
    ["password input", `<input id="t" type="password" aria-label="Password" />`],
    ["card autocomplete", `<input id="t" autocomplete="cc-number" aria-label="Number" />`],
    ["government id label", `<label for="t">Social Insurance Number</label><input id="t" />`],
    ["marked ancestor", `<div data-ghost-sensitive><input id="t" aria-label="Nickname" /></div>`],
  ];

  it.each(cases)("refuses a %s", async (_name, html) => {
    const input = mount<HTMLInputElement>(html, "#t");
    const onInput = vi.fn();
    input.addEventListener("input", onInput);
    const sendMessage = stubChrome(async () => ({ ok: true }));

    const result = await executeGhost(ghost({ value: "hunter2" }), input);

    expect(result).toEqual({ ok: false, method: "none", reason: "sensitive" });
    expect(input.value).toBe("");
    expect(onInput).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("executeGhost: select", () => {
  const html = `
    <label for="auth">Work authorization</label>
    <select id="auth">
      <option value="">Select...</option>
      <option value="citizen">Citizen or permanent resident</option>
      <option value="visa">Need a visa</option>
    </select>`;

  it("sets the option through the native setter and fires bubbling input and change", async () => {
    const select = mount<HTMLSelectElement>(html, "#auth");
    const events: string[] = [];
    document.body.addEventListener("input", (e) => events.push(e.type));
    document.body.addEventListener("change", (e) => events.push(e.type));

    const result = await executeGhost(ghost({ action: "select", value: "citizen", displayText: "Citizen or permanent resident" }), select);

    expect(result).toEqual({ ok: true, method: "native" });
    expect(select.value).toBe("citizen");
    expect(events).toEqual(["input", "change"]);
  });

  it("matches by option label when the value is not an option value", async () => {
    const select = mount<HTMLSelectElement>(html, "#auth");
    const result = await executeGhost(ghost({ action: "select", value: "need a visa", displayText: "Need a visa" }), select);
    expect(result.ok).toBe(true);
    expect(select.value).toBe("visa");
  });

  it("leaves the select alone when no option fits", async () => {
    const select = mount<HTMLSelectElement>(html, "#auth");
    const result = await executeGhost(ghost({ action: "select", value: "martian", displayText: "Martian" }), select);
    expect(result).toEqual({ ok: false, method: "none", reason: "option-missing" });
    expect(select.value).toBe("");
  });
});

describe("executeGhost: radio and checkbox", () => {
  const radios = `
    <form>
      <fieldset><legend>Will you require sponsorship?</legend>
        <label><input type="radio" name="sponsorship" value="yes" /> Yes</label>
        <label><input type="radio" name="sponsorship" value="no" /> No</label>
      </fieldset>
    </form>
    <form><input type="radio" name="sponsorship" value="no" id="other-form" /></form>`;

  it("clicks the matching radio of the group, given the first radio", async () => {
    const first = mount<HTMLInputElement>(radios, 'input[value="yes"]');
    const target = document.querySelector<HTMLInputElement>('form input[value="no"]');
    const clicks = vi.fn();
    target?.addEventListener("click", clicks);

    const result = await executeGhost(ghost({ action: "select", value: "no", displayText: "No" }), first);

    expect(result).toEqual({ ok: true, method: "click" });
    expect(target?.checked).toBe(true);
    expect(first.checked).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLInputElement>("#other-form")?.checked).toBe(false);
    expect(first.dataset.ghostWriting).toBeUndefined();
    expect(target?.dataset.ghostWriting).toBeUndefined();
  });

  it("scopes a radio group to its form", () => {
    const first = mount<HTMLInputElement>(radios, 'input[value="yes"]');
    expect(radioGroup(first).map((r) => r.value)).toEqual(["yes", "no"]);
    expect(radioGroup(first)).not.toContain(document.querySelector("#other-form"));
  });

  it("reports a missing radio option instead of guessing", async () => {
    const first = mount<HTMLInputElement>(radios, 'input[value="yes"]');
    const result = await executeGhost(ghost({ action: "select", value: "maybe", displayText: "Maybe" }), first);
    expect(result).toEqual({ ok: false, method: "none", reason: "option-missing" });
    expect(document.querySelectorAll("input:checked")).toHaveLength(0);
  });

  it("clicks a checkbox only when its state differs", async () => {
    const box = mount<HTMLInputElement>(`<label><input id="terms" type="checkbox" /> Keep me posted</label>`, "#terms");
    const clicks = vi.fn();
    box.addEventListener("click", clicks);

    expect(await executeGhost(ghost({ action: "check", value: "true" }), box)).toEqual({ ok: true, method: "click" });
    expect(box.checked).toBe(true);
    expect(await executeGhost(ghost({ action: "check", value: "true" }), box)).toEqual({ ok: true, method: "none" });
    expect(clicks).toHaveBeenCalledTimes(1);

    expect(await executeGhost(ghost({ action: "check", value: "false" }), box)).toEqual({ ok: true, method: "click" });
    expect(box.checked).toBe(false);
    expect(clicks).toHaveBeenCalledTimes(2);
  });

  it("fails verification when the page reverts the click and no debugger is available", async () => {
    const box = mount<HTMLInputElement>(`<label><input id="terms" type="checkbox" /> Keep me posted</label>`, "#terms");
    box.addEventListener("click", (event) => event.preventDefault());
    const result = await executeGhost(ghost({ action: "check", value: "true" }), box);
    expect(result).toEqual({ ok: false, method: "none", reason: "verify-failed" });
    expect(box.checked).toBe(false);
  });
});

describe("executeGhost: click", () => {
  it("never executes a locked click ghost", async () => {
    const button = mount<HTMLButtonElement>(`<form><button id="go" type="submit">Submit application</button></form>`, "#go");
    const clicks = vi.fn((event: Event) => event.preventDefault());
    button.addEventListener("click", clicks);

    const result = await executeGhost(ghost({ action: "click", locked: true, displayText: "Submit application" }), button);

    expect(result).toEqual({ ok: false, method: "none", reason: "locked" });
    expect(clicks).not.toHaveBeenCalled();
  });

  it("re-checks the DOM and refuses an irreversible button even when the ghost claims unlocked", async () => {
    const button = mount<HTMLButtonElement>(`<form><button id="go">Send</button></form>`, "#go");
    const clicks = vi.fn((event: Event) => event.preventDefault());
    button.addEventListener("click", clicks);

    const result = await executeGhost(ghost({ action: "click", locked: false, displayText: "Send" }), button);

    expect(result).toEqual({ ok: false, method: "none", reason: "locked" });
    expect(clicks).not.toHaveBeenCalled();
  });

  it("clicks an unlocked, reversible button", async () => {
    const button = mount<HTMLButtonElement>(`<button id="more" type="button">Show more fields</button>`, "#more");
    const clicks = vi.fn();
    button.addEventListener("click", clicks);

    const result = await executeGhost(ghost({ action: "click", displayText: "Show more fields" }), button);

    expect(result).toEqual({ ok: true, method: "click" });
    expect(clicks).toHaveBeenCalledTimes(1);
  });
});
