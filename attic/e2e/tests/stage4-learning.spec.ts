// Stage 4 + 7: resume import, opt-in learning (and everything it must never learn), and the metrics page.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Worker } from "@playwright/test";
import { SERVER_GHOSTS, expectGhosts, expectNotSubmitted, gotoForm, openForm, walk } from "../apply";
import { DEMO_URL, E2E_SERVER_URL, METRICS_KEY, PROFILE_KEY, expect, readAllStorage, readStorage, readToast, serverMetrics, test, writeStorage } from "../fixtures";

const RESUME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../demo/fixtures/resume-alex-chen.txt");
const LEARN_SETTLE_MS = 1200; // three times the learner's 400 ms debounce

interface StoredProfile {
  facts: Record<string, string>;
  pastAnswers: unknown[];
}
interface StoredMetrics {
  ghostsShown: number;
  ghostsAccepted: number;
  keystrokesSaved: number;
  clicksSaved: number;
  calibration: Array<{ c: number; a: number }>;
}

// Fictional values. The SIN is the well-known sample number that passes the Luhn check, which is exactly
// the shape the learner's last line of defence (looksSecret) has to catch if the label check ever fails.
const NEW_PHONE = "+1 226 555 0199";
const TRAP_SIN = "046 454 286";
const TRAP_PASSWORD = "hunter2-payroll-demo";

async function storedProfile(worker: Worker): Promise<StoredProfile> {
  const profile = await readStorage<StoredProfile>(worker, PROFILE_KEY);
  if (!profile) throw new Error("ghost.profile was never seeded");
  return profile;
}

/** The seeded demo profile minus `key`, so the form has one profile field Ghost cannot fill. */
async function forgetFact(worker: Worker, key: string): Promise<StoredProfile> {
  const profile = await storedProfile(worker);
  const { [key]: _dropped, ...facts } = profile.facts;
  const next = { ...profile, facts };
  await writeStorage(worker, PROFILE_KEY, next);
  return next;
}

/** Types like a person: click, keys, then a click on the section heading commits the field (change + blur). */
async function typeAndLeave(page: Page, selector: string, text: string): Promise<void> {
  await page.locator(selector).click();
  await page.keyboard.type(text);
  await page.locator("#apply-title").click();
  await expect(page.locator(selector)).toHaveValue(text);
}

async function typeIntoTheTraps(page: Page): Promise<void> {
  await typeAndLeave(page, "#sin", TRAP_SIN);
  await typeAndLeave(page, "#payroll-password", TRAP_PASSWORD);
}

async function expectTrapsNowhere(worker: Worker): Promise<void> {
  const everything = JSON.stringify(await readAllStorage(worker));
  expect(everything).not.toContain(TRAP_PASSWORD);
  expect(everything.replace(/[\s-]/g, "")).not.toContain(TRAP_SIN.replace(/\s/g, ""));
}

