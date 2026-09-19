import type { ReactNode } from "react";
import { ME } from "../../data/mail";
import { Link } from "../../router";

interface ChromeProps {
  app: "Mail" | "Calendar";
  /** Extra class on the wrapper: the calendar page widens the column. */
  className?: string;
  children: ReactNode;
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path d="M8 11.5h16v10H8z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      <path d="M8.5 12l7.5 6 7.5-6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Header and footer shared by the mail and calendar pages of the fictional "Larkspur" workspace. */
export function MailChrome({ app, className, children }: ChromeProps) {
  const home = app === "Mail" ? "/mail" : "/calendar";
  return (
    <div className={className ? `larkspur ${className}` : "larkspur"}>
      <header className="site-header">
        <div className="site-header-inner">
          <Link className="brand" href={home} aria-label={`Larkspur ${app}`}>
            <Logo />
            <span>Larkspur {app}</span>
          </Link>
          <span className="site-header-tag">{ME.email}</span>
        </div>
      </header>
      {children}
      <footer className="site-footer">
        Larkspur is a fictional workspace and everyone in it is invented. This page is a local Ghost demo: nothing is
        sent anywhere.
      </footer>
    </div>
  );
}
