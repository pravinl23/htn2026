import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_PROFILE } from "@ghost/shared";
import { getProfile, getSettings, resetMemoryStorage, saveSettings } from "../src/lib/storage";
import { profileSection } from "../src/options/profile-section";
import { mountSections } from "../src/options/sections";
import { settingsSection } from "../src/options/settings-section";
import { formatProfile, parseProfileJson, parseServerUrl } from "../src/options/validate";

describe("parseProfileJson", () => {
  it("accepts the demo profile", () => {
    expect(parseProfileJson(formatProfile(DEMO_PROFILE))).toEqual({ ok: true, profile: DEMO_PROFILE });
  });

  it("defaults pastAnswers to an empty list", () => {
    expect(parseProfileJson('{"facts":{"a":"b"}}')).toEqual({ ok: true, profile: { facts: { a: "b" }, pastAnswers: [] } });
  });

  it.each([
    ["{", /Invalid JSON/],
    ["[]", /must be an object/],
    ['{"facts":[]}', /"facts" must be an object/],
    ['{"facts":{"age":21}}', /"age" must be a string/],
    ['{"facts":{},"pastAnswers":{}}', /must be an array/],
    ['{"facts":{},"pastAnswers":[{"question":"q"}]}', /pastAnswers\[0\]/],
    ['{"facts":{"password":"hunter2"}}', /looks sensitive/],
    ['{"facts":{"creditCardNumber":"4111"}}', /looks sensitive/],
    ['{"facts":{"ssn":"000"}}', /looks sensitive/],
  ])("rejects %s", (text, message) => {
    const result = parseProfileJson(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

describe("parseServerUrl", () => {
  it("keeps http(s) URLs and trims trailing slashes", () => {
    expect(parseServerUrl(" http://localhost:8787/ ")).toBe("http://localhost:8787");
    expect(parseServerUrl("https://ghost.test/api/")).toBe("https://ghost.test/api");
  });

  it("rejects other schemes and junk", () => {
    expect(parseServerUrl("ftp://localhost")).toBeNull();
    expect(parseServerUrl("localhost:8787")).toBeNull();
    expect(parseServerUrl("")).toBeNull();
  });
});

describe("options page", () => {
  const $ = <T extends HTMLElement>(testId: string): T => {
    const el = document.querySelector<T>(`[data-testid="${testId}"]`);
    if (!el) throw new Error(`missing ${testId}`);
    return el;
  };
  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string, event = "input"): void => {
    el.value = value;
    el.dispatchEvent(new Event(event, { bubbles: true }));
  };
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(async () => {
    const nav = document.createElement("nav");
    const panels = document.createElement("main");
    document.body.replaceChildren(nav, panels);
    await mountSections(nav, panels, [profileSection, settingsSection]);
  });

  afterEach(() => {
    document.body.replaceChildren();
    resetMemoryStorage();
  });

  it("shows the profile tab first and switches tabs", () => {
    const [profilePanel, settingsPanel] = [...document.querySelectorAll<HTMLElement>(".panel")];
    expect(profilePanel?.hidden).toBe(false);
    expect(settingsPanel?.hidden).toBe(true);
    $("tab-settings").click();
    expect(profilePanel?.hidden).toBe(true);
    expect(settingsPanel?.hidden).toBe(false);
    expect($("tab-settings").getAttribute("aria-selected")).toBe("true");
  });

  it("loads the demo profile as JSON with Save disabled until something changes", () => {
    expect(JSON.parse($<HTMLTextAreaElement>("profile-json").value)).toEqual(DEMO_PROFILE);
    expect($<HTMLButtonElement>("profile-save").disabled).toBe(true);
    expect($("profile-summary").textContent).toContain("19 facts");
  });

  it("shows a validation error and blocks Save for invalid JSON", () => {
    type($<HTMLTextAreaElement>("profile-json"), "{ not json");
    expect($("profile-error").textContent).toMatch(/Invalid JSON/);
    expect($<HTMLButtonElement>("profile-save").disabled).toBe(true);
  });

  it("saves a valid edit and confirms it", async () => {
    const edited = { facts: { ...DEMO_PROFILE.facts, city: "Toronto" }, pastAnswers: [] };
    type($<HTMLTextAreaElement>("profile-json"), JSON.stringify(edited));
    expect($("profile-error").textContent).toBe("");
    $("profile-save").click();
    await settle();
    expect((await getProfile()).facts.city).toBe("Toronto");
    expect($("profile-status").textContent).toBe("Profile saved");
    expect($<HTMLButtonElement>("profile-save").disabled).toBe(true);
  });

  it("resets to the demo profile", async () => {
    type($<HTMLTextAreaElement>("profile-json"), '{"facts":{"firstName":"Sam"}}');
    $("profile-save").click();
    await settle();
    $("profile-reset").click();
    await settle();
    expect(await getProfile()).toEqual(DEMO_PROFILE);
    expect(JSON.parse($<HTMLTextAreaElement>("profile-json").value)).toEqual(DEMO_PROFILE);
  });

  it("reflects stored settings and saves each control", async () => {
    const enabled = $<HTMLInputElement>("setting-enabled");
    expect(enabled.checked).toBe(true);
    expect($("setting-threshold-value").textContent).toBe("0.70");
    enabled.click();
    type($<HTMLInputElement>("setting-threshold"), "0.85");
    expect($("setting-threshold-value").textContent).toBe("0.85");
    type($<HTMLInputElement>("setting-threshold"), "0.85", "change");
    $<HTMLInputElement>("setting-hud").click();
    $<HTMLInputElement>("setting-learning").click();
    type($<HTMLInputElement>("setting-server-url"), "http://localhost:9000/", "change");
    await settle();
    expect(await getSettings()).toEqual({ enabled: false, confidenceThreshold: 0.85, serverUrl: "http://localhost:9000", showHud: false, learningEnabled: true });
    expect($("settings-status").textContent).toBe("Saved");
  });

  it("limits the threshold slider to 0.5..0.95", () => {
    const slider = $<HTMLInputElement>("setting-threshold");
    expect([slider.min, slider.max, slider.step]).toEqual(["0.5", "0.95", "0.05"]);
  });

  it("rejects a bad server URL without saving it", async () => {
    type($<HTMLInputElement>("setting-server-url"), "not a url", "change");
    await settle();
    expect($("setting-server-url-error").textContent).toMatch(/http or https/);
    expect((await getSettings()).serverUrl).toBe("http://localhost:8787");
  });

  it("follows settings changed elsewhere, such as the toolbar toggle", async () => {
    await saveSettings({ enabled: false });
    expect($<HTMLInputElement>("setting-enabled").checked).toBe(false);
  });
});
