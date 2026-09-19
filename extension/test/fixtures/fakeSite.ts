// A tiny stand-in for the demo site (docs/demo-hooks.md) for executor tests: the inbox lives in the test's own
// document, item pages and the sheet "load" into separate jsdom windows (another realm, like a real iframe), and
// all of them share one store the way the demo pages share localStorage.
import { JSDOM } from "jsdom";
import type { LoopProgram } from "@ghost/shared";
import type { FramePool, PreviewFrame } from "../../src/content/dryRun";
import { inboxHtml, INVOICES, invoiceHtml, mount, sheetHtml } from "./demoPages";
import type { DemoInvoice } from "./demoPages";

export const SITE_ORIGIN = "http://localhost:3000"; // vitest's jsdom origin: nothing here ever leaves localhost
export const INBOX_SIGNATURE = "list|ul|list|invoice-list||invoice emails|";
const COLUMNS = ["Vendor", "Invoice #", "Date", "Total"] as const;

/** What the synthesizer produces for "open, reply, open the sheet, type four cells, go back" (see trace.test.ts). */
export function invoiceProgram(nextIndex = 2): LoopProgram {
  const at = { origin: SITE_ORIGIN, pathPattern: "/sheet" };
  const item = { origin: SITE_ORIGIN, pathPattern: "/invoices/:id" };
  const fields = ["vendor", "number", "date", "total"] as const;
  return {
    id: "loop-invoices",
    name: 'Copy 4 fields from /invoices/:id to /sheet and click "Reply: received"',
    iterator: { origin: SITE_ORIGIN, pathPattern: "/invoices", listSignature: INBOX_SIGNATURE, stride: 1, nextIndex, itemPathPattern: "/invoices/:id" },
    steps: [
      { op: "open-item" },
      ...fields.map((value) => ({ op: "extract" as const, var: value, from: { pathPattern: "/invoices/:id", locator: { by: "data-field" as const, value } } })),
      { op: "click", target: { label: "Reply: received", kind: "button" }, locked: true, at: item },
      { op: "click", target: { label: "Open spreadsheet", kind: "link" }, locked: false, at: item },
      { op: "goto", origin: SITE_ORIGIN, pathPattern: "/sheet", url: `${SITE_ORIGIN}/sheet` },
      ...fields.map((value, col) => ({
        op: "fill" as const, at, value: { var: value },
        target: { label: COLUMNS[col] ?? "", kind: "text" as const, cell: { row: "next-empty" as const, colHeader: COLUMNS[col] ?? "" } },
      })),
      { op: "click", target: { label: "Back to invoices", kind: "link" }, locked: false, at },
    ],
    irreversible: [{ stepIndex: 5, description: "Reply: received" }],
    confidence: 0.95,
    unresolved: [],
  };
}

export const REPLY_STEP = 5;

export class FakeSite {
  readonly replied = new Set<string>();
  /** The sheet's storage: every window showing /sheet writes here. */
  readonly rows: string[][] = [];
  /** Every click that reached an enabled "Reply: received" button, in order. */
  readonly replyClicks: string[] = [];
  readonly loads: string[] = [];
  /** Test hooks: a cell write the sheet throws away, and a hook that runs when a reply click lands. */
  rejectCell: ((value: string) => boolean) | null = null;
  onReply: ((id: string) => void) | null = null;
  onCell: ((value: string) => void) | null = null;
  /** Overrides what an invoice page shows when it is loaded (a page that changed after the preview). */
  patchInvoice: ((inv: DemoInvoice) => DemoInvoice) | null = null;

  constructor(readonly invoices: DemoInvoice[] = INVOICES) {}

  mountInbox(): void {
    mount(this.inbox(), "/invoices");
  }

  /** What the demo inbox does on a storage event: the handled state of every row is re-rendered. */
  refreshInbox(): void {
    for (const li of document.querySelectorAll<HTMLElement>('[data-testid="invoice-row"]')) {
      const done = this.replied.has(li.dataset.invoiceId ?? "");
      li.classList.toggle("replied", done);
      li.dataset.replied = String(done);
    }
  }

  pool(): FramePool {
    const frames = new Set<PreviewFrame>();
    return {
      acquire: () => {
        const frame = this.frame();
        frames.add(frame);
        return frame;
      },
      destroy: () => {
        for (const frame of frames) frame.dispose();
      },
    };
  }

  private inbox(): string {
    return inboxHtml(this.invoices.map((inv) => ({ ...inv, replied: this.replied.has(inv.id) })));
  }

  private frame(): PreviewFrame {
    let dom: JSDOM | null = null;
    return {
      load: async (url, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (signal.aborted) return false;
        this.loads.push(url);
        dom = this.open(url);
        return dom !== null;
      },
      document: () => dom?.window.document ?? null,
      dispose: () => {
        dom?.window.close();
        dom = null;
      },
    };
  }

  private open(url: string): JSDOM | null {
    const path = new URL(url).pathname;
    const id = /^\/invoices\/([^/]+)$/.exec(path)?.[1];
    const inv = this.invoices.find((i) => i.id === id);
    if (inv) return this.invoicePage(url, this.patchInvoice ? this.patchInvoice(inv) : inv);
    if (path === "/sheet") return this.sheetPage(url);
    return path === "/invoices" ? new JSDOM(this.inbox(), { url }) : null;
  }

  private invoicePage(url: string, inv: DemoInvoice): JSDOM {
    const dom = new JSDOM(invoiceHtml(inv), { url });
    const button = dom.window.document.querySelector<HTMLButtonElement>('[data-testid="reply-received"]');
    if (!button) throw new Error("fixture without a reply button");
    const showReplied = (): void => {
      button.disabled = true;
      button.textContent = "Replied";
    };
    if (this.replied.has(inv.id)) showReplied();
    button.addEventListener("click", () => {
      this.replyClicks.push(inv.id);
      this.replied.add(inv.id);
      showReplied();
      this.refreshInbox();
      this.onReply?.(inv.id);
    });
    return dom;
  }

  private sheetPage(url: string): JSDOM {
    const dom = new JSDOM(sheetHtml(this.rows, 8), { url });
    for (const input of dom.window.document.querySelectorAll<HTMLInputElement>("input[data-row]")) {
      input.addEventListener("input", () => {
        if (this.rejectCell?.(input.value)) return void (input.value = ""); // a controlled input that throws the write away
        const row = (this.rows[Number(input.dataset.row)] ??= ["", "", "", ""]);
        row[Number(input.dataset.col)] = input.value;
        this.onCell?.(input.value);
      });
    }
    return dom;
  }
}
