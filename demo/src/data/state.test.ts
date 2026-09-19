import { describe, expect, it, vi } from "vitest";
import { SHEET_COLUMNS, SHEET_ROW_COUNT, emptySheet, nonEmptyRows, normalizeSheet, trimForStorage, withCell } from "../pages/invoices/sheetModel";
import {
  KEYS, OWN_KEYS, clearOwnKeys, clearSheet, invoicesSnapshot, loggedIds, markReplied, parseReplied, parseSheet, readReplied,
  readSheet, repliedIds, sheetSnapshot, wantsReset, writeCell,
} from "../pages/invoices/state";
import { INVOICES, expectedSheetRow } from "./invoices";
import { DEMO_PREFIX, MemoryStorage, readRaw, subscribe, writeJson, type StorageEnv } from "./storage";

function makeEnv(): StorageEnv {
  return { storage: new MemoryStorage(), events: new EventTarget() };
}

describe("sheet model", () => {
  it("is a 60 x 4 grid with the documented headers", () => {
    expect(SHEET_COLUMNS).toEqual(["Vendor", "Invoice #", "Date", "Total"]);
    expect(emptySheet()).toHaveLength(SHEET_ROW_COUNT);
    expect(emptySheet().every((row) => row.length === 4 && row.every((cell) => cell === ""))).toBe(true);
  });

  it("normalizes anything found in storage into a full grid", () => {
    expect(normalizeSheet(null)).toEqual(emptySheet());
    expect(normalizeSheet("nope")).toEqual(emptySheet());
    const messy = normalizeSheet([["a", 5, "c", "d", "extra"], "row", ["only"]]);
    expect(messy).toHaveLength(SHEET_ROW_COUNT);
    expect(messy[0]).toEqual(["a", "", "c", "d"]);
    expect(messy[1]).toEqual(["", "", "", ""]);
    expect(messy[2]).toEqual(["only", "", "", ""]);
    expect(normalizeSheet(Array.from({ length: 90 }, () => ["x", "x", "x", "x"]))).toHaveLength(SHEET_ROW_COUNT);
  });

  it("sets one cell without mutating the input and ignores out-of-range writes", () => {
    const before = emptySheet();
    const after = withCell(before, 2, 1, "INV-1003");
    expect(before[2]?.[1]).toBe("");
    expect(after[2]).toEqual(["", "INV-1003", "", ""]);
    expect(withCell(before, 60, 0, "x")).toEqual(emptySheet());
    expect(withCell(before, 0, 4, "x")).toEqual(emptySheet());
    expect(withCell(before, -1, 0, "x")).toEqual(emptySheet());
  });

  it("reports only non-empty rows and stores no trailing blanks", () => {
    const rows = withCell(withCell(emptySheet(), 0, 0, "Brightwave Supply"), 3, 3, "$10.00");
    expect(nonEmptyRows(rows)).toEqual([["Brightwave Supply", "", "", ""], ["", "", "", "$10.00"]]);
    expect(trimForStorage(rows)).toHaveLength(4);
    expect(trimForStorage(emptySheet())).toEqual([]);
    expect(nonEmptyRows(withCell(emptySheet(), 5, 2, "   "))).toEqual([]);
  });
});

