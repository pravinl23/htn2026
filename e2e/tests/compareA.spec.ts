// MEASUREMENT SPEC (not a product test): walks approach A — "do it twice, Ghost does the rest" — exactly as a
// judge would, in headless Chromium with the built extension loaded and the keyless server on 8788.
//
// It deliberately asserts nothing until the very end of each phase and prints a timing/verdict line, so a run
// that stops early still says WHERE it stopped. Every wait is on a condition; there are no sleeps.
import type { CDPSession, Page, Worker } from "@playwright/test";
import { DEMO_URL, E2E_SERVER_URL, HOST, expect, readHud, test } from "../fixtures";

const LOOP_HOST = "#ghost-loop-host";
const FIELDS = ["vendor", "number", "date", "total"] as const;
const INVOICE_IDS = ["INV-1001", "INV-1002"] as const;

interface SheetWindow {
  __sheet?: { rows: string[][]; filled: number };
  __invoices?: { total: number; replied: string[]; logged: string[] };
}

interface TraceEventLite {
  t: number;
  type: string;
  url: string;
  pathPattern: string;
  synthetic?: boolean;
  target?: { label?: string; kind?: string; list?: { listSignature: string; index: number }; cell?: { row: number; colHeader: string } };
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

async function panelEval<T>(page: Page, fn: (root: ShadowRoot) => T): Promise<T | null> {
  const session = await cdp(page);
  const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as { root: DomNode };
  const shadowId = findById(root, LOOP_HOST.slice(1))?.shadowRoots?.[0]?.nodeId;
  if (shadowId === undefined) return null;
  const { object } = await session.send("DOM.resolveNode", { nodeId: shadowId });
  if (!object.objectId) return null;
  const { result, exceptionDetails } = await session.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function () { return (${fn.toString()})(this); }`,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`panelEval failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value as T;
}

interface PanelView {
  headline: string;
  name: string;
  confirmLabel: string;
  confirmDisabled: boolean;
  effects: string[];
  rows: Array<{ index: number; label: string; checked: boolean; disabled: boolean; vars: string[]; note: string }>;
  confirmBox: { x: number; y: number } | null;
}

function readPanel(page: Page): Promise<PanelView | null> {
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

async function hostAttrs(page: Page): Promise<Record<string, string>> {
  return page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return {};
    return Object.fromEntries(Array.from(el.attributes, (a) => [a.name, a.value]));
  }, LOOP_HOST.slice(1));
}

// ---------- the worker's own state, for the "why did nothing happen" answer ----------

async function sessionValue<T>(worker: Worker, key: string): Promise<T | undefined> {
  return worker.evaluate(async (k) => {
    const area = (globalThis as unknown as { chrome: { storage: { session: { get(key: string): Promise<Record<string, unknown>> } } } }).chrome.storage.session;
    return (await area.get(k))[k];
  }, key) as Promise<T | undefined>;
}

function shapeOf(e: TraceEventLite): string {
  const t = e.target;
  const target = t?.cell ? `CELL(${t.cell.colHeader})` : t?.list ? `LIST[${t.list.index}]` : t ? `${t.label}#${t.kind}` : "";
  return `${e.type}|${e.pathPattern}|${target}${e.synthetic ? "|SYNTH" : ""}`;
}

interface FactsEntry {
  url: string;
  pathPattern: string;
  facts: Array<{ locator: { by: string; value: string }; label: string; text: string }>;
  lists: Record<string, { total: number; handled: number[] }>;
}

async function dumpTrace(worker: Worker, why: string): Promise<void> {
  const events = (await sessionValue<TraceEventLite[]>(worker, "ghost.trace.events")) ?? [];
  const facts = (await sessionValue<FactsEntry[]>(worker, "ghost.trace.facts")) ?? [];
  const seen = (await sessionValue<unknown>(worker, "ghost.loop.seen")) ?? null;
  const state = (await sessionValue<unknown>(worker, "ghost.loop.state")) ?? null;
  console.log(`\n===== TRACE DUMP (${why}) =====`);
  console.log(`${events.length} events:`);
  events.forEach((e, i) => console.log(`  ${String(i).padStart(2)}  ${shapeOf(e)}`));
  console.log(`${facts.length} pages with facts:`);
  for (const f of facts) console.log(`  ${f.url}  lists=${JSON.stringify(f.lists)}  facts=${f.facts.length} first=${JSON.stringify(f.facts.slice(0, 5))}`);
  console.log(`loop.seen: ${JSON.stringify(seen)}`);
  console.log(`loop.state: ${JSON.stringify(state)?.slice(0, 800)}`);
  console.log("===== END TRACE DUMP =====\n");
}

