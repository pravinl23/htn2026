import { describe, expect, it } from "vitest";
import {
  COUNTER_CAP, FLIP_PRESSES, FREE_PROBES, KEY_MEMORY_MAX, KeyMemory, UNKNOWN_SITE,
  acceptKeyFor, applyTabProbe, applyUserPress, isPausedApp, probeVerdict, unknownObservation,
} from "../src";
import type { KeyMemorySnapshot, KeyObservation, PauseList } from "../src";

const SITE = { origin: "https://app.example.com" };
const KEY = "https://app.example.com";

/** The press the extension reports: a ghost was on screen and this key was aimed at it. */
const press = (memory: KeyMemory, key: "tab" | "ghost-key", times = 1, accepted = true): KeyObservation => {
  let last = memory.get(SITE);
  for (let i = 0; i < times; i++) last = memory.recordUserPress({ ...SITE, key, accepted });
  return last;
};

describe("probeVerdict: what one watched Tab press says", () => {
  it("reads a preventDefault as the page handling Tab itself", () => {
    expect(probeVerdict({ preventedDefault: true, focusMoved: true })).toBe("taken");
  });

  it("reads focus that did not move as the page handling Tab itself", () => {
    expect(probeVerdict({ preventedDefault: false, focusMoved: false })).toBe("taken");
  });

  it("reads a press that passed through and moved focus as free", () => {
    expect(probeVerdict({ preventedDefault: false, focusMoved: true })).toBe("free");
  });

  it("reads a press it could not follow as inconclusive", () => {
    expect(probeVerdict({})).toBe("inconclusive");
    expect(probeVerdict({ preventedDefault: false })).toBe("inconclusive");
  });
});

describe("applyTabProbe: one probe marks taken, two mark free", () => {
  it("marks a site that preventDefaults Tab taken on the very first probe", () => {
    const after = applyTabProbe(unknownObservation(KEY), { preventedDefault: true });
    expect(after.tab).toBe("taken");
    expect(after.probes.taken).toBe(1);
  });

  it("marks a site whose focus does not move taken on the very first probe", () => {
    expect(applyTabProbe(unknownObservation(KEY), { focusMoved: false }).tab).toBe("taken");
  });

  it("needs two clean probes before it calls Tab free", () => {
    const once = applyTabProbe(unknownObservation(KEY), { focusMoved: true });
    expect(once.tab).toBe("unknown");
    expect(applyTabProbe(once, { focusMoved: true }).tab).toBe("free");
    expect(FREE_PROBES).toBe(2);
  });

  it("keeps taken sticky against any number of later clean probes", () => {
    let record = applyTabProbe(unknownObservation(KEY), { preventedDefault: true });
    for (let i = 0; i < 5; i++) record = applyTabProbe(record, { focusMoved: true });
    expect(record.tab).toBe("taken");
    expect(record.probes.free).toBe(5);
  });

  it("takes free away again the moment one press is handled by the page", () => {
    let record = applyTabProbe(applyTabProbe(unknownObservation(KEY), { focusMoved: true }), { focusMoved: true });
    expect(record.tab).toBe("free");
    record = applyTabProbe(record, { preventedDefault: true });
    expect(record.tab).toBe("taken");
  });

  it("changes nothing on an inconclusive probe", () => {
    const before = unknownObservation(KEY);
    expect(applyTabProbe(before, {})).toEqual(before);
  });

  it("never mutates the record it was given", () => {
    const before = unknownObservation(KEY);
    applyTabProbe(before, { preventedDefault: true });
    expect(before.tab).toBe("unknown");
    expect(before.probes.taken).toBe(0);
  });

  it("counts evidence but does not override a place the user pinned", () => {
    const pinned: KeyObservation = { ...unknownObservation(KEY), tab: "free", pinned: true };
    const after = applyTabProbe(pinned, { preventedDefault: true });
    expect(after.tab).toBe("free");
    expect(after.probes.taken).toBe(1);
  });

  it("caps its counters so the file cannot grow with use", () => {
    let record = unknownObservation(KEY);
    for (let i = 0; i < COUNTER_CAP + 20; i++) record = applyTabProbe(record, { focusMoved: true });
    expect(record.probes.free).toBe(COUNTER_CAP);
  });
});

