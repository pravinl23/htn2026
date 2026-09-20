// The whole "Do it twice, Ghost does the rest" run with fakes: the real sheet (LoopPanel), the real content entry,
// driver and executor, the real background runner and state machine, against jsdom copies of the demo pages.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopMessage, LoopProposal } from "../src/lib/loopMessages";
import { createEpisodicMemory } from "../src/background/episodic";
import { createMemoryKv } from "../src/background/kvStorage";
import { createLoopBackground } from "../src/background/loopBackground";
import type { LoopBackground } from "../src/background/loopBackground";
import { createLoopRunner } from "../src/background/loopRunner";
import { createLoopStateStore } from "../src/background/loopState";
import type { LoopStateStore } from "../src/background/loopState";
import { createLoopWatcher } from "../src/background/loopWatcher";
import { createTraceRouter } from "../src/background/traceRouter";
import { createTraceStore } from "../src/background/traceStore";
import { startLoopContent } from "../src/content/loopContent";
import type { LoopContentHandle } from "../src/content/loopContent";
import { resetSynthetic } from "../src/content/trace";
import { INVOICES, mount, sheetHtml } from "./fixtures/demoPages";
import { FakeSite, invoiceProgram, SITE_ORIGIN } from "./fixtures/fakeSite";

const EXTENSION = "ghost-extension-id";
const TAB = 1;
const PROPOSAL: LoopProposal = { program: invoiceProgram(2), remaining: [2, 3, 4], total: 5 };
const FIRST_TWO = INVOICES.slice(0, 2).map((inv) => [inv.vendor, inv.id, inv.date, inv.total]);
const rowOf = (index: number): string[] => {
  const inv = INVOICES[index];
  if (!inv) throw new Error("no such invoice");
  return [inv.vendor, inv.id, inv.date, inv.total];
};

interface Page {
  handle: LoopContentHandle;
  paused: boolean[];
  /** The content script is gone (page reload, extension reload): nothing it sends arrives any more. */
  kill(): void;
}

interface World {
  site: FakeSite;
  loopState: LoopStateStore;
  background: LoopBackground;
  sent: LoopMessage[];
  propose(): Promise<void>;
  openPage(): Page;
}

function world(): World {
  const site = new FakeSite();
  site.rows.push(...FIRST_TWO); // the two runs the user did by hand
  site.replied.add("INV-1001").add("INV-1002");
  site.mountInbox();
  const storage = createMemoryKv();
  const loopState = createLoopStateStore({ storage });
  const tabListeners = new Set<(message: unknown) => void>();
  const emit = (_tabId: number, message: unknown): void => {
    for (const listener of [...tabListeners]) listener(JSON.parse(JSON.stringify(message)));
  };
  const trace = createTraceStore({ storage });
  const watcher = createLoopWatcher({ trace, emit, storage });
  const router = createTraceRouter({
    services: { trace, memory: createEpisodicMemory({ storage }), loopState, watcher }, extensionId: EXTENSION, isEnabled: async () => true,
  });
  let runs = 0;
  const runner = createLoopRunner({ loopState, storage, emit, newRunId: () => `run-${++runs}` });
  const background = createLoopBackground({ router, runner, extensionId: EXTENSION, executors: async () => [] });
  const sent: LoopMessage[] = [];

  function openPage(): Page {
    let dead = false;
    const paused: boolean[] = [];
    const handle = startLoopContent({
      // Like chrome.runtime.sendMessage: JSON in, JSON out, stamped with this tab by the browser, not by the page.
      send: async (message) => {
        if (dead) throw new Error("Extension context invalidated.");
        sent.push(message);
        const reply = await background.handle(JSON.parse(JSON.stringify(message)), { id: EXTENSION, origin: SITE_ORIGIN, tab: { id: TAB } });
        return reply === undefined ? undefined : JSON.parse(JSON.stringify(reply));
      },
      listen: (handler) => {
        const guarded = (message: unknown): void => void (dead || handler(message));
        tabListeners.add(guarded);
        return () => tabListeners.delete(guarded);
      },
      frames: () => site.pool(),
      isUserEvent: () => true, // jsdom cannot mint trusted events
      pauseGhosts: (value) => void paused.push(value),
      executor: { waitMs: 150, effectMs: 40, pollMs: 5 },
      preview: { locatorTimeoutMs: 200, graceMs: 10 },
      glideMs: 0,
    });
    pages.push(handle);
    return { handle, paused, kill: () => void (dead = true) };
  }

  return {
    site, loopState, background, sent, openPage,
    async propose() {
      await loopState.dispatch({ type: "propose", proposal: PROPOSAL, tabId: TAB });
      emit(TAB, { type: "ghost:loop-proposal", ...PROPOSAL });
    },
  };
}

