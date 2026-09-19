import { memo } from "react";
import { INVOICES, formatDate, formatMoney, type InvoiceEmail } from "../data/invoices";
import { Link } from "../router";
import type { RouteParams } from "../routes";
import { AppFooter, AppHeader, StateChip } from "./invoices/Chrome";
import { useDemoBoot, useLogged, useReplied } from "./invoices/useDemoState";

const InboxRow = memo(function InboxRow({ invoice, replied, logged }: { invoice: InvoiceEmail; replied: boolean; logged: boolean }) {
  const subjectId = `subject-${invoice.id}`;
  const detailsId = `details-${invoice.id}`;
  return (
    <li
      className={`inv-item${replied ? " replied" : ""}${logged ? " logged" : ""}`}
      data-testid="invoice-row"
      data-invoice-id={invoice.id}
      data-replied={replied}
      data-logged={logged}
    >
      <Link className="inv-row" href={`/invoices/${invoice.id}`} aria-labelledby={subjectId} aria-describedby={detailsId}>
        <span className="inv-avatar" aria-hidden="true">
          {invoice.vendor.charAt(0)}
        </span>
        <span className="inv-row-main">
          <span className="inv-row-vendor">{invoice.vendor}</span>
          <span className="inv-row-subject" id={subjectId}>
            {invoice.subject}
          </span>
          <span className="inv-row-preview">{invoice.description}</span>
        </span>
        <span className="inv-row-side" id={detailsId}>
          <span className="inv-row-total">{formatMoney(invoice.totalCents)}</span>
          <span className="inv-row-date">{formatDate(invoice.date)}</span>
          <span className="inv-row-chips">
            {logged && <StateChip kind="logged" />}
            {replied && <StateChip kind="replied" />}
          </span>
        </span>
      </Link>
    </li>
  );
});

export function Invoices(_props: { params: RouteParams }) {
  useDemoBoot();
  const replied = useReplied();
  const logged = useLogged();
  const total = INVOICES.length;
  const repliedCount = INVOICES.filter((invoice) => replied.has(invoice.id)).length;

  return (
    <div className="lb-app">
      <AppHeader product="Mail" home="/invoices">
        <span className="lb-account">alex.chen.dev@example.com</span>
      </AppHeader>
      <main className="lb-page">
        <div className="inv-titlebar">
          <div>
            <p className="eyebrow">Inbox</p>
            <h1>Invoices</h1>
          </div>
          <div className="inv-summary">
            <p className="inv-counts" aria-live="polite">
              <strong data-testid="replied-count">
                {repliedCount} of {total} replied
              </strong>
              <span data-testid="logged-count">
                {logged.size} of {total} logged
              </span>
            </p>
            <Link className="lb-button" href="/sheet">
              Open spreadsheet
            </Link>
          </div>
        </div>
        <ul role="list" className="inv-list" aria-label="Invoice emails" data-testid="invoice-list">
          {INVOICES.map((invoice) => (
            <InboxRow key={invoice.id} invoice={invoice} replied={replied.has(invoice.id)} logged={logged.has(invoice.id)} />
          ))}
        </ul>
      </main>
      <AppFooter />
    </div>
  );
}
