// The wiring between the controller and `ghost.keys` (docs/accept-key.md section 2). The policy and the counting
// have their own tests in shared/; what is proved here is the part that only the content script has: the verdict
// is readable in the same turn it is written, it is persisted under the ORIGIN and nothing longer, and it comes
// back on the next page load instead of the origin being probed from scratch again.
import { KeyMemory } from "@ghost/shared";
import type { TabProbe } from "@ghost/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_KEY_PREFS } from "../src/content/acceptKey";
import { createKeyPort } from "../src/content/keysPort";
import type { StoredKeys } from "../src/lib/storage";

const HREF = "https://jobs.example.com/apply/step-2?ref=hn#form";
const ORIGIN = "https://jobs.example.com";

/** Just enough Document for `originOf`. */
function docAt(href: string): Document {
  return { location: { href } } as unknown as Document;
}

function storedKeys(patch: Partial<StoredKeys> = {}): StoredKeys {
  return { ...DEFAULT_KEY_PREFS, memory: new KeyMemory().toJSON(), ...patch };
}

/** A store that answers `load()` and records what was written back, the way `ghost.keys` does. */
function fakeStore(initial: StoredKeys = storedKeys()) {
  const memory = KeyMemory.fromJSON(initial.memory);
  const written: TabProbe[] = [];
  return {
    written,
    snapshot: (): StoredKeys => ({ ...initial, memory: memory.toJSON() }),
    read: async (): Promise<StoredKeys> => ({ ...initial, memory: memory.toJSON() }),
    persist: async (probe: TabProbe): Promise<unknown> => {
      written.push(probe);
      memory.recordTabProbe(probe);
      return undefined;
    },
  };
}

const FREE: Omit<TabProbe, "origin" | "appId"> = { preventedDefault: false, focusMoved: true };
const TAKEN: Omit<TabProbe, "origin" | "appId"> = { preventedDefault: true };

describe("the content script's accept-key port", () => {
  it("starts on the default preferences and an origin nothing is known about", async () => {
    const store = fakeStore();
    const port = createKeyPort({ doc: docAt(HREF), read: store.read, persist: store.persist });
    await port.load();

    expect(port.origin).toBe(ORIGIN);
    expect(port.prefs()).toEqual(DEFAULT_KEY_PREFS);
    expect(port.tabState(), "an unwatched origin is 'unknown', so the controller probes rather than intercepts").toBe("unknown");
  });

  it("answers tabState() in the SAME turn a probe is observed, without waiting for the write", () => {
    const store = fakeStore();
    const port = createKeyPort({ doc: docAt(HREF), read: store.read, persist: store.persist });

    // The controller calls observe() and reads tabState() back synchronously (controller.ts settleProbe). A
    // verdict that only reached storage would arrive one press too late and the walk would probe again.
    port.observe(FREE);
    expect(port.tabState(), "one clean probe is not yet proof: FREE_PROBES is 2").toBe("unknown");
    port.observe(FREE);
    expect(port.tabState()).toBe("free");
  });

  it("marks an origin taken on a single probe the page handled", () => {
    const store = fakeStore();
    const port = createKeyPort({ doc: docAt(HREF), read: store.read, persist: store.persist });

    port.observe(TAKEN);
    expect(port.tabState(), "one page that handles Tab is enough to know").toBe("taken");
  });

  it("persists every probe under scheme://host and nothing longer", () => {
    const store = fakeStore();
    const port = createKeyPort({ doc: docAt(HREF), read: store.read, persist: store.persist });

    port.observe(FREE);
    port.observe(FREE);

    expect(store.written).toEqual([{ ...FREE, origin: ORIGIN }, { ...FREE, origin: ORIGIN }]);
    for (const probe of store.written) {
      expect(probe.origin, "no path, no query, no fragment ever reaches the store").toBe(ORIGIN);
    }
  });

  it("brings a verdict back on the next page load instead of probing the origin again", async () => {
    const store = fakeStore();
    const first = createKeyPort({ doc: docAt(HREF), read: store.read, persist: store.persist });
    await first.load();
    first.observe(FREE);
    first.observe(FREE);
    expect(first.tabState()).toBe("free");

    // A new page on the same origin: a fresh port, the same store.
    const second = createKeyPort({ doc: docAt(`${ORIGIN}/apply/step-3`), read: store.read, persist: store.persist });
    await second.load();
    expect(second.tabState(), "what the last load learned is what this one starts from").toBe("free");

    const elsewhere = createKeyPort({ doc: docAt("https://other.example.org/"), read: store.read, persist: store.persist });
    await elsewhere.load();
    expect(elsewhere.tabState(), "a verdict belongs to its origin and travels to no other").toBe("unknown");
  });

  it("takes on a preference someone else saved, and keeps a probe that has not been written back yet", async () => {
    const store = fakeStore();
    const port = createKeyPort({ doc: docAt(HREF), read: store.read, persist: store.persist });
    await port.load();
    port.observe(FREE);
    port.observe(FREE);

    // The options page saved a preference from a snapshot it read BEFORE those probes landed.
    port.adopt(storedKeys({ acceptKey: "ghost-key", ghostKey: "f19" }));

    expect(port.prefs()).toEqual({ acceptKey: "ghost-key", ghostKey: "f19" });
    expect(port.tabState(), "the verdict the user already paid two presses for is not undone").toBe("free");
  });

  it("adopts a record that is further along than its own", async () => {
    const store = fakeStore();
    const port = createKeyPort({ doc: docAt(HREF), read: store.read, persist: store.persist });
    await port.load();
    port.observe(FREE);

    // Another tab on the same origin watched two presses of its own and wrote them back.
    const other = KeyMemory.fromJSON(store.snapshot().memory);
    other.recordTabProbe({ ...FREE, origin: ORIGIN });
    other.recordTabProbe({ ...FREE, origin: ORIGIN });
    port.adopt(storedKeys({ memory: other.toJSON() }));

    expect(port.tabState(), "two tabs watching one origin both count").toBe("free");
  });
});
