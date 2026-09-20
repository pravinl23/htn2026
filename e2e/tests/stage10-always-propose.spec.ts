// Stage 10: "always propose something" (docs/always-propose.md), proved in a real Chromium with the built
// extension loaded, on the pages where Ghost has nothing to go on.
//
// The rule that outranks every other heuristic in this repo: if Ghost can see anything actionable, it proposes
// for it. Being unsure changes HOW a proposal is drawn -- a dimmer ghost, a "guess" chip, the reason in the HUD
// -- and never whether it exists. Silence is correct in exactly one situation, which this spec also pins: a
// page whose only fields are sensitive, because passwords, cards and government IDs are never captured,
// never proposed and never filled. That is a privacy rule, not a confidence rule.
//
// Every page here is a synthetic local document served through `page.route` on the demo's own origin: no real
// site is ever driven, nothing is ever submitted, and no key and no server are needed (these tests run against
// OFFLINE_SERVER_URL, so what they prove is that the offline path alone never goes quiet).
//
// The accept key is pinned to plain Tab, which is one of the settings docs/accept-key.md section 3 offers, so
// what is under test is the proposal and the walk rather than which key an origin ends up taking.
import type { Page } from "@playwright/test";
import { DEMO_URL, HOST, OFFLINE_SERVER_URL, expect, overlayEval, patchSettings, test } from "../fixtures";

/** A path the demo never serves: every document under it is fulfilled by this spec. */
const LAB = `${DEMO_URL}/always-propose`;

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

/** Records what was pressed, and refuses every navigation and submit: this spec proves proposals, not effects. */
const PAGE_SCRIPT = `
  window.__pressed = [];
  window.__submitted = false;
  addEventListener("click", (event) => {
    const el = event.target instanceof Element ? event.target.closest("button, a[href]") : null;
    if (!el) return;
    event.preventDefault();
    window.__pressed.push(el.id || el.textContent.trim());
  }, true);
  addEventListener("submit", (event) => { event.preventDefault(); window.__submitted = true; }, true);`;

const STYLE = `
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; color: #1d1b2f; }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  input, select, textarea { font: inherit; padding: 8px 10px; width: 320px; box-sizing: border-box; }
  button { font: inherit; min-width: 40px; min-height: 40px; padding: 8px 14px; margin-right: 8px; }`;

