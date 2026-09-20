// jsdom fixtures that mirror the demo markup described in docs/demo-hooks.md (demo/src/pages is the source of truth).

export interface DemoInvoice {
  id: string;
  vendor: string;
  date: string;
  total: string;
  replied?: boolean;
  logged?: boolean;
}

export const INVOICES: DemoInvoice[] = [
  { id: "INV-1001", vendor: "Thistledown Textiles", date: "Sep 17, 2026", total: "$3,712.06" },
  { id: "INV-1002", vendor: "Brightwave Supply", date: "Sep 16, 2026", total: "$918.40" },
  { id: "INV-1003", vendor: "Harbourlight Freight", date: "Sep 15, 2026", total: "$12,004.55" },
  { id: "INV-1004", vendor: "Quillon Print Works", date: "Sep 14, 2026", total: "$241.19" },
  { id: "INV-1005", vendor: "Fernbrook Catering", date: "Sep 13, 2026", total: "$1,530.00" },
];

const SHEET_HEADERS = ["Vendor", "Invoice #", "Date", "Total"];

function header(product: string): string {
  return `<header class="lb-header"><a href="/" aria-label="Ledgerbox ${product} home">Ledgerbox</a>
    <nav aria-label="Products"><ul><li><a href="/invoices">Mail</a></li><li><a href="/sheet">Sheets</a></li><li><a href="/calendar">Calendar</a></li></ul></nav>
    <span class="lb-account">alex.chen.dev@example.com</span></header>`;
}

function inboxRow(inv: DemoInvoice): string {
  const state = `${inv.replied ? " replied" : ""}${inv.logged ? " logged" : ""}`;
  return `<li class="inv-item${state}" data-testid="invoice-row" data-invoice-id="${inv.id}" data-replied="${inv.replied === true}" data-logged="${inv.logged === true}">
    <a class="inv-row" href="/invoices/${inv.id}" aria-labelledby="subject-${inv.id}" aria-describedby="details-${inv.id}">
      <span class="inv-avatar" aria-hidden="true">${inv.vendor.charAt(0)}</span>
      <span class="inv-row-main">
        <span class="inv-row-vendor">${inv.vendor}</span>
        <span class="inv-row-subject" id="subject-${inv.id}">Invoice ${inv.id} from ${inv.vendor}</span>
        <span class="inv-row-preview">Monthly order</span>
      </span>
      <span class="inv-row-side" id="details-${inv.id}">
        <span class="inv-row-total">${inv.total}</span><span class="inv-row-date">${inv.date}</span>
        <span class="inv-row-chips">${inv.logged ? '<span data-chip="logged">Logged</span>' : ""}${inv.replied ? '<span data-chip="replied">Replied</span>' : ""}</span>
      </span>
    </a>
  </li>`;
}

export function inboxHtml(invoices: DemoInvoice[] = INVOICES): string {
  const replied = invoices.filter((i) => i.replied).length;
  const logged = invoices.filter((i) => i.logged).length;
  return `<div class="lb-app">${header("Mail")}<main class="lb-page">
    <div class="inv-titlebar"><div><p class="eyebrow">Inbox</p><h1>Invoices</h1></div>
      <div class="inv-summary"><p class="inv-counts" aria-live="polite">
        <strong data-testid="replied-count">${replied} of ${invoices.length} replied</strong>
        <span data-testid="logged-count">${logged} of ${invoices.length} logged</span></p>
        <a class="lb-button" href="/sheet">Open spreadsheet</a></div></div>
    <ul role="list" class="inv-list" aria-label="Invoice emails" data-testid="invoice-list">${invoices.map(inboxRow).join("")}</ul>
  </main></div>`;
}

