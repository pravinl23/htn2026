import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearnToast, TOAST_MS } from "../src/content/learnToast";
import { Overlay } from "../src/content/overlay";

describe("learn toast", () => {
  let overlay: Overlay;

  beforeEach(() => {
    vi.useFakeTimers();
    overlay = new Overlay(document);
  });

  afterEach(() => {
    overlay.destroy();
    vi.useRealTimers();
  });

  const chip = (): HTMLElement | null => overlay.shadow.querySelector<HTMLElement>(".learn-toast");

  it("lives inside the overlay's closed shadow root, where the page cannot read it, for 6 seconds", () => {
    const toast = new LearnToast({ root: () => overlay.shadow, isUserEvent: () => true });
    toast.show({ text: "Ghost learned: phone", onUndo: vi.fn() });
    expect(chip()?.textContent).toBe("Ghost learned: phoneUndo");
    expect(document.querySelector(".learn-toast")).toBeNull();
    expect(overlay.host.shadowRoot).toBeNull();
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(chip()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(chip()).toBeNull();
  });

  it("never takes focus or a place in the tab order: Tab belongs to the page and the walk", () => {
    const toast = new LearnToast({ root: () => overlay.shadow, isUserEvent: () => true });
    toast.show({ text: "Ghost learned: phone", onUndo: vi.fn() });
    const button = chip()?.querySelector("button");
    expect(button?.tabIndex).toBe(-1);
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("Undo runs once, says so, and goes away", () => {
    const onUndo = vi.fn();
    const toast = new LearnToast({ root: () => overlay.shadow, isUserEvent: () => true });
    toast.show({ text: "Ghost learned: phone", onUndo });
    chip()?.querySelector("button")?.click();
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(chip()?.textContent).toBe("Undone");
    vi.advanceTimersByTime(2000);
    expect(chip()).toBeNull();
  });

  it("ignores a click that is not the user's", () => {
    const onUndo = vi.fn();
    const toast = new LearnToast({ root: () => overlay.shadow }); // default: event.isTrusted, which a scripted click is not
    toast.show({ text: "Ghost learned: phone", onUndo });
    chip()?.querySelector("button")?.click();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("shows one chip at a time and nothing while Ghost is off", () => {
    const toast = new LearnToast({ root: () => overlay.shadow, isUserEvent: () => true });
    toast.show({ text: "Ghost learned: phone", onUndo: vi.fn() });
    toast.show({ text: "Ghost learned: city", onUndo: vi.fn() });
    expect(overlay.shadow.querySelectorAll(".learn-toast")).toHaveLength(1);
    expect(chip()?.textContent).toContain("city");
    toast.hide();
    new LearnToast({ root: () => null }).show({ text: "Ghost learned: phone", onUndo: vi.fn() });
    expect(chip()).toBeNull();
  });
});