describe("applyUserPress: three consistent presses flip a place permanently", () => {
  it("flips an unwatched place to free after three Tab presses", () => {
    let record = unknownObservation(KEY);
    for (let i = 0; i < FLIP_PRESSES; i++) record = applyUserPress(record, { key: "tab" });
    expect(record.tab).toBe("free");
    expect(record.pinned).toBe(true);
    expect(record.flips).toBe(1);
  });

  it("does not flip on the first two presses", () => {
    let record = unknownObservation(KEY);
    record = applyUserPress(record, { key: "tab" });
    expect(record.tab).toBe("unknown");
    record = applyUserPress(record, { key: "tab" });
    expect(record.tab).toBe("unknown");
    expect(record.run).toEqual({ key: "tab", count: 2 });
  });

  it("flips a free place to taken after three Shabang-key presses", () => {
    let record: KeyObservation = { ...unknownObservation(KEY), tab: "free" };
    for (let i = 0; i < FLIP_PRESSES; i++) record = applyUserPress(record, { key: "ghost-key" });
    expect(record.tab).toBe("taken");
    expect(record.flips).toBe(1);
  });

  it("counts consistent as in a row: a press of the other key restarts the run", () => {
    let record = unknownObservation(KEY);
    record = applyUserPress(record, { key: "tab" });
    record = applyUserPress(record, { key: "tab" });
    record = applyUserPress(record, { key: "ghost-key" });
    record = applyUserPress(record, { key: "tab" });
    expect(record.tab).toBe("unknown");
    expect(record.run).toEqual({ key: "tab", count: 1 });
  });

  it("outranks the watching: a pinned place ignores later probes", () => {
    let record = applyTabProbe(unknownObservation(KEY), { preventedDefault: true });
    for (let i = 0; i < FLIP_PRESSES; i++) record = applyUserPress(record, { key: "tab" });
    expect(record.tab).toBe("free");
    expect(applyTabProbe(record, { preventedDefault: true }).tab).toBe("free");
  });

  it("pins without counting a flip when the presses agree with what was already known", () => {
    let record: KeyObservation = { ...unknownObservation(KEY), tab: "free" };
    for (let i = 0; i < FLIP_PRESSES; i++) record = applyUserPress(record, { key: "tab" });
    expect(record.flips).toBe(0);
    expect(record.pinned).toBe(true);
  });

  it("resets the run after a flip, so a fourth press does not flip again", () => {
    let record = unknownObservation(KEY);
    for (let i = 0; i < FLIP_PRESSES + 1; i++) record = applyUserPress(record, { key: "tab" });
    expect(record.run).toEqual({ key: "tab", count: 1 });
    expect(record.flips).toBe(1);
  });

  it("can flip back again with three presses of the other key", () => {
    let record = unknownObservation(KEY);
    for (let i = 0; i < FLIP_PRESSES; i++) record = applyUserPress(record, { key: "tab" });
    for (let i = 0; i < FLIP_PRESSES; i++) record = applyUserPress(record, { key: "ghost-key" });
    expect(record.tab).toBe("taken");
    expect(record.flips).toBe(2);
  });

  it("counts a press that accepted nothing as the user reaching for that key", () => {
    const record = applyUserPress(unknownObservation(KEY), { key: "tab", accepted: false });
    expect(record.missed).toBe(1);
    expect(record.presses.tab).toBe(1);
    expect(record.run).toEqual({ key: "tab", count: 1 });
  });

  it("lets three presses that accepted nothing flip the place, which is how a correction starts", () => {
    let record: KeyObservation = { ...unknownObservation(KEY), tab: "taken" };
    for (let i = 0; i < FLIP_PRESSES; i++) record = applyUserPress(record, { key: "tab", accepted: false });
    expect(record.tab).toBe("free");
  });

  it("never mutates the record it was given", () => {
    const before = unknownObservation(KEY);
    applyUserPress(before, { key: "tab" });
    expect(before.presses.tab).toBe(0);
    expect(before.run).toBeNull();
  });
});

