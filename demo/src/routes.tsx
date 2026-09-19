import type { ComponentType } from "react";
import { Apply } from "./pages/Apply";
import { Calendar } from "./pages/Calendar";
import { InvoiceView } from "./pages/InvoiceView";
import { Invoices } from "./pages/Invoices";
import { Mail } from "./pages/Mail";
import { MailView } from "./pages/MailView";
import { Reset } from "./pages/Reset";
import { Sheet } from "./pages/Sheet";

export type RouteParams = Record<string, string>;

export interface DemoRoute {
  /** Exact path, or a pattern with ":param" segments such as "/invoices/:id". */
  path: string;
  title: string;
  blurb: string;
  /** React page. Omit for static pages served from demo/public (they need a full page load). */
  component?: ComponentType<{ params: RouteParams }>;
  /** Shown on the index page. Pattern routes are never listed. */
  listed?: boolean;
}

export const ROUTES: DemoRoute[] = [
  { path: "/apply", title: "Job application (React)", blurb: "Northwind Robotics, Software Engineering Intern. Controlled inputs.", component: Apply, listed: true },
  { path: "/apply-plain/", title: "Job application (plain HTML)", blurb: "The same form with no framework.", listed: true },
  { path: "/mail", title: "Mail", blurb: "An inbox with a meeting request. Ghost helps you check the calendar and reply.", component: Mail, listed: true },
  { path: "/mail/:id", title: "Mail message", blurb: "", component: MailView },
  { path: "/calendar", title: "Calendar", blurb: "A week view with one free Thursday afternoon slot.", component: Calendar, listed: true },
  { path: "/invoices", title: "Invoices inbox", blurb: "50 invoice emails. Do two by hand, Ghost does the other 48.", component: Invoices, listed: true },
  { path: "/invoices/:id", title: "Invoice", blurb: "", component: InvoiceView },
  { path: "/sheet", title: "Spreadsheet", blurb: "Where the invoice fields get logged.", component: Sheet, listed: true },
  { path: "/reset", title: "Reset demo data", blurb: "Clears all demo state in localStorage.", component: Reset },
];

function trimSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function matchPattern(pattern: string, pathname: string): RouteParams | null {
  const want = trimSlash(pattern).split("/");
  const got = trimSlash(pathname).split("/");
  if (want.length !== got.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(":")) {
      if (!g) return null;
      params[w.slice(1)] = decodeURIComponent(g);
    } else if (w !== g) return null;
  }
  return params;
}

export function matchRouteWithParams(pathname: string): { route: DemoRoute; params: RouteParams } | undefined {
  for (const route of ROUTES) {
    const params = matchPattern(route.path, pathname);
    if (params) return { route, params };
  }
  return undefined;
}

export function matchRoute(pathname: string): DemoRoute | undefined {
  return matchRouteWithParams(pathname)?.route;
}
