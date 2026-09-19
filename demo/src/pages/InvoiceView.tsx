import { displayFields, findInvoice, formatDateTime, type InvoiceDisplay, type InvoiceEmail } from "../data/invoices";
import { Link } from "../router";
import type { RouteParams } from "../routes";
import { AppFooter, AppHeader, StateChip } from "./invoices/Chrome";
import { markReplied } from "./invoices/state";
import { useDemoBoot, useLogged, useReplied } from "./invoices/useDemoState";

const REPLY_TEXT = "Received, thanks.";

/** Row order of the invoice. Subtotal, tax, and the due date are there so "total" and "date" have look-alikes. */
const FIELD_ROWS: ReadonlyArray<{ field: keyof InvoiceDisplay; label: string }> = [
  { field: "vendor", label: "Vendor" },
  { field: "number", label: "Invoice number" },
  { field: "date", label: "Invoice date" },
  { field: "due", label: "Due date" },
  { field: "description", label: "Description" },
  { field: "subtotal", label: "Subtotal" },
  { field: "tax-rate", label: "Tax rate" },
  { field: "tax", label: "Tax" },
  { field: "total", label: "Total" },
];

function InvoiceFields({ invoice }: { invoice: InvoiceEmail }) {
  const shown = displayFields(invoice);
  return (
    <section className="inv-doc" aria-labelledby="invoice-doc-title">
      <h2 id="invoice-doc-title">Invoice</h2>
      <dl className="inv-fields" data-testid="invoice-fields">
        {FIELD_ROWS.map(({ field, label }) => (
          <div key={field} className={`inv-field inv-field-${field}`}>
            <dt>{label}</dt>
            <dd data-field={field}>{shown[field]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ReplyActions({ invoice, replied }: { invoice: InvoiceEmail; replied: boolean }) {
  return (
    <div className="inv-actions">
      {/* data-ghost-lock: a reply cannot be unsent, so Ghost must never press this with Tab. Nothing is actually sent. */}
      <button
        type="button"
        className="lb-button lb-button-primary"
        data-testid="reply-received"
        data-ghost-lock=""
        disabled={replied}
        onClick={() => markReplied(invoice.id)}
      >
        {replied ? "Replied" : "Reply: received"}
      </button>
      <Link className="lb-button" href="/sheet">
        Open spreadsheet
      </Link>
      <p className="inv-reply-status" role="status" data-testid="reply-confirmation">
        {replied ? `Reply sent: ${REPLY_TEXT}` : ""}
      </p>
    </div>
  );
}

function InvoiceNotFound({ id }: { id: string }) {
  return (
    <section className="inv-email inv-missing" data-testid="invoice-not-found">
      <h1>Invoice not found</h1>
      <p className="lede">
        There is no email for <code>{id || "that id"}</code> in this inbox. Invoices run from INV-1001 to INV-1050.
      </p>
    </section>
  );
}

function Email({ invoice, replied, logged }: { invoice: InvoiceEmail; replied: boolean; logged: boolean }) {
  return (
    <article className="inv-email" aria-labelledby="email-subject" data-invoice-id={invoice.id} data-replied={replied} data-logged={logged}>
      <header className="inv-email-head">
        <div className="inv-email-title">
          <h1 id="email-subject">{invoice.subject}</h1>
          <span className="inv-row-chips">
            {logged && <StateChip kind="logged" />}
            {replied && <StateChip kind="replied" />}
          </span>
        </div>
        <dl className="inv-email-meta">
          <div>
            <dt>From</dt>
            <dd>
              {invoice.senderName} &lt;{invoice.senderEmail}&gt;
            </dd>
          </div>
          <div>
            <dt>To</dt>
            <dd>Alex Chen &lt;alex.chen.dev@example.com&gt;</dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd>
              <time dateTime={invoice.receivedAt}>{formatDateTime(invoice.receivedAt)}</time>
            </dd>
          </div>
        </dl>
      </header>
      <div className="inv-email-body">
        {invoice.body.split("\n\n").map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <InvoiceFields invoice={invoice} />
      <ReplyActions invoice={invoice} replied={replied} />
    </article>
  );
}

export function InvoiceView({ params }: { params: RouteParams }) {
  useDemoBoot();
  const replied = useReplied();
  const logged = useLogged();
  const id = params.id ?? "";
  const invoice = findInvoice(id);

  return (
    <div className="lb-app">
      <AppHeader product="Mail" home="/invoices">
        <span className="lb-account">alex.chen.dev@example.com</span>
      </AppHeader>
      <main className="lb-page lb-page-narrow">
        <nav className="inv-toolbar" aria-label="Message">
          <Link className="inv-back" href="/invoices">
            Back to inbox
          </Link>
        </nav>
        {invoice ? <Email invoice={invoice} replied={replied.has(invoice.id)} logged={logged.has(invoice.id)} /> : <InvoiceNotFound id={id} />}
      </main>
      <AppFooter />
    </div>
  );
}
