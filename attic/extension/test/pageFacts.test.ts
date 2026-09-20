import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactLocator, PageFact } from "@ghost/shared";
import { LIST_HANDLED_LABEL, LIST_LENGTH_LABEL, sanitizePageFacts } from "../src/lib/loopMessages";
import {
  extractListFacts, extractPageFacts, FACTS_DEBOUNCE_MS, looksSensitiveValue, MAX_FACTS, PageFactsWatcher, readLocator,
  resolveLocator, sendPageFacts,
} from "../src/content/pageFacts";
import type { PageFactsMessage } from "../src/content/pageFacts";
import { LIST_HANDLED_LABEL as STORE_HANDLED, LIST_LENGTH_LABEL as STORE_LENGTH } from "../src/background/traceStore";
import { el, inboxHtml, INVOICES, invoiceHtml, mount, sheetHtml } from "./fixtures/demoPages";

const INBOX_SIGNATURE = "list|ul|list|invoice-list||invoice emails|";

function fact(facts: PageFact[], by: FactLocator["by"], value: string): PageFact | undefined {
  return facts.find((f) => f.locator.by === by && f.locator.value === value);
}

beforeEach(() => mount(""));

describe("extractPageFacts on the invoice view", () => {
  it("reads every data-field with its dt as the label", () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    const facts = extractPageFacts(document);
    expect(fact(facts, "data-field", "vendor")).toEqual({ locator: { by: "data-field", value: "vendor" }, label: "Vendor", text: "Thistledown Textiles" });
    expect(fact(facts, "data-field", "number")).toMatchObject({ label: "Invoice number", text: "INV-1001" });
    expect(fact(facts, "data-field", "date")).toMatchObject({ label: "Invoice date", text: "Sep 17, 2026" });
    expect(fact(facts, "data-field", "total")).toMatchObject({ label: "Total", text: "$3,712.06" });
    expect(fact(facts, "data-field", "tax-rate")).toMatchObject({ label: "Tax rate", text: "13%" });
  });

  it("puts data-field facts first, then plain dt/dd pairs, then headings", () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    const facts = extractPageFacts(document);
    const order = facts.map((f) => f.locator.by);
    expect(order.indexOf("data-field")).toBe(0);
    expect(order.lastIndexOf("data-field")).toBeLessThan(order.indexOf("label"));
    expect(fact(facts, "label", "Received")).toMatchObject({ text: "Sep 17, 2026, 9:05 AM" });
    expect(fact(facts, "label", "From")?.text).toContain("Thistledown Textiles");
    expect(fact(facts, "id", "email-subject")).toMatchObject({ label: "Page heading", text: "Invoice INV-1001 from Thistledown Textiles" });
  });

  it("never reports buttons, containers or an element twice", () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    const facts = extractPageFacts(document);
    expect(fact(facts, "testid", "reply-received")).toBeUndefined();
    expect(fact(facts, "testid", "invoice-fields")).toBeUndefined();
    expect(facts.filter((f) => f.text === "Thistledown Textiles")).toHaveLength(1);
    expect(new Set(facts.map((f) => `${f.locator.by}=${f.locator.value}`)).size).toBe(facts.length);
  });

  it("resolves every locator back to the element it was read from, on this and on another invoice", () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    const facts = extractPageFacts(document);
    for (const f of facts) expect(readLocator(document, f.locator), JSON.stringify(f.locator)).toBe(f.text);
    mount(invoiceHtml(INVOICES[2]), "/invoices/INV-1003");
    expect(resolveLocator(document, { by: "data-field", value: "vendor" })).toBe(el('[data-field="vendor"]'));
    expect(readLocator(document, { by: "data-field", value: "total" })).toBe("$12,004.55");
    expect(readLocator(document, { by: "label", value: "Received" })).toBe("Sep 15, 2026, 9:05 AM");
    expect(readLocator(document, { by: "data-field", value: "missing" })).toBeNull();
  });
});

describe("extractPageFacts on the inbox and the sheet", () => {
  it("skips test ids shared by every row and keeps the unique counters", () => {
    mount(inboxHtml(), "/invoices");
    const facts = extractPageFacts(document);
    expect(fact(facts, "testid", "invoice-row")).toBeUndefined();
    expect(fact(facts, "testid", "replied-count")).toMatchObject({ label: "replied count", text: "0 of 5 replied" });
    expect(facts.some((f) => f.label === "Page heading" && f.text === "Invoices")).toBe(true);
  });

  it("never reads typed cell values", () => {
    mount(sheetHtml([["Thistledown Textiles", "INV-1001", "Sep 17, 2026", "$3,712.06"]]), "/sheet");
    el<HTMLInputElement>("#cell-1-0").value = "typed by the user";
    const texts = extractPageFacts(document).map((f) => f.text).join(" | ");
    expect(texts).not.toContain("Thistledown");
    expect(texts).not.toContain("typed by the user");
    expect(texts).toContain("1 of 60 rows filled");
  });
});