test.describe("stage 4: import a resume on the options page", () => {
  test.use({ serverUrl: E2E_SERVER_URL });

  test("pasted resume text proposes facts, and saving writes only the checked ones to storage", async ({ page, worker, extensionId }) => {
    await writeStorage(worker, PROFILE_KEY, { facts: { firstName: "Alex" }, pastAnswers: [] });
    const resumeText = await readFile(RESUME, "utf8");

    await page.goto(`chrome-extension://${extensionId}/options.html#resume`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    await page.getByTestId("resume-text").fill(resumeText);
    await page.getByTestId("resume-extract").click();

    await expect(page.getByTestId("review-table")).toBeVisible();
    await expect(page.getByTestId("review-source")).toContainText("regex extractor");
    await expect(page.getByTestId("review-value-email")).toHaveValue("alex.chen.dev@example.com");
    await expect(page.getByTestId("review-value-graduationDate")).toHaveValue("2028-04");
    await expect(page.getByTestId("review-check-email")).toBeChecked();
    await expect(page.getByTestId("review-check-firstName")).toBeDisabled(); // already saved, nothing to review
    await expect(page.getByTestId("review-check-extra.skills")).not.toBeChecked(); // extras are opt in
    expect((await storedProfile(worker)).facts).toEqual({ firstName: "Alex" }); // nothing is saved before Save

    await page.getByTestId("review-check-website").uncheck();
    await page.getByTestId("review-save").click();
    await expect(page.getByTestId("resume-status")).toContainText(/Saved \d+ facts/);

    const { facts } = await storedProfile(worker);
    expect(facts).toMatchObject({
      firstName: "Alex",
      lastName: "Chen",
      email: "alex.chen.dev@example.com",
      phone: "+1 519 555 0142",
      github: "https://github.com/alexchen-dev",
      linkedin: "https://linkedin.com/in/alexchen-dev",
      school: "University of Waterloo",
      degree: "BCS Computer Science",
      graduationDate: "2028-04",
    });
    expect(facts).not.toHaveProperty("website"); // unchecked in the review
    expect(facts).not.toHaveProperty(["extra.skills"]);

    // The resume itself is never stored, and the textarea is cleared once it has served its purpose.
    await expect(page.getByTestId("resume-text")).toHaveValue("");
    expect(JSON.stringify(await readAllStorage(worker))).not.toMatch(/Maple Lantern|Kestrel Yard|bouldering/);
  });
});

test.describe("stage 4: learning is opt in", () => {
  test.describe("with learning enabled", () => {
    test.use({ serverUrl: E2E_SERVER_URL, settings: { learningEnabled: true } });

    test("a typed phone number becomes a fact (with a toast), the SIN and password never do", async ({ page, worker }) => {
      const before = await forgetFact(worker, "phone");
      await openForm(page, "/apply", SERVER_GHOSTS - 1); // no phone fact, so no phone ghost

      // The traps go first: by the time the phone lesson lands, a (wrong) lesson from them would have landed too.
      await typeIntoTheTraps(page);
      await typeAndLeave(page, "#phone", NEW_PHONE);

      await expect.poll(() => readToast(page)).toBe("Ghost learned: phone"); // the KEY, never the value
      await expect.poll(async () => (await storedProfile(worker)).facts.phone).toBe(NEW_PHONE);

      const after = await storedProfile(worker);
      expect(after.facts).toEqual({ ...before.facts, phone: NEW_PHONE }); // one new fact and nothing else
      expect(after.pastAnswers).toEqual([]);
      await expectTrapsNowhere(worker);
      await expectNotSubmitted(page);

      // What was learned is a real fact: the next visit ghosts the phone field again.
      await gotoForm(page, "/apply-plain/");
      await expectGhosts(page, SERVER_GHOSTS);
    });
  });

  test.describe("with learning disabled (the default)", () => {
    test.use({ serverUrl: E2E_SERVER_URL });

    test("nothing typed is stored", async ({ page, worker }) => {
      const before = await forgetFact(worker, "phone");
      await openForm(page, "/apply", SERVER_GHOSTS - 1);
      await typeIntoTheTraps(page);
      await typeAndLeave(page, "#phone", NEW_PHONE);
      await typeAndLeave(page, "#why-northwind", "Because robots that ship are the best kind of robots.");

      await page.waitForTimeout(LEARN_SETTLE_MS); // negative check: give a (wrongly) eager learner time to write
      expect(await readToast(page)).toBeNull();
      await page.goto(`${DEMO_URL}/`); // pagehide flushes whatever a learner would still be holding
      expect(await storedProfile(worker)).toEqual(before);
      expect(JSON.stringify(await readAllStorage(worker))).not.toContain(NEW_PHONE);
      await expectTrapsNowhere(worker);
    });
  });
});

test.describe("stage 7: metrics", () => {
  test.use({ serverUrl: E2E_SERVER_URL });

  test("a walk is counted in ghost.metrics, reaches the server, and the options page draws the reliability chart", async ({ page, worker, extensionId }) => {
    const serverBefore = (await serverMetrics()).counters;
    await openForm(page, "/apply", SERVER_GHOSTS);
    const accepted = await walk(page);
    expect(accepted).toBe(SERVER_GHOSTS); // every value ghost; the Submit is still gated behind the privacy box
    await expectNotSubmitted(page);

    // The reporter batches every 5 s (and on pagehide); the worker is the one writer of ghost.metrics.
    const stored = async (): Promise<StoredMetrics | undefined> => readStorage<StoredMetrics>(worker, METRICS_KEY);
    await expect.poll(async () => (await stored())?.ghostsAccepted ?? 0, { timeout: 15_000 }).toBe(accepted);
    const metrics = await stored();
    expect(metrics?.ghostsShown).toBeGreaterThanOrEqual(accepted);
    expect(metrics?.keystrokesSaved).toBeGreaterThan(100); // two essays alone are several hundred characters
    expect(metrics?.clicksSaved).toBeGreaterThan(0); // selects and radios
    expect(metrics?.calibration).toHaveLength(accepted);
    expect(metrics?.calibration.every((pair) => pair.a === 1 && pair.c >= 0.7 && pair.c <= 1)).toBe(true);
    expect(JSON.stringify(metrics)).not.toMatch(/alex|chen\b|519|waterloo|example\.com/i); // numbers only

    await expect.poll(async () => (await serverMetrics()).counters.ghostsAccepted - serverBefore.ghostsAccepted).toBe(accepted);

    const options = await page.context().newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html#metrics`);
    await expect(options.locator("body")).toHaveAttribute("data-ready", "true");
    await expect(options.getByTestId("metric-acceptance")).toContainText(`${accepted} of`);
    await expect(options.getByTestId("metric-keystrokes")).toContainText(String(metrics?.keystrokesSaved.toLocaleString("en-US")));
    await expect(options.getByTestId("latency-table")).toContainText("/v1/predict/form");
    const chart = options.getByTestId("reliability-chart");
    await expect(chart).toBeVisible();
    expect(await chart.locator("circle.dot").count()).toBeGreaterThan(0);
    await expect(options.getByTestId("reliability-readout")).toContainText(`${accepted} ghosts`);
  });
});