// ---------- the routine, done by hand ----------

async function readInvoice(page: Page): Promise<string[]> {
  return page.evaluate((fields) => fields.map((f) => document.querySelector(`[data-testid="invoice-fields"] dd[data-field="${f}"]`)?.textContent?.trim() ?? ""), [...FIELDS]);
}

/** Opens invoice `index` from the inbox with a real click on its row link. */
async function openInvoice(page: Page, index: number): Promise<void> {
  await expect(page).toHaveURL(/\/invoices$/);
  const row = page.getByTestId("invoice-row").nth(index);
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/invoices/${INVOICE_IDS[index] ?? "INV-"}$`));
  await expect(page.getByTestId("invoice-fields")).toBeVisible();
}

/** Clicks each cell and types into it; the blur of the next click commits the previous edit. */
async function typeRow(page: Page, row: number, values: string[]): Promise<void> {
  for (let col = 0; col < values.length; col++) {
    const cell = page.locator(`#cell-${row}-${col}`);
    await cell.click();
    await cell.pressSequentially(values[col] ?? "", { delay: 5 });
  }
  await page.locator(`#cell-${row}-${values.length - 1}`).press("Enter"); // native: moves down, committing the last cell
  await expect(page.getByTestId("sheet-filled")).toHaveAttribute("data-filled", String(row + 1));
}

