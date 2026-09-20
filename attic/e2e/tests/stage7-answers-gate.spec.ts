// The answer engine and the walk gate, as docs/answers.md and docs/incremental.md describe them:
// Ghost answers every question it can, says out loud when it is guessing, never proposes a Submit the page
// would reject, and remembers the correction the user makes instead.
import type { Page, Worker } from "@playwright/test";
import { EXPECTED, expectNotSubmitted, gotoForm, hostState, scrollToForm, walk } from "../apply";
import { HOST, OFFLINE_SERVER_URL, PROFILE_KEY, expect, overlayEval, readStorage, readToast, test, writeStorage } from "../fixtures";

const SUBMIT = "[data-testid=submit]";
const REFERRAL = "#referral-source";
const MY_ESSAY = "Robots that ship, and a team that reviews carefully.";
/** What the user picks instead of Ghost's guess. It is one of the form's own options. */
const MY_REFERRAL = "LinkedIn";

interface StoredProfile {
  facts: Record<string, string>;
  pastAnswers: unknown[];
}

interface GhostChip {
  guess: boolean;
  answerClass: string;
  chip: string;
  text: string;
}

/** What the overlay drew for one field, read through the CLOSED shadow root. */
async function readChip(page: Page, fieldId: string): Promise<GhostChip | null> {
  return overlayEval(page, (root, id) => {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(".ghost[data-signature]"));
    const node = nodes.find((el) => (el.getAttribute("data-signature") ?? "").split("|").includes(id));
    if (!node) return null;
    return {
      guess: node.getAttribute("data-guess") === "true",
      answerClass: node.getAttribute("data-answer-class") ?? "",
      chip: node.querySelector(".chip")?.textContent ?? "",
      text: node.querySelector(".label")?.textContent ?? "",
    };
  }, fieldId);
}

/** The demo profile with `referralSource` taken out, so "How did you hear about us?" has no fact behind it. */
async function forgetReferral(worker: Worker): Promise<void> {
  const profile = await readStorage<StoredProfile>(worker, PROFILE_KEY);
  if (!profile) throw new Error("ghost.profile was never seeded");
  const { referralSource: _dropped, ...facts } = profile.facts;
  await writeStorage(worker, PROFILE_KEY, { ...profile, facts });
}

/** A held Tab, spaced like a real key repeat so writes are never dropped mid-flight. */
async function holdTab(page: Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const state = await hostState(page);
    if (state.count === 0 || state.locked) break;
    await page.keyboard.down("Tab");
    await page.waitForTimeout(40);
  }
  await page.keyboard.up("Tab");
}

test.describe("stage 7: every question answered, and no Submit before the form is ready", () => {
  test.use({ serverUrl: OFFLINE_SERVER_URL, settings: { learningEnabled: true } });

  test("a required field left empty means NO Submit ghost, and Tab goes to that field instead", async ({ page }) => {
    await gotoForm(page, "/apply");
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready");
    await scrollToForm(page);

    // Every required field is empty on arrival, so the gate is shut before a single Tab.
    await expect(host).toHaveAttribute("data-ghost-gate", "blocked");
    await expect(host).toHaveAttribute("data-ghost-unmet", "12");

    const presses = await walk(page);
    expect(presses).toBeGreaterThan(10);
    // The essay and the privacy box are still empty: no Submit ghost exists, so the walk simply ends.
    await expect(host).toHaveAttribute("data-ghost-count", "0");
    await expect(host).toHaveAttribute("data-ghost-gate", "blocked");
    await expect(host).toHaveAttribute("data-ghost-unmet", "2");
    await expect(page.locator(SUBMIT)).not.toBeFocused();
    await expectNotSubmitted(page);

    // docs/incremental.md section 4: Tab at the end of the walk goes to the first unfilled required field.
    await page.keyboard.press("Tab");
    await expect(page.locator("#why-northwind")).toBeFocused();
    await expect(page.locator("#why-northwind")).toHaveValue("");
  });

  test("once every required field is answered the Submit ghost appears, locked, and Tab does not press it", async ({ page }) => {
    await gotoForm(page, "/apply");
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "ready");
    await scrollToForm(page);
    await walk(page);

    const host = page.locator(HOST);
    await page.locator("#why-northwind").fill(MY_ESSAY);
    await expect(host).toHaveAttribute("data-ghost-unmet", "1");
    await page.locator("#consent").check();

    // The moment the last required field is answered, the gate opens and the Submit ghost arrives.
    await expect(host).toHaveAttribute("data-ghost-gate", "allowed");
    await expect(host).toHaveAttribute("data-ghost-unmet", "0");
    await expect(host).toHaveAttribute("data-ghost-count", "1");
    await expect(host).toHaveAttribute("data-ghost-current-locked", "true");

    await page.keyboard.press("Tab");
    await expect(page.locator(SUBMIT)).toBeFocused();
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab"); // over-pressing a locked ghost is harmless
    await expect(page.locator(SUBMIT)).toBeFocused();
    await expectNotSubmitted(page);
    await expect(page.locator("#first-name")).toHaveValue(EXPECTED.firstName ?? "");
  });

  test("a dropdown no fact answers gets a visible guess, and a held Tab stops there", async ({ page, worker }) => {
    await forgetReferral(worker);
    await gotoForm(page, "/apply");
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready");
    await scrollToForm(page);

    // Ghost never gives up on a field: with no fact it proposes the most neutral option this form offers.
    const guess = await readChip(page, "referral-source");
    expect(guess?.guess).toBe(true);
    expect(guess?.answerClass).toBe("ordinary");
    expect(guess?.chip).toBe("guess");
    expect(guess?.text).toBe("Other");

    await page.locator("#first-name").focus();
    await holdTab(page);
    // The hold stops AT the guess: it is current, it is still a guess, and the dropdown is untouched.
    await expect(host).toHaveAttribute("data-ghost-guess", "true");
    expect((await hostState(page)).current).toContain("referral-source");
    await expect(page.locator(REFERRAL)).toHaveValue("");
    await expect(host).toHaveAttribute("data-ghost-gate", "blocked");
    await expectNotSubmitted(page);
  });

  test("correcting a guess teaches Ghost: after a reload the answer comes back, with no guess chip", async ({ page, worker }) => {
    await forgetReferral(worker);
    await gotoForm(page, "/apply");
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "ready");
    await scrollToForm(page);
    expect((await readChip(page, "referral-source"))?.guess).toBe(true);

    // The user answers it themselves, with the keyboard, so every event the page sees is a real one.
    await page.locator(REFERRAL).focus();
    await page.keyboard.press("l"); // a native select jumps to the first option starting with this letter
    await expect(page.locator(REFERRAL)).toHaveValue(MY_REFERRAL);
    await page.locator("#apply-title").click(); // commit the change the way leaving the field does
    await expect.poll(() => readToast(page)).toBe("Ghost will remember this answer");

    await page.reload();
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "ready");
    await scrollToForm(page);
    const learned = await readChip(page, "referral-source");
    expect(learned?.text).toBe(MY_REFERRAL);
    expect(learned?.guess).toBe(false);
    expect(learned?.chip).toBe("");

    // It is stored locally and only locally: a value the user gave never rides along to any server.
    const stored = await readStorage<{ answers: Array<{ value: string; class: string }> }>(worker, "ghost.answers");
    expect(stored?.answers.some((a) => a.value === MY_REFERRAL && a.class === "ordinary")).toBe(true);
  });
});