export function invoiceHtml(inv: DemoInvoice = INVOICES[0] as DemoInvoice): string {
  const fields: Array<[string, string, string]> = [
    ["Vendor", "vendor", inv.vendor], ["Invoice number", "number", inv.id], ["Invoice date", "date", inv.date],
    ["Due date", "due", "Oct 17, 2026"], ["Description", "description", "Monthly order of woven goods"],
    ["Subtotal", "subtotal", "$3,285.00"], ["Tax rate", "tax-rate", "13%"], ["Tax", "tax", "$427.06"], ["Total", "total", inv.total],
  ];
  return `<div class="lb-app">${header("Mail")}<main class="lb-page lb-page-narrow">
    <nav class="inv-toolbar" aria-label="Message"><a class="inv-back" href="/invoices">Back to inbox</a></nav>
    <article class="inv-email" aria-labelledby="email-subject" data-invoice-id="${inv.id}" data-replied="false" data-logged="false">
      <header class="inv-email-head"><div class="inv-email-title"><h1 id="email-subject">Invoice ${inv.id} from ${inv.vendor}</h1></div>
        <dl class="inv-email-meta">
          <div><dt>From</dt><dd>${inv.vendor} &lt;billing@example.com&gt;</dd></div>
          <div><dt>To</dt><dd>Alex Chen &lt;alex.chen.dev@example.com&gt;</dd></div>
          <div><dt>Received</dt><dd><time datetime="2026-09-17T09:05:00">${inv.date}, 9:05 AM</time></dd></div>
        </dl></header>
      <div class="inv-email-body"><p>Hi Alex,</p><p>Please find the invoice for this month below.</p></div>
      <section class="inv-doc" aria-labelledby="invoice-doc-title"><h2 id="invoice-doc-title">Invoice</h2>
        <dl class="inv-fields" data-testid="invoice-fields">
          ${fields.map(([label, field, value]) => `<div class="inv-field inv-field-${field}"><dt>${label}</dt><dd data-field="${field}">${value}</dd></div>`).join("")}
        </dl></section>
      <div class="inv-actions">
        <button type="button" data-testid="reply-received" data-ghost-lock>Reply: received</button>
        <a class="lb-button" href="/sheet">Open spreadsheet</a>
        <p class="inv-reply-status" role="status" data-testid="reply-confirmation"></p>
      </div>
    </article></main></div>`;
}

function sheetRow(row: number, cells: string[]): string {
  const inputs = SHEET_HEADERS.map(
    (h, col) =>
      `<td><input type="text" id="cell-${row}-${col}" aria-label="${h} row ${row + 1}" data-row="${row}" data-col="${col}" data-col-header="${h}" autocomplete="off" value="${cells[col] ?? ""}"></td>`,
  );
  return `<tr data-row="${row}"><th scope="row" class="sheet-rownum">${row + 1}</th>${inputs.join("")}</tr>`;
}

export function sheetHtml(rows: string[][] = [], rowCount = 6): string {
  const body = Array.from({ length: rowCount }, (_, row) => sheetRow(row, rows[row] ?? [])).join("");
  return `<div class="lb-app">${header("Sheets")}<main class="lb-page">
    <div class="sheet-titlebar"><div><p class="eyebrow">Spreadsheet</p><h1>Invoice log</h1></div></div>
    <div class="sheet-toolbar" role="toolbar" aria-label="Sheet actions">
      <a class="lb-button" href="/invoices">Back to invoices</a>
      <p class="sheet-counter" aria-live="polite" data-testid="sheet-filled" data-filled="${rows.length}">${rows.length} of 60 rows filled</p>
      <button type="button" class="lb-button lb-button-danger" data-testid="clear-sheet" data-ghost-lock="">Clear sheet</button>
    </div>
    <div class="sheet-scroll"><table class="sheet-grid" aria-label="Invoice log" data-testid="sheet-grid">
      <thead><tr><th scope="col" class="sheet-corner"><span class="lb-sr-only">Row</span></th>${SHEET_HEADERS.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody></table></div>
  </main></div>`;
}

export function mount(html: string, path = "/"): void {
  window.history.replaceState(null, "", path);
  document.body.innerHTML = html;
}

export function el<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}
