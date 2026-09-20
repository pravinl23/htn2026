// MEASUREMENT SPEC (not a product test): drives approach B — "atomic workflows" (docs/workflows.md) — end to
// end in headless Chromium, in TWO configurations:
//   (a) a plain Chromium page, no Ghost extension  -> `plain` tests below
//   (b) the built Ghost extension loaded            -> `ghost` tests below (e2e/fixtures.ts)
// and looks for the Tab conflict: approach B's page handles Tab on `window` (bubble, demo/public/workflow/
// index.html:125) while Ghost's content script handles Tab on `window` in the CAPTURE phase
// (extension/src/content/controller.ts:711, extension/src/content/nextAction.ts:554) and swallows it with
// preventDefault + stopPropagation (controller.ts:787, nextAction.ts:246).
//
// Everything waits on a condition; there are no sleeps. Latencies come from the page's own Resource Timing.
// Ports are overridable so the spec can run beside the repo's default e2e web servers:
//   GHOST_B_SERVER=http://127.0.0.1:8791 GHOST_B_DEMO=http://localhost:5199
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test as plain } from "@playwright/test";
import { E2E_SERVER_URL, HOST, serverCalls, test as ghost } from "../fixtures";

const SERVER = process.env.GHOST_B_SERVER ?? E2E_SERVER_URL;
const DEMO = process.env.GHOST_B_DEMO ?? "http://localhost:5173";
const WORKFLOW_URL = `${DEMO}/workflow/index.html?server=${encodeURIComponent(SERVER)}`;
const API = `${SERVER}/v1/workflows`;

interface ProbeWindow {
  /** How often a *B-style* window Tab handler (the exact contract of workflow/index.html:125) fired. */
  __bApprovals?: number;
  /** Every Tab keydown that reached the page world at all, whatever the phase. */
  __bTabsSeen?: number;
}

// ---------- reading the workflow page ----------

interface SuggestionView {
  title: string;
  safety: string;
  preview: string;
  meta: string[];
  tabHintVisible: boolean;
  explicitVisible: boolean;
  step: string;
}

async function readSuggestion(page: Page): Promise<SuggestionView> {
  return page.evaluate(() => {
    const text = (id: string): string => document.getElementById(id)?.textContent?.trim() ?? "";
    const shown = (id: string): boolean => {
      const el = document.getElementById(id);
      return Boolean(el) && !el!.classList.contains("hidden");
    };
    return {
      title: text("title"),
      safety: text("safety"),
      preview: text("preview"),
      meta: Array.from(document.querySelectorAll("#meta span"), (s) => s.textContent?.trim() ?? ""),
      tabHintVisible: shown("tabHint"),
      explicitVisible: shown("explicit"),
      step: text("step"),
    };
  });
}

/** Every /v1/workflows/* call this page made, with the browser's own end-to-end timing. */
async function apiTimings(page: Page): Promise<Array<{ path: string; ms: number }>> {
  return page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.includes("/v1/workflows/"))
      .map((entry) => ({ path: new URL(entry.name).pathname.replace("/v1/workflows", ""), ms: Math.round(entry.duration) })),
  );
}

function summarize(label: string, calls: Array<{ path: string; ms: number }>, note: (line: string) => void): void {
  const byPath = new Map<string, number[]>();
  for (const call of calls) byPath.set(call.path, [...(byPath.get(call.path) ?? []), call.ms]);
  const sorted = [...calls].map((c) => c.ms).sort((a, b) => a - b);
  const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  note(`${label}: ${calls.length} server calls, total ${sorted.reduce((a, b) => a + b, 0)} ms, p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${sorted.at(-1)} ms`);
  for (const [path, list] of byPath) note(`  ${path} x${list.length}: ${list.join(", ")} ms`);
}