describe("other sources", () => {
  it("reads two-column table rows, label: value lines and aria-labelledby pairs", () => {
    mount(`<table><tr><th>PO number</th><td>PO-77</td></tr><tr><td>Terms</td><td>Net 30</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>
      <p><strong>Ship to:</strong> 12 Harbour Street</p>
      <div><span>Contact:</span> <span>Priya Nair</span></div>
      <p>Hi Alex, one more thing: the truck is late.</p>
      <p>See https://example.com/path for details</p>
      <span id="l1">Carrier</span><span aria-labelledby="l1">Northwind</span>`);
    const facts = extractPageFacts(document);
    expect(fact(facts, "label", "PO number")?.text).toBe("PO-77");
    expect(fact(facts, "label", "Terms")?.text).toBe("Net 30");
    expect(fact(facts, "label", "Ship to")?.text).toBe("12 Harbour Street");
    expect(fact(facts, "label", "Contact")?.text).toBe("Priya Nair");
    expect(fact(facts, "label", "Carrier")?.text).toBe("Northwind");
    expect(facts.some((f) => f.text.includes("truck") || f.text.includes("example.com"))).toBe(false);
    expect(readLocator(document, { by: "label", value: "ship to" })).toBe("12 Harbour Street");
    expect(readLocator(document, { by: "label", value: "Terms" })).toBe("Net 30");
  });

  it("gives the second holder of a label a structural locator that still resolves", () => {
    mount(`<main id="app"><dl><dt>Date</dt><dd>Sep 1, 2026</dd></dl><dl><dt>Date</dt><dd>Oct 1, 2026</dd></dl><h2>Details</h2></main>`);
    const facts = extractPageFacts(document);
    expect(facts.map((f) => f.locator.by)).toEqual(["label", "css", "css"]);
    expect(facts.map((f) => readLocator(document, f.locator))).toEqual(["Sep 1, 2026", "Oct 1, 2026", "Details"]);
    expect(facts[1]?.locator.value).toBe("#app > dl:nth-of-type(2) > dd:nth-of-type(1)");
  });

  it("prefers a stable id and ignores generated ones", () => {
    mount(`<dl><dt>Order</dt><dd id="order-ref">A-17</dd><dt>Batch</dt><dd id="ember12345">B-9</dd></dl>`);
    const facts = extractPageFacts(document);
    expect(facts.map((f) => f.locator)).toEqual([{ by: "id", value: "order-ref" }, { by: "label", value: "Batch" }]);
  });

  it("survives a selector it cannot parse", () => {
    expect(resolveLocator(document, { by: "css", value: "][" })).toBeNull();
  });
});

describe("safety", () => {
  it("skips sensitive labels, sensitive-looking values, marked regions and hidden content", () => {
    mount(`<dl><dt>Card number</dt><dd>4111 1111 1111 1111</dd><dt>Reference</dt><dd>4111 1111 1111 1111</dd>
      <dt>SSN</dt><dd>n/a</dd><dt>Employee</dt><dd>123-45-6789</dd><dt>Vendor</dt><dd>Acme</dd></dl>
      <div data-ghost-sensitive><p data-field="iban-holder">Alex Chen</p></div>
      <p data-field="draft" hidden>Hidden draft</p><p data-field="aria" aria-hidden="true">Decorative</p>
      <p data-field="password-hint">hunter2</p>`);
    expect(extractPageFacts(document).map((f) => f.label)).toEqual(["Vendor"]);
    expect(readLocator(document, { by: "data-field", value: "iban-holder" })).toBeNull();
    expect(readLocator(document, { by: "label", value: "Card number" })).toBeNull();
    expect(looksSensitiveValue("pay 4111-1111-1111-1111 now")).toBe(true);
    expect(looksSensitiveValue("$3,712.06 on Sep 17, 2026")).toBe(false);
  });

  it("caps the list at 80 facts and the text at 200 characters", () => {
    const rows = Array.from({ length: 120 }, (_, i) => `<p data-field="f${i}">value ${i}</p>`).join("");
    mount(`${rows}<p data-field="long">${"x".repeat(201)}</p><p data-field="fits">${"y".repeat(200)}</p>`);
    const facts = extractPageFacts(document);
    expect(facts).toHaveLength(MAX_FACTS);
    mount(`<p data-field="long">${"x".repeat(201)}</p><p data-field="fits">${"y".repeat(200)}</p>`);
    expect(extractPageFacts(document).map((f) => f.locator.value)).toEqual(["fits"]);
  });

  it("ignores Ghost's own hosts", () => {
    mount(`<div id="ghost-overlay-host"><p data-field="hud">heuristic 12 ms</p></div><div id="ghost-loop-host"><p data-testid="panel">48 left</p></div>`);
    expect(extractPageFacts(document)).toEqual([]);
  });

  it("passes the worker's sanitizer unchanged", () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    const facts = extractPageFacts(document);
    expect(sanitizePageFacts(facts)).toEqual(facts);
  });
});

