import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDebuggerMessage, isDebuggerMessage } from "../src/background/debugger-input";
import { seedDefaults } from "../src/background/install";
import { toggleEnabled } from "../src/background/toggle";
import { PROFILE_KEY, SETTINGS_KEY, getSettings, resetMemoryStorage } from "../src/lib/storage";
import { createChromeStorageMock } from "./chrome-mock";

type SendCommand = (target: { tabId: number }, method: string, params?: Record<string, unknown>) => Promise<unknown>;

function stubDebugger(sendCommand: SendCommand = async () => ({ result: { value: false } })) {
  const api = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(sendCommand),
  };
  vi.stubGlobal("chrome", { debugger: api });
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetMemoryStorage();
});

const TOKEN = "11111111-2222-4333-8444-555555555555";
const FILL = { type: "ghost:debugger-fill", value: "Alex", target: TOKEN } as const;
const CLICK = { type: "ghost:debugger-click", x: 10, y: 20, target: TOKEN } as const;

/** A page where every guard passes: evaluate answers "" for a fill and a point for a click. */
const agreeablePage: SendCommand = async (_target, method, params) => {
  if (method !== "Runtime.evaluate") return {};
  return { result: { value: String(params?.expression).includes("elementFromPoint") ? { x: 10, y: 20 } : "" } };
};

/** Runs the guard expressions for real against the jsdom document, the way Runtime.evaluate would in the page. */
const realPage: SendCommand = async (_target, method, params) => {
  if (method !== "Runtime.evaluate") return {};
  return { result: { value: (0, eval)(String(params?.expression)) as unknown } };
};

function methods(api: ReturnType<typeof stubDebugger>): string[] {
  return api.sendCommand.mock.calls.map(([, method, params]) => (method === "Input.dispatchMouseEvent" ? String(params?.type) : method));
}

