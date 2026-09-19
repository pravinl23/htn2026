import type { PageFact, TraceEvent } from "@ghost/shared";
import { DEMO_ORIGIN, INBOX_LIST, INVOICES, invoiceFacts, invoicePath } from "../../shared/test/helpers/traceBuilder";
import type { Invoice } from "../../shared/test/helpers/traceBuilder";
import { LIST_HANDLED_LABEL, LIST_LENGTH_LABEL } from "../src/background/traceStore";
import type { TraceStore } from "../src/background/traceStore";

export const INBOX_URL = `${DEMO_ORIGIN}/invoices`;

/** A clock the test moves: the store and the watcher both read it. */
export function createClock(start = 0): { now: () => number; set(t: number): void } {
  let current = start;
  return { now: () => current, set: (t) => void (current = t) };
}

/** The list-length report of the inbox, as a content script sends it inside "ghost:page-facts". */
export function inboxFacts(total = 50, handled?: string): PageFact[] {
  const facts: PageFact[] = [{ locator: { by: "css", value: INBOX_LIST }, label: LIST_LENGTH_LABEL, text: String(total) }];
  if (handled !== undefined) facts.push({ locator: { by: "css", value: INBOX_LIST }, label: LIST_HANDLED_LABEL, text: handled });
  return facts;
}

export async function reportInvoiceFacts(store: TraceStore, opts: { inbox?: PageFact[] | null; keep?: (fact: PageFact) => boolean; invoices?: Invoice[] } = {}): Promise<void> {
  const from = { tabId: 1, origin: DEMO_ORIGIN };
  if (opts.inbox !== null) await store.setFacts({ url: INBOX_URL, facts: opts.inbox ?? inboxFacts() }, from);
  for (const inv of opts.invoices ?? INVOICES) {
    await store.setFacts({ url: DEMO_ORIGIN + invoicePath(inv), facts: invoiceFacts(inv).filter(opts.keep ?? (() => true)) }, from);
  }
}

/** The content script's view of an event: no tab id, that comes from the sender. */
export function asContentEvent(event: TraceEvent): Omit<TraceEvent, "tabId"> {
  const { tabId: _tabId, ...rest } = event;
  return rest;
}

/** Real timers: lets every promise chain over the in-memory storage finish. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