/** One full demonstration: open the invoice, copy its four fields into sheet row `index`, come back, reply. */
async function demonstrate(page: Page, index: number): Promise<string[]> {
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

async function fresh(page: Page): Promise<void> {
  await page.goto(`${DEMO_URL}/reset`);
  await expect(page.getByTestId("reset-done")).toHaveAttribute("data-remaining", "0");
  await page.goto(`${DEMO_URL}/invoices`);
  await expect(page.getByTestId("invoice-row").first()).toBeVisible();
}

const sheetRows = (page: Page): Promise<string[][]> => page.evaluate(() => (window as SheetWindow).__sheet?.rows ?? []);
const repliedIds = (page: Page): Promise<string[]> => page.evaluate(() => (window as SheetWindow).__invoices?.replied ?? []);

// ============================================================================

test.describe("approach A, measured in Chrome", () => {
  test.use({ serverUrl: E2E_SERVER_URL });
  test.setTimeout(420_000);

  test("the canonical invoice loop: two by hand, then what does Ghost do?", async ({ page, worker }) => {
    const report: string[] = [];
    const note = (line: string): void => void (console.log(`  [A] ${line}`), report.push(line));
    const t0 = Date.now();
    page.on("pageerror", (error) => note(`PAGE ERROR: ${error.message}`));
    page.on("console", (m) => void (m.text().includes("[ghost]") ? note(`ghost log: ${m.text()}`) : undefined));

    await fresh(page);
    await expect(page.locator(HOST)).toHaveCount(1); // the content script is in
    note(`reset + inbox ready in ${Date.now() - t0} ms`);

    const first = await demonstrate(page, 0);
    note(`demonstration 1 done (${first.join(" | ")})`);
    const second = await demonstrate(page, 1);
    note(`demonstration 2 done (${second.join(" | ")})`);

    // Both demonstrations really happened in the page.
    expect(await sheetRows(page)).toEqual([first, second]);
    expect(await repliedIds(page)).toEqual([...INVOICE_IDS]);
    await expect(page.getByTestId("replied-count")).toHaveText("2 of 50 replied");
    note(`the page itself is correct after two manual runs (${Date.now() - t0} ms)`);

    // ---- 1. does a proposal appear? ----
    const proposalAt = Date.now();
    let proposed = true;
    await expect
      .poll(async () => (await hostAttrs(page))["data-loop-state"] ?? "no-host", { timeout: 30_000, message: 'the loop sheet reaching data-loop-state="proposed"' })
      .toBe("proposed")
      .catch(() => void (proposed = false));
    if (!proposed) {
      note(`NO PROPOSAL after ${Date.now() - proposalAt} ms. host=${JSON.stringify(await hostAttrs(page))}`);
      await dumpTrace(worker, "no proposal");
      throw new Error("STOP: no loop proposal. See the trace dump above.");
    }
    note(`proposal shown ${Date.now() - proposalAt} ms after the second demonstration`);
    note(`host attrs: ${JSON.stringify(await hostAttrs(page))}`);

    // ---- 2. does the preview grid fill with the remaining 48? ----
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-remaining", "48");
    const previewAt = Date.now();
    let previewed = true;
    await expect
      .poll(async () => (await hostAttrs(page))["data-loop-preview"], { timeout: 180_000, message: "the dry-run preview finishing" })
      .toBe("ready")
      .catch(() => void (previewed = false));
    const previewMs = Date.now() - previewAt;
    const panel = await readPanel(page);
    note(`preview ${previewed ? "ready" : "DID NOT FINISH"} in ${previewMs} ms; host=${JSON.stringify(await hostAttrs(page))}`);
    note(`sheet says: headline="${panel?.headline}" name="${panel?.name}" confirm="${panel?.confirmLabel}" effects=${JSON.stringify(panel?.effects)}`);
    note(`first 3 preview rows: ${JSON.stringify(panel?.rows.slice(0, 3))}`);
    note(`last preview row: ${JSON.stringify(panel?.rows.at(-1))}`);
    expect(panel?.rows.length, "one preview row per remaining item").toBe(48);
    const filled = (panel?.rows ?? []).filter((r) => r.vars.every((v) => v !== ""));
    note(`${filled.length}/48 preview rows carry every extracted value`);

    // ---- 3. does ONE explicit confirmation run them? ----
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-checked", "48");
    expect(panel?.confirmDisabled, "the confirm control is enabled once the preview is ready").toBe(false);
    const runAt = Date.now();
    // The judge's gesture: Tab moves focus onto the locked confirm button, Enter starts the batch. Both trusted.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    let started = true;
    await expect
      .poll(async () => (await hostAttrs(page))["data-loop-state"], { timeout: 20_000, message: "the run starting" })
      .toMatch(/running|done/)
      .catch(() => void (started = false));
    if (!started) {
      note(`Tab+Enter did NOT start a run. host=${JSON.stringify(await hostAttrs(page))}; panel=${JSON.stringify(await readPanel(page))}`);
      const box = (await readPanel(page))?.confirmBox;
      if (box) {
        note(`falling back to a real mouse click on the confirm button at ${box.x},${box.y}`);
        await page.mouse.click(box.x, box.y);
        await expect.poll(async () => (await hostAttrs(page))["data-loop-state"], { timeout: 20_000 }).toMatch(/running|done/);
      } else {
        await dumpTrace(worker, "confirm did not start a run");
        throw new Error("STOP: the single confirmation did not start a run.");
      }
    }
    note(`run started ${Date.now() - runAt} ms after the confirmation; mode=${(await hostAttrs(page))["data-loop-mode"]}`);

    let finished = true;
    await expect
      .poll(async () => (await hostAttrs(page))["data-loop-state"], { timeout: 240_000, message: "the run finishing" })
      .toMatch(/done|failed/)
      .catch(() => void (finished = false));
    const runMs = Date.now() - runAt;
    note(`run ${finished ? "finished" : "DID NOT FINISH"} in ${runMs} ms; host=${JSON.stringify(await hostAttrs(page))}`);

    // ---- 4. did the page actually change? ----
    const rows = await sheetRows(page);
    const replied = await repliedIds(page);
    note(`sheet rows after the run: ${rows.length}; replied invoices: ${replied.length}`);
    note(`row 3 = ${JSON.stringify(rows[2])}; row 50 = ${JSON.stringify(rows[49])}`);
    const finalPanel = await readPanel(page);
    note(`final sheet: headline="${finalPanel?.headline}" effects=${JSON.stringify(finalPanel?.effects)}`);
    note(`rows reported failed: ${JSON.stringify((finalPanel?.rows ?? []).filter((r) => r.note !== "").slice(0, 5))}`);
    console.log(`\n===== APPROACH A REPORT =====\n${report.join("\n")}\n=============================\n`);

    expect(rows.length, "50 sheet rows: 2 by hand + 48 by Ghost").toBe(50);
    expect(replied.length, "50 replied invoices").toBe(50);
  });

  // The demo-video path: the ghost cursor moving in the real tab. Background mode is the default above 10 items,
  // so a judge who wants to SEE it has to pick "Visible" and trim the batch — both of which happen inside the sheet.
  test("visible mode: three items, run in the real tab", async ({ page, worker }) => {
    const note = (line: string): void => console.log(`  [A/visible] ${line}`);
    await fresh(page);
    await demonstrate(page, 0);
    await demonstrate(page, 1);
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-state", "proposed", { timeout: 30_000 });
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-preview", "ready", { timeout: 180_000 });

    // Mode buttons and row checkboxes carry no trusted-event gate (only the confirm control does), so the sheet
    // can be driven from here. Switch to Visible and keep the first three rows.
    const picked = await panelEval(page, (root) => {
      const visible = root.querySelector<HTMLButtonElement>('button.mode[data-mode="visible"]');
      if (!visible || visible.disabled) return "visible mode is not offered";
      visible.click();
      const all = root.querySelector<HTMLInputElement>("thead input[type=checkbox]");
      if (all?.checked) {
        all.click();
        all.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const boxes = Array.from(root.querySelectorAll<HTMLInputElement>("tbody tr input[type=checkbox]"));
      for (const box of boxes.slice(0, 3)) {
        if (box.disabled || box.checked) continue;
        box.click();
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return "ok";
    });
    note(`sheet driven: ${picked}`);
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-mode", "visible");
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-checked", "3");
    note(`confirm now reads "${(await readPanel(page))?.confirmLabel}"`);

    const runAt = Date.now();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-state", /running|done/, { timeout: 20_000 });

    // A visible run navigates THIS tab, so the loop host comes and goes with every page load: the durable
    // signal is the demo's own state. Nothing here touches the tab; the run is driving it.
    let done = true;
    await expect
      .poll(async () => page.evaluate(() => (window as SheetWindow).__invoices?.replied.length ?? -1).catch(() => -1),
        { timeout: 240_000, intervals: [500], message: "three more invoices replied by the visible run" })
      .toBe(5)
      .catch(() => void (done = false));
    const runMs = Date.now() - runAt;
    note(`visible run ${done ? "finished" : "DID NOT FINISH"} in ${runMs} ms for 3 items (${Math.round(runMs / 3)} ms/item); tab ended on ${page.url()}`);
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-state", /done|failed/, { timeout: 30_000 });
    note(`host=${JSON.stringify(await hostAttrs(page))}; final sheet headline="${(await readPanel(page))?.headline}"`);

    const rows = await sheetRows(page);
    const replied = await repliedIds(page);
    note(`sheet rows ${rows.length}, replied ${replied.length}; rows 3..5 = ${JSON.stringify(rows.slice(2, 5))}`);
    if (rows.length !== 5 || replied.length !== 5) await dumpTrace(worker, "visible run did not finish three items");
    expect(rows.length, "2 by hand + 3 by Ghost").toBe(5);
    expect(replied.length).toBe(5);
  });

  test("the form story: page load to first ghost, and Tab-to-Tab", async ({ page }) => {
    const lines: string[] = [];
    const note = (line: string): void => void (console.log(`  [A/form] ${line}`), lines.push(line));

    const load = Date.now();
    await page.goto(`${DEMO_URL}/apply`);
    const domReady = Date.now();
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready", { timeout: 20_000 });
    const firstGhost = Date.now();
    const count = Number((await host.getAttribute("data-ghost-count")) ?? "0");
    note(`goto -> DOM ${domReady - load} ms; goto -> first ghost ${firstGhost - load} ms; ${count} ghosts`);
    note(`HUD: ${JSON.stringify(await readHud(page))}`);

    await page.evaluate(() => document.getElementById("apply-title")?.scrollIntoView({ block: "start" }));
    await expect(page.locator("#first-name")).toBeInViewport({ ratio: 1 });

    const taps: number[] = [];
    for (let i = 0; i < 12; i++) {
      const accepted = Number((await host.getAttribute("data-ghost-accepted")) ?? "0");
      if ((await host.getAttribute("data-ghost-current-locked")) === "true") break;
      const at = Date.now();
      await page.keyboard.press("Tab");
      await expect(host).toHaveAttribute("data-ghost-accepted", String(accepted + 1));
      taps.push(Date.now() - at);
    }
    const sorted = [...taps].sort((a, b) => a - b);
    note(`${taps.length} Tab presses: ${taps.join(",")} ms (median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms)`);
    note(`after the walk: ${JSON.stringify(await readHud(page))}`);

    // Second visit: the per-form cache must answer without the server.
    const reload = Date.now();
    await page.reload();
    await expect(host).toHaveAttribute("data-ghost-state", "ready", { timeout: 20_000 });
    note(`reload -> first ghost ${Date.now() - reload} ms; HUD ${JSON.stringify(await readHud(page))}`);
    console.log(`\n===== FORM STORY =====\n${lines.join("\n")}\n======================\n`);
    expect(count).toBeGreaterThan(10);
  });
});
