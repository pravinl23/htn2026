import { randomUUID } from "node:crypto";
import type { FactLocator, StepTarget } from "@ghost/shared";
import type { Locator, Page } from "playwright-core";
import type { CdpConnector, RemotePage } from "./browserbase";

const CONNECT_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const MARK = "data-ghost-exec";

/**
 * Runs in the page (the server compiles without DOM types, so it is kept as source text).
 * Finds the grid that has a column header equal to `colHeader`. Without `row` it answers the first data row after the
 * last filled one (append semantics, never a gap in the middle); with `row` it tags that row's cell editor with `token`,
 * or with `read` answers that editor's current value (null when the cell does not exist).
 * The column index is the header's position among its siblings, so a leading row-number cell lines up on both sides.
 */
const GRID_SCRIPT = `(args) => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const EDITABLE = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=''], [contenteditable='true']";
  const editors = (root) => Array.from(root.querySelectorAll(EDITABLE));
  const valueOf = (el) => ("value" in el ? el.value : el.textContent) || "";
  for (const grid of document.querySelectorAll("table, [role=grid], [role=table]")) {
    const header = Array.from(grid.querySelectorAll("th, [role=columnheader]")).find((h) => h.getAttribute("scope") !== "row" && norm(h.textContent) === norm(args.colHeader));
    if (!header || !header.parentElement) continue;
    const col = Array.from(header.parentElement.children).indexOf(header);
    const rows = Array.from(grid.querySelectorAll("tr, [role=row]")).filter((r) => r !== header.parentElement && editors(r).length > 0);
    if (args.row === undefined) {
      let last = -1;
      rows.forEach((r, i) => { if (editors(r).some((el) => valueOf(el).trim() !== "")) last = i; });
      return last + 1 < rows.length ? last + 1 : -1;
    }
    const cell = rows[args.row] && rows[args.row].children[col];
    const editor = cell && (cell.matches(EDITABLE) ? cell : editors(cell)[0]);
    if (args.read) return editor ? valueOf(editor) : null;
    if (!editor) return -1;
    editor.setAttribute("${MARK}", args.token);
    return args.row;
  }
  return args.read ? null : -1;
}`;

/** Text of the element that follows a label-like element (dt/dd, th/td, label + value), as page facts are captured. */
const LABELLED_TEXT_SCRIPT = `(label) => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase().replace(/:$/, "");
  for (const el of document.querySelectorAll("dt, th, label, [data-label]")) {
    if (norm(el.textContent) !== norm(label) || !el.nextElementSibling) continue;
    return (el.nextElementSibling.textContent || "").replace(/\\s+/g, " ").trim();
  }
  return null;
}`;

const UNMARK_SCRIPT = `(token) => document.querySelectorAll("[${MARK}]").forEach((el) => { if (el.getAttribute("${MARK}") === token) el.removeAttribute("${MARK}"); })`;

/** Scripts are sent as one self-calling expression: Playwright only calls a function it was handed as a function, not as text. */
function call(script: string, arg: unknown): string {
  return `(${script})(${JSON.stringify(arg)})`;
}

function attr(name: string, value: string): string {
  return `[${name}=${JSON.stringify(value)}]`;
}

function factSelector(locator: FactLocator): string | null {
  if (locator.by === "label") return null;
  if (locator.by === "css") return locator.value;
  return attr(locator.by === "testid" ? "data-testid" : locator.by, locator.value);
}

/** Drives one Playwright page. Every write goes through real input events, so React-controlled fields keep the value. */
export function createPlaywrightPage(page: Page, timeoutMs: number = ACTION_TIMEOUT_MS): RemotePage {
  page.setDefaultTimeout(timeoutMs);

  async function write(field: Locator, target: StepTarget, value: string): Promise<string> {
    if (target.kind === "file") throw new Error("file inputs are never filled");
    if (target.kind === "checkbox" || target.kind === "radio") {
      const group = target.kind === "radio" ? page.getByRole("radio", { name: value, exact: true }).first() : field;
      if (target.kind === "checkbox" && !/^(true|on|yes|checked|1)$/i.test(value)) await group.uncheck();
      else await group.check();
      return value;
    }
    if (target.kind === "select") {
      await field.selectOption({ label: value }).catch(() => field.selectOption(value));
      // The program may carry the option's label or its value: either one counts as "stuck".
      const selected = await field.inputValue();
      return selected === value ? selected : ((await field.locator("option:checked").first().textContent()) ?? "").trim();
    }
    await field.fill(value);
    // inputValue() only exists for form controls; a contenteditable cell is read as text.
    return field.inputValue().catch(async () => (await field.textContent()) ?? "");
  }

  return {
    async goto(url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    },
    url: () => page.url(),
    async readText(locator) {
      const selector = factSelector(locator);
      if (selector === null) {
        await page.locator("dt, th, label, [data-label]").first().waitFor({ state: "attached" }).catch(() => undefined);
        return (await page.evaluate(call(LABELLED_TEXT_SCRIPT, locator.value))) as string | null;
      }
      const el = page.locator(selector).first();
      // A SPA may still be rendering after domcontentloaded: wait for the element before deciding it is missing.
      const attached = await el.waitFor({ state: "attached" }).then(() => true, () => false);
      return attached ? ((await el.textContent()) ?? "").replace(/\s+/g, " ").trim() : null;
    },
    async nextEmptyRow(colHeader) {
      await page.locator("table, [role=grid], [role=table]").first().waitFor({ state: "visible" });
      return (await page.evaluate(call(GRID_SCRIPT, { colHeader }))) as number;
    },
    async readCell(colHeader, row) {
      await page.locator("table, [role=grid], [role=table]").first().waitFor({ state: "visible" });
      return (await page.evaluate(call(GRID_SCRIPT, { colHeader, row, read: true }))) as string | null;
    },
    async fill(target, value, row) {
      if (row === undefined) return write(page.getByLabel(target.label, { exact: true }).first(), target, value);
      const token = randomUUID();
      const found = (await page.evaluate(call(GRID_SCRIPT, { colHeader: target.cell?.colHeader ?? target.label, row, token }))) as number;
      if (found < 0) throw new Error("grid cell not found");
      const cell = page.locator(attr(MARK, token));
      try {
        return await write(cell, target, value);
      } finally {
        await page.evaluate(call(UNMARK_SCRIPT, token)).catch(() => undefined);
      }
    },
    async click(target) {
      const role = target.kind === "link" ? "link" : "button";
      // Prefer the accessible role; fall back to the exact text for div-buttons. `or` waits for whichever renders.
      await page.getByRole(role, { name: target.label, exact: true }).or(page.getByText(target.label, { exact: true })).first().click();
    },
  };
}

/** Browserbase hands back a browser with one default context and page: reuse them, since new contexts lose its session settings. */
export const connectOverCdp: CdpConnector = async (connectUrl) => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(connectUrl, { timeout: CONNECT_TIMEOUT_MS });
  return {
    async page() {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      return createPlaywrightPage(context.pages()[0] ?? (await context.newPage()));
    },
    close: () => browser.close(),
  };
};
