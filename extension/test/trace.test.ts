import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectLoop, MASKED_VALUE, shapeKey, synthesizeProgram } from "@ghost/shared";
import type { FactsByUrl, TraceEvent } from "@ghost/shared";
import { sanitizeTraceEvent } from "../src/lib/loopMessages";
import type { ContentTraceEvent } from "../src/lib/loopMessages";
import { executeGhost, setNativeValue } from "../src/content/execute";
import { extractPageFacts } from "../src/content/pageFacts";
import {
  buildTarget, isSyntheticNow, markSynthetic, resetSynthetic, syncLoopCapture, SYNTHETIC_WINDOW_MS, TraceRecorder, withSynthetic,
} from "../src/content/trace";
import type { TraceMessage, TraceRecorderOptions } from "../src/content/trace";
import { el, inboxHtml, INVOICES, invoiceHtml, mount, sheetHtml } from "./fixtures/demoPages";

const INBOX_SIGNATURE = "list|ul|list|invoice-list||invoice emails|";
const ORIGIN = "http://localhost:3000";

let sent: ContentTraceEvent[];
let recorder: TraceRecorder | null;
let clock: number;

function start(opts: Partial<TraceRecorderOptions> = {}): TraceRecorder {
  recorder = new TraceRecorder({
    send: (message: TraceMessage) => void sent.push(message.event),
    isTrusted: () => true,
    now: () => ++clock,
    ...opts,
  });
  recorder.start();
  sent.length = 0; // drop the arrival "navigate"
  return recorder;
}

