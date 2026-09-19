import type { LoopStep } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopStepOrder } from "../src/lib/loopMessages";
import { ITEM_URL_VAR, rowVar } from "../src/lib/loopRouting";
import { createLoopExecutor, findCell, findTarget, looksLocked, nameOfTarget } from "../src/content/loopExecutor";
import type { LoopExecutor, LoopSurface } from "../src/content/loopExecutor";
import { createFrameSurface, createVisibleSurface } from "../src/content/loopSurface";
import { isSyntheticNow, resetSynthetic } from "../src/content/trace";
import { el, inboxHtml, INVOICES, invoiceHtml, mount, sheetHtml } from "./fixtures/demoPages";
import { FakeSite, invoiceProgram, SITE_ORIGIN } from "./fixtures/fakeSite";

const PROGRAM = invoiceProgram();
const FAST = { waitMs: 60, effectMs: 40, pollMs: 5 };

function order(step: LoopStep, extra: Partial<LoopStepOrder> = {}): LoopStepOrder {
  return { runId: "run-1", mode: "visible", item: 2, stepIndex: 0, step, iterator: PROGRAM.iterator, vars: {}, confirmed: true, ...extra };
}

function step<T extends LoopStep["op"]>(op: T, nth = 0): Extract<LoopStep, { op: T }> {
  const found = PROGRAM.steps.filter((s): s is Extract<LoopStep, { op: T }> => s.op === op)[nth];
  if (!found) throw new Error(`no ${op} step ${nth}`);
  return found;
}

/** The tab itself, with SPA-like links: a click on a same-origin link swaps the page without a reload. */
function visible(pages: Record<string, () => string> = {}): { surface: LoopSurface; executor: LoopExecutor; navigated: string[]; shown: string[] } {
  const navigated: string[] = [];
  const shown: string[] = [];
  document.addEventListener("click", route);
  function route(event: Event): void {
    const link = (event.target as Element).closest("a[href]");
    const path = link?.getAttribute("href") ?? "";
    event.preventDefault();
    if (pages[path]) mount(pages[path](), path);
  }
  cleanups.push(() => document.removeEventListener("click", route));
  const surface = createVisibleSurface({
    arriveMs: 80,
    navigate: (url) => void navigated.push(url),
    showTarget: async (target) => void shown.push(target.textContent?.trim().slice(0, 40) ?? ""),
  });
  return { surface, executor: createLoopExecutor(surface, FAST), navigated, shown };
}

const cleanups: Array<() => void> = [];

beforeEach(() => resetSynthetic());

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("open-item in the tab", () => {
  it("reports the item's page first and clicks the link only afterwards, marked as Ghost's own action", async () => {
    mount(inboxHtml(), "/invoices");
    const { executor, shown } = visible();
    const clicks: string[] = [];
    el('[data-invoice-id="INV-1003"] a').addEventListener("click", (event) => (event.preventDefault(), clicks.push("INV-1003")));
    const result = await executor.run(order(step("open-item")), false);
    expect(result).toMatchObject({ ok: true, extracted: { var: ITEM_URL_VAR, value: `${SITE_ORIGIN}/invoices/INV-1003` } });
    expect(clicks).toEqual([]); // a full page load would end this script: the outcome has to be on its way first
    expect(shown).toHaveLength(1);
    result.afterReport?.();
    expect(clicks).toEqual(["INV-1003"]);
    expect(isSyntheticNow()).toBe(true);
  });

  it("never opens an item that already shows a handled marker", async () => {
    mount(inboxHtml(INVOICES.map((inv, i) => ({ ...inv, replied: i === 2 }))), "/invoices");
    expect(await visible().executor.run(order(step("open-item")), false)).toEqual({ ok: false, error: "item-handled" });
  });

  it("fails when the list has no such item", async () => {
    mount(inboxHtml(), "/invoices");
    expect(await visible().executor.run(order(step("open-item"), { item: 9 }), false)).toEqual({ ok: false, error: "item-missing" });
  });

  it("goes back to the list through a route link when the tab is somewhere else", async () => {
    mount(sheetHtml(), "/sheet");
    const { executor, navigated } = visible({ "/invoices": () => inboxHtml() });
    const result = await executor.run(order(step("open-item")), false);
    expect(result.ok).toBe(true);
    expect(location.pathname).toBe("/invoices");
    expect(navigated).toEqual([]); // the SPA link was enough: no full navigation
  });

  it("falls back to a full navigation when the page offers no link, and reports failure if nothing arrives", async () => {
    mount("<main><p>Nothing to click here</p></main>", "/elsewhere");
    const { executor, navigated } = visible();
    expect(await executor.run(order(step("open-item")), false)).toEqual({ ok: false, error: "navigation-failed" });
    expect(navigated).toEqual([`${SITE_ORIGIN}/invoices`]);
  });
});

