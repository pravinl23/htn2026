import { describe, expect, it, vi } from "vitest";
import {
  CHANGE_EVENT, MemoryStorage, clearPrefix, keysWithPrefix, parseJson, readJson, readRaw, removeKey, subscribe, writeJson,
  type StorageEnv,
} from "./storage";

function makeEnv(): StorageEnv & { storage: MemoryStorage; events: EventTarget } {
  return { storage: new MemoryStorage(), events: new EventTarget() };
}

/** What the browser fires in OTHER documents (tabs, iframes) after a write. `key` is null for storage.clear(). */
function storageEvent(key: string | null): Event {
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: key });
  return event;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => typeof n === "number");
}

describe("read and write", () => {
  it("round-trips JSON", () => {
    const env = makeEnv();
    expect(writeJson("ghostdemo.a", { n: 1, list: ["x"] }, env)).toBe(true);
    expect(readJson("ghostdemo.a", null, undefined, env)).toEqual({ n: 1, list: ["x"] });
    expect(readRaw("ghostdemo.a", env)).toBe('{"n":1,"list":["x"]}');
  });

  it("falls back on missing, malformed, or wrongly shaped values", () => {
    const env = makeEnv();
    expect(readJson("ghostdemo.none", [1], isNumberArray, env)).toEqual([1]);
    env.storage.setItem("ghostdemo.bad", "{not json");
    expect(readJson("ghostdemo.bad", [2], isNumberArray, env)).toEqual([2]);
    env.storage.setItem("ghostdemo.shape", '["a"]');
    expect(readJson("ghostdemo.shape", [3], isNumberArray, env)).toEqual([3]);
    expect(parseJson("[4,5]", [], isNumberArray)).toEqual([4, 5]);
  });

  it("survives storage that is missing or throws", () => {
    const none: StorageEnv = { storage: null, events: null };
    expect(writeJson("ghostdemo.a", 1, none)).toBe(false);
    expect(readJson("ghostdemo.a", "fallback", undefined, none)).toBe("fallback");
    expect(clearPrefix("ghostdemo.", none)).toEqual([]);

    const full = makeEnv();
    full.storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const heard = vi.fn();
    subscribe(null, heard, full);
    expect(writeJson("ghostdemo.a", 1, full)).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("clearPrefix", () => {
  it("removes only keys with the prefix and reports them", () => {
    const env = makeEnv();
    writeJson("ghostdemo.sheet.rows", [["a"]], env);
    writeJson("ghostdemo.invoices.replied", ["INV-1001"], env);
    writeJson("ghostdemo.mail.pickedSlot", "Thu 2pm", env);
    writeJson("othersite.setting", true, env);

    expect(keysWithPrefix("ghostdemo.", env)).toHaveLength(3);
    expect(clearPrefix("ghostdemo.", env)).toEqual(["ghostdemo.invoices.replied", "ghostdemo.mail.pickedSlot", "ghostdemo.sheet.rows"]);
    expect(keysWithPrefix("ghostdemo.", env)).toEqual([]);
    expect(readJson("othersite.setting", false, undefined, env)).toBe(true);
  });
});

describe("subscribe", () => {
  it("hears same-document writes and removals through the custom event", () => {
    const env = makeEnv();
    const heard = vi.fn();
    subscribe("ghostdemo.a", heard, env);
    writeJson("ghostdemo.a", 1, env);
    writeJson("ghostdemo.b", 2, env);
    removeKey("ghostdemo.a", env);
    expect(heard.mock.calls).toEqual([["ghostdemo.a"], ["ghostdemo.a"]]);
  });

  it("hears writes from other tabs and iframes through the storage event", () => {
    const env = makeEnv();
    const heard = vi.fn();
    subscribe(["ghostdemo.a", "ghostdemo.b"], heard, env);
    env.events.dispatchEvent(storageEvent("ghostdemo.b"));
    env.events.dispatchEvent(storageEvent("ghostdemo.zzz"));
    env.events.dispatchEvent(storageEvent(null)); // localStorage.clear() elsewhere
    expect(heard.mock.calls).toEqual([["ghostdemo.b"], [null]]);
  });

  it("hears everything when subscribed with null, and nothing after unsubscribing", () => {
    const env = makeEnv();
    const heard = vi.fn();
    const stop = subscribe(null, heard, env);
    writeJson("ghostdemo.a", 1, env);
    env.events.dispatchEvent(storageEvent("ghostdemo.q"));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    writeJson("ghostdemo.a", 2, env);
    env.events.dispatchEvent(storageEvent("ghostdemo.q"));
    env.events.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key: "ghostdemo.a" } }));
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
