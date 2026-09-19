import { INVOICES, type InvoiceEmail } from "../../data/invoices";
import { browserEnv, parseJson, readRaw, removeKey, writeJson, type StorageEnv } from "../../data/storage";
import { loggedNumbers, nonEmptyRows, normalizeSheet, trimForStorage, withCell, type SheetRows } from "./sheetModel";

/** The localStorage keys owned by the invoices and sheet pages. */
export const KEYS = {
  /** JSON string[] of invoice ids whose "Reply: received" was pressed. */
  replied: "ghostdemo.invoices.replied",
  /** JSON string[][] (rows of [vendor, number, date, total]); trailing blank rows are not stored. */
  sheet: "ghostdemo.sheet.rows",
} as const;

export const OWN_KEYS: readonly string[] = [KEYS.replied, KEYS.sheet];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// ---------- parsing (pure, used by the hooks on the raw stored string) ----------

export function parseReplied(raw: string | null): string[] {
  return parseJson<string[]>(raw, [], isStringArray);
}

export function parseSheet(raw: string | null): SheetRows {
  return normalizeSheet(parseJson<unknown>(raw, []));
}

// ---------- derivation ----------

/** Replied ids in inbox order, ignoring ids that are not real invoices. */
export function repliedIds(replied: readonly string[], invoices: readonly InvoiceEmail[] = INVOICES): string[] {
  const set = new Set(replied);
  return invoices.filter((invoice) => set.has(invoice.id)).map((invoice) => invoice.id);
}

/** Invoices whose number appears in the sheet's "Invoice #" column, in inbox order. */
export function loggedIds(rows: readonly (readonly string[])[], invoices: readonly InvoiceEmail[] = INVOICES): string[] {
  const numbers = loggedNumbers(rows);
  return invoices.filter((invoice) => numbers.has(invoice.number.toUpperCase())).map((invoice) => invoice.id);
}

export interface InvoicesSnapshot {
  total: number;
  replied: string[];
  logged: string[];
}

export interface SheetSnapshot {
  /** Only the non-empty rows, top to bottom. */
  rows: string[][];
  filled: number;
}

export function invoicesSnapshot(replied: readonly string[], rows: readonly (readonly string[])[]): InvoicesSnapshot {
  return { total: INVOICES.length, replied: repliedIds(replied), logged: loggedIds(rows) };
}

export function sheetSnapshot(rows: readonly (readonly string[])[]): SheetSnapshot {
  const filledRows = nonEmptyRows(rows);
  return { rows: filledRows, filled: filledRows.length };
}

// ---------- storage operations (always read-modify-write, so concurrent tabs and iframes do not clobber each other) ----------

export function readReplied(env: StorageEnv = browserEnv()): string[] {
  return parseReplied(readRaw(KEYS.replied, env));
}

export function readSheet(env: StorageEnv = browserEnv()): SheetRows {
  return parseSheet(readRaw(KEYS.sheet, env));
}

export function markReplied(id: string, env: StorageEnv = browserEnv()): void {
  const current = readReplied(env);
  if (!current.includes(id)) writeJson(KEYS.replied, [...current, id], env);
}

export function writeCell(row: number, col: number, value: string, env: StorageEnv = browserEnv()): void {
  writeJson(KEYS.sheet, trimForStorage(withCell(readSheet(env), row, col, value)), env);
}

export function clearSheet(env: StorageEnv = browserEnv()): void {
  removeKey(KEYS.sheet, env);
}

export function clearOwnKeys(env: StorageEnv = browserEnv()): void {
  for (const key of OWN_KEYS) removeKey(key, env);
}

/** True when the query string asks for a reset: "?reset=1" (also "?reset" and "?reset=true"). */
export function wantsReset(search: string): boolean {
  const value = new URLSearchParams(search).get("reset");
  return value !== null && value !== "0" && value !== "false";
}

/**
 * Honors "?reset=1": clears this demo's keys, then drops the flag from the URL so a later reload keeps new work.
 * Call from a lazy useState initializer so it runs before the page's first read of storage.
 */
export function applyResetFromUrl(): boolean {
  if (typeof window === "undefined" || !wantsReset(window.location.search)) return false;
  clearOwnKeys();
  const params = new URLSearchParams(window.location.search);
  params.delete("reset");
  const query = params.toString();
  window.history.replaceState(window.history.state, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);
  return true;
}
