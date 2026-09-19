import { EXPECTED, NEVER_FILLED, OFFLINE_GHOSTS, expectFormState, expectNotSubmitted, gotoForm, readFormState, scrollToForm } from "../apply";
import { E2E_SERVER_URL, HOST, expect, overlayEval, test } from "../fixtures";

test.describe("Jev computer-use demo", () => {
  test.use({ serverUrl: process.env.GHOST_AGENT_SERVER_URL ?? E2E_SERVER_URL });

  test("observes and fills the whole safe application, then stops before consent and Submit", async ({ page }) => {
    await gotoForm(page, "/apply");
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready");
    // The required essay must have a draft. A provider may reasonably decline the optional second essay.
    await expect.poll(async () => Number(await host.getAttribute("data-ghost-count"))).toBeGreaterThanOrEqual(OFFLINE_GHOSTS + 1);
    await scrollToForm(page);
    await page.keyboard.press("Alt+Shift+J");
    expect(await overlayEval(page, (root) => root.querySelector<HTMLElement>("#ghost-agent-panel")?.hidden === false)).toBe(true);

    const started = await overlayEval(page, (root, goal) => {
      const input = root.querySelector<HTMLTextAreaElement>("#ghost-agent-goal");
      const run = root.querySelector<HTMLButtonElement>("#ghost-agent-panel .run");
      if (!input || !run) return false;
      input.value = goal;
      run.click();
      return true;
    }, "Fill every field that has a safe local value; leave consent untouched and stop before Submit application");
    expect(started).toBe(true);

    await expect.poll(async () => await host.getAttribute("data-ghost-agent-state"), { timeout: 60_000 })
      .toMatch(/^(done|blocked)$/);
    const terminal = await host.getAttribute("data-ghost-agent-state");
    const debug = {
      reason: await host.getAttribute("data-ghost-agent-reason"),
      operation: await host.getAttribute("data-ghost-agent-operation"),
      confidence: await host.getAttribute("data-ghost-agent-confidence"),
      operationConfidence: await host.getAttribute("data-ghost-agent-operation-confidence"),
      targetConfidence: await host.getAttribute("data-ghost-agent-target-confidence"),
      step: await host.getAttribute("data-ghost-agent-step"),
    };
    expect(terminal, JSON.stringify(debug)).toBe("done");
    await expect(host).toHaveAttribute("data-ghost-agent-provider", /^(heuristic|typesafe|jev-gateway|baseten|llm)$/);
    await expectFormState(page, EXPECTED);
    const state = await readFormState(page);
    expect(String(state.whyNorthwind ?? "").length).toBeGreaterThan(20);
    expect(state.project === "" || String(state.project ?? "").length > 20).toBe(true);
    expect(state).toMatchObject(NEVER_FILLED);
    await expectNotSubmitted(page);

    const panel = await overlayEval(page, (root) => ({
      status: root.querySelector("#ghost-agent-panel .status")?.textContent ?? "",
      meta: root.querySelector("#ghost-agent-panel .meta")?.textContent ?? "",
    }));
    expect(panel?.status).toContain("verified actions");
    expect(panel?.meta).toContain((await host.getAttribute("data-ghost-agent-provider")) ?? "");
  });
});

test.describe("Jev outcome telemetry", () => {
  // Always use the isolated keyless server, even when the main scenario is explicitly pointed at a live provider.
  test.use({ serverUrl: E2E_SERVER_URL });

  test("turns a real blocked browser run into a redacted replay fixture", async ({ page }) => {
    const before = await fetch(`${E2E_SERVER_URL}/v1/agent/replays`).then((response) => response.json()) as { count: number };
    await gotoForm(page, "/apply");
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready");
    await expect.poll(async () => Number(await host.getAttribute("data-ghost-count"))).toBeGreaterThanOrEqual(OFFLINE_GHOSTS + 1);
    await scrollToForm(page);
    await page.keyboard.press("Alt+Shift+J");
    const started = await overlayEval(page, (root, goal) => {
      const input = root.querySelector<HTMLTextAreaElement>("#ghost-agent-goal");
      const run = root.querySelector<HTMLButtonElement>("#ghost-agent-panel .run");
      if (!input || !run) return false;
      input.value = goal;
      run.click();
      return true;
    }, "Complete every required field");
    expect(started).toBe(true);
    await expect.poll(async () => await host.getAttribute("data-ghost-agent-state"), { timeout: 60_000 }).toBe("blocked");

    let latest: unknown;
    await expect.poll(async () => {
      const body = await fetch(`${E2E_SERVER_URL}/v1/agent/replays`).then((response) => response.json()) as { count: number; fixtures: unknown[] };
      latest = body.fixtures[0];
      return body.count;
    }).toBeGreaterThan(before.count);
    expect(latest).toMatchObject({ schemaVersion: "ghost.agent-replay.v1", observed: { state: "blocked" } });
    expect(JSON.stringify(latest)).not.toMatch(/"(goal|url|origin|title|label|context|targetId|targetLabel|value|profile|email)"/i);
    await expectNotSubmitted(page);
  });
});
