import type { FactLocator, LoopProgram, LoopStep } from "@ghost/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIframePool, itemUrlFromElement, loopVariables, previewItems, resolveItemUrls } from "../src/content/dryRun";
import type { DryRunOptions, DryRunRow, FramePool, LocatorResolver, PreviewFrame } from "../src/content/dryRun";

const ORIGIN = "http://localhost:3000"; // vitest's jsdom origin: every URL in this file stays on localhost

type Page = { html: string; after?: number } | "fail";

const EXTRACTS: LoopStep[] = [
  { op: "extract", var: "vendor", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" } } },
  { op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "total" }, transform: "number" } },
];

function program(steps: LoopStep[] = EXTRACTS, extra: Partial<LoopProgram> = {}): LoopProgram {
  return {
    id: "loop-test",
    name: "Copy 2 fields from /invoices/:id to /sheet",
    iterator: { origin: ORIGIN, pathPattern: "/invoices", listSignature: "list:invoice-list", stride: 1, nextIndex: 2, itemPathPattern: "/invoices/:id" },
    steps: [
      { op: "open-item" },
      ...steps,
      { op: "goto", origin: ORIGIN, pathPattern: "/sheet", url: `${ORIGIN}/sheet` },
      { op: "fill", target: { label: "B3", kind: "text", cell: { row: "next-empty", colHeader: "Vendor" } }, value: { var: "vendor" } },
      { op: "fill", target: { label: "D3", kind: "text", cell: { row: "next-empty", colHeader: "Total" } }, value: { var: "total" } },
    ],
    irreversible: [],
    confidence: 0.95,
    ...extra,
  };
}

function invoice(vendor: string, total: string): string {
  return `<dl><dt>Vendor</dt><dd data-field="vendor"> ${vendor}\n </dd><dt>Total</dt><dd data-field="total">${total}</dd></dl>`;
}

const resolve: LocatorResolver = (doc, locator: FactLocator) => {
  if (locator.by === "id") return doc.getElementById(locator.value);
  if (locator.by === "css") return doc.querySelector(locator.value);
  if (locator.by === "label") return [...doc.querySelectorAll("dt")].find((dt) => dt.textContent === locator.value)?.nextElementSibling ?? null;
  return doc.querySelector(`[${locator.by === "testid" ? "data-testid" : "data-field"}="${locator.value}"]`);
};

/** Frames that "load" canned pages into detached documents, optionally rendering late like a SPA does. */
class FakePool implements FramePool {
  readonly loads: string[] = [];
  live = 0;
  maxLive = 0;
  acquired = 0;
  disposed = 0;
  destroyed = false;

  constructor(private readonly pages: Record<string, Page>, private readonly loadMs = 5) {}

  acquire(): PreviewFrame {
    this.acquired++;
    let doc: Document | null = null;
    return {
      load: async (url) => {
        this.loads.push(url);
        this.maxLive = Math.max(this.maxLive, ++this.live);
        await new Promise((r) => setTimeout(r, this.loadMs));
        this.live--;
        const page = this.pages[new URL(url).pathname];
        if (page === undefined || page === "fail") return false;
        const next = (doc = document.implementation.createHTMLDocument("item"));
        if (page.after === undefined) next.body.innerHTML = page.html;
        else setTimeout(() => (next.body.innerHTML = page.html), page.after);
        return true;
      },
      document: () => doc,
      dispose: () => void this.disposed++,
    };
  }

  destroy(): void {
    this.destroyed = true;
  }
}

async function collect(rows: AsyncIterable<DryRunRow>): Promise<DryRunRow[]> {
  const out: DryRunRow[] = [];
  for await (const row of rows) out.push(row);
  return out.sort((a, b) => a.index - b.index);
}

function options(frames: FramePool, extra: Partial<DryRunOptions> = {}): DryRunOptions {
  return { resolve, frames, locatorTimeoutMs: 120, graceMs: 20, ...extra };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.getElementById("ghost-dryrun-host")?.remove();
});

