// Stage 8: the fact graph. The options page sources facts from what the user already has, proposes them
// for review, saves only what they check, and forgets a whole source on request. The job application must
// keep filling exactly as before: the graph replaced the mapping layer, not the behaviour.
import { OFFLINE_GHOSTS, EXPECTED, expectFormState, expectNotSubmitted, openForm, walk } from "../apply";
import { PROFILE_KEY, expect, readAllStorage, readStorage, test, writeStorage } from "../fixtures";

const FACTS_KEY = "ghost.facts";
/**
 * `FACT_SCHEMA_VERSION` in shared/src/facts/graph.ts. It is 2 since a stored rejection carries the day it was
 * made, so it can expire instead of blocking a fact for ever; a migrated graph must be written at the CURRENT
 * schema, which is what these assertions are for.
 */
const FACT_SCHEMA_VERSION = 2;
/** A signature block, the way one arrives in a mail. Fictional, like the rest of the demo profile. */
const SIGNATURE = [
  "Alex Chen",
  "Software Engineer at Northwind Robotics",
  "alex.chen.dev@example.com",
  "M: +1 519 555 0142",
].join("\n");

interface StoredFact {
  key: string;
  value: string;
  label: string;
  source: { kind: string };
  verifiedByUser: boolean;
}
interface StoredGraph {
  version: number;
  /** Stored as it lives in memory: keyed by fact key. */
  facts: Record<string, StoredFact>;
  rejected: string[];
}
interface StoredProfile {
  facts: Record<string, string>;
  pastAnswers: unknown[];
}

async function graph(worker: Parameters<typeof readStorage>[0]): Promise<StoredGraph> {
  const stored = await readStorage<StoredGraph>(worker, FACTS_KEY);
  if (!stored) throw new Error("ghost.facts was never written");
  return stored;
}

function factValue(stored: StoredGraph, key: string): string | undefined {
  return stored.facts[key]?.value;
}

function factKeys(stored: StoredGraph): string[] {
  return Object.keys(stored.facts).sort();
}