function docHtml(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${title}</title>
    <style>${STYLE}</style></head><body>${body}<script>${PAGE_SCRIPT}</script></body></html>`;
}

const PAGES: Record<string, string> = {
  // A toolbar of icons: no labels, no names, no text. Nothing here can be matched against a profile fact.
  icons: docHtml("Icon bar", `
    <h1>Icon bar</h1>
    <div id="toolbar">
      <button id="icon-1" type="button"><svg width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" fill="currentColor"></rect></svg></button>
      <button id="icon-2" type="button"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 1v14" stroke="currentColor"></path></svg></button>
      <button id="icon-3" type="button"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"></circle></svg></button>
    </div>`),

  // A properly labelled form about something the profile has never heard of.
  strange: docHtml("Parts order", `
    <h1>Parts order</h1>
    <form id="order">
      <label for="tolerance">Sprocket tolerance</label><input id="tolerance" name="sprocketTolerance" />
      <label for="finish">Flange colour</label><input id="finish" name="flangeColour" />
      <label for="batch">Widget batch code</label><input id="batch" name="widgetBatch" />
      <button id="order-submit" type="submit">Submit order</button>
    </form>`),

  // One dropdown whose options match no fact and offer no neutral choice ("Other", "N/A", "Prefer not to say").
  dropdown: docHtml("Finishing", `
    <h1>Finishing</h1>
    <form id="finishing">
      <label for="coating">Preferred sprocket finish</label>
      <select id="coating" name="coating">
        <option value="">Select an option</option>
        <option value="matte">Matte</option>
        <option value="gloss">Gloss</option>
        <option value="brushed">Brushed</option>
      </select>
    </form>`),

  // A player: one video and three unlabelled controls. The video is not a control and is never proposed for.
  video: docHtml("Player", `
    <h1>Player</h1>
    <video id="clip" width="320" height="180" muted></video>
    <div id="controls">
      <button id="play" type="button"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 2l11 6-11 6z" fill="currentColor"></path></svg></button>
      <button id="mute" type="button"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 6h3l4-3v10L5 10H2z" fill="currentColor"></path></svg></button>
      <button id="expand" type="button"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 1h6M1 1v6" stroke="currentColor"></path></svg></button>
    </div>`),

  // Nothing on the page but one link.
  link: docHtml("The end", `<h1>The end</h1><p>That is all there is here.</p><a id="onward" href="#next">Continue reading</a>`),

  // The one page where silence is right: every field on it is sensitive (CLAUDE.md rule 3).
  sensitive: docHtml("Checkout", `
    <h1>Checkout</h1>
    <form id="checkout">
      <label for="pw">Password</label><input id="pw" name="password" type="password" />
      <label for="card">Card number</label><input id="card" name="cardNumber" autocomplete="cc-number" />
      <label for="cvc">Security code</label><input id="cvc" name="cvc" autocomplete="cc-csc" />
      <button id="pay" type="submit">Pay now</button>
    </form>`),

  // A form Ghost DOES know, for the tiers, the hold, the lock and rule 9. "Robin" is already in the first field.
  known: docHtml("Apply", `
    <h1>Apply</h1>
    <form id="apply">
      <label for="first">First name</label><input id="first" name="firstName" value="Robin" />
      <label for="last">Last name</label><input id="last" name="lastName" />
      <label for="email">Email</label><input id="email" name="email" type="email" />
      <label for="style">Preferred working style</label>
      <select id="style" name="workingStyle">
        <option value="">Select an option</option>
        <option value="remote">Remote</option>
        <option value="hybrid">Hybrid</option>
        <option value="onsite">On-site</option>
      </select>
      <button id="apply-submit" type="submit">Submit application</button>
    </form>`),
};

/** The five pages Ghost knows nothing about. Every one of them must still end up with a proposal on screen. */
const HARD_PAGES: { name: string; page: string; on: string }[] = [
  { name: "a toolbar of unlabelled icon buttons", page: "icons", on: "icon-1" },
  { name: "a form whose labels match nothing in the profile", page: "strange", on: "tolerance" },
  { name: "a dropdown whose options match no fact", page: "dropdown", on: "coating" },
  { name: "a video and three icon controls", page: "video", on: "play" },
  { name: "a page with a single link", page: "link", on: "onward" },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ProbeWindow {
  __pressed?: string[];
  __submitted?: boolean;
}

/**
 * Serves this spec's documents on the demo's own origin. They are fulfilled rather than written into demo/,
 * because these pages exist to be awkward and belong with the test that asserts on them.
 */
async function serveLab(page: Page): Promise<void> {
  await page.route(`${LAB}/*`, async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const body = PAGES[name];
    if (!body) return route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>no such page</title>" });
    await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
}

async function openLab(page: Page, name: string): Promise<void> {
  await serveLab(page);
  await page.goto(`${LAB}/${name}`);
  await expect(page.locator("h1")).toBeVisible();
}

interface Drawn {
  state: string;
  count: number;
  current: string;
  tier: string;
  guess: boolean;
  locked: boolean;
}

/** How the proposal on screen is DRAWN, read from the overlay host (the shadow root itself is closed). */
async function drawn(page: Page): Promise<Drawn> {
  return page.locator(HOST).evaluate((el) => ({
    state: el.getAttribute("data-ghost-state") ?? "",
    count: Number(el.getAttribute("data-ghost-count") ?? "0"),
    current: el.getAttribute("data-ghost-current") ?? "",
    tier: el.getAttribute("data-ghost-tier") ?? "",
    guess: el.getAttribute("data-ghost-guess") === "true",
    locked: el.getAttribute("data-ghost-current-locked") === "true",
  }));
}

/** The HUD row that carries a long shot's reason. Empty while it is hidden. */
async function readWhy(page: Page): Promise<string> {
  const why = await overlayEval(page, (root) => {
    const row = root.querySelector<HTMLElement>(".hud-why");
    return !row || row.hidden ? "" : (row.textContent ?? "");
  });
  return why ?? "";
}

interface Chip {
  guess: boolean;
  tier: string;
  chip: string;
  text: string;
}

/** What the overlay drew for one field, through the CLOSED shadow root. Click ghosts have no text node. */
async function readChip(page: Page, fieldId: string): Promise<Chip | null> {
  return overlayEval(page, (root, id) => {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(".ghost[data-signature]"));
    const node = nodes.find((el) => (el.getAttribute("data-signature") ?? "").split("|").includes(id));
    if (!node) return null;
    return {
      guess: node.getAttribute("data-guess") === "true",
      tier: node.getAttribute("data-tier") ?? "",
      chip: node.querySelector(".chip")?.textContent ?? "",
      text: node.querySelector(".label")?.textContent ?? "",
    };
  }, fieldId);
}

