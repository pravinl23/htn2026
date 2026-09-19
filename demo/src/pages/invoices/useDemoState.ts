import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { readRaw, subscribe } from "../../data/storage";
import type { SheetRows } from "./sheetModel";
import { KEYS, applyResetFromUrl, loggedIds, parseReplied, parseSheet } from "./state";
import { installTestHooks } from "./testHooks";

/** The raw stored string is the snapshot: strings compare by value, so re-renders happen only on real changes. */
function useStoredRaw(key: string): string | null {
  const listen = useCallback((onChange: () => void) => subscribe(key, onChange), [key]);
  return useSyncExternalStore(listen, () => readRaw(key), () => null);
}

/** Runs once before the page first reads storage: honors "?reset=1" and exposes window.__invoices / window.__sheet. */
export function useDemoBoot(): void {
  useState(() => {
    applyResetFromUrl();
    installTestHooks();
    return true;
  });
}

export function useReplied(): ReadonlySet<string> {
  const raw = useStoredRaw(KEYS.replied);
  return useMemo(() => new Set(parseReplied(raw)), [raw]);
}

export function useSheetRows(): SheetRows {
  const raw = useStoredRaw(KEYS.sheet);
  return useMemo(() => parseSheet(raw), [raw]);
}

export function useLogged(): ReadonlySet<string> {
  const rows = useSheetRows();
  return useMemo(() => new Set(loggedIds(rows)), [rows]);
}