describe("debugger fallback input", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("inserts text through CDP and detaches", async () => {
    const api = stubDebugger(agreeablePage);
    expect(await handleDebuggerMessage(FILL, 7)).toEqual({ ok: true });
    expect(api.attach).toHaveBeenCalledWith({ tabId: 7 }, "1.3");
    expect(api.sendCommand).toHaveBeenLastCalledWith({ tabId: 7 }, "Input.insertText", { text: "Alex" });
    expect(api.detach).toHaveBeenCalledTimes(1);
  });

  it("clicks with mousePressed then mouseReleased at the point recomputed after the attach", async () => {
    const api = stubDebugger(agreeablePage);
    expect(await handleDebuggerMessage({ ...CLICK, x: 900, y: 900 }, 3)).toEqual({ ok: true });
    expect(methods(api)).toEqual(["Runtime.evaluate", "mouseMoved", "Runtime.evaluate", "mousePressed", "mouseReleased"]);
    expect(api.sendCommand).toHaveBeenLastCalledWith({ tabId: 3 }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 1 });
    expect(api.detach).toHaveBeenCalledTimes(1);
  });

  it("does not press when the page moved under the click point during the attach reflow", async () => {
    let looks = 0;
    const api = stubDebugger(async (_target, method) => (method === "Runtime.evaluate" ? { result: { value: { x: 10, y: 20 + 40 * looks++ } } } : {}));
    const reply = await handleDebuggerMessage(CLICK, 3);
    expect(reply).toEqual({ ok: false, error: "refused: the page moved under the click point" });
    expect(methods(api)).not.toContain("mousePressed");
  });

  it("still detaches and reports the error when a command fails", async () => {
    const api = stubDebugger(async (target, method, params) => {
      if (method === "Input.insertText") throw new Error("boom");
      return agreeablePage(target, method, params);
    });
    expect(await handleDebuggerMessage(FILL, 1)).toEqual({ ok: false, error: "boom" });
    expect(api.detach).toHaveBeenCalledTimes(1);
  });

  it("does not detach when attach itself failed", async () => {
    const api = stubDebugger(agreeablePage);
    api.attach.mockRejectedValueOnce(new Error("Cannot access a chrome:// URL"));
    expect(await handleDebuggerMessage(FILL, 1)).toEqual({ ok: false, error: "Cannot access a chrome:// URL" });
    expect(api.detach).not.toHaveBeenCalled();
  });

  it("recovers a tab whose session was left attached by a torn-down worker", async () => {
    const api = stubDebugger(agreeablePage);
    api.attach.mockRejectedValueOnce(new Error("Another debugger is already attached to the tab with id: 1."));
    expect(await handleDebuggerMessage(FILL, 1)).toEqual({ ok: true });
    expect(api.attach).toHaveBeenCalledTimes(2);
    expect(api.detach).toHaveBeenCalledTimes(2); // the stale session, then our own
  });

  it("gives up when someone else (DevTools) really holds the tab", async () => {
    const api = stubDebugger(agreeablePage);
    api.attach.mockRejectedValue(new Error("Another debugger is already attached to the tab with id: 1."));
    const reply = await handleDebuggerMessage(FILL, 1);
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/already attached/);
    expect(methods(api)).toEqual([]);
  });

  it("types only while the focused element still carries the content script's token", async () => {
    document.body.innerHTML = `<input id="city" aria-label="City" data-ghost-target="${TOKEN}"><input id="other" aria-label="Notes">`;
    const api = stubDebugger(realPage);
    document.querySelector<HTMLElement>("#city")?.focus();
    expect(await handleDebuggerMessage(FILL, 1)).toEqual({ ok: true });

    document.querySelector<HTMLElement>("#other")?.focus(); // the user clicked elsewhere during the attach
    const reply = await handleDebuggerMessage(FILL, 1);
    expect(reply).toEqual({ ok: false, error: "refused: focus moved away from the field" });
    expect(methods(api).filter((m) => m === "Input.insertText")).toHaveLength(1);
    expect(api.detach).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a password", `<input type="password" data-ghost-target="${TOKEN}">`],
    ["a card autocomplete", `<input autocomplete="cc-number" data-ghost-target="${TOKEN}">`],
    ["a government id by name", `<input name="sin" data-ghost-target="${TOKEN}">`],
    ["a government id by label", `<label>Social Insurance Number <input data-ghost-target="${TOKEN}"></label>`],
    ["a marked ancestor", `<div data-sensitive><input data-ghost-target="${TOKEN}"></div>`],
  ])("refuses to type into %s field even when the token matches", async (_name, html) => {
    document.body.innerHTML = html;
    document.querySelector<HTMLElement>("input")?.focus();
    const api = stubDebugger(realPage);
    const reply = await handleDebuggerMessage(FILL, 1);
    expect(reply).toEqual({ ok: false, error: "refused: focused field is sensitive" });
    expect(methods(api)).not.toContain("Input.insertText");
    expect(api.detach).toHaveBeenCalledTimes(1);
  });

  it("refuses to click anything but the tokened checkbox or radio that really is at the point", async () => {
    const doc = document as Document & { elementFromPoint?: (x: number, y: number) => Element | null };
    document.body.innerHTML = `<input type="checkbox" id="box" data-ghost-target="${TOKEN}"><button id="pay">Pay now</button>`;
    const box = document.querySelector<HTMLElement>("#box");
    if (!box) throw new Error("fixture");
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 20, 20));
    const api = stubDebugger(realPage);
    try {
      doc.elementFromPoint = () => document.querySelector("#pay"); // a fixed Pay bar slid under the point
      expect(await handleDebuggerMessage(CLICK, 1)).toEqual({ ok: false, error: "refused: something else is at the click point" });
      doc.elementFromPoint = () => box;
      expect(await handleDebuggerMessage(CLICK, 1)).toEqual({ ok: true });
      expect(api.sendCommand).toHaveBeenLastCalledWith({ tabId: 1 }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 1 });
      box.removeAttribute("data-ghost-target");
      expect(await handleDebuggerMessage(CLICK, 1)).toEqual({ ok: false, error: "refused: target is gone" });
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
    expect(methods(api).filter((m) => m === "mousePressed")).toHaveLength(1);
  });

  it("serializes requests for the same tab so attach never overlaps", async () => {
    const api = stubDebugger(agreeablePage);
    let attached = 0;
    let maxAttached = 0;
    api.attach.mockImplementation(async () => void (maxAttached = Math.max(maxAttached, ++attached)));
    api.detach.mockImplementation(async () => void attached--);
    const replies = await Promise.all([handleDebuggerMessage(FILL, 5), handleDebuggerMessage({ ...FILL, value: "b" }, 5)]);
    expect(replies).toEqual([{ ok: true }, { ok: true }]);
    expect(maxAttached).toBe(1);
  });

  it("fails cleanly without a sender tab", async () => {
    stubDebugger();
    expect(await handleDebuggerMessage(FILL, undefined)).toEqual({ ok: false, error: "no sender tab" });
  });

  it("validates message shapes, including the target token", () => {
    expect(isDebuggerMessage(FILL)).toBe(true);
    expect(isDebuggerMessage(CLICK)).toBe(true);
    expect(isDebuggerMessage({ type: "ghost:debugger-fill", value: "x" })).toBe(false);
    expect(isDebuggerMessage({ ...FILL, target: `x"]); alert(1); ("` })).toBe(false);
    expect(isDebuggerMessage({ ...FILL, value: 3 })).toBe(false);
    expect(isDebuggerMessage({ ...CLICK, x: "1" })).toBe(false);
    expect(isDebuggerMessage({ type: "ghost:toggle" })).toBe(false);
    expect(isDebuggerMessage(null)).toBe(false);
  });
});

describe("toggle and install", () => {
  let action: Record<"setBadgeText" | "setBadgeBackgroundColor" | "setTitle", ReturnType<typeof vi.fn>>;
  let storage: ReturnType<typeof createChromeStorageMock>;

  beforeEach(() => {
    storage = createChromeStorageMock();
    action = { setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined), setTitle: vi.fn(async () => undefined) };
    vi.stubGlobal("chrome", { ...storage.chrome, action });
  });

  it("flips settings.enabled and paints the badge", async () => {
    expect(await toggleEnabled()).toBe(false);
    expect((await getSettings()).enabled).toBe(false);
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: "OFF" });
    expect(await toggleEnabled()).toBe(true);
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: "ON" });
    expect(action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({ color: "#16a34a" });
  });

  it("seeds defaults on install without clobbering existing values", async () => {
    storage.store.set(SETTINGS_KEY, { enabled: false });
    await seedDefaults();
    expect(storage.store.get(PROFILE_KEY)).toMatchObject({ facts: { fullName: "Alex Chen" } });
    expect(storage.store.get(SETTINGS_KEY)).toMatchObject({ enabled: false, confidenceThreshold: 0.7 });
  });
});