describe("KeyMemory: one compact record per place", () => {
  it("starts empty and reports an unknown place without storing it", () => {
    const memory = new KeyMemory();
    expect(memory.get(SITE).tab).toBe("unknown");
    expect(memory.size).toBe(0);
  });

  it("keys on the origin only, so two pages of one site share a record", () => {
    const memory = new KeyMemory();
    memory.recordTabProbe({ origin: "https://app.example.com/a/1?x=1", preventedDefault: true });
    expect(memory.tabState({ origin: "https://app.example.com/b/2" })).toBe("taken");
    expect(memory.ids).toEqual([KEY]);
  });

  it("keeps browser origins and native apps apart", () => {
    const memory = new KeyMemory();
    memory.recordTabProbe({ appId: "com.example.Notes", preventedDefault: true });
    expect(memory.tabState({ appId: "com.example.Notes" })).toBe("taken");
    expect(memory.tabState({ origin: "https://notes.example.com" })).toBe("unknown");
    expect(memory.ids).toEqual(["app://com.example.notes"]);
  });

  it("stores nothing for a place it cannot name", () => {
    const memory = new KeyMemory();
    expect(memory.recordTabProbe({ preventedDefault: true }).id).toBe(UNKNOWN_SITE);
    expect(memory.size).toBe(0);
  });

  it("never asks the question in a paused app: no probe and no press is stored", () => {
    const memory = new KeyMemory();
    memory.recordTabProbe({ appId: "com.example.terminal", preventedDefault: true, paused: true });
    memory.recordUserPress({ appId: "com.example.terminal", key: "tab", paused: true });
    expect(memory.size).toBe(0);
    expect(memory.tabState({ appId: "com.example.terminal" })).toBe("unknown");
  });

  it("hands back a copy, so a caller cannot edit the store through it", () => {
    const memory = new KeyMemory();
    memory.recordTabProbe({ ...SITE, preventedDefault: true });
    const snapshot = memory.get(SITE);
    snapshot.tab = "free";
    snapshot.probes.taken = 99;
    expect(memory.get(SITE).tab).toBe("taken");
    expect(memory.get(SITE).probes.taken).toBe(1);
  });

  it("forgets a place on request", () => {
    const memory = new KeyMemory();
    memory.recordTabProbe({ ...SITE, preventedDefault: true });
    memory.forget(SITE);
    expect(memory.size).toBe(0);
    expect(memory.tabState(SITE)).toBe("unknown");
  });

  it("records presses through the store, flipping after three", () => {
    const memory = new KeyMemory();
    expect(press(memory, "tab", 2).tab).toBe("unknown");
    expect(press(memory, "tab").tab).toBe("free");
    expect(memory.get(SITE).pinned).toBe(true);
  });
});

describe("KeyMemory: the cap on how much is kept", () => {
  it("defaults to the 300 origins docs/storage.md budgets for", () => {
    expect(new KeyMemory().max).toBe(KEY_MEMORY_MAX);
    expect(KEY_MEMORY_MAX).toBe(300);
  });

  it("evicts the least recently used place past the cap", () => {
    const memory = new KeyMemory(3);
    for (const host of ["a", "b", "c", "d"]) memory.recordTabProbe({ origin: `https://${host}.example`, preventedDefault: true });
    expect(memory.size).toBe(3);
    expect(memory.ids).toEqual(["https://b.example", "https://c.example", "https://d.example"]);
    expect(memory.tabState({ origin: "https://a.example" })).toBe("unknown");
  });

  it("counts a fresh write as use, so a place in daily use is never evicted", () => {
    const memory = new KeyMemory(2);
    memory.recordTabProbe({ origin: "https://a.example", preventedDefault: true });
    memory.recordTabProbe({ origin: "https://b.example", preventedDefault: true });
    memory.recordTabProbe({ origin: "https://a.example", focusMoved: true });
    memory.recordTabProbe({ origin: "https://c.example", preventedDefault: true });
    expect(memory.ids).toEqual(["https://a.example", "https://c.example"]);
  });

  it("does not count a read as use", () => {
    const memory = new KeyMemory(2);
    memory.recordTabProbe({ origin: "https://a.example", preventedDefault: true });
    memory.recordTabProbe({ origin: "https://b.example", preventedDefault: true });
    memory.get({ origin: "https://a.example" });
    memory.recordTabProbe({ origin: "https://c.example", preventedDefault: true });
    expect(memory.ids).toEqual(["https://b.example", "https://c.example"]);
  });

  it("holds a snapshot to the same cap when it is restored", () => {
    const wide = new KeyMemory(50);
    for (let i = 0; i < 10; i++) wide.recordTabProbe({ origin: `https://s${i}.example`, preventedDefault: true });
    const narrow = new KeyMemory(4, wide.toJSON().entries);
    expect(narrow.size).toBe(4);
    expect(narrow.ids).toEqual(["https://s6.example", "https://s7.example", "https://s8.example", "https://s9.example"]);
  });
});