describe("extract", () => {
  const vars = { [ITEM_URL_VAR]: `${SITE_ORIGIN}/invoices/INV-1003` };

  it("reads the locator's text on the item's page", async () => {
    mount(invoiceHtml(INVOICES[2]), "/invoices/INV-1003");
    const result = await visible().executor.run(order(step("extract", 3), { vars }), false);
    expect(result).toEqual({ ok: true, extracted: { var: "total", value: "$12,004.55", confidence: 1 } });
  });

  it("applies the transform and refuses text that will not transform", async () => {
    mount(invoiceHtml(INVOICES[2]), "/invoices/INV-1003");
    const { executor } = visible();
    const total: LoopStep = { op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "total" }, transform: "number" } };
    const vendor: LoopStep = { op: "extract", var: "vendor", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" }, transform: "number" } };
    expect((await executor.run(order(total, { vars }), false)).extracted?.value).toBe("12004.55");
    expect(await executor.run(order(vendor, { vars }), false)).toEqual({ ok: false, error: "extract-untransformable" });
  });

  it("fails on a missing or empty value instead of guessing", async () => {
    mount(invoiceHtml(INVOICES[2]), "/invoices/INV-1003");
    el('[data-field="total"]').textContent = "  ";
    expect(await visible().executor.run(order(step("extract", 3), { vars }), false)).toEqual({ ok: false, error: "extract-missing" });
  });

  it("waits for a value the page renders late", async () => {
    mount(invoiceHtml(INVOICES[2]), "/invoices/INV-1003");
    el('[data-field="vendor"]').textContent = "";
    setTimeout(() => (el('[data-field="vendor"]').textContent = "Harbourlight Freight"), 20);
    expect((await visible().executor.run(order(step("extract", 0), { vars }), false)).extracted?.value).toBe("Harbourlight Freight");
  });

  it("never resolves a locator that names something sensitive, and never reports a card-like value", async () => {
    mount(`<dl><dt>Card number</dt><dd data-field="card-number">4111 1111 1111 1111</dd><dt>Ref</dt><dd data-field="ref">4111 1111 1111 1111</dd></dl>`, "/invoices/INV-1003");
    const { executor } = visible();
    const card: LoopStep = { op: "extract", var: "cardNumber", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "card-number" } } };
    const ref: LoopStep = { op: "extract", var: "ref", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "ref" } } };
    expect(await executor.run(order(card, { vars }), false)).toEqual({ ok: false, error: "sensitive" });
    expect(await executor.run(order(ref, { vars }), false)).toEqual({ ok: false, error: "extract-missing" });
  });

  it("refuses to read an item page that is not the item's own", async () => {
    mount(invoiceHtml(INVOICES[0]), "/invoices/INV-1001");
    const { executor, navigated } = visible();
    expect(await executor.run(order(step("extract", 0), { vars }), false)).toEqual({ ok: false, error: "navigation-failed" });
    expect(navigated).toEqual([`${SITE_ORIGIN}/invoices/INV-1003`]); // it tried to open the right one instead
  });
});