const pages: LoopContentHandle[] = [];

function host(): HTMLElement {
  const el = document.getElementById("ghost-loop-host");
  if (!el) throw new Error("the sheet is not mounted");
  return el;
}

function part<T extends HTMLElement>(page: Page, selector: string): T {
  const el = page.handle.panel.shadow?.querySelector<T>(selector);
  if (!el) throw new Error(`the sheet has no ${selector}`);
  return el;
}

const hostState = (name: string): string | undefined => document.getElementById("ghost-loop-host")?.getAttribute(name) ?? undefined;
const until = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 8000, interval: 10 });

async function previewed(w: World): Promise<Page> {
  const page = w.openPage();
  await w.propose();
  await until(() => expect(hostState("data-loop-preview")).toBe("ready"));
  return page;
}

function confirmInBackground(page: Page): void {
  part<HTMLButtonElement>(page, '.mode[data-mode="background"]').click();
  part<HTMLButtonElement>(page, "button.confirm").click();
}

beforeEach(() => resetSynthetic());

afterEach(() => {
  for (const page of pages.splice(0)) page.stop();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the canonical invoice loop in background mode", () => {
  it("previews the remaining items without touching anything", async () => {
    const w = world();
    const page = await previewed(w);
    expect(host().getAttribute("data-loop-state")).toBe("proposed");
    expect(host().getAttribute("data-loop-remaining")).toBe("3");
    expect(page.handle.panel.shadow?.textContent).toContain("Harbourlight Freight");
    expect(page.handle.panel.shadow?.textContent).toContain("Reply: received x 3");
    expect(page.paused).toEqual([true]); // the Tab walk steps aside while the sheet is open
    expect(w.site.replyClicks).toEqual([]);
    expect(w.site.rows).toEqual(FIRST_TWO);
    expect(w.sent.some((m) => m.type === "ghost:loop-start")).toBe(false);
  });

  it("runs items 3 to 5: rows appended in order, one reply each, the tab never moves", async () => {
    const w = world();
    const page = await previewed(w);
    confirmInBackground(page);
    await until(() => expect(hostState("data-loop-state")).toBe("done"));
    expect(w.site.rows).toEqual([...FIRST_TWO, rowOf(2), rowOf(3), rowOf(4)]);
    expect(w.site.replyClicks).toEqual(["INV-1003", "INV-1004", "INV-1005"]);
    expect(location.pathname).toBe("/invoices");
    expect(document.querySelectorAll('[data-testid="invoice-row"].replied')).toHaveLength(5); // the visible list updated live
    const state = await w.loopState.get();
    expect(state).toMatchObject({ phase: "done", mode: "background", irreversibleDone: 3 });
    expect(host().getAttribute("data-loop-progress")).toBe("3/3");
    expect(w.site.loads.filter((url) => url.endsWith("/sheet"))).toHaveLength(1); // the constant page is loaded once
    const start = w.sent.filter((m) => m.type === "ghost:loop-start");
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ confirmIrreversible: true, mode: "background", items: [2, 3, 4], rows: [{ index: 2, vars: { vendor: "Harbourlight Freight" } }, {}, {}] });
  });

  it("closing the final report hands Tab back and resets the worker", async () => {
    const w = world();
    const page = await previewed(w);
    confirmInBackground(page);
    await until(() => expect(hostState("data-loop-state")).toBe("done"));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, composed: true }));
    await until(async () => expect((await w.loopState.get()).phase).toBe("idle"));
    expect(page.paused).toEqual([true, false]);
    expect(document.getElementById("ghost-dryrun-host")).toBeNull();
  });

  it("does nothing irreversible when the proposal is dismissed", async () => {
    const w = world();
    const page = await previewed(w);
    part<HTMLButtonElement>(page, "button.later").click();
    await until(async () => expect((await w.loopState.get()).phase).toBe("idle"));
    expect(w.sent.map((m) => m.type)).toContain("ghost:loop-dismiss");
    expect(w.site.replyClicks).toEqual([]);
    expect(w.site.rows).toEqual(FIRST_TWO);
    expect(page.paused).toEqual([true, false]);
  });

  it("runs only the checked items", async () => {
    const w = world();
    const page = await previewed(w);
    part<HTMLInputElement>(page, 'tbody tr[data-index="3"] input').click();
    confirmInBackground(page);
    await until(() => expect(hostState("data-loop-state")).toBe("done"));
    expect(w.site.replyClicks).toEqual(["INV-1003", "INV-1005"]);
    expect(w.site.rows).toEqual([...FIRST_TWO, rowOf(2), rowOf(4)]);
  });

  it("stops the whole run on a verification mismatch and reports the failing item", async () => {
    const w = world();
    w.site.rejectCell = (value) => value === "Quillon Print Works"; // the sheet throws INV-1004's vendor away
    const page = await previewed(w);
    confirmInBackground(page);
    await until(() => expect(hostState("data-loop-state")).toBe("failed"));
    const state = await w.loopState.get();
    expect(state.failure).toMatchObject({ item: 3, reason: "value-mismatch" });
    expect(state.items).toEqual([{ index: 2, status: "done" }, { index: 3, status: "failed", error: "value-mismatch" }, { index: 4, status: "skipped" }]);
    expect(w.site.rows).toEqual([...FIRST_TWO, rowOf(2)]);
    expect(w.site.replyClicks).toEqual(["INV-1003", "INV-1004"]); // item 5 was never opened
    expect(page.handle.panel.shadow?.querySelector('tbody tr[data-index="3"]')?.textContent).toContain("Quillon");
  });

  it("stops when a page no longer shows what the user confirmed", async () => {
    const w = world();
    const page = await previewed(w);
    w.site.patchInvoice = (inv) => (inv.id === "INV-1004" ? { ...inv, total: "$99,999.00" } : inv);
    confirmInBackground(page);
    await until(() => expect(hostState("data-loop-state")).toBe("failed"));
    expect((await w.loopState.get()).failure).toMatchObject({ item: 3, reason: "value-changed" });
    expect(w.site.replyClicks).toEqual(["INV-1003"]); // the changed invoice was never replied to
  });

  it("cancels mid-run: the current item stops, the rest never starts", async () => {
    const w = world();
    const page = await previewed(w);
    w.site.onReply = (id) => {
      if (id === "INV-1004") part<HTMLButtonElement>(page, "button.cancel").click();
    };
    confirmInBackground(page);
    await until(() => expect(hostState("data-loop-cancelled")).toBe("true"));
    const state = await w.loopState.get();
    expect(state.phase).toBe("cancelled");
    expect(state.items.map((item) => item.status)).toEqual(["done", "skipped", "skipped"]);
    await new Promise((resolve) => setTimeout(resolve, 150)); // nothing keeps running behind the report
    expect(w.site.replyClicks).toEqual(["INV-1003", "INV-1004"]);
    expect(w.site.rows).toEqual([...FIRST_TWO, rowOf(2)]);
  });

  it("a content script that reloads mid-run resumes at the pending step, without a duplicate row", async () => {
    const w = world();
    const first = await previewed(w);
    w.site.onCell = (value) => {
      if (value !== "Quillon Print Works") return;
      w.site.onCell = null;
      first.kill(); // the cell was written, the result never reaches the worker
      setTimeout(() => first.handle.stop(), 0);
    };
    confirmInBackground(first);
    await until(() => expect(document.getElementById("ghost-loop-host")).toBeNull());
    expect((await w.loopState.get()).phase).toBe("running");

    const second = w.openPage(); // the page is back: it asks "ghost:loop-state?" and picks the run up
    await until(() => expect(hostState("data-loop-state")).toBe("done"));
    expect(w.site.rows).toEqual([...FIRST_TWO, rowOf(2), rowOf(3), rowOf(4)]);
    expect(w.site.replyClicks).toEqual(["INV-1003", "INV-1004", "INV-1005"]);
    expect(second.paused[0]).toBe(true);
  });

  it("never retries an irreversible step: a reply whose result was lost stops the run", async () => {
    const w = world();
    const first = await previewed(w);
    w.site.onReply = (id) => {
      if (id !== "INV-1004") return;
      first.kill(); // the click landed, the page died before reporting it
      setTimeout(() => first.handle.stop(), 0);
    };
    confirmInBackground(first);
    await until(() => expect(document.getElementById("ghost-loop-host")).toBeNull());

    w.openPage();
    await until(() => expect(hostState("data-loop-state")).toBe("failed"));
    expect((await w.loopState.get()).failure).toMatchObject({ item: 3, reason: "irreversible-unverified" });
    expect(w.site.replyClicks).toEqual(["INV-1003", "INV-1004"]); // exactly one click for INV-1004
  });
});

