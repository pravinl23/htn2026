/** Pure model of the demo spreadsheet: a fixed 60 x 4 grid of strings. */
export const SHEET_COLUMNS = ["Vendor", "Invoice #", "Date", "Total"] as const;
export const SHEET_ROW_COUNT = 60;
export const INVOICE_NUMBER_COL = 1;

export type SheetRows = string[][];

function emptyRow(): string[] {
  return SHEET_COLUMNS.map(() => "");
}

export function emptySheet(): SheetRows {
  return Array.from({ length: SHEET_ROW_COUNT }, emptyRow);
}

/** Accepts whatever was in storage and returns a full grid: bad shapes become blanks, extras are dropped. */
export function normalizeSheet(value: unknown): SheetRows {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: SHEET_ROW_COUNT }, (_, r) => {
    const row: unknown = source[r];
    const cells = Array.isArray(row) ? row : [];
    return SHEET_COLUMNS.map((_, c) => {
      const cell: unknown = cells[c];
      return typeof cell === "string" ? cell : "";
    });
  });
}

export function isRowEmpty(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

export function nonEmptyRows(rows: readonly (readonly string[])[]): string[][] {
  return rows.filter((row) => !isRowEmpty(row)).map((row) => [...row]);
}

/** Trailing blank rows are not stored, so an empty sheet is "[]". */
export function trimForStorage(rows: readonly (readonly string[])[]): string[][] {
  let end = rows.length;
  while (end > 0 && isRowEmpty(rows[end - 1] ?? [])) end--;
  return rows.slice(0, end).map((row) => [...row]);
}

export function withCell(rows: readonly (readonly string[])[], row: number, col: number, value: string): SheetRows {
  const next = normalizeSheet(rows);
  const target = next[row];
  if (target && col >= 0 && col < SHEET_COLUMNS.length) target[col] = value;
  return next;
}

/** Invoice numbers present in the "Invoice #" column, trimmed and upper-cased. */
export function loggedNumbers(rows: readonly (readonly string[])[]): Set<string> {
  const found = new Set<string>();
  for (const row of rows) {
    const number = (row[INVOICE_NUMBER_COL] ?? "").trim().toUpperCase();
    if (number) found.add(number);
  }
  return found;
}
