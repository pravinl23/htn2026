import { DEFAULT_SETTINGS, DEMO_PROFILE } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserAgentObserver } from "../src/content/agentBrowser";
import { setVisibilityProbe } from "../src/content/capture";

describe("browser agent adapter", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <form>
        <label for="first">First name</label><input id="first" name="firstName" required>
        <label for="email">Email</label><input id="email" name="email" value="already@example.test" required>
        <label for="consent">I agree to the privacy policy</label><input id="consent" name="consent" type="checkbox" required>
        <label for="password">Password</label><input id="password" type="password">
        <button id="submit" type="submit">Submit application</button>
      </form>`;
    setVisibilityProbe(() => true);
  });

  afterEach(() => {
    setVisibilityProbe(null);
    document.body.innerHTML = "";
  });

  it("offers value-free candidates and executes the private local ghost", async () => {
    const observe = createBrowserAgentObserver({
      getProfile: () => DEMO_PROFILE,
      getSettings: () => DEFAULT_SETTINGS,
      doc: document,
    });
    const before = observe();
    expect(before.candidates.map(({ label, required, locked, filled, operations }) => ({ label, required, locked, filled, operations }))).toEqual([
      { label: "First name", required: true, locked: false, filled: false, operations: ["FILL"] },
      { label: "Email", required: true, locked: false, filled: true, operations: [] },
      { label: "I agree to the privacy policy", required: true, locked: false, filled: false, operations: [] },
      { label: "Submit application", required: false, locked: true, filled: false, operations: ["CLICK"] },
    ]);
    const wire = JSON.stringify({ page: before.page, candidates: before.candidates });
    expect(wire).not.toContain("Alex");
    expect(wire).not.toContain("already@example.test");

    const first = before.candidates[0];
    expect(first).toBeDefined();
    expect(await before.execute("FILL", first!.id)).toMatchObject({ ok: true });
    expect((document.querySelector("#first") as HTMLInputElement).value).toBe("Alex");
    expect(observe().fingerprint).not.toBe(before.fingerprint);
  });
});