describe("replied and logged derivation", () => {
  it("lists replied ids in inbox order and drops unknown ids", () => {
    expect(repliedIds(["INV-1010", "INV-9999", "INV-1002", "INV-1010"])).toEqual(["INV-1002", "INV-1010"]);
    expect(repliedIds([])).toEqual([]);
  });

  it("marks an invoice logged when its number is in the Invoice # column", () => {
    const rows = emptySheet();
    rows[0] = [...expectedSheetRow(INVOICES[4]!)];
    rows[1] = [...expectedSheetRow(INVOICES[1]!)];
    rows[7] = ["Somebody", "  inv-1030 ", "", ""];
    rows[8] = ["INV-1040", "", "", ""]; // number typed into the wrong column does not count
    rows[9] = ["", "INV-7777", "", ""];
    expect(loggedIds(rows)).toEqual(["INV-1002", "INV-1005", "INV-1030"]);
    expect(loggedIds(emptySheet())).toEqual([]);
  });

  it("builds the window.__invoices and window.__sheet shapes", () => {
    const rows = withCell(emptySheet(), 0, 1, "INV-1001");
    expect(invoicesSnapshot(["INV-1001", "INV-1003"], rows)).toEqual({ total: 50, replied: ["INV-1001", "INV-1003"], logged: ["INV-1001"] });
    expect(sheetSnapshot(rows)).toEqual({ rows: [["", "INV-1001", "", ""]], filled: 1 });
    expect(sheetSnapshot(emptySheet())).toEqual({ rows: [], filled: 0 });
  });

  it("parses stored strings defensively", () => {
    expect(parseReplied(null)).toEqual([]);
    expect(parseReplied('{"a":1}')).toEqual([]);
    expect(parseReplied('["INV-1001",2]')).toEqual([]);
    expect(parseReplied('["INV-1001"]')).toEqual(["INV-1001"]);
    expect(parseSheet("not json")).toEqual(emptySheet());
    expect(parseSheet('[["a","b","c","d"]]')[0]).toEqual(["a", "b", "c", "d"]);
  });
});

describe("storage operations", () => {
  it("uses ghostdemo.-prefixed keys", () => {
    expect(KEYS).toEqual({ replied: "ghostdemo.invoices.replied", sheet: "ghostdemo.sheet.rows" });
    expect(OWN_KEYS.every((key) => key.startsWith(DEMO_PREFIX))).toBe(true);
  });

  it("marks replies once and announces the change", () => {
    const env = makeEnv();
    const heard = vi.fn();
    subscribe(KEYS.replied, heard, env);
    markReplied("INV-1002", env);
    markReplied("INV-1002", env);
    markReplied("INV-1001", env);
    expect(readReplied(env)).toEqual(["INV-1002", "INV-1001"]);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("writes cells read-modify-write, so a stale writer cannot clobber another tab's row", () => {
    const env = makeEnv();
    writeCell(0, 0, "Brightwave Supply", env);
    // Another tab or iframe fills row 2 directly in storage while this one still shows the old grid.
    writeJson(KEYS.sheet, [["Brightwave Supply", "", "", ""], ["Harbor Lane Logistics", "INV-1002", "", ""]], env);
    writeCell(0, 1, "INV-1001", env);
    expect(sheetSnapshot(readSheet(env))).toEqual({
      rows: [["Brightwave Supply", "INV-1001", "", ""], ["Harbor Lane Logistics", "INV-1002", "", ""]],
      filled: 2,
    });
    expect(readRaw(KEYS.sheet, env)).toBe(JSON.stringify(nonEmptyRows(readSheet(env))));
  });

  it("clears the sheet, and clears both keys on reset", () => {
    const env = makeEnv();
    writeCell(1, 3, "$5.00", env);
    markReplied("INV-1001", env);
    writeJson("ghostdemo.mail.pickedSlot", "Thu 2pm", env);
    clearSheet(env);
    expect(readSheet(env)).toEqual(emptySheet());
    expect(readReplied(env)).toEqual(["INV-1001"]);
    clearOwnKeys(env);
    expect(readReplied(env)).toEqual([]);
    expect(readRaw("ghostdemo.mail.pickedSlot", env)).toBe('"Thu 2pm"'); // ?reset=1 only clears this demo's own keys
  });

  it("recognizes the reset flag", () => {
    expect(wantsReset("?reset=1")).toBe(true);
    expect(wantsReset("?a=b&reset=true")).toBe(true);
    expect(wantsReset("?reset")).toBe(true);
    expect(wantsReset("?reset=0")).toBe(false);
    expect(wantsReset("?reset=false")).toBe(false);
    expect(wantsReset("")).toBe(false);
    expect(wantsReset("?resetting=1")).toBe(false);
  });
});