describe("previewItems", () => {
  it("yields one row per item with transformed values, mapped to the list indexes", async () => {
    const pool = new FakePool({
      "/invoices/INV-1003": { html: invoice("Brightwave Supply", "$3,712.06") },
      "/invoices/INV-1004": { html: invoice("Thistledown Textiles", "$88.00") },
    });
    const urls = [`${ORIGIN}/invoices/INV-1003`, "/invoices/INV-1004#reply"];
    const rows = await collect(previewItems(program(), urls, options(pool, { indexes: [2, 3] })));
    expect(rows).toEqual([
      { index: 2, url: `${ORIGIN}/invoices/INV-1003`, vars: { vendor: "Brightwave Supply", total: "3712.06" }, confidence: 1, missing: [] },
      { index: 3, url: `${ORIGIN}/invoices/INV-1004`, vars: { vendor: "Thistledown Textiles", total: "88.00" }, confidence: 1, missing: [] },
    ]);
    expect(pool.destroyed).toBe(true);
    expect(pool.disposed).toBe(pool.acquired);
  });

  it("never loads more than four items at a time and reuses one frame per slot", async () => {
    const pages: Record<string, Page> = {};
    const urls: string[] = [];
    for (let i = 0; i < 11; i++) {
      pages[`/invoices/INV-${1000 + i}`] = { html: invoice(`Vendor ${i}`, `${i}.50`) };
      urls.push(`${ORIGIN}/invoices/INV-${1000 + i}`);
    }
    const pool = new FakePool(pages);
    const rows = await collect(previewItems(program(), urls, options(pool)));
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows.every((r) => r.confidence === 1)).toBe(true);
    expect(pool.maxLive).toBe(4);
    expect(pool.acquired).toBe(4);
    expect(pool.loads).toHaveLength(11);
  });

  it("waits for a page that renders after load", async () => {
    const pool = new FakePool({ "/invoices/INV-1003": { html: invoice("Late Render Ltd", "12"), after: 40 } });
    const [row] = await collect(previewItems(program(), [`${ORIGIN}/invoices/INV-1003`], options(pool, { locatorTimeoutMs: 1000 })));
    expect(row).toMatchObject({ vars: { vendor: "Late Render Ltd", total: "12" }, confidence: 1 });
  });

  it("gives up on a locator after the timeout: confidence 0 and the variable is listed as missing", async () => {
    const pool = new FakePool({ "/invoices/INV-1003": { html: `<dl><dd data-field="vendor">Acme</dd></dl>` } });
    const started = Date.now();
    const [row] = await collect(previewItems(program(), [`${ORIGIN}/invoices/INV-1003`], options(pool)));
    expect(row).toMatchObject({ vars: { vendor: "Acme" }, confidence: 0, missing: ["total"] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("flags a value only a fallback locator explains, or that will not transform, as 0.6", async () => {
    const pool = new FakePool({
      "/invoices/INV-1003": { html: `<p data-testid="vendor">Acme</p><p data-field="total">$5.00</p>` },
      "/invoices/INV-1004": { html: invoice("Acme", "on request") },
    });
    const urls = [`${ORIGIN}/invoices/INV-1003`, `${ORIGIN}/invoices/INV-1004`];
    const rows = await collect(previewItems(program(), urls, options(pool)));
    expect(rows[0]).toMatchObject({ vars: { vendor: "Acme", total: "5.00" }, confidence: 0.6, missing: [] });
    expect(rows[1]).toMatchObject({ vars: { vendor: "Acme", total: "on request" }, confidence: 0.6, missing: [] });
  });

  it("caps variables whose locator is a guess at 0.6", async () => {
    const pool = new FakePool({ "/invoices/INV-1003": { html: invoice("Acme", "5") } });
    const [row] = await collect(previewItems(program(), [`${ORIGIN}/invoices/INV-1003`], options(pool, { fallbackVars: ["total"] })));
    expect(row?.confidence).toBe(0.6);
  });

  it("never follows cross-origin, non-http or empty item urls", async () => {
    const pool = new FakePool({});
    const urls = ["https://elsewhere.invalid/invoices/INV-1", "javascript:alert(1)", "", "http://localhost:9/invoices/INV-2"];
    const rows = await collect(previewItems(program(), urls, options(pool)));
    expect(pool.loads).toEqual([]);
    expect(pool.acquired).toBe(0);
    for (const row of rows) expect(row).toMatchObject({ url: "", confidence: 0, vars: {}, missing: ["vendor", "total"] });
  });

  it("treats a frame that fails to load as missing", async () => {
    const pool = new FakePool({ "/invoices/INV-1003": "fail" });
    const [row] = await collect(previewItems(program(), [`${ORIGIN}/invoices/INV-1003`], options(pool)));
    expect(row).toMatchObject({ confidence: 0, missing: ["vendor", "total"] });
  });

  it("never reads a sensitive element or a sensitively named locator", async () => {
    const steps: LoopStep[] = [
      { op: "extract", var: "vendor", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" } } },
      { op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "label", value: "Card number" } } },
    ];
    const html = `<div data-ghost-sensitive><span data-field="vendor">Hidden Vendor</span></div><dl><dt>Card number</dt><dd>4111 1111</dd></dl>`;
    const pool = new FakePool({ "/invoices/INV-1003": { html } });
    const spy = vi.fn(resolve);
    const [row] = await collect(previewItems(program(steps), [`${ORIGIN}/invoices/INV-1003`], options(pool, { resolve: spy })));
    expect(row).toMatchObject({ vars: {}, confidence: 0, missing: ["vendor", "total"] });
    expect(JSON.stringify(row)).not.toContain("4111");
    expect(spy.mock.calls.some(([, locator]) => locator.value === "Card number")).toBe(false);
  });

  it("does not read a value from a page the extract does not belong to", async () => {
    const steps: LoopStep[] = [{ op: "extract", var: "vendor", from: { pathPattern: "/vendors/:id", locator: { by: "data-field", value: "vendor" } } }];
    const pool = new FakePool({ "/invoices/INV-1003": { html: invoice("Wrong Page", "1") } });
    const [row] = await collect(previewItems(program(steps), [`${ORIGIN}/invoices/INV-1003`], options(pool)));
    expect(row).toMatchObject({ confidence: 0, missing: ["vendor", "total"] });
    expect(pool.loads).toEqual([]);
  });

  it("needs no frame for a program without variables, and lists unresolved variables as missing", async () => {
    const clickOnly: LoopProgram = { ...program([]), steps: [{ op: "open-item" }, { op: "click", target: { label: "Reply: received", kind: "button" }, locked: true }] };
    const pool = new FakePool({});
    const [plain] = await collect(previewItems(clickOnly, [`${ORIGIN}/invoices/INV-1003`], options(pool)));
    expect(plain).toEqual({ index: 0, url: `${ORIGIN}/invoices/INV-1003`, vars: {}, confidence: 1, missing: [] });
    expect(pool.loads).toEqual([]);

    const pool2 = new FakePool({ "/invoices/INV-1003": { html: invoice("Acme", "1") } });
    const [row] = await collect(previewItems(program([EXTRACTS[0] as LoopStep]), [`${ORIGIN}/invoices/INV-1003`], options(pool2)));
    expect(row).toMatchObject({ vars: { vendor: "Acme" }, confidence: 0, missing: ["total"] });
  });

  it("stops on abort: no more loads, no more rows, frames removed", async () => {
    const pages: Record<string, Page> = {};
    const urls: string[] = [];
    for (let i = 0; i < 12; i++) {
      pages[`/invoices/INV-${1000 + i}`] = { html: invoice(`Vendor ${i}`, "1") };
      urls.push(`${ORIGIN}/invoices/INV-${1000 + i}`);
    }
    const pool = new FakePool(pages, 15);
    const abort = new AbortController();
    const rows: DryRunRow[] = [];
    for await (const row of previewItems(program(), urls, options(pool, { signal: abort.signal }))) {
      rows.push(row);
      abort.abort();
    }
    expect(rows).toHaveLength(1);
    expect(pool.loads.length).toBeLessThanOrEqual(8);
    expect(pool.destroyed).toBe(true);
    expect(pool.disposed).toBe(pool.acquired);
  });

  it("cleans up when the consumer leaves the loop early", async () => {
    const pages: Record<string, Page> = {};
    const urls: string[] = [];
    for (let i = 0; i < 6; i++) {
      pages[`/invoices/INV-${1000 + i}`] = { html: invoice(`Vendor ${i}`, "1") };
      urls.push(`${ORIGIN}/invoices/INV-${1000 + i}`);
    }
    const pool = new FakePool(pages);
    for await (const row of previewItems(program(), urls, options(pool, { poolSize: 1 }))) {
      expect(row.index).toBe(0);
      break;
    }
    expect(pool.destroyed).toBe(true);
    expect(pool.disposed).toBe(pool.acquired);
    expect(pool.loads.length).toBeLessThanOrEqual(2); // the slot may already have started the next item
  });
});

describe("loopVariables", () => {
  it("names each column after the field the value goes into, in fill order", () => {
    expect(loopVariables(program())).toEqual([
      { var: "vendor", header: "Vendor", resolved: true },
      { var: "total", header: "Total", resolved: true },
    ]);
  });

  it("marks a variable without an extract step as unresolved and falls back to the label, then the name", () => {
    const steps: LoopStep[] = [
      { op: "fill", target: { label: "Notes", kind: "textarea" }, value: { var: "notes" } },
      { op: "fill", target: { label: "", kind: "text" }, value: { var: "other" } },
      { op: "fill", target: { label: "Status", kind: "text" }, value: { const: "Paid" } },
    ];
    expect(loopVariables({ ...program([]), steps })).toEqual([
      { var: "notes", header: "Notes", resolved: false },
      { var: "other", header: "other", resolved: false },
    ]);
  });
});

describe("item urls", () => {
  it("reads the href of the list item's link, without the fragment", () => {
    document.body.innerHTML = `
      <ul><li id="a"><a href="/invoices/INV-1007#top"><span id="inner">Invoice INV-1007</span></a></li>
      <li id="b">no link</li><li id="c"><a href="javascript:void(0)">x</a></li></ul>`;
    const el = (id: string): Element => document.getElementById(id) as Element;
    expect(itemUrlFromElement(el("a"))).toBe(`${ORIGIN}/invoices/INV-1007`);
    expect(itemUrlFromElement(el("inner"))).toBe(`${ORIGIN}/invoices/INV-1007`);
    expect(itemUrlFromElement(el("b"))).toBeNull();
    expect(itemUrlFromElement(el("c"))).toBeNull();
  });

  it("maps list indexes to urls through the injected lookup", () => {
    const urls = resolveItemUrls([2, 3, 4], (i) => (i === 3 ? null : `${ORIGIN}/invoices/INV-${1001 + i}`));
    expect(urls).toEqual([`${ORIGIN}/invoices/INV-1003`, "", `${ORIGIN}/invoices/INV-1005`]);
  });
});

describe("createIframePool", () => {
  it("keeps sandboxed 1px frames in a closed shadow host and removes everything afterwards", async () => {
    const created: HTMLIFrameElement[] = [];
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string, opts?: ElementCreationOptions) => {
      const el = createElement(tag, opts);
      if (el instanceof HTMLIFrameElement) created.push(el);
      return el;
    });
    const pool = createIframePool(document, 20);
    expect(document.getElementById("ghost-dryrun-host")).toBeNull(); // nothing on the page until a frame is needed
    const frame = pool.acquire();
    const loading = frame.load(`${ORIGIN}/invoices/INV-1003`, new AbortController().signal);
    const host = document.getElementById("ghost-dryrun-host");
    expect(host?.parentElement).toBe(document.documentElement);
    expect(host?.shadowRoot).toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]?.getAttribute("sandbox")).toBe("allow-same-origin allow-scripts");
    expect(created[0]?.style.width).toBe("1px");
    expect(created[0]?.isConnected).toBe(true);
    expect(await loading).toBe(false); // jsdom loads no frames: the load times out
    expect(frame.document()).toBeNull();
    pool.destroy();
    expect(created[0]?.isConnected).toBe(false);
    expect(document.getElementById("ghost-dryrun-host")).toBeNull();
  });

  it("does not start a load once aborted", async () => {
    const pool = createIframePool(document, 20);
    const abort = new AbortController();
    abort.abort();
    expect(await pool.acquire().load(`${ORIGIN}/invoices/INV-1003`, abort.signal)).toBe(false);
    pool.destroy();
  });
});