describe("KeyMemory: surviving a round trip through disk", () => {
  it("restores exactly what it saved", () => {
    const memory = new KeyMemory();
    memory.recordTabProbe({ ...SITE, preventedDefault: true });
    press(memory, "ghost-key", 2);
    const restored = KeyMemory.fromJSON(JSON.parse(JSON.stringify(memory.toJSON())) as KeyMemorySnapshot);
    expect(restored.get(SITE)).toEqual(memory.get(SITE));
    expect(restored.max).toBe(memory.max);
  });

  it("keeps nothing but counters and the flag in the snapshot", () => {
    const memory = new KeyMemory();
    memory.recordTabProbe({ origin: "https://shop.example.com/cart?coupon=SECRET", preventedDefault: true });
    const json = JSON.stringify(memory.toJSON());
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("cart");
    expect(Object.keys(memory.get({ origin: "https://shop.example.com" })).sort()).toEqual(
      ["flips", "id", "missed", "pinned", "presses", "probes", "run", "tab"],
    );
  });

  it("yields an empty store for a missing or corrupt snapshot", () => {
    expect(KeyMemory.fromJSON(null).size).toBe(0);
    expect(KeyMemory.fromJSON(undefined).size).toBe(0);
    expect(KeyMemory.fromJSON({ max: 10 } as KeyMemorySnapshot).size).toBe(0);
  });

  it("drops junk rows and repairs junk fields rather than trusting them", () => {
    const snapshot = {
      max: 9,
      entries: [
        null,
        { id: "" },
        { id: "https://ok.example", tab: "sideways", probes: { free: -3, taken: "x" }, presses: {}, missed: 1.9, run: { key: "space", count: 7 }, flips: 2, pinned: "yes" },
      ],
    } as unknown as KeyMemorySnapshot;
    const memory = KeyMemory.fromJSON(snapshot);
    expect(memory.size).toBe(1);
    const row = memory.get({ origin: "https://ok.example" });
    expect(row.tab).toBe("unknown");
    expect(row.probes).toEqual({ free: 0, taken: 0 });
    expect(row.missed).toBe(1);
    expect(row.run).toBeNull();
    expect(row.pinned).toBe(false);
    expect(row.flips).toBe(2);
  });
});

describe("observe and policy together", () => {
  const ghost = { action: "fill" } as const;
  const ask = (memory: KeyMemory) =>
    acceptKeyFor({ ...SITE, ghost, focusIsOnGhostField: true, siteState: memory.get(SITE) });

  it("a normal form: watch once, watch twice, then Tab", () => {
    const memory = new KeyMemory();
    expect(ask(memory).key).toBe("ghost-key");
    expect(ask(memory).probeTab).toBe(true);
    memory.recordTabProbe({ ...SITE, preventedDefault: false, focusMoved: true });
    expect(ask(memory).key).toBe("ghost-key");
    memory.recordTabProbe({ ...SITE, preventedDefault: false, focusMoved: true });
    expect(ask(memory).key).toBe("tab");
  });

  it("a site that preventDefaults Tab keeps it forever", () => {
    const memory = new KeyMemory();
    memory.recordTabProbe({ ...SITE, preventedDefault: true });
    expect(ask(memory).key).toBe("ghost-key");
    memory.recordTabProbe({ ...SITE, focusMoved: true });
    memory.recordTabProbe({ ...SITE, focusMoved: true });
    expect(ask(memory).key).toBe("ghost-key");
    expect(ask(memory).reason).toBe("tab-taken");
  });

  it("a user who insists on Tab gets Tab on the third press", () => {
    const memory = new KeyMemory();
    memory.recordTabProbe({ ...SITE, preventedDefault: true });
    press(memory, "tab", 2, false);
    expect(ask(memory).key).toBe("ghost-key");
    press(memory, "tab", 1, false);
    expect(ask(memory).key).toBe("tab");
  });

  it("a click ghost stays on the Shabang key however free Tab is here", () => {
    const memory = new KeyMemory();
    memory.recordTabProbe({ ...SITE, focusMoved: true });
    memory.recordTabProbe({ ...SITE, focusMoved: true });
    const choice = acceptKeyFor({ ...SITE, ghost: { action: "click" }, focusIsOnGhostField: true, siteState: memory.get(SITE) });
    expect(choice.key).toBe("ghost-key");
    expect(choice.reason).toBe("click-ghost");
  });
});

describe("isPausedApp: a list the client owns, matched generically", () => {
  const list: PauseList = { ids: ["com.example.Terminal"], prefixes: ["com.example.vault."] };

  it("matches an exact id, ignoring case", () => {
    expect(isPausedApp("com.example.terminal", list)).toBe(true);
    expect(isPausedApp("COM.EXAMPLE.TERMINAL", list)).toBe(true);
  });

  it("matches a family by prefix, which is how every build of one app is covered", () => {
    expect(isPausedApp("com.example.vault.helper", list)).toBe(true);
    expect(isPausedApp("com.example.vaulted", list)).toBe(false);
  });

  it("does not match an app that is not on the list, or no app at all", () => {
    expect(isPausedApp("com.example.mail", list)).toBe(false);
    expect(isPausedApp("", list)).toBe(false);
    expect(isPausedApp(undefined, list)).toBe(false);
    expect(isPausedApp("com.example.mail", {})).toBe(false);
  });
});