function click(target: Element): void {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function type(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  input.focus();
  for (let i = 1; i <= text.length; i++) {
    setNativeValue(input, text.slice(0, i));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function commit(input: HTMLElement): void {
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
}

beforeEach(() => {
  sent = [];
  recorder = null;
  clock = 1000;
  resetSynthetic();
  mount("");
  // Links in the fixtures must not make jsdom navigate.
  window.addEventListener("click", preventNavigation);
});

afterEach(() => {
  recorder?.stop();
  syncLoopCapture(false);
  window.removeEventListener("click", preventNavigation);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function preventNavigation(event: Event): void {
  if ((event.target as Element).closest("a")) event.preventDefault();
}

describe("clicks", () => {
  it("records ARIA and custom app controls with the same kinds used by prediction", () => {
    mount(`
      <div role="tab" aria-label="Activity"></div>
      <div role="link" aria-label="Open dashboard"></div>
      <div onclick="void 0" aria-label="Custom action"></div>`, "/app");
    start();
    click(el('[role="tab"]'));
    click(el('[role="link"]'));
    click(el("[onclick]"));
    expect(sent.map((event) => [event.target?.label, event.target?.kind])).toEqual([
      ["Activity", "button"],
      ["Open dashboard", "link"],
      ["Custom action", "button"],
    ]);
  });

  it("records an inbox row click with its list position, never the row's values in the shape", () => {
    mount(inboxHtml(), "/invoices");
    start();
    click(el('[data-invoice-id="INV-1002"] .inv-row-total'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      t: 1002, type: "click", origin: ORIGIN, pathPattern: "/invoices", url: `${ORIGIN}/invoices`,
      target: {
        signature: expect.stringContaining("a|"), label: "Invoice INV-1002 from Brightwave Supply", kind: "link", locked: false,
        list: { listSignature: INBOX_SIGNATURE, index: 1, itemKey: "Invoice INV-1002 from Brightwave Supply" },
      },
    });
    expect(shapeKey({ ...(sent[0] as ContentTraceEvent), tabId: 1 })).toBe(`click|/invoices|LIST(${INBOX_SIGNATURE})`);
  });

  it("marks locked buttons and keeps the url free of query and fragment", () => {
    mount(invoiceHtml(), "/invoices/INV-1001?from=inbox#fields");
    start();
    click(el('[data-testid="reply-received"]'));
    expect(sent[0]).toMatchObject({
      type: "click", pathPattern: "/invoices/:id", url: `${ORIGIN}/invoices/INV-1001`,
      target: { label: "Reply: received", kind: "button", locked: true },
    });
    expect(sent[0]?.target?.list).toBeUndefined();
  });

  it("ignores clicks that hit nothing, that focus a field, or that land on Ghost's own UI", () => {
    mount(`${sheetHtml()}<div id="ghost-overlay-host"><button id="hud">HUD</button></div><label for="cell-0-0" id="lab">Vendor</label>`, "/sheet");
    start();
    click(el("h1"));
    click(el("#cell-0-0"));
    click(el("#lab"));
    click(el("#hud"));
    expect(sent).toEqual([]);
  });

  it("records a row that is itself the control, but not blank space in a row that has a link", () => {
    mount(`<ul aria-label="Files"><li tabindex="0" id="f0"><span>report.pdf</span></li><li tabindex="0"><span>notes.txt</span></li></ul>${inboxHtml()}`, "/files");
    start();
    click(el("#f0 span"));
    click(el('[data-invoice-id="INV-1001"]'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({
      signature: "item|list|ul||||files|", label: "report.pdf", kind: "other", locked: false,
      list: { listSignature: "list|ul||||files|", index: 0, itemKey: "report.pdf" },
    });
  });

  it("ignores untrusted clicks from page scripts unless Ghost announced them", () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    start({ isTrusted: (event) => event.isTrusted });
    click(el('a[href="/sheet"].lb-button'));
    expect(sent).toEqual([]);
    markSynthetic();
    click(el('a[href="/sheet"].lb-button'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "click", synthetic: true, target: { label: "Open spreadsheet" } });
  });
});

describe("Ghost's own executor", () => {
  it("has its clicks and fills recorded as synthetic, so they never count as the user doing it twice", async () => {
    mount(`${sheetHtml()}<a id="next" href="/invoices">Back</a>`, "/sheet");
    start({ isTrusted: (event) => event.isTrusted });
    const ghost = { signature: "s", displayText: "", confidence: 0.9, locked: false, source: "loop" } as const;
    await executeGhost({ ...ghost, action: "fill", value: "Thistledown Textiles" }, el("#cell-0-0"));
    await executeGhost({ ...ghost, action: "click" }, el("#next"));
    expect(sent.map((e) => [e.type, e.synthetic, e.value])).toEqual([["input", true, "Thistledown Textiles"], ["click", true, undefined]]);
    const events = sent.map((e) => ({ ...e, tabId: 1 }));
    expect(detectLoop([...events, ...events, ...events], clock + 1, { minLength: 1 })).toBeNull();
  });

  it("refuses a locked target and records nothing", async () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    start({ isTrusted: (event) => event.isTrusted });
    const result = await executeGhost({ signature: "s", displayText: "", confidence: 1, locked: false, source: "loop", action: "click" }, el('[data-testid="reply-received"]'));
    expect(result).toMatchObject({ ok: false, reason: "locked" });
    expect(sent).toEqual([]);
  });
});

describe("field edits", () => {
  it("emits ONE input event per edit with the final value and the grid cell", () => {
    mount(sheetHtml(), "/sheet");
    start();
    const cell = el<HTMLInputElement>("#cell-0-1");
    type(cell, "INV-1001");
    expect(sent).toEqual([]);
    commit(cell);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "input", pathPattern: "/sheet", value: "INV-1001",
      target: { label: "Invoice # row 1", kind: "text", locked: false, cell: { row: 0, col: 1, colHeader: "Invoice #" } },
    });
    expect(sent[0]?.synthetic).toBeUndefined();
    expect(shapeKey({ ...(sent[0] as ContentTraceEvent), tabId: 1 })).toBe("input|/sheet|CELL(Invoice #)");
  });

  it("commits on blur when no change event arrives, and only once when both do", () => {
    mount(sheetHtml(), "/sheet");
    start();
    const cell = el<HTMLInputElement>("#cell-2-0");
    type(cell, "Acme");
    cell.blur();
    expect(sent.map((e) => e.value)).toEqual(["Acme"]);
    type(cell, "Acme Ltd");
    commit(cell);
    expect(sent.map((e) => e.value)).toEqual(["Acme", "Acme Ltd"]);
  });

  it("records a change that came without input events (autofill, pickers)", () => {
    mount(`<label for="d">Due date</label><input id="d" type="date">`);
    start();
    el<HTMLInputElement>("#d").value = "2026-10-17";
    el("#d").dispatchEvent(new Event("change", { bubbles: true }));
    expect(sent).toMatchObject([{ type: "input", value: "2026-10-17", target: { label: "Due date", kind: "date" } }]);
  });

  it("tags Ghost's own writes as synthetic, and hands the edit back to the user when they retype", () => {
    mount(sheetHtml(), "/sheet");
    start({ isTrusted: (event) => event.isTrusted });
    const cell = el<HTMLInputElement>("#cell-0-0");
    cell.dataset.ghostWriting = "1";
    type(cell, "Thistledown Textiles");
    cell.dispatchEvent(new Event("change", { bubbles: true }));
    delete cell.dataset.ghostWriting;
    expect(sent).toMatchObject([{ type: "input", value: "Thistledown Textiles", synthetic: true }]);

    type(cell, "scripted"); // an untrusted page script: nobody's action
    cell.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sent).toHaveLength(1);
  });

  it("lets the last writer own the value", () => {
    mount(sheetHtml(), "/sheet");
    start();
    const cell = el<HTMLInputElement>("#cell-0-0");
    cell.dataset.ghostWriting = "1";
    type(cell, "Ghost");
    delete cell.dataset.ghostWriting;
    type(cell, "Ghost, fixed by hand");
    commit(cell);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.synthetic).toBeUndefined();
  });

  it("records selects and toggles with their value", () => {
    mount(`<form><label for="c">Country</label><select id="c"><option value="">Pick</option><option value="CA">Canada</option></select>
      <label><input type="checkbox" id="news"> Newsletter</label>
      <fieldset><legend>Plan</legend><label><input type="radio" name="plan" value="free" id="free"> Free</label>
      <label><input type="radio" name="plan" value="pro" id="pro"> Pro</label></fieldset></form>`);
    start();
    el<HTMLSelectElement>("#c").value = "CA";
    el("#c").dispatchEvent(new Event("change", { bubbles: true }));
    el<HTMLInputElement>("#news").click();
    el<HTMLInputElement>("#pro").click();
    expect(sent.map((e) => [e.type, e.target?.label, e.target?.kind, e.value])).toEqual([
      ["select", "Country", "select", "CA"], ["check", "Newsletter", "checkbox", "true"], ["check", "Plan", "radio", "pro"],
    ]);
  });
});

describe("sensitive fields", () => {
  const FORM = `<form aria-label="Checkout">
    <label for="pw">Password</label><input id="pw" type="password">
    <label for="card">Card number</label><input id="card" autocomplete="cc-number">
    <label for="sin">Social Insurance Number</label><input id="sin">
    <div data-ghost-sensitive><label for="memo">Memo</label><input id="memo"><button type="button" id="reveal">Reveal</button></div>
    <label for="note">Order note</label><input id="note">
    <label><input type="checkbox" id="save-card"> Save card number</label>
    <button type="button" id="show">Show password</button></form>`;

  it("records nothing at all for them: no input, no check, no click", () => {
    mount(FORM, "/checkout");
    start();
    for (const id of ["pw", "card", "sin", "memo"]) {
      type(el<HTMLInputElement>(`#${id}`), "4111 1111 1111 1111");
      commit(el(`#${id}`));
    }
    el<HTMLInputElement>("#save-card").click();
    click(el("#reveal"));
    click(el("#show"));
    expect(sent).toEqual([]);
    expect(buildTarget(el("#card"))).toBeNull();
  });

  it("masks a value that looks like a card number or an SSN in an innocent field", () => {
    mount(FORM, "/checkout");
    start();
    type(el<HTMLInputElement>("#note"), "use 4111 1111 1111 1111");
    commit(el("#note"));
    type(el<HTMLInputElement>("#note"), "leave at the door");
    commit(el("#note"));
    expect(sent.map((e) => e.value)).toEqual([MASKED_VALUE, "leave at the door"]);
  });

  it("masks the value when the field turned sensitive during the edit", () => {
    mount(FORM, "/checkout");
    start();
    const note = el<HTMLInputElement>("#note");
    type(note, "hunter2");
    note.setAttribute("autocomplete", "current-password");
    commit(note);
    expect(sent.map((e) => e.value)).toEqual([MASKED_VALUE]);
    expect(JSON.stringify(sent)).not.toContain("hunter2");
  });
});

describe("submit and navigation", () => {
  it("flushes pending edits of the form, then records a locked submit", () => {
    mount(`<form aria-label="Contact"><label for="n">Name</label><input id="n"><button id="go">Send message</button></form>`, "/contact");
    start();
    el("form").addEventListener("submit", (event) => event.preventDefault());
    type(el<HTMLInputElement>("#n"), "Alex Chen");
    el("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(sent.map((e) => [e.type, e.target?.label, e.target?.locked, e.value])).toEqual([
      ["input", "Name", false, "Alex Chen"], ["submit", "Contact", true, undefined],
    ]);
  });

  it("reports arriving on a page, SPA route changes, and nothing for query or anchor changes", () => {
    vi.useFakeTimers();
    mount(inboxHtml(), "/invoices");
    const all: ContentTraceEvent[] = [];
    recorder = new TraceRecorder({ send: (m) => void all.push(m.event), isTrusted: () => true });
    recorder.start();
    expect(all).toMatchObject([{ type: "navigate", pathPattern: "/invoices", url: `${ORIGIN}/invoices` }]);
    expect(all[0]?.target).toBeUndefined();

    window.history.pushState(null, "", "/invoices?filter=unread#top");
    vi.advanceTimersByTime(600);
    expect(all).toHaveLength(1);

    window.history.pushState(null, "", "/invoices/INV-1001");
    vi.advanceTimersByTime(600);
    expect(all.map((e) => [e.type, e.pathPattern])).toEqual([["navigate", "/invoices"], ["navigate", "/invoices/:id"]]);
  });

  it("reports a pending edit with the page it happened on, before the navigation", () => {
    vi.useFakeTimers();
    mount(sheetHtml(), "/sheet");
    start();
    type(el<HTMLInputElement>("#cell-0-3"), "$3,712.06");
    window.history.pushState(null, "", "/invoices");
    vi.advanceTimersByTime(600);
    expect(sent.map((e) => [e.type, e.pathPattern, e.value])).toEqual([["input", "/sheet", "$3,712.06"], ["navigate", "/invoices", undefined]]);
  });

  it("tags a navigation inside the synthetic window", async () => {
    vi.useFakeTimers();
    mount(inboxHtml(), "/invoices");
    start();
    await withSynthetic(() => window.history.pushState(null, "", "/sheet"));
    expect(isSyntheticNow()).toBe(true);
    vi.advanceTimersByTime(SYNTHETIC_WINDOW_MS - 50);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(sent).toMatchObject([{ type: "navigate", pathPattern: "/sheet", synthetic: true }]);
    vi.advanceTimersByTime(SYNTHETIC_WINDOW_MS);
    expect(isSyntheticNow()).toBe(false);
  });
});