describe("showing the sheet", () => {
  it("waits for the list page when the proposal arrives somewhere else", async () => {
    const w = world();
    mount(sheetHtml(), "/sheet");
    w.openPage();
    await w.propose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.getElementById("ghost-loop-host")?.getAttribute("data-loop-state") ?? "hidden").toBe("hidden");
    w.site.mountInbox();
    await until(() => expect(hostState("data-loop-state")).toBe("proposed"));
  });

  it("rebuilds the proposal from the worker's state after a page load", async () => {
    const w = world();
    await w.loopState.dispatch({ type: "propose", proposal: PROPOSAL, tabId: TAB });
    w.openPage(); // no proposal message: the fresh page asks
    await until(() => expect(hostState("data-loop-state")).toBe("proposed"));
  });

  it("stays out of the way while Ghost is switched off", async () => {
    const w = world();
    const handle = startLoopContent({ isEnabled: () => false, send: async () => ({ phase: "proposed", proposal: PROPOSAL }), listen: () => () => undefined });
    pages.push(handle);
    await handle.sync();
    expect(document.getElementById("ghost-loop-host")).toBeNull();
    expect(w.site.replyClicks).toEqual([]);
  });

  it("only listens to its own worker", async () => {
    const listeners: Array<(message: unknown, sender: { id?: string; tab?: unknown }) => void> = [];
    vi.stubGlobal("chrome", {
      runtime: {
        id: EXTENSION, sendMessage: vi.fn(async () => ({ phase: "idle" })),
        onMessage: { addListener: (fn: (typeof listeners)[number]) => void listeners.push(fn), removeListener: vi.fn() },
      },
    });
    world();
    pages.push(startLoopContent({ frames: () => new FakeSite().pool() }));
    const proposal = { type: "ghost:loop-proposal", ...PROPOSAL };
    listeners[0]?.(proposal, { id: "another-extension" });
    listeners[0]?.(proposal, { id: EXTENSION, tab: { id: 5 } }); // another tab's content script, not the worker
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(document.getElementById("ghost-loop-host")).toBeNull();
    listeners[0]?.(proposal, { id: EXTENSION });
    await until(() => expect(hostState("data-loop-state")).toBe("proposed"));
  });
});