async function openWorkflow(page: Page, errors: string[]): Promise<number> {
  // The persistent (extension) context asks the demo preview for a favicon it does not serve; that 404 is the
  // browser profile's, not the page's, so it is the one thing filtered out here.
  page.on("console", (message) => {
    const where = message.location().url;
    if (message.type() === "error" && !where.endsWith("/favicon.ico")) errors.push(`${message.text()} @ ${where}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => void (response.status() >= 400 ? console.log(`  [http] ${response.status()} ${response.url()}`) : undefined));
  page.on("requestfailed", (request) => console.log(`  [http] FAILED ${request.url()} (${request.failure()?.errorText})`));
  const at = Date.now();
  await page.goto(WORKFLOW_URL);
  await expect(page.locator("#title")).toHaveText("Check calendar availability", { timeout: 20_000 });
  return Date.now() - at;
}

/** Tab, then wait for the page to reach the next state. Returns the round-trip the user actually feels. */
async function tabUntil(page: Page, until: () => Promise<void>): Promise<number> {
  const at = Date.now();
  await page.keyboard.press("Tab");
  await until();
  return Date.now() - at;
}

// ============================================================================
// (a) plain Chromium: no Ghost extension
// ============================================================================

plain.describe("approach B in plain Chromium (no extension)", () => {
  plain("the three-step meeting story: suggestion, approval mode and result at every step", async ({ page }) => {
    const lines: string[] = [];
    const note = (line: string): void => void (console.log(`  [B] ${line}`), lines.push(line));
    const errors: string[] = [];

    note(`page -> first suggestion: ${await openWorkflow(page, errors)} ms`);

    // Step 1 — read, ordinary Tab approval.
    const first = await readSuggestion(page);
    note(`step 1: "${first.title}" | ${first.safety} | meta=${JSON.stringify(first.meta)} | step=${first.step}`);
    expect(first.safety, "a read action is labelled read").toContain("read");
    expect(first.meta, "executor + confirmation + provider are all on screen").toEqual(["composio", "tab approval", "heuristic"]);
    expect(first.tabHintVisible, "Tab is offered for a read action").toBe(true);
    expect(first.explicitVisible, "no explicit confirmation is demanded for a read action").toBe(false);

    const t1 = await tabUntil(page, () => expect(page.locator("#title")).toHaveText("Create draft response"));
    await expect(page.locator("#timeline")).toContainText("Calendar checked");
    note(`Tab 1 -> executed + next suggestion in ${t1} ms`);

    // Step 2 — reversible, "review" approval, complete change visible first.
    const second = await readSuggestion(page);
    note(`step 2: "${second.title}" | ${second.safety} | meta=${JSON.stringify(second.meta)} | preview="${second.preview}"`);
    expect(second.safety).toContain("reversible");
    expect(second.meta).toContain("review approval");
    expect(second.preview, "the reviewed change names the slot the calendar returned").toContain("Thursday 2:30 PM");

    const t2 = await tabUntil(page, () => expect(page.locator("#title")).toHaveText("Create tentative event"));
    await expect(page.locator("#timeline")).toContainText("Draft created");
    note(`Tab 2 -> executed + next suggestion in ${t2} ms`);

    // Step 3 — reversible, then the workflow completes and nothing more is suggested.
    const third = await readSuggestion(page);
    note(`step 3: "${third.title}" | ${third.safety} | meta=${JSON.stringify(third.meta)}`);
    expect(third.safety).toContain("reversible");
    expect(third.meta).toContain("review approval");

    const t3 = await tabUntil(page, () => expect(page.locator("#timeline")).toContainText("Workflow complete"));
    await expect(page.locator("#timeline")).toContainText("Event created");
    await expect(page.locator("#suggestion")).toBeHidden();
    await expect(page.locator("#empty")).toBeVisible();
    note(`Tab 3 -> workflow complete in ${t3} ms`);

    const calls = await apiTimings(page);
    summarize("three-step meeting story", calls, note);
    console.log(`\n===== APPROACH B / meeting =====\n${lines.join("\n")}\n================================\n`);

    expect(errors, "the demo runs without a single console error").toEqual([]);
    // Exactly one predict + approve + execute per step, and no fourth prediction once the workflow completed.
    expect(calls.map((c) => c.path), "one prediction per state, one approval, one execution").toEqual([
      "/predict", "/approve", "/execute", "/predict", "/approve", "/execute", "/predict", "/approve", "/execute",
    ]);
    expect(Math.max(...calls.map((c) => c.ms)), "no keyless server call takes longer than 2 s").toBeLessThan(2000);
  });

  plain("the Slack report becomes one reviewed GitHub issue", async ({ page }) => {
    const errors: string[] = [];
    await openWorkflow(page, errors);

    await page.locator("#issue").click();
    await expect(page.locator("#title")).toHaveText("Create GitHub issue");
    const view = await readSuggestion(page);
    console.log(`  [B] issue story: "${view.title}" | ${view.safety} | meta=${JSON.stringify(view.meta)} | preview="${view.preview}"`);
    expect(view.safety).toContain("reversible");
    expect(view.meta).toContain("review approval");
    expect(view.preview).toContain("Checkout crashes after applying a coupon");
    await expect(page.locator("#subject")).toHaveText("Checkout crashes after applying a coupon");

    const ms = await tabUntil(page, () => expect(page.locator("#timeline")).toContainText("GitHub issue #42 created"));
    await expect(page.locator("#timeline")).toContainText("Workflow complete");
    console.log(`  [B] issue story: one Tab -> deterministic issue #42 in ${ms} ms`);
    expect(errors).toEqual([]);
  });

  plain("the local field action comes back as a directive the client writes and reports", async ({ page }) => {
    const errors: string[] = [];
    await openWorkflow(page, errors);

    await page.locator("#local").click();
    await expect(page.locator("#title")).toHaveText("Fill focused field");
    const view = await readSuggestion(page);
    console.log(`  [B] local action: "${view.title}" | ${view.safety} | meta=${JSON.stringify(view.meta)}`);
    expect(view.meta, "a local directive is executed by the client, not Composio").toContain("local");
    expect(view.meta, "the exact text is already visible, so ordinary Tab is enough").toContain("tab approval");
    await expect(page.locator("#reply")).toHaveValue("");

    const ms = await tabUntil(page, () => expect(page.locator("#reply")).toHaveValue("Thursday at 2:30 PM works for me. Looking forward to it!"));
    console.log(`  [B] local action: Tab -> directive written + verified result reported in ${ms} ms`);

    // The page writes the field first and reports afterwards, so wait for the report rather than assume it.
    await expect
      .poll(async () => (await apiTimings(page)).map((c) => c.path), { message: "the client reporting the verified local result back" })
      .toContain("/local-result");
    summarize("local field action", await apiTimings(page), (line) => console.log(`  [B] ${line}`));
    expect(errors).toEqual([]);
  });

  plain("a client cannot downgrade the confirmation a high-impact action requires", async ({ request }) => {
    const userId = `compareB-downgrade-${Date.now()}`;
    const context = {
      version: 1,
      timestamp: Date.now(),
      activeApplication: { name: "Slack", bundleIdentifier: "com.tinyspeck.slackmacgap" },
      windowTitle: "Ship notes thread",
      focusedElement: { role: "AXGroup", label: "Composer" },
      nearbyText: ["Ship notes are ready for the team."],
      connectedToolkits: ["slack"],
      relevantActionIds: ["slack.send_message"],
    };

    const post = async (path: string, data: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await (request as APIRequestContext).post(`${API}${path}`, { data });
      return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
    };

    const predicted = await post("/predict", { userId, context, demo: true });
    expect(predicted.status).toBe(200);
    const suggestion = predicted.body.suggestion as { workflowId: string; action: { id: string; safety: string; confirmation: string } } | null;
    console.log(`  [B] high-impact suggestion: ${suggestion?.action.id} | ${suggestion?.action.safety} | ${suggestion?.action.confirmation}`);
    expect(suggestion?.action.safety).toBe("high-impact");
    expect(suggestion?.action.confirmation, "the server, not the client, decides the confirmation mode").toBe("explicit");
    expect(Object.keys(suggestion?.action ?? {}), "the hidden execution payload never leaves the server").not.toContain("preparedArguments");

    const workflowId = suggestion!.workflowId;
    const actionId = suggestion!.action.id;

    // The downgrade attempts a client can make.
    for (const confirmation of ["tab", "review"]) {
      const refused = await post("/approve", { userId, workflowId, actionId, confirmation });
      console.log(`  [B] approve as "${confirmation}" -> ${refused.status} ${JSON.stringify(refused.body)}`);
      expect(refused.status, `"${confirmation}" must not buy a high-impact action`).toBe(409);
      expect(String(refused.body.error)).toContain("explicit confirmation is required");
    }

    // Executing without ever approving.
    const forged = await post("/execute", { userId, workflowId, executionToken: "x".repeat(32) });
    console.log(`  [B] execute with a forged token -> ${forged.status} ${JSON.stringify(forged.body)}`);
    expect(forged.status).toBe(409);

    // The one confirmation the policy accepts, and its token is single use.
    const approved = await post("/approve", { userId, workflowId, actionId, confirmation: "explicit" });
    expect(approved.status).toBe(200);
    const token = String(approved.body.executionToken);
    const executed = await post("/execute", { userId, workflowId, executionToken: token });
    expect(executed.status).toBe(200);
    const result = executed.body.result as { simulated: boolean; ok: boolean };
    console.log(`  [B] explicit -> execute: simulated=${result.simulated} ok=${result.ok}`);
    expect(result.simulated, "with no COMPOSIO_API_KEY every execution is simulated").toBe(true);

    const replayed = await post("/execute", { userId, workflowId, executionToken: token });
    console.log(`  [B] replaying the same token -> ${replayed.status} ${JSON.stringify(replayed.body)}`);
    expect(replayed.status, "an approval token is consumed exactly once").toBe(409);
  });

  plain("approach B's own Tab handler ignores where focus is", async ({ page }) => {
    // The page approves on ANY Tab while a suggestion exists (demo/public/workflow/index.html:125 has no focus
    // gate), unlike Ghost's walk, which only takes Tab when focus is inside the walk (controller.ts onTab ->
    // focusInWalk). Typing a reply and tabbing out of the field therefore executes an action.
    const errors: string[] = [];
    await openWorkflow(page, errors);
    await page.locator("#reply").click();
    await page.keyboard.type("I'll check and get back to you");
    await expect(page.locator("#reply")).toHaveValue("I'll check and get back to you");

    await page.keyboard.press("Tab");
    await expect(page.locator("#timeline")).toContainText("Calendar checked");
    console.log("  [B] Tab pressed inside the reply textarea executed calendar.check_availability instead of moving focus");
    expect(await page.evaluate(() => document.activeElement?.id ?? ""), "focus never left the textarea").toBe("reply");
  });
});

