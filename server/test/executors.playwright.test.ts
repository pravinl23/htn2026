import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPlaywrightPage } from "../src/executors/playwrightConnector";

/**
 * The page-side scripts of the CDP driver only mean something in a real DOM, so this drives a local headless Chromium
 * over inline HTML (page.setContent: no network, no port, no demo server). Skipped when no Playwright browser is installed.
 */
const SHEET = `
  <h1>Invoice log</h1>
  <dl><dt>Vendor</dt><dd data-field="vendor">  Northwind   Traders </dd><dt>Amount due:</dt><dd>$1,204.50</dd></dl>
  <label for="note">Note</label><input id="note" />
  <label for="status">Status</label><select id="status"><option value="o">Open</option><option value="p">Paid</option></select>
  <button type="button" onclick="window.replied = (window.replied || 0) + 1">Reply: received</button>
  <table aria-label="Invoice log">
    <thead><tr><th class="corner"></th><th scope="col">Vendor</th><th scope="col">Invoice #</th><th scope="col">Total</th></tr></thead>
    <tbody>
      ${[0, 1, 2, 3].map((r) => `<tr><th scope="row">${r + 1}</th>${[0, 1, 2].map((c) => `<td><input id="cell-${r}-${c}" aria-label="col ${c} row ${r + 1}" value="${r === 0 ? "filled" : ""}"></td>`).join("")}</tr>`).join("")}
    </tbody>
  </table>`;

let browser: Browser | undefined;
let page: Page | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true }).catch(() => undefined);
  page = await browser?.newPage();
  await page?.setContent(SHEET);
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

describe("Playwright page driver (local Chromium)", () => {
  it("finds the append row, fills the cell under a column header and reads the value back", async (ctx) => {
    if (!page) return ctx.skip();
    const remote = createPlaywrightPage(page, 3000);
    expect(await remote.nextEmptyRow("Invoice #")).toBe(1);
    const target = { label: "Invoice #", kind: "text" as const, cell: { row: "next-empty" as const, colHeader: "Invoice #" } };
    expect(await remote.fill(target, "INV-1003", 1)).toBe("INV-1003");
    expect(await page.inputValue("#cell-1-1")).toBe("INV-1003");
    expect(await page.locator("[data-ghost-exec]").count()).toBe(0); // the temporary marker is removed
    // What the durability check of parallel mode reads back from a second browser.
    expect(await remote.readCell("Invoice #", 1)).toBe("INV-1003");
    expect(await remote.readCell("Invoice #", 2)).toBe("");
    expect(await remote.readCell("Invoice #", 99)).toBeNull();
    expect(await remote.readCell("No such column", 0)).toBeNull();
    expect(await remote.nextEmptyRow("vendor")).toBe(2);
    expect(await remote.nextEmptyRow("No such column")).toBe(-1);
    await expect(remote.fill({ ...target, cell: { row: "next-empty", colHeader: "Total" } }, "1", 99)).rejects.toThrow("grid cell not found");
  }, 30_000);

  it("reads page facts by data-field and by label, fills by label, selects and clicks", async (ctx) => {
    if (!page) return ctx.skip();
    const remote = createPlaywrightPage(page, 3000);
    expect(await remote.readText({ by: "data-field", value: "vendor" })).toBe("Northwind Traders");
    expect(await remote.readText({ by: "label", value: "Amount due" })).toBe("$1,204.50");
    expect(await remote.fill({ label: "Note", kind: "text" }, "Received, thanks.")).toBe("Received, thanks.");
    expect(await remote.fill({ label: "Status", kind: "select" }, "Paid")).toBe("Paid");
    await remote.click({ label: "Reply: received", kind: "button" });
    expect(await page.evaluate("window.replied")).toBe(1);
    // A short timeout for the misses: each one waits its full timeout before giving up.
    const impatient = createPlaywrightPage(page, 300);
    expect(await impatient.readText({ by: "testid", value: "missing" })).toBeNull();
    await expect(impatient.click({ label: "No such button", kind: "button" })).rejects.toThrow(/Timeout/);
  }, 30_000);
});
