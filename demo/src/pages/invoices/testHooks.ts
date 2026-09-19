import { invoicesSnapshot, readReplied, readSheet, sheetSnapshot, type InvoicesSnapshot, type SheetSnapshot } from "./state";

declare global {
  interface Window {
    /** Invoices demo state, computed from localStorage on every read. */
    __invoices?: InvoicesSnapshot;
    /** Sheet demo state (non-empty rows only), computed from localStorage on every read. */
    __sheet?: SheetSnapshot;
  }
}

/**
 * Test hooks are getters over localStorage rather than copies of React state, so a test that reads them right
 * after a write (even a write made by another tab or an iframe) never sees a stale value.
 */
export function installTestHooks(): void {
  if (typeof window === "undefined") return;
  Object.defineProperty(window, "__invoices", {
    configurable: true,
    enumerable: true,
    get: (): InvoicesSnapshot => invoicesSnapshot(readReplied(), readSheet()),
  });
  Object.defineProperty(window, "__sheet", {
    configurable: true,
    enumerable: true,
    get: (): SheetSnapshot => sheetSnapshot(readSheet()),
  });
}