/**
 * One tap of the Ghost key: right Option down and up with nothing in between (docs/accept-key.md section 3).
 * The Ghost key is the one that accepts WHEREVER a ghost is on screen -- a click ghost, a field the user is
 * not in, a brand-new origin whose Tab has never been watched -- which is what makes these pages testable at
 * all. On an origin observed to leave Tab alone, Tab accepts a field ghost as well; that is stage 1's subject.
 */
async function tapGhostKey(page: Page): Promise<void> {
  await page.keyboard.down("AltRight");
  await page.keyboard.up("AltRight");
  await page.waitForTimeout(80);
}

/** The Ghost key HELD: auto-repeat keydowns, spaced like a real repeat so no write is dropped mid-flight. */
async function holdGhostKey(page: Page, repeats = 8): Promise<void> {
  await page.keyboard.down("AltRight");
  for (let i = 0; i < repeats; i++) {
    await page.keyboard.down("AltRight");
    await page.waitForTimeout(45);
  }
  await page.keyboard.up("AltRight");
  await page.waitForTimeout(80);
}

async function pressed(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as ProbeWindow).__pressed ?? ["<the page never loaded its probe>"]);
}

async function submitted(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as ProbeWindow).__submitted === true);
}

/** Nothing on the page was activated, and nothing was sent. Asserted after every walk in this file. */
async function expectNothingPressed(page: Page): Promise<void> {
  expect(await pressed(page)).toEqual([]);
  expect(await submitted(page)).toBe(false);
}

const READY = { timeout: 20_000 };

// ---------------------------------------------------------------------------

