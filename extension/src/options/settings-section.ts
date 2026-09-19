import type { GhostSettings } from "@ghost/shared";
import { getSettings, onStorageChanged, saveSettings } from "../lib/storage";
import { flashStatus, h } from "./dom";
import type { OptionsSection } from "./sections";
import { parseServerUrl } from "./validate";

type BooleanSetting = "enabled" | "showHud" | "learningEnabled";

const THRESHOLD = { min: "0.5", max: "0.95", step: "0.05" };

function field(title: string, hint: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "setting" }, h("span", { class: "setting-text" }, h("strong", {}, title), h("small", {}, hint)), control);
}

function toggle(testId: string): HTMLInputElement {
  return h("input", { type: "checkbox", class: "switch", role: "switch", "data-testid": testId });
}

async function mount(panel: HTMLElement): Promise<void> {
  const status = h("span", { class: "status", role: "status", "data-testid": "settings-status" });
  const toggles: Record<BooleanSetting, HTMLInputElement> = {
    enabled: toggle("setting-enabled"),
    showHud: toggle("setting-hud"),
    learningEnabled: toggle("setting-learning"),
  };
  const threshold = h("input", { type: "range", ...THRESHOLD, "data-testid": "setting-threshold" });
  const thresholdValue = h("output", { class: "value", "data-testid": "setting-threshold-value" });
  const serverUrl = h("input", { type: "url", class: "text", spellcheck: "false", placeholder: "http://localhost:8787", "data-testid": "setting-server-url" });
  const urlError = h("p", { class: "error", role: "alert", "data-testid": "setting-server-url-error" });

  const show = (settings: GhostSettings): void => {
    for (const key of Object.keys(toggles) as BooleanSetting[]) toggles[key].checked = settings[key];
    threshold.value = String(settings.confidenceThreshold);
    thresholdValue.textContent = settings.confidenceThreshold.toFixed(2);
    if (document.activeElement !== serverUrl) serverUrl.value = settings.serverUrl;
  };

  const persist = async (patch: Partial<GhostSettings>): Promise<void> => {
    try {
      await saveSettings(patch);
      flashStatus(status, "Saved");
    } catch (err) {
      flashStatus(status, `Could not save: ${err instanceof Error ? err.message : String(err)}`, "error", 6000);
    }
  };

  for (const key of Object.keys(toggles) as BooleanSetting[]) {
    toggles[key].addEventListener("change", () => void persist({ [key]: toggles[key].checked }));
  }
  const thresholdNumber = (): number => Math.round(Number(threshold.value) * 100) / 100;
  threshold.addEventListener("input", () => {
    thresholdValue.textContent = thresholdNumber().toFixed(2);
  });
  threshold.addEventListener("change", () => void persist({ confidenceThreshold: thresholdNumber() }));
  serverUrl.addEventListener("change", () => {
    const url = parseServerUrl(serverUrl.value);
    urlError.textContent = url ? "" : "Enter an http or https URL, for example http://localhost:8787";
    if (!url) return;
    serverUrl.value = url;
    void persist({ serverUrl: url });
  });

  onStorageChanged((changes) => {
    if (changes.settings) show(changes.settings);
  });

  panel.append(
    h("div", { class: "row" }, h("h2", {}, "Settings"), h("span", { class: "spacer" }), status),
    h("p", { class: "muted" }, "Changes save automatically."),
    field("Ghost enabled", "Also toggled by the toolbar icon or Alt+Shift+G.", toggles.enabled),
    field("Form confidence threshold", "Controls form filling and generated text. Safe next-action guesses are shown as exploratory even when confidence is lower.", h("span", { class: "slider" }, threshold, thresholdValue)),
    field("Prediction server URL", "Local Ghost server. API keys live there, never in the extension.", serverUrl),
    urlError,
    field("Debug HUD", "Small overlay with the active provider, last latency, and cache status.", toggles.showHud),
    field("Learn from what I type", "Opt in: values you type into recognized fields become profile facts. Sensitive fields are never learned.", toggles.learningEnabled),
  );
  show(await getSettings());
}

export const settingsSection: OptionsSection = { id: "settings", title: "Settings", mount };
