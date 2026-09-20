// Stage 6 acceptance: "Do it twice, Ghost does the rest", asserted end to end with the built extension loaded.
//
// The story a judge watches: two invoices copied into the spreadsheet by hand, a proposal for the remaining 48,
// a preview of every one of them, ONE person holding a single invoice back for review, ONE explicit confirmation
// that names the irreversible effect, then 47 items done and verified -- and the held one untouched.
//
// compareA.spec.ts measures this same flow and prints timings; this spec is the one that fails the build.
import { DEMO_URL, E2E_SERVER_URL, HOST, expect, test } from "../fixtures";
import { LOOP_HOST, demonstrate, excludeRow, fresh, hostAttrs, readPanel, repliedIds, sheetRows } from "../loop";
import type { PreviewRow } from "../loop";

const REMAINING = 48;
const HELD_BACK = 1;
const RUN = REMAINING - HELD_BACK;

/** "$1,300.17" -> 130017. The preview shows money as the invoice page renders it. */
function cents(money: string): number {
  const digits = money.replace(/[^0-9.]/g, "");
  return Math.round(Number(digits || "0") * 100);
}

/** The invoice a person would stop on: the largest total in the batch. Deterministic for the seeded demo data. */
function biggest(rows: readonly PreviewRow[]): PreviewRow {
  return rows.reduce((max, row) => (cents(row.vars[3] ?? "") > cents(max.vars[3] ?? "") ? row : max));
}

