import { memo, useCallback, type ChangeEvent, type KeyboardEvent } from "react";
import { Link } from "../router";
import type { RouteParams } from "../routes";
import "../styles/sheet.css";
import { AppFooter, AppHeader } from "./invoices/Chrome";
import { SHEET_COLUMNS, SHEET_ROW_COUNT, isRowEmpty } from "./invoices/sheetModel";
import { clearSheet, writeCell } from "./invoices/state";
import { useDemoBoot, useSheetRows } from "./invoices/useDemoState";

function cellId(row: number, col: number): string {
  return `cell-${row}-${col}`;
}

function focusCell(row: number, col: number): boolean {
  const input = document.getElementById(cellId(row, col));
  if (!(input instanceof HTMLInputElement)) return false;
  input.focus();
  input.select();
  return true;
}

/** Enter and the vertical arrows move between rows. Tab is left alone so it moves right natively (and stays Ghost's key). */
function handleCellKey(event: KeyboardEvent<HTMLInputElement>, row: number, col: number): void {
  if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  const up = event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey);
  const down = event.key === "ArrowDown" || (event.key === "Enter" && !event.shiftKey);
  if (!up && !down) return;
  event.preventDefault();
  focusCell(row + (up ? -1 : 1), col);
}

interface RowProps {
  row: number;
  cells: readonly string[];
}

/** data-row and data-col are zero-based indexes; the visible row number and the aria-label are one-based. */
const SheetRow = memo(
  function SheetRow({ row, cells }: RowProps) {
    return (
      <tr data-row={row} className={isRowEmpty(cells) ? undefined : "sheet-row-filled"}>
        <th scope="row" className="sheet-rownum">
          {row + 1}
        </th>
        {SHEET_COLUMNS.map((header, col) => (
          <td key={header}>
            <input
              type="text"
              id={cellId(row, col)}
              className="sheet-cell"
              aria-label={`${header} row ${row + 1}`}
              data-row={row}
              data-col={col}
              data-col-header={header}
              autoComplete="off"
              spellCheck={false}
              value={cells[col] ?? ""}
              onChange={(event: ChangeEvent<HTMLInputElement>) => writeCell(row, col, event.target.value)}
              onKeyDown={(event) => handleCellKey(event, row, col)}
            />
          </td>
        ))}
      </tr>
    );
  },
  (prev, next) => prev.row === next.row && prev.cells.length === next.cells.length && prev.cells.every((cell, i) => cell === next.cells[i]),
);

export function Sheet(_props: { params: RouteParams }) {
  useDemoBoot();
  const rows = useSheetRows();
  const filled = rows.filter((row) => !isRowEmpty(row)).length;

  const handleClear = useCallback(() => {
    if (window.confirm("Clear every row in this sheet? This cannot be undone.")) clearSheet();
  }, []);

  return (
    <div className="lb-app">
      <AppHeader product="Sheets" home="/sheet">
        <span className="lb-account">alex.chen.dev@example.com</span>
      </AppHeader>
      <main className="lb-page">
        <div className="sheet-titlebar">
          <div>
            <p className="eyebrow">Spreadsheet</p>
            <h1>Invoice log</h1>
          </div>
        </div>
        <div className="sheet-toolbar" role="toolbar" aria-label="Sheet actions">
          <Link className="lb-button" href="/invoices">
            Back to invoices
          </Link>
          <p className="sheet-counter" aria-live="polite" data-testid="sheet-filled" data-filled={filled}>
            {filled} of {SHEET_ROW_COUNT} rows filled
          </p>
          {/* data-ghost-lock: destructive, so Ghost must never press it with Tab. */}
          <button type="button" className="lb-button lb-button-danger" data-testid="clear-sheet" data-ghost-lock="" onClick={handleClear}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M5 7V5a3 3 0 0 1 6 0v2h1a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm1.5 0h3V5a1.5 1.5 0 0 0-3 0z" fill="currentColor" />
            </svg>
            Clear sheet
          </button>
        </div>
        <div className="sheet-scroll">
          <table className="sheet-grid" aria-label="Invoice log" data-testid="sheet-grid">
            <thead>
              <tr>
                <th scope="col" className="sheet-corner">
                  <span className="lb-sr-only">Row</span>
                </th>
                {SHEET_COLUMNS.map((header) => (
                  <th key={header} scope="col">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, row) => (
                <SheetRow key={row} row={row} cells={cells} />
              ))}
            </tbody>
          </table>
        </div>
      </main>
      <AppFooter />
    </div>
  );
}