// ============================================================================
// (b) the same page with the Ghost extension loaded
// ============================================================================

ghost.describe("approach B with the Ghost extension loaded", () => {
  ghost.use({ serverUrl: SERVER });

  ghost("the workflow page still runs, and Ghost stays inert on it", async ({ page }) => {
    const lines: string[] = [];
    const note = (line: string): void => void (console.log(`  [B+ext] ${line}`), lines.push(line));
    const errors: string[] = [];
    const before = { form: await serverCalls("/v1/predict/form", SERVER), next: await serverCalls("/v1/predict/next", SERVER) };

    note(`page -> first suggestion: ${await openWorkflow(page, errors)} ms`);
    await expect(page.locator(HOST), "the content script really is in this page").toHaveCount(1);

    // Ghost's own state on this page, read from the host's test hooks.
    const hostState = async (): Promise<Record<string, string>> =>
      page.evaluate(
        (id) => Object.fromEntries(Array.from(document.getElementById(id)?.attributes ?? [], (a) => [a.name, a.value])),
        HOST.slice(1),
      );
    note(`Ghost host attributes: ${JSON.stringify(await hostState())}`);

    const t1 = await tabUntil(page, () => expect(page.locator("#title")).toHaveText("Create draft response"));
    const t2 = await tabUntil(page, () => expect(page.locator("#title")).toHaveText("Create tentative event"));
    const t3 = await tabUntil(page, () => expect(page.locator("#timeline")).toContainText("Workflow complete"));
    note(`Tab 1/2/3 with the extension loaded: ${t1} / ${t2} / ${t3} ms`);
    await expect(page.locator("#timeline")).toContainText("Event created");

    const after = await hostState();
    const asked = { form: (await serverCalls("/v1/predict/form", SERVER)) - before.form, next: (await serverCalls("/v1/predict/next", SERVER)) - before.next };
    note(`Ghost host attributes after three Tabs: ${JSON.stringify(after)}`);
    note(`Ghost asked the server about this page: ${asked.form}x /v1/predict/form, ${asked.next}x /v1/predict/next`);
    summarize("three-step meeting story, extension loaded", await apiTimings(page), note);
    console.log(`\n===== APPROACH B / with extension =====\n${lines.join("\n")}\n=======================================\n`);

    // Why there is no conflict HERE: Ghost has nothing to accept on this page, so its capture-phase handler
    // falls through and the page's own bubble-phase handler still sees Tab.
    expect(after["data-ghost-count"] ?? "0", "Ghost drew no form ghost on the workflow page").toBe("0");
    expect(after["data-ghost-accepted"] ?? "0", "Ghost accepted nothing").toBe("0");
    // The single reply textarea is below MIN_FORM_FIELDS (extension/src/content/controller.ts:61,251), so the
    // form walk never even asks. That, not any coordination between the two streams, is why Tab is free here.
    expect(asked.form, "the workflow page's one textarea never triggers a form prediction").toBe(0);
    expect(errors).toEqual([]);
  });

  ghost("the latent conflict: where Ghost DOES have a ghost, a B-style Tab handler never fires", async ({ page }) => {
    // Approach B's exact Tab contract (demo/public/workflow/index.html:125), installed on a page where Ghost
    // is active. Registered at document_start in the page world, i.e. BEFORE the content script's listener.
    await page.addInitScript(() => {
      const w = window as ProbeWindow;
      w.__bApprovals = 0;
      w.__bTabsSeen = 0;
      window.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        (w.__bTabsSeen as number)++;
        if (event.shiftKey || event.metaKey || event.altKey || event.ctrlKey) return;
        event.preventDefault();
        (w.__bApprovals as number)++;
      });
    });

    await page.goto(`${DEMO}/apply`);
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready", { timeout: 20_000 });
    const count = Number((await host.getAttribute("data-ghost-count")) ?? "0");
    await page.evaluate(() => document.getElementById("apply-title")?.scrollIntoView({ block: "start" }));
    await expect(page.locator("#first-name")).toBeInViewport({ ratio: 1 });

    await page.keyboard.press("Tab");
    await expect(host).toHaveAttribute("data-ghost-accepted", "1");
    const probe = await page.evaluate(() => ({ approvals: (window as ProbeWindow).__bApprovals ?? -1, seen: (window as ProbeWindow).__bTabsSeen ?? -1 }));
    console.log(`  [conflict] ${count} Ghost ghosts; after one Tab: Ghost accepted 1, B-style handler saw ${probe.seen} Tab(s) and approved ${probe.approvals}`);

    expect(probe.seen, "Ghost's capture-phase stopPropagation keeps Tab from ever reaching a page handler").toBe(0);
    expect(probe.approvals, "a workflow page like approach B's would silently stop approving anything").toBe(0);
  });
});