test.describe("stage 10: Ghost always proposes something", () => {
  // No server at all: what is proved here is that the offline path on its own never goes quiet.
  test.use({ serverUrl: OFFLINE_SERVER_URL });

  for (const hard of HARD_PAGES) {
    test(`proposes on ${hard.name}`, async ({ page }) => {
      await openLab(page, hard.page);

      const host = page.locator(HOST);
      await expect(host, "silence is only right when there is nothing to act on").toHaveAttribute("data-ghost-state", "ready", READY);

      const view = await drawn(page);
      expect(view.count).toBeGreaterThan(0);
      expect(view.current, "the proposal landed on something the user can act on").toContain(hard.on);
      expect(view.locked, "and never on something irreversible").toBe(false);
      // Unsure, and saying so: the dimmest tier, the guess flag, and the reason where the user can read it.
      expect(view.tier).toBe("long-shot");
      expect(view.guess).toBe(true);
      expect(await readWhy(page)).not.toBe("");

      // Proposing is not doing.
      await expectNothingPressed(page);
    });
  }

  test("a dropdown that matches no fact is answered with the option that claims the least, chipped as a guess", async ({ page }) => {
    await openLab(page, "dropdown");
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "ready", READY);

    const chip = await readChip(page, "coating");
    expect(chip?.guess).toBe(true);
    expect(chip?.tier).toBe("long-shot");
    expect(chip?.chip).toBe("guess");
    expect(chip?.text).toBe("Matte");
    // It is a proposal, not a change: the select still holds its placeholder until a key is pressed.
    await expect(page.locator("#coating")).toHaveValue("");
  });

  test("proposes for the controls on a video page, and never for the video", async ({ page }) => {
    await openLab(page, "video");
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "ready", READY);

    const view = await drawn(page);
    expect(view.count).toBe(1);
    expect(view.current).not.toContain("clip");
    expect(view.current).toContain("play");
  });

  test("the confidence threshold dims a proposal; it never removes one", async ({ page, worker }) => {
    await openLab(page, "known");
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready", READY);

    // At the default threshold the facts are ordinary ghosts: no chip, nothing to check.
    const atDefault = await drawn(page);
    expect(atDefault.count).toBeGreaterThan(1);
    expect((await readChip(page, "email"))?.chip).toBe("");
    expect((await readChip(page, "email"))?.tier).toBe("confident");

    // The user drags the bar up past everything Ghost knows. The same proposals are still there.
    await patchSettings(worker, { confidenceThreshold: 0.99 });
    await expect(host).toHaveAttribute("data-ghost-tier", "long-shot", READY);

    const raised = await drawn(page);
    expect(raised.count, "raising the bar dims proposals, it does not delete them").toBe(atDefault.count);
    const email = await readChip(page, "email");
    expect(email?.text, "the email fact is still proposed").toContain("@");
    expect(email?.tier).toBe("long-shot");
    expect(email?.guess, "and hold-to-accept now stops at it, because the user set the bar there").toBe(true);
  });

  test("a 0.99 threshold does not silence the long shot on a page Ghost knows nothing about", async ({ page, worker }) => {
    await openLab(page, "icons");
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "ready", READY);
    const before = await drawn(page);

    await patchSettings(worker, { confidenceThreshold: 0.99 });
    await page.waitForTimeout(300);

    const after = await drawn(page);
    expect(after.state).toBe("ready");
    expect(after.count).toBe(before.count);
    expect(after.current).toBe(before.current);
    expect(after.tier).toBe("long-shot");
    await expectNothingPressed(page);
  });

  test("hold-to-accept fills what Ghost knows and stops at the first guess", async ({ page }) => {
    await openLab(page, "known");
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "ready", READY);

    await page.locator("#last").focus();
    await tapGhostKey(page); // one deliberate press to start the walk
    await holdGhostKey(page);

    // The hold walked THROUGH what Ghost knows and stopped at the first thing it does not.
    await expect(page.locator("#last")).toHaveValue("Chen");
    expect(await page.locator("#email").inputValue()).toContain("@");
    await expect(page.locator("#style"), "the guess is where the hold stopped").toHaveValue("");
    expect((await drawn(page)).current).toContain("style");
    expect((await drawn(page)).tier).toBe("long-shot");
    expect((await readChip(page, "style"))?.chip).toBe("guess");
    await expectNothingPressed(page);
  });

  test("a held key never accepts the long shot on a page Ghost knows nothing about", async ({ page }) => {
    await openLab(page, "icons");
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "ready", READY);

    await holdGhostKey(page);
    expect(await pressed(page), "a hold stops at every guess, and this whole page is one").toEqual([]);

    // A deliberate tap is a different thing entirely: the user looked at the proposal and took it.
    await tapGhostKey(page);
    expect(await pressed(page)).toEqual(["icon-1"]);
    expect(await submitted(page)).toBe(false);
  });

  test("a locked action is proposed and walked to, and never pressed", async ({ page }) => {
    await openLab(page, "known");
    const host = page.locator(HOST);
    await expect(host).toHaveAttribute("data-ghost-state", "ready", READY);

    // Take every value ghost by hand, guesses included: a deliberate press may accept a guess, a hold may not.
    await page.locator("#last").focus();
    for (let i = 0; i < 6 && !(await drawn(page)).locked; i++) await tapGhostKey(page);

    await expect(host).toHaveAttribute("data-ghost-current-locked", "true");
    expect((await drawn(page)).current).toContain("apply-submit");
    await expect(page.locator("#apply-submit")).toBeFocused();
    // The chip on a locked ghost names the one thing that can take it, and it is not the accept key.
    await expect(host).toHaveAttribute("data-ghost-key-hint", "Enter");

    // Over-pressing a locked ghost is harmless: it is a proposal to press Submit, never a press.
    for (let i = 0; i < 3; i++) await tapGhostKey(page);
    expect((await drawn(page)).current).toContain("apply-submit");
    await expectNothingPressed(page);
  });

  test("a field that already has a value is never proposed for and never overwritten", async ({ page }) => {
    await openLab(page, "known");
    await expect(page.locator(HOST)).toHaveAttribute("data-ghost-state", "ready", READY);

    expect(await readChip(page, "first"), "nothing is drawn over what the page already filled in").toBeNull();
    await page.locator("#last").focus();
    await tapGhostKey(page);
    await holdGhostKey(page);
    await expect(page.locator("#first")).toHaveValue("Robin");
  });

  test("a page whose only fields are sensitive is the one page Ghost is right to leave alone", async ({ page, worker }) => {
    await openLab(page, "sensitive");
    // Nothing is proposed: no overlay at all, or an overlay with nothing in it.
    await page.waitForTimeout(1_000);
    const host = page.locator(HOST);
    if ((await host.count()) > 0) {
      const view = await drawn(page);
      expect(view.state).toBe("idle");
      expect(view.count).toBe(0);
    }

    // And a threshold of 0 does not change that: this is a privacy rule, not a confidence rule.
    await patchSettings(worker, { confidenceThreshold: 0 });
    await page.locator("#pw").focus();
    await tapGhostKey(page);
    await holdGhostKey(page);

    await expect(page.locator("#pw")).toHaveValue("");
    await expect(page.locator("#card")).toHaveValue("");
    await expect(page.locator("#cvc")).toHaveValue("");
    await expectNothingPressed(page);
  });
});
