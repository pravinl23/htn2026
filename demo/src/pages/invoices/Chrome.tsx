import type { ReactNode } from "react";
import { Link } from "../../router";
import "../../styles/invoices.css";

/** Top bar shared by the fictional "Ledgerbox" mail and sheet apps. */
export function AppHeader({ product, home, children }: { product: string; home: string; children?: ReactNode }) {
  return (
    <header className="lb-header">
      <div className="lb-header-inner">
        <Link className="brand" href={home} aria-label={`Ledgerbox ${product} home`}>
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="currentColor" />
            <path d="M10 8h3.4v12.6H22V24H10z" fill="#fff" />
          </svg>
          <span>
            Ledgerbox <span className="lb-product">{product}</span>
          </span>
        </Link>
        <div className="lb-header-side">{children}</div>
      </div>
    </header>
  );
}

export function AppFooter() {
  return (
    <footer className="lb-footer">
      Ledgerbox and every vendor shown here are fictional. Nothing on this page leaves your machine. <Link href="/">All demo sites</Link>
    </footer>
  );
}

export function StateChip({ kind }: { kind: "logged" | "replied" }) {
  return (
    <span className={`lb-chip lb-chip-${kind}`} data-chip={kind}>
      {kind === "logged" ? "Logged" : "Replied"}
    </span>
  );
}
