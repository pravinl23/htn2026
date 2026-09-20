// Smoke test for the demo sites WITHOUT the Ghost extension: proves the pages work as plain web apps.
//
//   pnpm --filter @ghost/demo build && pnpm --filter @ghost/demo preview   (or "dev" for React warnings)
//   node e2e/scripts/smoke-demo.mjs                                        (BASE_URL=http://localhost:5173 by default)
//
// Screenshots land in e2e/test-results/smoke/ (gitignored). Exits 1 on the first failed check.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "test-results", "smoke");
const REPLY = "Thursday 2:30 PM to 3:00 PM works for me. See you then!";

mkdirSync(SHOTS, { recursive: true });

let checks = 0;
function check(condition, message) {
  checks++;
  if (!condition) throw new Error(`CHECK FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}
function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message} (got ${JSON.stringify(actual)})`);
}

/** Console errors, warnings (React reports problems as console.error / console.warn) and uncaught exceptions. */
const problems = [];
function watch(page, name) {
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") problems.push(`[${name}] console.${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`[${name}] pageerror: ${error.message}`));
  page.on("requestfailed", (request) => problems.push(`[${name}] request failed: ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(`[${name}] HTTP ${response.status()}: ${response.url()}`);
  });
}

async function shot(page, name) {
  await page.waitForTimeout(250); // let the 120ms hover/pressed colour transitions settle, or the PNG shows a half-way colour
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** A marker on window survives client-side navigation and dies on a full page load. */
async function markSpa(page) {
  await page.evaluate(() => {
    window.__smokeSpa = true;
  });
}
async function stillSpa(page) {
  return page.evaluate(() => window.__smokeSpa === true);
}

async function noSidewaysScroll(page, name) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${name}: no horizontal page scroll (overflow ${overflow}px)`);
}

async function invoicesFlow(context) {
  console.log("\n/reset");
  const page = await context.newPage();
  watch(page, "A");
  await page.goto(`${BASE}/reset`);
  const done = page.getByTestId("reset-done");
  await done.waitFor();
  equal(await done.getAttribute("data-remaining"), "0", "/reset leaves no ghostdemo.* keys");
  await shot(page, "00-reset");

  console.log("\n/invoices");
  await page.getByRole("link", { name: "Invoices inbox" }).click();
  await page.waitForURL(`${BASE}/invoices`);
  const rows = page.getByTestId("invoice-row");
  equal(await rows.count(), 50, "inbox lists 50 invoice emails");
  equal(await page.getByTestId("replied-count").innerText(), "0 of 50 replied", "replied count starts at 0");
  equal(await page.getByTestId("logged-count").innerText(), "0 of 50 logged", "logged count starts at 0");
  equal(await page.locator('[data-chip]').count(), 0, "no chips on a fresh inbox");
  await shot(page, "01-invoices-fresh");

  const first = rows.first();
  const firstId = await first.getAttribute("data-invoice-id");
  equal(firstId, "INV-1001", "first inbox row is INV-1001");
  await markSpa(page);
  await first.getByRole("link").click();
  await page.waitForURL(`${BASE}/invoices/${firstId}`);
  check(await stillSpa(page), "opening an invoice is a client-side navigation");
  await page.goBack(); // the browser's own Back and Forward buttons must work in the SPA too
  await page.waitForURL(`${BASE}/invoices`);
  equal(await page.getByTestId("invoice-row").count(), 50, "browser Back returns to the inbox");
  await page.goForward();
  await page.waitForURL(`${BASE}/invoices/${firstId}`);
  check(await stillSpa(page), "Back and Forward did not reload the document");

  console.log(`\n/invoices/${firstId}`);
  const fields = {};
  for (const field of ["vendor", "number", "date", "total"]) {
    fields[field] = (await page.locator(`[data-testid="invoice-fields"] dd[data-field="${field}"]`).innerText()).trim();
  }
  console.log("  fields:", fields);
  equal(fields.number, firstId, "invoice number field matches the id");
  check(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(fields.date), `date looks like "Sep 17, 2026"`);
  check(/^\$[\d,]+\.\d{2}$/.test(fields.total), `total looks like "$3,712.06"`);
  check(fields.vendor.length > 2, "vendor is present");
  equal(await page.getByRole("heading", { level: 1 }).innerText(), `Invoice ${firstId} from ${fields.vendor}`, "subject heading");
  const replyButton = page.getByRole("button", { name: "Reply: received", exact: true });
  check(await replyButton.isEnabled(), '"Reply: received" button is enabled');
  check((await replyButton.getAttribute("data-ghost-lock")) !== null, '"Reply: received" carries data-ghost-lock');
  await shot(page, "02-invoice-open");

  console.log("\n/sheet");
  await page.getByRole("link", { name: "Open spreadsheet" }).click();
  await page.waitForURL(`${BASE}/sheet`);
  check(await stillSpa(page), "invoice -> sheet is a client-side navigation");
  equal(await page.locator('[data-testid="sheet-grid"] tbody tr').count(), 60, "sheet has 60 rows");
  equal(
    await page.locator('[data-testid="sheet-grid"] thead th').allInnerTexts().then((t) => t.map((s) => s.trim())),
    ["Row", "Vendor", "Invoice #", "Date", "Total"],
    "sheet column headers",
  );
  const row1 = [fields.vendor, fields.number, fields.date, fields.total];
  await page.getByLabel("Vendor row 1", { exact: true }).click();
  for (let col = 0; col < row1.length; col++) {
    await page.keyboard.type(row1[col], { delay: 5 }); // real key events, one storage write per keystroke
    if (col < row1.length - 1) await page.keyboard.press("Tab"); // native Tab moves one cell to the right
  }
  const labels = ["Vendor row 1", "Invoice # row 1", "Date row 1", "Total row 1"];
  for (let col = 0; col < labels.length; col++) {
    equal(await page.getByLabel(labels[col], { exact: true }).inputValue(), row1[col], `cell "${labels[col]}" holds the typed value`);
  }
  equal(await page.getByTestId("sheet-filled").innerText(), "1 of 60 rows filled", "filled counter");
  equal(await page.evaluate(() => window.__sheet), { rows: [row1], filled: 1 }, "window.__sheet after row 1");
  await page.keyboard.press("Enter");
  equal(await page.evaluate(() => document.activeElement?.id), "cell-1-3", "Enter moves focus one row down");
  await shot(page, "03-sheet-row1");

  console.log("\nback to the invoice, reply");
  await page.getByRole("link", { name: "Back to invoices" }).click();
  await page.waitForURL(`${BASE}/invoices`);
  const loggedRow = page.locator(`[data-testid="invoice-row"][data-invoice-id="${firstId}"]`);
  equal(await loggedRow.getAttribute("data-logged"), "true", "inbox row is logged after the sheet row");
  equal(await loggedRow.getAttribute("data-replied"), "false", "inbox row is not replied yet");
  await loggedRow.getByRole("link").click();
  await page.waitForURL(`${BASE}/invoices/${firstId}`);
  equal(await page.getByTestId("reply-confirmation").innerText(), "", "no confirmation before the reply");
  await page.getByRole("button", { name: "Reply: received", exact: true }).click();
  equal(await page.getByTestId("reply-confirmation").innerText(), "Reply sent: Received, thanks.", "reply confirmation");
  const after = page.getByTestId("reply-received");
  check(await after.isDisabled(), "reply button is disabled after replying");
  equal(await after.innerText(), "Replied", 'reply button reads "Replied"');
  await shot(page, "04-invoice-replied");

  await page.getByRole("link", { name: "Back to inbox" }).click();
  await page.waitForURL(`${BASE}/invoices`);
  check(await stillSpa(page), "the whole invoices walk stayed in one document");
  const doneRow = page.locator(`[data-testid="invoice-row"][data-invoice-id="${firstId}"]`);
  equal(await doneRow.locator("[data-chip]").allInnerTexts(), ["Logged", "Replied"], "inbox row shows Logged + Replied chips");
  equal(await page.locator("[data-chip]").count(), 2, "no other row has chips");
  equal(await page.getByTestId("replied-count").innerText(), "1 of 50 replied", "replied count");
  equal(await page.getByTestId("logged-count").innerText(), "1 of 50 logged", "logged count");
  equal(await page.evaluate(() => window.__invoices), { total: 50, replied: [firstId], logged: [firstId] }, "window.__invoices");
  equal(await page.evaluate(() => window.__sheet), { rows: [row1], filled: 1 }, "window.__sheet from the inbox page");
  await shot(page, "05-invoices-one-done");

  console.log("\nstorage sync between two pages");
  await page.goto(`${BASE}/sheet`);
  const other = await context.newPage();
  watch(other, "B");
  await other.goto(`${BASE}/sheet`);
  equal(await other.getByLabel("Vendor row 1", { exact: true }).inputValue(), fields.vendor, "page B loads row 1 from storage");
  await page.getByLabel("Vendor row 2", { exact: true }).click();
  await page.keyboard.type("Typed in page A", { delay: 5 });
  await other.waitForFunction(() => document.getElementById("cell-1-0")?.value === "Typed in page A", undefined, { timeout: 5000 });
  check(true, "a cell typed in page A shows up in page B");
  equal(await other.evaluate(() => window.__sheet.filled), 2, "page B's window.__sheet sees 2 filled rows");
  await other.getByLabel("Invoice # row 2", { exact: true }).fill("INV-1002");
  await page.waitForFunction(() => document.getElementById("cell-1-1")?.value === "INV-1002", undefined, { timeout: 5000 });
  check(true, "a cell filled in page B shows up in page A");
  equal(await page.getByLabel("Vendor row 2", { exact: true }).inputValue(), "Typed in page A", "page B's write kept page A's cell");
  equal(await page.evaluate(() => window.__invoices.logged), [firstId, "INV-1002"], "INV-1002 now counts as logged");
  await shot(other, "06-sheet-page-b");
  await other.getByRole("link", { name: "Back to invoices" }).click();
  await other.waitForURL(`${BASE}/invoices`);
  await page.getByLabel("Invoice # row 3", { exact: true }).fill("inv-1003 ");
  await other.locator('[data-invoice-id="INV-1003"][data-logged="true"]').waitFor({ timeout: 5000 });
  check(true, "an inbox open in page B marks INV-1003 logged while page A types (trimmed, case-insensitive)");
  equal(await other.getByTestId("logged-count").innerText(), "3 of 50 logged", "page B's logged count follows");
  await other.close();

  console.log("\nreload and ?reset=1");
  await page.reload();
  equal(await page.getByLabel("Total row 1", { exact: true }).inputValue(), fields.total, "sheet survives a reload");

  console.log("\nsheet edge cases");
  const scratch = page.getByLabel("Vendor row 5", { exact: true });
  await scratch.click();
  await page.keyboard.type("abc");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("X");
  equal(await scratch.inputValue(), "abXc", "caret stays in place on a mid-string edit");
  // The way Ghost fills a React controlled input: native value setter, then an input event.
  await page.evaluate(() => {
    const input = document.getElementById("cell-5-3");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "$12.50");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  equal(await page.getByLabel("Total row 6", { exact: true }).inputValue(), "$12.50", "a programmatic fill sticks in the controlled input");
  equal(await page.evaluate(() => window.__sheet.rows.at(-1)), ["", "", "", "$12.50"], "the programmatic fill reached storage");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Clear sheet", exact: true }).click();
  equal(await page.evaluate(() => window.__sheet.filled), 5, "dismissing the confirm keeps the sheet");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear sheet", exact: true }).click();
  equal(await page.evaluate(() => window.__sheet), { rows: [], filled: 0 }, "accepting the confirm clears the sheet");
  equal(await scratch.inputValue(), "", "cleared cells render empty");
  equal(await page.evaluate(() => window.__invoices.replied), [firstId], "clearing the sheet keeps the replies");

  await page.goto(`${BASE}/sheet?reset=1`);
  await page.getByTestId("sheet-filled").waitFor();
  equal(await page.getByTestId("sheet-filled").innerText(), "0 of 60 rows filled", "?reset=1 clears the sheet");
  equal(await page.evaluate(() => window.__invoices), { total: 50, replied: [], logged: [] }, "?reset=1 clears replies too");
  equal(await page.evaluate(() => window.location.search), "", "?reset=1 is dropped from the URL");
  await page.close();
}

async function mailFlow(context) {
  console.log("\n/mail");
  const page = await context.newPage();
  watch(page, "M");
  await page.goto(`${BASE}/mail?reset=1`);
  const rows = page.getByTestId("mail-row");
  await rows.first().waitFor();
  equal(await rows.count(), 8, "inbox lists 8 messages");
  equal(await page.evaluate(() => window.__mail), { pickedSlot: null, sentReplies: {}, lastOpenedId: null }, "window.__mail starts empty");
  await shot(page, "10-mail-inbox");

  const first = rows.first();
  equal(await first.getAttribute("data-mail-id"), "msg-1001", "first message is msg-1001");
  await markSpa(page);
  await first.click();
  await page.waitForURL(`${BASE}/mail/msg-1001`);
  check(await stillSpa(page), "opening a message is a client-side navigation");

  console.log("\n/mail/msg-1001");
  equal(await page.locator("#mail-subject").innerText(), "Quick chat Thursday afternoon?", "subject");
  check((await page.locator('[data-field="body"]').innerText()).includes("Thursday afternoon"), "body asks about Thursday afternoon");
  equal(await page.locator('[data-field="picked-slot"]').count(), 0, "no picked-time chip before the calendar visit");
  equal(await page.evaluate(() => window.__mailSent), false, "window.__mailSent starts false");
  equal(await page.evaluate(() => window.__mail.lastOpenedId), "msg-1001", "lastOpenedId is recorded");
  await shot(page, "11-mail-message");

  const otherTab = await context.newPage();
  watch(otherTab, "C");
  await otherTab.goto(`${BASE}/calendar`);
  await otherTab.getByRole("button", { name: "Thursday 10:30 AM to 11:00 AM, free", exact: true }).click();
  await page.locator('p[data-field="picked-slot"]').waitFor({ timeout: 5000 });
  equal(await page.locator('p[data-field="picked-slot"]').innerText(), "Picked time: Thursday 10:30 AM to 11:00 AM", "a pick made in another tab shows up live");
  await otherTab.close();

  await page.getByRole("link", { name: "Open calendar" }).click();
  await page.waitForURL(`${BASE}/calendar`);
  console.log("\n/calendar");
  equal(await page.locator('[data-field="week"]').innerText(), "Week of Sep 21, 2026", "week heading");
  equal(await page.getByTestId("cal-slot").count(), 17, "17 free slots");
  const afternoonStarts = await page
    .locator('[data-testid="cal-slot"][data-day="Thursday"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-start")).filter((s) => s >= "13:00"));
  equal(afternoonStarts, ["14:30"], "exactly one free Thursday afternoon slot");
  equal(await page.locator('[data-testid="cal-slot"][aria-pressed="true"]').getAttribute("data-start"), "10:30", "the other tab's pick is shown as pressed");
  await shot(page, "12-calendar-other-pick");
  const slot = page.getByRole("button", { name: "Thursday 2:30 PM to 3:00 PM, free", exact: true });
  await slot.click();
  equal(await slot.getAttribute("aria-pressed"), "true", "picked slot is aria-pressed");
  equal(await page.locator('[data-testid="cal-slot"][aria-pressed="true"]').count(), 1, "only one slot is pressed at a time");
  equal(await page.locator('[data-testid="calendar-banner"] [data-field="picked-slot"]').innerText(), "Thursday 2:30 PM to 3:00 PM", "banner names the slot");
  equal(
    await page.evaluate(() => window.__mail.pickedSlot),
    { day: "Thursday", start: "14:30", end: "15:00", label: "Thursday 2:30 PM to 3:00 PM" },
    "window.__mail.pickedSlot",
  );
  await shot(page, "13-calendar-picked");

  await page.getByRole("link", { name: "Back to mail" }).click();
  await page.waitForURL(`${BASE}/mail/msg-1001`);
  check(await stillSpa(page), "mail -> calendar -> mail stayed in one document");
  console.log("\nback on /mail/msg-1001");
  equal(await page.locator('p[data-field="picked-slot"]').innerText(), "Picked time: Thursday 2:30 PM to 3:00 PM", "picked-time chip");

  await page.getByTestId("send-reply").click();
  equal(await page.locator("#reply-error").innerText(), "Write a reply before sending.", "empty reply is rejected");
  equal(await page.getByTestId("mail-sent").count(), 0, "nothing sent for an empty reply");
  const reply = page.getByLabel("Reply", { exact: true });
  await reply.click();
  await page.keyboard.type(REPLY, { delay: 3 });
  equal(await reply.inputValue(), REPLY, "reply textarea holds the typed text");
  equal(await page.evaluate(() => window.__formState), { reply: REPLY }, "window.__formState");
  equal(await page.locator("#reply-error").count(), 0, "typing clears the error");
  await page.evaluate((text) => {
    const area = document.getElementById("reply");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, text);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }, `${REPLY} `);
  equal(await page.evaluate(() => window.__formState.reply), `${REPLY} `, "a programmatic fill reaches the reply state");
  await shot(page, "14-mail-reply-typed");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await page.getByTestId("mail-sent").waitFor();
  equal(await page.getByTestId("mail-sent-text").innerText(), REPLY, "sent confirmation shows the reply");
  equal(await page.evaluate(() => window.__mailSent), true, "window.__mailSent is true");
  equal(await page.evaluate(() => window.__mail.sentReplies), { "msg-1001": REPLY }, "window.__mail.sentReplies");
  await shot(page, "15-mail-sent");

  await page.getByRole("link", { name: "Back to inbox" }).click();
  await page.waitForURL(`${BASE}/mail`);
  equal(await page.locator('[data-testid="mail-row"][data-mail-id="msg-1001"]').getAttribute("data-replied"), "true", "inbox row is marked replied");
  await shot(page, "16-mail-inbox-replied");
  await page.close();
}

/** Extra screenshots for the visual pass: the reference page, the not-found states, and phone width. */
async function gallery(browser) {
  console.log("\ngallery");
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await desktop.newPage();
  watch(page, "G");
  for (const [name, path] of [["20-index", "/"], ["21-apply-reference", "/apply"], ["22-invoice-missing", "/invoices/INV-9999"], ["23-mail-missing", "/mail/msg-0"]]) {
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState("networkidle");
    await shot(page, name);
  }
  await desktop.close();

  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  const small = await phone.newPage();
  watch(small, "P");
  for (const [name, path] of [
    ["30-phone-invoices", "/invoices"],
    ["31-phone-invoice", "/invoices/INV-1001"],
    ["32-phone-sheet", "/sheet"],
    ["33-phone-mail", "/mail"],
    ["34-phone-message", "/mail/msg-1001"],
    ["35-phone-calendar", "/calendar"],
  ]) {
    await small.goto(`${BASE}${path}`);
    await small.waitForLoadState("networkidle");
    await noSidewaysScroll(small, `${path} at 375px`);
    await shot(small, name);
  }
  await phone.close();
}

const browser = await chromium.launch({ headless: true });
let failed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await invoicesFlow(context);
  await mailFlow(context);
  await context.close();
  await gallery(browser);
  console.log("\nconsole");
  check(problems.length === 0, `no console errors, warnings, page errors or failed requests (${problems.length})`);
} catch (error) {
  failed = true;
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser.close();
}
if (problems.length) console.error(`\nProblems seen:\n${problems.map((p) => `  ${p}`).join("\n")}`);
console.log(`\n${failed ? "FAILED" : "PASSED"}: ${checks} checks against ${BASE}. Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