describe("lifecycle and wiring", () => {
  it("stops listening", () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    const r = start();
    r.stop();
    click(el('[data-testid="reply-received"]'));
    expect(sent).toEqual([]);
  });

  it("tells the facts watcher about the list and flushes it before the click is reported", () => {
    mount(inboxHtml(), "/invoices");
    const order: string[] = [];
    const facts = { noteList: vi.fn(() => void order.push("note")), flush: vi.fn(() => void order.push("flush")) };
    start({ facts, send: () => void order.push("send") });
    order.length = 0; // the arrival "navigate"
    click(el('[data-invoice-id="INV-1001"] a'));
    expect(order).toEqual(["note", "flush", "send"]);
    expect(facts.noteList).toHaveBeenCalledWith(el('[data-testid="invoice-list"]'));
  });

  it("syncLoopCapture sends trace events and page facts through chrome.runtime, and stops when disabled", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    mount(invoiceHtml(), "/invoices/INV-1001");
    syncLoopCapture(true);
    syncLoopCapture(true);
    await vi.advanceTimersByTimeAsync(400);
    const types = sendMessage.mock.calls.map((call) => (call as unknown as [{ type: string }])[0].type);
    expect(types).toEqual(["ghost:trace-event", "ghost:page-facts"]);
    syncLoopCapture(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("survives a missing chrome and a rejecting worker", async () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    expect(() => new TraceRecorder({ isTrusted: () => true }).start()).not.toThrow();
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => Promise.reject(new Error("no receiver"))) } });
    const r = new TraceRecorder({ isTrusted: () => true });
    r.start();
    click(el('[data-testid="reply-received"]'));
    await Promise.resolve();
    r.stop();
  });
});