test.describe("stage 8: the profile sources page", () => {
  test("migrates the demo profile into a fact graph, proposes, and saves only what is checked", async ({ page, worker, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/options.html#sources`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");

    // The flat demo profile became a graph, with a category and a human label per fact.
    const migrated = await graph(worker);
    expect(migrated.version).toBe(FACT_SCHEMA_VERSION);
    expect(factValue(migrated, "firstName")).toBe("Alex");
    expect(Object.values(migrated.facts).every((fact) => fact.source.kind === "user")).toBe(true);
    await expect(page.getByTestId("fact-row-firstName")).toContainText("first name");
    await expect(page.getByTestId("facts-summary")).toContainText("facts");
    // The connectors that do not exist yet say so instead of pretending.
    await expect(page.getByTestId("source-scan-mail")).toBeDisabled();
    await expect(page.getByTestId("source-scan-mail")).toHaveText("Connect through the desktop app");

    // A scan proposes; nothing is saved.
    await page.getByTestId("source-input-text").fill(SIGNATURE);
    await page.getByTestId("source-scan-text").click();
    await expect(page.getByTestId("facts-review-table")).toBeVisible();
    await expect(page.getByTestId("proposal-value-work.employer.current")).toHaveValue("Northwind Robotics");
    await expect(page.getByTestId("proposal-value-work.title")).toHaveValue("Software Engineer");
    await expect(page.getByTestId("proposal-check-email")).toBeDisabled(); // already exactly this
    expect(factValue(await graph(worker), "work.employer.current")).toBeUndefined();

    // Only the checked row is saved.
    await page.getByTestId("proposal-check-work.title").uncheck();
    await page.getByTestId("proposal-save").click();
    await expect(page.getByTestId("facts-status")).toContainText("Saved 1 fact");

    const saved = await graph(worker);
    expect(factValue(saved, "work.employer.current")).toBe("Northwind Robotics");
    expect(factValue(saved, "work.title")).toBeUndefined();
    // The flat profile is the graph's mirror, so the content script sees the new fact without knowing about it.
    const profile = await readStorage<StoredProfile>(worker, PROFILE_KEY);
    expect(profile?.facts["work.employer.current"]).toBe("Northwind Robotics");

    // "Forget everything from this source" takes exactly that source's facts.
    const before = factKeys(await graph(worker)).length;
    const forget = page.getByTestId("source-forget-file:pasted text");
    await forget.click();
    await forget.click();
    await expect(page.getByTestId("facts-status")).toContainText("Forgot 1 fact");
    const after = await graph(worker);
    expect(factKeys(after)).toHaveLength(before - 1);
    expect(factValue(after, "firstName")).toBe("Alex"); // the user's own facts are untouched
  });

  test("never proposes or stores anything sensitive, and never sends a value anywhere", async ({ page, worker, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/options.html#sources`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    await page.getByTestId("source-input-text").fill("Alex Chen\nSIN 046 454 286\nVisa 4111 1111 1111 1111\npassword: hunter2-demo");
    await page.getByTestId("source-scan-text").click();
    await expect(page.getByTestId("facts-review")).toBeVisible();

    const rows = await page.locator('[data-testid^="proposal-row-"]').count();
    for (let i = 0; i < rows; i++) {
      const value = await page.locator('[data-testid^="proposal-value-"]').nth(i).inputValue();
      expect(value.replace(/[\s-]/g, "")).not.toContain("046454286");
      expect(value).not.toContain("4111");
      expect(value).not.toContain("hunter2");
    }
    if (rows > 0) await page.getByTestId("proposal-save").click();
    const everything = JSON.stringify(await readAllStorage(worker));
    expect(everything.replace(/[\s-]/g, "")).not.toContain("046454286");
    expect(everything).not.toContain("hunter2-demo");
  });
});

test.describe("stage 8: the job application fills exactly as before", () => {
  test("a graph-backed walk fills every profile field and still stops at the lock", async ({ page, worker, extensionId }) => {
    // Opening the options page is what migrates the profile into a graph; the form must fill the same after.
    await page.goto(`chrome-extension://${extensionId}/options.html#sources`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    expect((await graph(worker)).version).toBe(FACT_SCHEMA_VERSION);

    await openForm(page, "/apply", OFFLINE_GHOSTS);
    expect(await walk(page)).toBe(OFFLINE_GHOSTS);
    await expectFormState(page, EXPECTED);
    await expectNotSubmitted(page);
  });

  test("a fact the user adds to the graph reaches the next form through the profile mirror", async ({ page, worker, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/options.html#sources`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    await page.getByTestId("fact-value-location").fill("Toronto, ON");
    await page.getByTestId("fact-save-location").click();
    await expect(page.getByTestId("facts-status")).toContainText("Saved location");

    expect(factValue(await graph(worker), "location")).toBe("Toronto, ON");
    const form = await page.context().newPage();
    await openForm(form, "/apply", OFFLINE_GHOSTS);
    await walk(form);
    await expectFormState(form, { ...EXPECTED, location: "Toronto, ON" });
    await form.close();
  });
});

test.describe("stage 8: an old install", () => {
  test("a profile stored before the graph existed is migrated, keys and all", async ({ page, worker, extensionId }) => {
    await writeStorage(worker, PROFILE_KEY, { facts: { firstName: "Alex", "address.home.postalCode": "N2L 3G1" }, pastAnswers: [] });
    await writeStorage(worker, FACTS_KEY, null);
    await page.goto(`chrome-extension://${extensionId}/options.html#sources`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    await expect(page.getByTestId("fact-row-address.home.postalCode")).toContainText("postal code");
    const migrated = await graph(worker);
    expect(factValue(migrated, "address.home.postalCode")).toBe("N2L 3G1");
    expect(factKeys(migrated)).toEqual(["address.home.postalCode", "firstName"]);
  });
});
