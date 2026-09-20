// The learning loop end to end: a real Tab walk in the loaded extension must reach the server as a strictly
// value-free outcome, and an abandoned walk must become a reviewable replay case with no page content in it.
import { EXPECTED, expectNotSubmitted, gotoForm, scrollToForm } from "../apply";
import { E2E_SERVER_URL, HOST, expect, test } from "../fixtures";

interface ReplayBody {
  count: number;
  fixtures: unknown[];
}

const replays = async (): Promise<ReplayBody> =>
  await fetch(`${E2E_SERVER_URL}/v1/walk/replays`).then((response) => response.json()) as ReplayBody;

test.describe("walk outcome telemetry", () => {
  test.use({ serverUrl: E2E_SERVER_URL });

  test("turns a real abandoned walk into a redacted replay fixture", async ({ page }) => {
    const before = await replays();
    await gotoForm(page, "/apply");
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready");
    await scrollToForm(page);

    // Accept a couple of ghosts so the walk has real proposals, then leave the page mid-walk.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect.poll(async () => Number(await host.getAttribute("data-ghost-accepted"))).toBeGreaterThan(0);
    await expectNotSubmitted(page);
    await page.goto(`${E2E_SERVER_URL}/v1/health`);

    let latest: unknown;
    await expect.poll(async () => {
      const body = await replays();
      latest = body.fixtures[0];
      return body.count;
    }, { timeout: 15_000 }).toBeGreaterThan(before.count);

    expect(latest).toMatchObject({
      schemaVersion: "ghost.walk-replay.v1",
      observed: { state: "abandoned", reason: "page-left" },
      expected: { lockedAccepted: 0 },
    });
    // Nothing that identifies the page, the field or the user may appear anywhere in the fixture.
    const encoded = JSON.stringify(latest);
    expect(encoded).not.toMatch(/"(goal|url|origin|title|label|context|signature|value|profile|email)"/i);
    for (const value of Object.values(EXPECTED)) expect(encoded).not.toContain(value);
  });

  test("keeps a healthy completed walk out of the review queue", async ({ page }) => {
    const before = await replays();
    await gotoForm(page, "/apply");
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready");
    await scrollToForm(page);

    // Hold Tab to the end of the walk: it parks on the locked Submit and never presses it.
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    await expectNotSubmitted(page);

    // A walk with no safety violation and no confident calibrated rejection is only a counter.
    const after = await replays();
    expect(after.count).toBe(before.count);
  });
});