describe("the whole demo loop", () => {
  const factsByUrl: FactsByUrl = {};

  function visit(html: string, path: string): void {
    mount(html, path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    factsByUrl[`${ORIGIN}${path}`] = extractPageFacts(document);
  }

  function doInvoice(index: number): void {
    const inv = INVOICES[index];
    if (!inv) throw new Error("no such invoice");
    click(el(`[data-invoice-id="${inv.id}"] a`));
    visit(invoiceHtml(inv), `/invoices/${inv.id}`);
    click(el('[data-testid="reply-received"]'));
    click(el("a.lb-button"));
    visit(sheetHtml(), "/sheet");
    [inv.vendor, inv.id, inv.date, inv.total].forEach((value, col) => {
      const cell = el<HTMLInputElement>(`#cell-${index}-${col}`);
      type(cell, value);
      commit(cell);
    });
    click(el(".sheet-toolbar a"));
    visit(inboxHtml(), "/invoices");
  }

  it("produces events the worker accepts and the detector sees as a loop after two invoices", () => {
    mount(inboxHtml(), "/invoices");
    start();
    doInvoice(0);
    doInvoice(1);
    const events: TraceEvent[] = sent.map((event) => {
      const clean = sanitizeTraceEvent(JSON.parse(JSON.stringify(event)));
      expect(clean).toEqual(event);
      return { ...(clean as ContentTraceEvent), tabId: 7 };
    });
    const loop = detectLoop(events, clock + 1);
    expect(loop?.length).toBe(11);
    expect(loop?.runB.find((e) => e.target?.list)?.target?.list).toMatchObject({ index: 1, listSignature: INBOX_SIGNATURE });
    expect(loop?.runB.filter((e) => e.type === "input").map((e) => [e.target?.cell?.row, e.target?.cell?.colHeader, e.value])).toEqual([
      [1, "Vendor", "Brightwave Supply"], [1, "Invoice #", "INV-1002"], [1, "Date", "Sep 16, 2026"], [1, "Total", "$918.40"],
    ]);

    const program = loop ? synthesizeProgram(loop, factsByUrl) : null;
    expect(program?.iterator).toMatchObject({ pathPattern: "/invoices", listSignature: INBOX_SIGNATURE, stride: 1, nextIndex: 2 });
    expect(program?.unresolved ?? []).toEqual([]);
    const extracts = (program?.steps ?? []).flatMap((step) => (step.op === "extract" ? [step.from] : []));
    expect(extracts).toEqual(["vendor", "number", "date", "total"].map((value) => ({ pathPattern: "/invoices/:id", locator: { by: "data-field", value } })));
    expect(program?.irreversible.map((effect) => effect.description)).toEqual([expect.stringContaining("Reply: received")]);
  });
});