describe("fill", () => {
  const values = { vendor: "Harbourlight Freight", number: "INV-1003", date: "Sep 15, 2026", total: "$12,004.55" };

  it("appends to the first empty row, hands the row back, and later cells reuse it", async () => {
    mount(sheetHtml([["Thistledown Textiles", "INV-1001", "Sep 17, 2026", "$3,712.06"], ["Brightwave Supply", "INV-1002", "", ""]]), "/sheet");
    const { executor } = visible();
    const first = await executor.run(order(step("fill", 0), { vars: values }), false);
    expect(first).toEqual({ ok: true, extracted: { var: rowVar("/sheet"), value: "2", confidence: 1 } });
    expect(el<HTMLInputElement>("#cell-2-0").value).toBe("Harbourlight Freight");
    const second = await executor.run(order(step("fill", 3), { vars: { ...values, [rowVar("/sheet")]: "2" } }), false);
    expect(second).toEqual({ ok: true });
    expect(el<HTMLInputElement>("#cell-2-3").value).toBe("$12,004.55");
  });

  it("dispatches input and change so a framework sees the write, and tags it for the recorder", async () => {
    mount(sheetHtml(), "/sheet");
    const seen: string[] = [];
    const cell = el<HTMLInputElement>("#cell-0-1");
    cell.addEventListener("input", () => seen.push(`input:${cell.dataset.ghostWriting ?? ""}`));
    cell.addEventListener("change", () => seen.push("change"));
    await visible().executor.run(order(step("fill", 1), { vars: values }), false);
    expect(seen).toEqual(["input:1", "change"]);
  });

  it("stops when the value did not stick", async () => {
    mount(sheetHtml(), "/sheet");
    el<HTMLInputElement>("#cell-0-0").addEventListener("input", (event) => ((event.target as HTMLInputElement).value = ""));
    expect(await visible().executor.run(order(step("fill", 0), { vars: values }), false)).toEqual({ ok: false, error: "value-mismatch" });
  });

  it("fails without a value, without a free row, and on a sensitive field", async () => {
    mount(sheetHtml([["a", "b", "c", "d"]], 1), "/sheet");
    const { executor } = visible();
    expect(await executor.run(order(step("fill", 0), { vars: {} }), false)).toEqual({ ok: false, error: "value-missing" });
    expect(await executor.run(order(step("fill", 0), { vars: values }), false)).toEqual({ ok: false, error: "row-missing" });
    mount(`<form><label for="pw">Password</label><input id="pw" type="password"></form>`, "/sheet");
    const secret: LoopStep = { op: "fill", target: { label: "Password", kind: "text" }, value: { const: "hunter2" }, at: { origin: SITE_ORIGIN, pathPattern: "/sheet" } };
    expect((await executor.run(order(secret), false)).ok).toBe(false);
    expect(el<HTMLInputElement>("#pw").value).toBe("");
  });

  it("fills an ordinary field found by its label", async () => {
    mount(`<label for="note">Note</label><input id="note" type="text"><label for="other">Other</label><input id="other" type="text">`, "/sheet");
    const note: LoopStep = { op: "fill", target: { label: "Note", kind: "text" }, value: { const: "Received" }, at: { origin: SITE_ORIGIN, pathPattern: "/sheet" } };
    expect(await visible().executor.run(order(note), false)).toEqual({ ok: true });
    expect(el<HTMLInputElement>("#note").value).toBe("Received");
    expect(el<HTMLInputElement>("#other").value).toBe("");
  });
});

