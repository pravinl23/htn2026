/** Test-only synthetic traces for /v1/loop/synthesize. Fictional data, no network, no keys. */
import type { FactsByUrl, LoopCandidate, PageFact, TraceEvent, TraceEventType, TraceTarget } from "@ghost/shared";

export const ORIGIN = "http://localhost:5173";
export const INBOX_LIST = "ul#inbox";
export const REPLY_LABEL = "Reply: received";
export const SHEET_COLUMNS = ["Vendor", "Invoice #", "Date", "Total"] as const;

export interface Invoice {
  id: string;
  /** As rendered on the invoice page. */
  vendor: string;
  date: string;
  total: string;
  /** As the user types them into the sheet, in SHEET_COLUMNS order. */
  typed: [string, string, string, string];
}

/** Every typed value is explained by a page fact under a shared transform: the heuristic resolves all four columns. */
export const RESOLVED_INVOICES: Invoice[] = [
  { id: "INV-1001", vendor: "Northwind Traders", date: "Sep 3, 2026", total: "$1,204.50", typed: ["Northwind Traders", "INV-1001", "2026-09-03", "1204.50"] },
  { id: "INV-1002", vendor: "Globex Corporation", date: "Sep 8, 2026", total: "$980.00", typed: ["Globex Corporation", "INV-1002", "2026-09-08", "980.00"] },
];

/** The user shortens the vendor to its first word and types the bare invoice digits: no shared transform explains either. */
export const SHORTHAND_INVOICES: Invoice[] = [
  { id: "INV-2001", vendor: "Thistledown Textiles", date: "Sep 3, 2026", total: "$1,204.50", typed: ["Thistledown", "2001", "2026-09-03", "1204.50"] },
  { id: "INV-2002", vendor: "Marigold Freight Lines", date: "Sep 8, 2026", total: "$980.00", typed: ["Marigold", "2002", "2026-09-08", "980.00"] },
];

function target(label: string, kind: TraceTarget["kind"], extra: Partial<TraceTarget> = {}): TraceTarget {
  return { signature: `${kind}:${label}`, label, kind, locked: false, ...extra };
}

export function invoiceUrl(inv: Invoice): string {
  return `${ORIGIN}/invoices/${inv.id}`;
}

export function invoiceFacts(inv: Invoice): PageFact[] {
  return [
    { locator: { by: "css", value: "h1" }, label: "", text: `Invoice ${inv.id}` },
    { locator: { by: "data-field", value: "vendor" }, label: "Vendor", text: inv.vendor },
    { locator: { by: "data-field", value: "number" }, label: "Invoice #", text: inv.id },
    { locator: { by: "data-field", value: "date" }, label: "Date", text: inv.date },
    { locator: { by: "data-field", value: "total" }, label: "Total", text: inv.total },
    { locator: { by: "label", value: "Payment terms" }, label: "Payment terms", text: "Net 30" },
  ];
}

export function factsFor(invoices: Invoice[]): FactsByUrl {
  const facts: FactsByUrl = { [`${ORIGIN}/invoices`]: [{ locator: { by: "css", value: "h1" }, label: "", text: "Inbox" }] };
  for (const inv of invoices) facts[invoiceUrl(inv)] = invoiceFacts(inv);
  return facts;
}

export interface RunOptions {
  /** A constant field filled with the same value in both runs, before the sheet columns. */
  constant?: { label: string; value: string };
}

/** One pass: open the item, go to the sheet, type the four columns into row `index`, go back, press the locked reply button. */
export function invoiceRun(invoices: Invoice[], index: number, options: RunOptions = {}): TraceEvent[] {
  const inv = invoices[index];
  if (!inv) throw new Error(`no invoice ${index}`);
  let clock = 1_800_000_000_000 + index * 60_000;
  const event = (type: TraceEventType, path: string, pathPattern: string, t?: TraceTarget, value?: string): TraceEvent => {
    clock += 1500;
    const e: TraceEvent = { t: clock, tabId: 1, type, origin: ORIGIN, pathPattern, url: ORIGIN + path };
    if (t) e.target = t;
    if (value !== undefined) e.value = value;
    return e;
  };
  const itemPath = `/invoices/${inv.id}`;
  const list = { listSignature: INBOX_LIST, index, itemKey: inv.id };
  return [
    event("click", "/invoices", "/invoices", target(inv.id, "link", { signature: `${INBOX_LIST}[${index}]`, list })),
    event("navigate", itemPath, "/invoices/:id"),
    event("navigate", "/sheet", "/sheet"),
    ...(options.constant ? [event("input", "/sheet", "/sheet", target(options.constant.label, "text"), options.constant.value)] : []),
    ...inv.typed.map((value, col) => {
      const colHeader = SHEET_COLUMNS[col] ?? "";
      return event("input", "/sheet", "/sheet", target(`${colHeader} row ${index + 1}`, "text", { signature: `cell:${index}:${col}`, cell: { row: index, col, colHeader } }), value);
    }),
    event("navigate", itemPath, "/invoices/:id"),
    event("click", itemPath, "/invoices/:id", target(REPLY_LABEL, "button", { locked: true })),
    event("navigate", "/invoices", "/invoices"),
  ];
}

export function invoiceCandidate(invoices: Invoice[], options: RunOptions = {}): LoopCandidate {
  const runA = invoiceRun(invoices, 0, options);
  const runB = invoiceRun(invoices, 1, options);
  return { length: runA.length, runA, runB };
}

export function synthesizeBody(invoices: Invoice[], options: RunOptions = {}): { candidate: LoopCandidate; factsByUrl: FactsByUrl } {
  return { candidate: invoiceCandidate(invoices, options), factsByUrl: factsFor(invoices) };
}