test.describe("Stage 6: do it twice, Ghost does the rest", () => {
  test.use({ serverUrl: E2E_SERVER_URL });
  test.setTimeout(420_000);

  test("two by hand, preview 48, hold one back, one confirmation, 47 done and verified", async ({ page, saveVideo }) => {
    saveVideo(page, "stage6-loop.webm");

    await fresh(page);
    await expect(page.locator(HOST)).toHaveCount(1); // the content script is in

    // ---- 1. the two demonstrations, performed exactly as a person would ----
    const first = await demonstrate(page, 0);
    const second = await demonstrate(page, 1);
    expect(await sheetRows(page), "both demonstrations really happened in the page").toEqual([first, second]);
    expect(await repliedIds(page)).toEqual(["INV-1001", "INV-1002"]);
    await expect(page.getByTestId("replied-count")).toHaveText("2 of 50 replied");

    // ---- 2. Ghost proposes the rest on its own ----
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-state", "proposed", { timeout: 30_000 });
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-remaining", String(REMAINING));

    // ---- 3. every remaining item is previewed, with its extracted values ----
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-preview", "ready", { timeout: 180_000 });
    const proposal = await readPanel(page);
    expect(proposal, "the loop sheet is mounted").not.toBeNull();
    const rows = proposal?.rows ?? [];
    expect(rows.length, "one preview row per remaining item").toBe(REMAINING);
    expect(
      rows.filter((row) => row.vars.length === 4 && row.vars.every((value) => value !== "")).length,
      "every preview row carries all four extracted values, so nothing is guessed at run time",
    ).toBe(REMAINING);
    expect(rows.map((row) => row.index), "preview rows are the 48 items after the two demonstrations").toEqual(
      Array.from({ length: REMAINING }, (_, i) => i + 2),
    );

    // ---- 4. the person holds ONE invoice back for review ----
    const held = biggest(rows);
    const heldNumber = held.vars[1] ?? "";
    expect(heldNumber, "the held row names an invoice").toMatch(/^INV-\d{4}$/);
    expect(await excludeRow(page, held.index), `row ${held.index} (${heldNumber}) can be unchecked`).toBe(true);
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-checked", String(RUN));

    // ---- 5. ONE explicit confirmation, naming the irreversible effect ----
    const armed = await readPanel(page);
    expect(armed?.confirmDisabled, "the confirm control is enabled once the preview is ready").toBe(false);
    expect(armed?.confirmLabel, "the confirmation counts only the items that will run").toContain(String(RUN));
    expect(
      (armed?.effects ?? []).join(" "),
      "the batch confirmation lists the irreversible effect and its count before anything runs",
    ).toMatch(new RegExp(`Reply[^]*${RUN}`));
    expect(await hostAttrs(page)).toMatchObject({ "data-loop-confirmation": "explicit", "data-loop-state": "proposed" });

    // Nothing has run yet: the proposal alone changed no page state.
    expect((await sheetRows(page)).length, "no row is written before the confirmation").toBe(2);
    expect((await repliedIds(page)).length, "no reply is sent before the confirmation").toBe(2);

    // The gesture: Tab moves focus onto the locked confirm control, Enter starts the batch. Both trusted.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-state", /running|done/, { timeout: 20_000 });

    // ---- 6. the run completes and the page really changed ----
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-state", "done", { timeout: 240_000 });
    await expect(page.locator(LOOP_HOST)).toHaveAttribute("data-loop-progress", `${RUN}/${RUN}`);

    const finalRows = await sheetRows(page);
    const replied = await repliedIds(page);
    expect(finalRows.length, "2 by hand + 47 by Ghost").toBe(2 + RUN);
    expect(replied.length, "2 by hand + 47 by Ghost").toBe(2 + RUN);

    // ---- 7. the held invoice is untouched, and it is the ONLY one ----
    expect(finalRows.map((row) => row[1]), "the held invoice was never written to the sheet").not.toContain(heldNumber);
    expect(replied, "the held invoice was never replied to").not.toContain(heldNumber);
    const loggedNumbers = new Set(finalRows.map((row) => (row[1] ?? "").trim().toUpperCase()));
    const missing = Array.from({ length: 50 }, (_, i) => `INV-${1001 + i}`).filter((id) => !loggedNumbers.has(id));
    expect(missing, "exactly one invoice is left for review, and it is the one held back").toEqual([heldNumber]);

    // ---- 8. every row Ghost wrote is verified, and no row failed ----
    const done = await readPanel(page);
    expect((done?.rows ?? []).filter((row) => row.note !== "").map((row) => `${row.index}: ${row.note}`), "no row reported a failure").toEqual([]);
    for (const row of rows) {
      if (row.index === held.index) continue;
      const written = finalRows.find((sheetRow) => (sheetRow[1] ?? "") === row.vars[1]);
      expect(written, `invoice ${row.vars[1]} reached the sheet`).toBeDefined();
      expect(written, `invoice ${row.vars[1]} was written exactly as previewed`).toEqual(row.vars);
    }
  });

  // The batch above clicks "Reply: received" 47 times, but only because a person confirmed it once. Pressing Tab
  // on that same page must never send one: a reply cannot be unsent (CLAUDE.md, locked actions).
  //
  // An invoice page carries no fields to fill, so Ghost offers nothing at all there: the overlay stays idle with
  // zero ghosts and Tab belongs to the page. That is the property asserted here -- Ghost is not merely declining
  // to press the locked control, it is standing down entirely, and Tab still sends nothing.
  test("a Tab walk on an invoice never sends the reply", async ({ page }) => {
    await fresh(page);
    await page.goto(`${DEMO_URL}/invoices/INV-1003`);
    await expect(page.getByTestId("reply-received")).toHaveAttribute("data-ghost-lock", "");

    const host = page.locator(HOST);
    await expect(host).toHaveCount(1); // the content script is in, it simply has nothing to offer
    await expect(host).toHaveAttribute("data-ghost-state", "idle");
    await expect(host).toHaveAttribute("data-ghost-count", "0");

    for (let i = 0; i < 20; i++) await page.keyboard.press("Tab");

    await expect(host).toHaveAttribute("data-ghost-accepted", "0");
    expect(await repliedIds(page), "20 Tab presses sent no reply").toEqual([]);
    await expect(page.getByTestId("reply-received")).toHaveText("Reply: received");
    await expect(page.getByTestId("reply-confirmation")).toBeEmpty();
  });
});