describe("click", () => {
  const vars = { [ITEM_URL_VAR]: `${SITE_ORIGIN}/invoices/INV-1003` };

  function replyPage(): { clicks: number } {
    mount(invoiceHtml(INVOICES[2]), "/invoices/INV-1003");
    const counter = { clicks: 0 };
    const button = el<HTMLButtonElement>('[data-testid="reply-received"]');
    button.addEventListener("click", () => {
      counter.clicks++;
      button.disabled = true;
      button.textContent = "Replied";
    });
    return counter;
  }

  it("runs a locked step only when the batch was confirmed AND the order is armed", async () => {
    const counter = replyPage();
    const { executor } = visible();
    const reply = step("click", 0);
    expect(await executor.run(order(reply, { vars, confirmed: false }), true)).toEqual({ ok: false, error: "locked-unconfirmed" });
    expect(await executor.run(order(reply, { vars, confirmed: true }), false)).toEqual({ ok: false, error: "locked-unconfirmed" });
    expect(counter.clicks).toBe(0);
    expect(await executor.run(order(reply, { vars, confirmed: true }), true)).toEqual({ ok: true });
    expect(counter.clicks).toBe(1);
    expect(isSyntheticNow()).toBe(true);
  });

  it("finds nothing to click once the item was replied, so a reply is never sent twice", async () => {
    const counter = replyPage();
    const { executor } = visible();
    await executor.run(order(step("click", 0), { vars }), true);
    expect(await executor.run(order(step("click", 0), { vars }), true)).toEqual({ ok: false, error: "target-missing" });
    expect(counter.clicks).toBe(1);
  });

  it("never clicks a control the page marks locked from a step recorded as unlocked", async () => {
    const counter = replyPage();
    const unlocked: LoopStep = { ...step("click", 0), locked: false };
    expect(await visible().executor.run(order(unlocked, { vars }), true)).toEqual({ ok: false, error: "locked-target" });
    expect(counter.clicks).toBe(0);
  });

  it("reports a refusal the page shows as an alert", async () => {
    mount(`<button type="button" id="send" data-ghost-lock>Send reply</button><div id="slot"></div>`, "/invoices/INV-1003");
    el("#send").addEventListener("click", () => (el("#slot").innerHTML = `<p role="alert">Write a reply before sending.</p>`));
    const send: LoopStep = { op: "click", target: { label: "Send reply", kind: "button" }, locked: true, at: { origin: SITE_ORIGIN, pathPattern: "/invoices/:id" } };
    expect(await visible().executor.run(order(send, { vars }), true)).toEqual({ ok: false, error: "action-rejected" });
  });

  it("reports a link click first and performs it afterwards", async () => {
    mount(invoiceHtml(INVOICES[2]), "/invoices/INV-1003");
    const { executor } = visible({ "/sheet": () => sheetHtml() });
    const result = await executor.run(order(step("click", 1), { vars }), false);
    expect(result.ok).toBe(true);
    expect(location.pathname).toBe("/invoices/INV-1003");
    result.afterReport?.();
    expect(location.pathname).toBe("/sheet");
  });
});

describe("goto", () => {
  it("is done when the tab already shows the page, and uses a route link otherwise", async () => {
    mount(invoiceHtml(INVOICES[2]), "/invoices/INV-1003");
    const { executor, navigated } = visible({ "/sheet": () => sheetHtml() });
    expect(await executor.run(order(step("goto")), false)).toEqual({ ok: true });
    expect(location.pathname).toBe("/sheet");
    expect(await executor.run(order(step("goto")), false)).toEqual({ ok: true });
    expect(navigated).toEqual([]);
  });

  it("never follows a url that is not http(s)", async () => {
    mount(sheetHtml(), "/invoices");
    const evil: LoopStep = { op: "goto", origin: SITE_ORIGIN, pathPattern: "/x", url: "javascript:alert(1)" };
    const { executor, navigated } = visible();
    expect((await executor.run(order(evil), false)).ok).toBe(false);
    expect(navigated).toEqual([]);
  });
});