ghost.describe("approach B with a Ghost that is willing to guess", () => {
  // Ghost asks /v1/predict/next about the workflow page on arrival (measured above: 1 request), and only the
  // confidence gate keeps a click ghost off it. Dropping the threshold to 0 is the cheapest way to show what
  // happens the day that gate opens — a learned page, a calibrated provider, a lower configured threshold.
  ghost.use({ serverUrl: SERVER, settings: { confidenceThreshold: 0, learningEnabled: true } });

  ghost("does the next-action layer put a click ghost on the workflow page, and who gets Tab then?", async ({ page }) => {
    const errors: string[] = [];
    const asked = await serverCalls("/v1/predict/next", SERVER);
    await openWorkflow(page, errors);

    // Wait for Ghost to have actually asked about this page, then see whether it drew anything.
    await expect
      .poll(async () => (await serverCalls("/v1/predict/next", SERVER)) - asked, { timeout: 20_000, message: "Ghost asking /v1/predict/next about the workflow page" })
      .toBeGreaterThan(0);
    // The next-action host is only created when a ghost is shown, so its absence is the answer.
    const nextHost = page.locator("#ghost-next-host");
    const visible = (await nextHost.count()) > 0 && (await nextHost.getAttribute("data-ghost-next")) === "visible";
    console.log(`  [conflict] confidenceThreshold=0 on the workflow page: Ghost asked, next-action ghost visible=${visible}`);

    await page.keyboard.press("Tab");
    if (visible) {
      // Ghost owns the key: its own handler swallows it and approach B never sees the approval.
      await expect(page.locator("#title"), "approach B's page is frozen while a Ghost click ghost is up").toHaveText("Check calendar availability");
      await expect(page.locator("#timeline")).not.toContainText("Calendar checked");
    } else {
      await expect(page.locator("#title")).toHaveText("Create draft response");
    }
    expect(errors).toEqual([]);
  });
});