describe("list facts", () => {
  it("uses the labels the trace store expects", () => {
    expect([LIST_LENGTH_LABEL, LIST_HANDLED_LABEL]).toEqual([STORE_LENGTH, STORE_HANDLED]);
  });

  it("reports the inbox length and the handled rows", () => {
    mount(inboxHtml(INVOICES.map((inv, i) => ({ ...inv, replied: i < 2, logged: i < 2 }))), "/invoices");
    const locator = { by: "css", value: INBOX_SIGNATURE };
    expect(extractListFacts(document)).toEqual([
      { locator, label: LIST_LENGTH_LABEL, text: "5" },
      { locator, label: LIST_HANDLED_LABEL, text: "0,1" },
    ]);
  });

  it("omits the handled fact when nothing is handled and cuts long index lists at a comma", () => {
    mount(inboxHtml(), "/invoices");
    expect(extractListFacts(document).map((f) => f.label)).toEqual([LIST_LENGTH_LABEL]);
    mount(`<ul data-testid="big">${Array.from({ length: 150 }, () => `<li class="done">x</li>`).join("")}</ul>`);
    const handled = extractListFacts(document).find((f) => f.label === LIST_HANDLED_LABEL)?.text ?? "";
    expect(handled.length).toBeLessThanOrEqual(200);
    expect(handled.endsWith(",")).toBe(false);
    expect(handled.split(",").map(Number).every((n, i) => n === i)).toBe(true);
  });
});

describe("sending", () => {
  let sent: PageFactsMessage[];
  const send = (message: PageFactsMessage): void => void sent.push(message);

  beforeEach(() => {
    sent = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("sends url, path pattern, list sizes and facts, and nothing when nothing changed", () => {
    mount(invoiceHtml(), "/invoices/INV-1001?utm=1#top");
    const first = sendPageFacts(document, send);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "ghost:page-facts", url: "http://localhost:3000/invoices/INV-1001", pathPattern: "/invoices/:id" });
    expect(sent[0]?.facts.length).toBeGreaterThan(9);
    expect(sendPageFacts(document, send, first)).toBe(first);
    expect(sent).toHaveLength(1);
  });

  it("puts list sizes first so the cap cannot drop them", () => {
    mount(inboxHtml(), "/invoices");
    sendPageFacts(document, send);
    expect(sent[0]?.facts[0]).toEqual({ locator: { by: "css", value: INBOX_SIGNATURE }, label: LIST_LENGTH_LABEL, text: "5" });
  });

  it("debounces 300 ms after the page settles and resends only on change", async () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    const watcher = new PageFactsWatcher({ send });
    watcher.start();
    vi.advanceTimersByTime(FACTS_DEBOUNCE_MS - 1);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);

    el('[data-testid="reply-confirmation"]').append("Reply sent: Received, thanks.");
    await vi.advanceTimersByTimeAsync(FACTS_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.facts.some((f) => f.text === "Reply sent: Received, thanks.")).toBe(true);

    el("main").setAttribute("data-busy", "true");
    el("main").append(document.createElement("span"));
    await vi.advanceTimersByTimeAsync(FACTS_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
    watcher.stop();
  });

  it("reports the new page after an SPA navigation", async () => {
    mount(inboxHtml(), "/invoices");
    const watcher = new PageFactsWatcher({ send });
    watcher.start();
    await vi.advanceTimersByTimeAsync(FACTS_DEBOUNCE_MS);
    mount(invoiceHtml(), "/invoices/INV-1001");
    await vi.advanceTimersByTimeAsync(500 + FACTS_DEBOUNCE_MS);
    expect(sent.map((m) => m.pathPattern)).toEqual(["/invoices", "/invoices/:id"]);
    watcher.stop();
  });

  it("flushes a pending rescan at once and ignores Ghost's own mutations", async () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    const watcher = new PageFactsWatcher({ send });
    watcher.flush();
    expect(sent).toHaveLength(0); // not running
    watcher.start();
    watcher.flush();
    expect(sent).toHaveLength(1);
    watcher.flush();
    expect(sent).toHaveLength(1); // nothing pending

    const host = document.createElement("div");
    host.id = "ghost-overlay-host";
    document.documentElement.append(host);
    host.append(document.createElement("p"));
    await vi.advanceTimersByTimeAsync(0);
    watcher.flush();
    expect(sent).toHaveLength(1);
    host.remove();
    watcher.stop();
  });

  it("reports a look-alike list once the recorder noted it", async () => {
    mount(`<main id="app"><div class="cards">${[1, 2, 3].map((n) => `<div class="card"><h3>Card ${n}</h3><a href="/c/${n}">Open</a></div>`).join("")}</div></main>`, "/cards");
    const watcher = new PageFactsWatcher({ send });
    watcher.start();
    await vi.advanceTimersByTimeAsync(FACTS_DEBOUNCE_MS);
    expect(sent[0]?.facts.some((f) => f.label === LIST_LENGTH_LABEL)).toBe(false);
    watcher.noteList(el(".cards"));
    watcher.flush();
    expect(sent[1]?.facts[0]).toMatchObject({ label: LIST_LENGTH_LABEL, text: "3" });
    watcher.stop();
  });

  it("stops quietly: no timers, no sends", async () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    const watcher = new PageFactsWatcher({ send });
    watcher.start();
    watcher.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not throw where chrome is missing", () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    expect(() => sendPageFacts(document)).not.toThrow();
  });
});