describe("hidden frames (background mode)", () => {
  function framed(site: FakeSite): { executor: LoopExecutor; surface: ReturnType<typeof createFrameSurface> } {
    const surface = createFrameSurface({ frames: site.pool() });
    cleanups.push(() => surface.dispose());
    return { surface, executor: createLoopExecutor(surface, FAST) };
  }

  it("opens the item in a frame instead of clicking, and reads it across realms", async () => {
    const site = new FakeSite();
    site.mountInbox();
    const { executor, surface } = framed(site);
    const opened = await executor.run(order(step("open-item"), { mode: "background" }), false);
    expect(opened).toEqual({ ok: true, extracted: { var: ITEM_URL_VAR, value: `${SITE_ORIGIN}/invoices/INV-1003`, confidence: 1 } });
    expect(opened.afterReport).toBeUndefined();
    expect(location.pathname).toBe("/invoices"); // the tab never moved
    const vars = { [ITEM_URL_VAR]: `${SITE_ORIGIN}/invoices/INV-1003` };
    const read = await executor.run(order(step("extract", 0), { mode: "background", vars }), false);
    expect(read.extracted?.value).toBe("Harbourlight Freight");
    const frameDoc = surface.documentAt(`${SITE_ORIGIN}/invoices/INV-1003`);
    expect(frameDoc).not.toBeNull();
    expect(frameDoc).not.toBe(document);
  });

  it("names and locks controls of another realm without instanceof", () => {
    const site = new FakeSite();
    const frame = site.pool().acquire();
    return frame.load(`${SITE_ORIGIN}/invoices/INV-1003`, new AbortController().signal).then(() => {
      const doc = frame.document() as Document;
      const reply = findTarget(doc, { label: "Reply: received", kind: "button" });
      expect(reply?.tagName).toBe("BUTTON");
      expect(nameOfTarget(reply as Element)).toBe("Reply: received");
      expect(looksLocked(reply as Element)).toBe(true);
      const form = doc.createElement("form");
      form.innerHTML = `<button>Continue</button>`;
      doc.body.appendChild(form);
      expect(looksLocked(form.firstElementChild as Element)).toBe(true); // a submit button, seen by tag name
      expect(looksLocked(findTarget(doc, { label: "Open spreadsheet", kind: "link" }) as Element)).toBe(false);
      frame.dispose();
    });
  });

  it("skips a link that only navigates, loads the constant page once, and fills it in its own frame", async () => {
    const site = new FakeSite();
    site.mountInbox();
    const { executor } = framed(site);
    const vars = { [ITEM_URL_VAR]: `${SITE_ORIGIN}/invoices/INV-1003`, vendor: "Harbourlight Freight" };
    await executor.run(order(step("open-item"), { mode: "background" }), false);
    expect(await executor.run(order(step("click", 1), { mode: "background", vars }), false)).toEqual({ ok: true });
    expect(await executor.run(order(step("goto"), { mode: "background", vars }), false)).toEqual({ ok: true });
    const filled = await executor.run(order(step("fill", 0), { mode: "background", vars }), false);
    expect(filled).toMatchObject({ ok: true, extracted: { var: rowVar("/sheet"), value: "0" } });
    expect(site.rows).toEqual([["Harbourlight Freight", "", "", ""]]);
    expect(await executor.run(order(step("goto"), { mode: "background", vars }), false)).toEqual({ ok: true });
    expect(site.loads.filter((url) => url.endsWith("/sheet"))).toHaveLength(1);
  });

  it("never loads another origin", async () => {
    const site = new FakeSite();
    site.mountInbox();
    const { surface } = framed(site);
    expect(await surface.open("https://example.com/invoices/INV-1003", "item")).toBe(false);
    expect(site.loads).toEqual([]);
  });

  it("prepare() brings up the page of a locked step and says where it is", async () => {
    const site = new FakeSite();
    site.mountInbox();
    const { executor } = framed(site);
    const vars = { [ITEM_URL_VAR]: `${SITE_ORIGIN}/invoices/INV-1004` };
    expect(await executor.prepare(order(step("click", 0), { mode: "background", item: 3, vars }))).toEqual({
      ok: true, url: `${SITE_ORIGIN}/invoices/INV-1004`, pathPattern: "/invoices/:id",
    });
    expect(await executor.prepare(order(step("click", 0), { mode: "background", item: 3, vars: {} }))).toEqual({ ok: false, error: "page-mismatch" });
  });
});

describe("findCell", () => {
  it("skips rows that hold anything and honours the row hint", () => {
    mount(sheetHtml([["a", "", "", ""], ["", "", "", "x"]]), "/sheet");
    expect(findCell(document, "Date", null)).toMatchObject({ row: 2, el: el("#cell-2-2") });
    expect(findCell(document, "Date", 1)).toMatchObject({ row: 1, el: el("#cell-1-2") });
    expect(findCell(document, "Nope", null)).toBeNull();
  });
});
