import { normalizeUrl } from "../../src/trace/normalize";
import type { FactsByUrl, FieldKind, PageFact, TraceEvent, TraceEventType, TraceTarget } from "../../src";

export const DEMO_ORIGIN = "http://localhost:5173";
export const START_TIME = 1_800_000_000_000;

export interface BuilderOptions {
  origin?: string;
  tabId?: number;
  start?: number;
  /** Time between events. */
  stepMs?: number;
}

export type TargetOptions = Partial<Omit<TraceTarget, "label">>;

/** Fluent builder for synthetic traces: tracks the current page and a clock so tests read like the user's session. */
export class TraceBuilder {
  private readonly out: TraceEvent[] = [];
  private readonly origin: string;
  private readonly stepMs: number;
  private tabId: number;
  private clock: number;
  private path = "/";
  private syntheticNext = false;

  constructor(opts: BuilderOptions = {}) {
    this.origin = opts.origin ?? DEMO_ORIGIN;
    this.tabId = opts.tabId ?? 1;
    this.clock = opts.start ?? START_TIME;
    this.stepMs = opts.stepMs ?? 1500;
  }

  /** Time of the last event: pass it as `now` to detectLoop. */
  get now(): number {
    return this.clock;
  }

  events(): TraceEvent[] {
    return this.out.map((e) => ({ ...e }));
  }

  wait(ms: number): this {
    this.clock += ms;
    return this;
  }

  /** Marks the next event as Shabang's own action. */
  synthetic(): this {
    this.syntheticNext = true;
    return this;
  }

  /** Moves to a page without emitting an event. */
  at(path: string): this {
    this.path = path;
    return this;
  }

  navigate(path: string): this {
    this.path = path;
    return this.push("navigate");
  }

  tabswitch(tabId: number, path: string): this {
    this.tabId = tabId;
    this.path = path;
    return this.push("tabswitch");
  }

  click(label: string, target: TargetOptions = {}): this {
    return this.push("click", makeTarget(label, "button", target));
  }

  clickBody(): this {
    return this.push("click");
  }

  clickItem(listSignature: string, index: number, itemKey: string): this {
    const list = { listSignature, index, itemKey };
    return this.push("click", makeTarget(itemKey, "link", { signature: `${listSignature}[${index}]`, list }));
  }

  input(label: string, value: string, target: TargetOptions = {}): this {
    return this.push("input", makeTarget(label, "text", target), value);
  }

  fillCell(row: number, col: number, colHeader: string, value: string): this {
    const cell = { row, col, colHeader };
    return this.push("input", makeTarget(`${colHeader} row ${row + 1}`, "text", { signature: `cell:${row}:${col}`, cell }), value);
  }

  submit(label: string, target: TargetOptions = {}): this {
    return this.push("submit", makeTarget(label, "button", { locked: true, ...target }));
  }

  private push(type: TraceEventType, target?: TraceTarget, value?: string): this {
    const where = normalizeUrl(this.origin + this.path);
    if (!where) throw new Error(`bad url ${this.origin}${this.path}`);
    this.clock += this.stepMs;
    const e: TraceEvent = { t: this.clock, tabId: this.tabId, type, origin: where.origin, pathPattern: where.pathPattern, url: where.url };
    if (target) e.target = target;
    if (value !== undefined) e.value = value;
    if (this.syntheticNext) e.synthetic = true;
    this.syntheticNext = false;
    this.out.push(e);
    return this;
  }
}

export function makeTarget(label: string, kind: FieldKind, opts: TargetOptions = {}): TraceTarget {
  return { signature: `${kind}:${label}`, label, kind, locked: false, ...opts };
}

// ---- The canonical "copy invoices into the sheet and reply" scenario (docs/loops.md section 4) ----

export const INBOX_LIST = "ul#inbox";
export const SHEET_COLUMNS = ["Vendor", "Invoice #", "Date", "Total"] as const;
export const REPLY_LABEL = "Reply: received";

export interface Invoice {
  id: string;
  vendor: string;
  /** As rendered on the invoice page. */
  date: string;
  total: string;
  /** As the user types them into the sheet. */
  typedDate: string;
  typedTotal: string;
}

export const INVOICES: Invoice[] = [
  { id: "INV-1001", vendor: "Northwind Traders", date: "Sep 3, 2026", total: "$1,204.50", typedDate: "2026-09-03", typedTotal: "1204.50" },
  { id: "INV-1002", vendor: "Globex Corporation", date: "Sep 8, 2026", total: "$980.00", typedDate: "2026-09-08", typedTotal: "980" },
  { id: "INV-1003", vendor: "Initech", date: "Sep 12, 2026", total: "$15,000.00", typedDate: "2026-09-12", typedTotal: "15000" },
  { id: "INV-1004", vendor: "Umbrella Supply", date: "Oct 1, 2026", total: "$42.10", typedDate: "2026-10-01", typedTotal: "42.10" },
];

export function invoicePath(inv: Invoice): string {
  return `/invoices/${inv.id}`;
}

export function invoiceFacts(inv: Invoice): PageFact[] {
  return [
    { locator: { by: "css", value: "h1" }, label: "", text: `Invoice ${inv.id} from ${inv.vendor}` },
    { locator: { by: "data-field", value: "vendor" }, label: "Vendor", text: inv.vendor },
    { locator: { by: "data-field", value: "number" }, label: "Invoice #", text: inv.id },
    { locator: { by: "data-field", value: "date" }, label: "Date", text: inv.date },
    { locator: { by: "data-field", value: "total" }, label: "Total", text: inv.total },
    { locator: { by: "label", value: "Amount due" }, label: "Amount due", text: inv.total },
  ];
}

export function invoiceFactsByUrl(invoices: Invoice[] = INVOICES): FactsByUrl {
  const facts: FactsByUrl = { [`${DEMO_ORIGIN}/invoices`]: [{ locator: { by: "css", value: "h1" }, label: "", text: "Inbox" }] };
  for (const inv of invoices) facts[DEMO_ORIGIN + invoicePath(inv)] = invoiceFacts(inv);
  return facts;
}

export function typedCells(inv: Invoice): string[] {
  return [inv.vendor, inv.id, inv.typedDate, inv.typedTotal];
}

/** One full pass: open the item, copy four fields into sheet row `row`, go back, press the locked reply button. */
export function handleInvoice(tb: TraceBuilder, index: number, row: number = index, invoices: Invoice[] = INVOICES): TraceBuilder {
  const inv = invoices[index];
  if (!inv) throw new Error(`no invoice ${index}`);
  tb.at("/invoices").clickItem(INBOX_LIST, index, inv.id).navigate(invoicePath(inv)).navigate("/sheet");
  typedCells(inv).forEach((value, col) => tb.fillCell(row, col, SHEET_COLUMNS[col] ?? "", value));
  return tb.navigate(invoicePath(inv)).click(REPLY_LABEL, { locked: true });
}

/** Lands on the inbox, then handles invoices 0..count-1, returning to the inbox between items. */
export function invoiceSession(count = 2, opts: BuilderOptions = {}): TraceBuilder {
  const tb = new TraceBuilder(opts).navigate("/invoices");
  for (let i = 0; i < count; i++) {
    if (i > 0) tb.navigate("/invoices");
    handleInvoice(tb, i);
  }
  return tb;
}
