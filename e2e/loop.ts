// Shared driver for the invoice-loop specs: the closed loop sheet's shadow root, the demo's own state, and the
// routine a person performs by hand. compareA.spec.ts measures this flow; stage6-loop.spec.ts asserts it.
import type { CDPSession, Page } from "@playwright/test";
import { DEMO_URL, expect } from "./fixtures";

export const LOOP_HOST = "#ghost-loop-host";
export const FIELDS = ["vendor", "number", "date", "total"] as const;
export const INVOICE_IDS = ["INV-1001", "INV-1002"] as const;

interface SheetWindow {
  __sheet?: { rows: string[][]; filled: number };
  __invoices?: { total: number; replied: string[]; logged: string[] };
}

// ---------- the loop sheet's closed shadow root (same CDP trick as fixtures.overlayEval, other host id) ----------

interface DomNode {
  nodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

const sessions = new WeakMap<Page, Promise<CDPSession>>();

function cdp(page: Page): Promise<CDPSession> {
  let session = sessions.get(page);
  if (!session) sessions.set(page, (session = page.context().newCDPSession(page)));
  return session;
}

function findById(node: DomNode, id: string): DomNode | null {
  const attrs = node.attributes ?? [];
  for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i] === "id" && attrs[i + 1] === id) return node;
  for (const child of node.children ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * Runs `fn` inside the loop sheet's closed shadow root, optionally with one serializable argument. `fn` is sent
 * as source, so it closes over nothing: everything it needs has to arrive through `arg`.
 * Returns null when the sheet is not mounted.
 */
export async function panelEval<T, A = undefined>(page: Page, fn: (root: ShadowRoot, arg: A) => T, arg?: A): Promise<T | null> {
  const session = await cdp(page);
  const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  const shadowId = findById(root, LOOP_HOST.slice(1))?.shadowRoots?.[0]?.nodeId;
  if (shadowId === undefined) return null;
  const { object } = await session.send("DOM.resolveNode", { nodeId: shadowId });
  if (!object.objectId) return null;
  const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function (a) { return (${fn.toString()})(this, a); }`,
    arguments: [{ value: arg }],
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`panelEval failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value as T;
}

export interface PreviewRow {
  index: number;
  label: string;
  checked: boolean;
  disabled: boolean;
  vars: string[];
  note: string;
}

export interface PanelView {
  headline: string;
  name: string;
  confirmLabel: string;
  confirmDisabled: boolean;
  effects: string[];
  rows: PreviewRow[];
  confirmBox: { x: number; y: number } | null;
}

export function readPanel(page: Page): Promise<PanelView | null> {
  return panelEval(page, (root): PanelView => {
    const text = (sel: string): string => root.querySelector(sel)?.textContent?.trim() ?? "";
    const confirm = root.querySelector<HTMLButtonElement>(".foot .confirm, button.confirm");
    const box = confirm?.getBoundingClientRect();
    return {
      headline: text(".headline"),
      name: text(".name"),
      confirmLabel: confirm?.textContent?.trim() ?? "",
      confirmDisabled: confirm?.disabled ?? true,
      effects: Array.from(root.querySelectorAll(".effects li"), (li) => li.textContent?.trim() ?? ""),
      rows: Array.from(root.querySelectorAll<HTMLTableRowElement>("tbody tr"), (tr) => ({
        index: Number(tr.dataset.index ?? "-1"),
        label: tr.querySelector(".item")?.textContent?.trim() ?? "",
        checked: tr.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked ?? false,
        disabled: tr.querySelector<HTMLInputElement>("input[type=checkbox]")?.disabled ?? true,
        vars: Array.from(tr.querySelectorAll("td.val"), (td) => td.textContent?.trim() ?? ""),
        note: tr.querySelector(".note")?.textContent?.trim() ?? "",
      })),
      confirmBox: box && box.width > 0 ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null,
    };
  });
}

export async function hostAttrs(page: Page): Promise<Record<string, string>> {
  return page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return {};
    return Object.fromEntries(Array.from(el.attributes, (a) => [a.name, a.value]));
  }, LOOP_HOST.slice(1));
}

/**
 * Unchecks exactly one preview row by its `data-index`: the person holding one item back for review.
 * Returns false when that row has no usable checkbox, so a caller can fail loudly instead of running 48.
 */
export async function excludeRow(page: Page, index: number): Promise<boolean> {
  const done = await panelEval(
    page,
    (root, target: number) => {
      const rows = Array.from(root.querySelectorAll<HTMLTableRowElement>("tbody tr"));
      const row = rows.find((tr) => Number(tr.dataset.index ?? "-1") === target);
      const box = row?.querySelector<HTMLInputElement>("input[type=checkbox]");
      if (!box || box.disabled || !box.checked) return false;
      box.click();
      box.dispatchEvent(new Event("change", { bubbles: true }));
      return !box.checked;
    },
    index,
  );
  return done === true;
}

// ---------- the routine, done by hand ----------

export async function readInvoice(page: Page): Promise<string[]> {
  return page.evaluate(
    (fields) => fields.map((f) => document.querySelector(`[data-testid="invoice-fields"] dd[data-field="${f}"]`)?.textContent?.trim() ?? ""),
    [...FIELDS],
  );
}

/** Opens invoice `index` from the inbox with a real click on its row link. */
export async function openInvoice(page: Page, index: number): Promise<void> {
  await expect(page).toHaveURL(/\/invoices$/);
  const row = page.getByTestId("invoice-row").nth(index);
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${INVOICE_IDS[index] ?? "INV-"}$`));
  await expect(page.getByTestId("invoice-fields")).toBeVisible();
}

/** Clicks each cell and types into it; the blur of the next click commits the previous edit. */
export async function typeRow(page: Page, row: number, values: string[]): Promise<void> {
  for (let col = 0; col < values.length; col++) {
    const cell = page.locator(`#cell-${row}-${col}`);
    await cell.click();
    await cell.pressSequentially(values[col] ?? "", { delay: 5 });
  }
  await page.locator(`#cell-${row}-${values.length - 1}`).press("Enter"); // native: moves down, committing the last cell
  await expect(page.getByTestId("sheet-filled")).toHaveAttribute("data-filled", String(row + 1));
}

/** One full demonstration: open the invoice, copy its four fields into sheet row `index`, come back, reply. */
export async function demonstrate(page: Page, index: number): Promise<string[]> {
  await openInvoice(page, index);
  const values = await readInvoice(page);
  await page.getByRole("link", { name: "Open spreadsheet" }).click();
  await expect(page).toHaveURL(/\/sheet$/);
  await typeRow(page, index, values);
  await page.goBack(); // back to the invoice, exactly as docs/loops.md section 4 describes the routine
  await expect(page).toHaveURL(new RegExp(`/invoices/${INVOICE_IDS[index] ?? "INV-"}$`));
  await page.getByTestId("reply-received").click();
  await expect(page.getByTestId("reply-confirmation")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/invoices$/);
  return values;
}

export async function fresh(page: Page): Promise<void> {
  await page.goto(`${DEMO_URL}/reset`);
  await expect(page.getByTestId("reset-done")).toHaveAttribute("data-remaining", "0");
  await page.goto(`${DEMO_URL}/invoices`);
  await expect(page.getByTestId("invoice-row").first()).toBeVisible();
}

export const sheetRows = (page: Page): Promise<string[][]> => page.evaluate(() => (window as SheetWindow).__sheet?.rows ?? []);
export const repliedIds = (page: Page): Promise<string[]> => page.evaluate(() => (window as SheetWindow).__invoices?.replied ?? []);
