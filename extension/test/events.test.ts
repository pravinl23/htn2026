import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmitter, ghostEvents } from "../src/lib/events";

afterEach(() => {
  ghostEvents.clear();
  vi.restoreAllMocks();
});

describe("ghost events", () => {
  it("delivers typed payloads to every subscriber of that event only", () => {
    const events = createEmitter();
    const shown = vi.fn();
    const finished = vi.fn();
    events.on("ghosts:shown", shown);
    events.on("walk:finished", finished);
    events.emit("ghosts:shown", { count: 3, source: "offline" });
    expect(shown).toHaveBeenCalledExactlyOnceWith({ count: 3, source: "offline" });
    expect(finished).not.toHaveBeenCalled();
    events.emit("walk:finished");
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after unsubscribe and after clear", () => {
    const events = createEmitter();
    const first = vi.fn();
    const second = vi.fn();
    const off = events.on("walk:finished", first);
    events.on("walk:finished", second);
    off();
    events.emit("walk:finished");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    events.clear();
    events.emit("walk:finished");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps going when a subscriber throws: a broken listener must never stop the walk", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const events = createEmitter();
    const after = vi.fn();
    events.on("walk:finished", () => {
      throw new Error("boom");
    });
    events.on("walk:finished", after);
    expect(() => events.emit("walk:finished")).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("lets a subscriber unsubscribe itself while being called", () => {
    const events = createEmitter();
    const calls: string[] = [];
    const off = events.on("walk:finished", () => {
      calls.push("once");
      off();
    });
    events.on("walk:finished", () => calls.push("always"));
    events.emit("walk:finished");
    events.emit("walk:finished");
    expect(calls).toEqual(["once", "always", "always"]);
  });

  it("exports one shared emitter for the content script", () => {
    const seen = vi.fn();
    ghostEvents.on("ghosts:shown", seen);
    ghostEvents.emit("ghosts:shown", { count: 1, source: "cache" });
    expect(seen).toHaveBeenCalledWith({ count: 1, source: "cache" });
  });
});
