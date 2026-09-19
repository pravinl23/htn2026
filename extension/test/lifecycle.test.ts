import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionAlive, watchForOrphan } from "../src/content/lifecycle";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("orphaned content script", () => {
  it("retires exactly once, as soon as the extension context is gone", () => {
    vi.useFakeTimers();
    let alive = true;
    const onOrphan = vi.fn();
    watchForOrphan(onOrphan, () => alive, 1000);
    vi.advanceTimersByTime(5000);
    expect(onOrphan).not.toHaveBeenCalled();
    alive = false; // chrome.runtime.reload(), an update, or a dev rebuild
    vi.advanceTimersByTime(1000);
    expect(onOrphan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(onOrphan).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled", () => {
    vi.useFakeTimers();
    const onOrphan = vi.fn();
    watchForOrphan(onOrphan, () => false, 1000)();
    vi.advanceTimersByTime(3000);
    expect(onOrphan).not.toHaveBeenCalled();
  });

  it("reads liveness from chrome.runtime.id and survives a throwing getter", () => {
    expect(extensionAlive()).toBe(false); // no chrome at all
    vi.stubGlobal("chrome", { runtime: { id: "abcdefghijklmnop" } });
    expect(extensionAlive()).toBe(true);
    vi.stubGlobal("chrome", { runtime: {} });
    expect(extensionAlive()).toBe(false);
    vi.stubGlobal("chrome", { get runtime(): never { throw new Error("Extension context invalidated."); } });
    expect(extensionAlive()).toBe(false);
  });
});
