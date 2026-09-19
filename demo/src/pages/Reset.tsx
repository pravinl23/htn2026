import { useState } from "react";
import { DEMO_PREFIX, clearPrefix, keysWithPrefix } from "../data/storage";
import { Link } from "../router";
import type { RouteParams } from "../routes";
import { installTestHooks } from "./invoices/testHooks";

const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/invoices", label: "Invoices inbox" },
  { href: "/sheet", label: "Spreadsheet" },
  { href: "/mail", label: "Mail" },
  { href: "/calendar", label: "Calendar" },
  { href: "/", label: "All demo sites" },
];

/** Clears every "ghostdemo." key. Runs in a state initializer so it has happened before anything renders. */
export function Reset(_props: { params: RouteParams }) {
  useState(() => {
    clearPrefix(DEMO_PREFIX);
    installTestHooks();
    return true;
  });
  const remaining = keysWithPrefix(DEMO_PREFIX).length;

  return (
    <main className="page index">
      <p className="eyebrow">Ghost demo</p>
      <h1>Demo data reset</h1>
      <p className="lede" role="status" data-testid="reset-done" data-remaining={remaining}>
        {remaining === 0
          ? "All demo state in this browser was cleared: replies, the spreadsheet, and the mail and calendar picks."
          : "Some demo state could not be cleared. Check that this site may use localStorage."}
      </p>
      <ul className="demo-list">
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link className="demo-card" href={link.href}>
              <span className="demo-card-title">{link.label}</span>
              <code>{link.href}</code>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
