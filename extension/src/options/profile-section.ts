import { DEMO_PROFILE } from "@ghost/shared";
import type { Profile } from "@ghost/shared";
import { getProfile, onStorageChanged, saveProfile } from "../lib/storage";
import { flashStatus, h } from "./dom";
import type { OptionsSection } from "./sections";
import { formatProfile, parseProfileJson } from "./validate";

function summarize(profile: Profile): string {
  const facts = Object.keys(profile.facts).length;
  const answers = profile.pastAnswers.length;
  return `${facts} fact${facts === 1 ? "" : "s"}, ${answers} past answer${answers === 1 ? "" : "s"}`;
}

async function mount(panel: HTMLElement): Promise<void> {
  const initial = await getProfile();
  let savedText = "";

  const editor = h("textarea", { class: "json-editor", spellcheck: "false", rows: "24", "aria-label": "Profile JSON", "data-testid": "profile-json" });
  const error = h("p", { class: "error", role: "alert", "data-testid": "profile-error" });
  const summary = h("span", { class: "muted", "data-testid": "profile-summary" });
  const status = h("span", { class: "status", role: "status", "data-testid": "profile-status" });
  const save = h("button", { type: "button", class: "primary", "data-testid": "profile-save" }, "Save profile");
  const format = h("button", { type: "button", "data-testid": "profile-format" }, "Format");
  const reset = h("button", { type: "button", class: "danger", "data-testid": "profile-reset" }, "Reset to demo profile");

  const validate = (): Profile | null => {
    const result = parseProfileJson(editor.value);
    error.textContent = result.ok ? "" : result.error;
    editor.classList.toggle("invalid", !result.ok);
    save.disabled = !result.ok || editor.value === savedText;
    format.disabled = !result.ok;
    if (result.ok) summary.textContent = summarize(result.profile);
    return result.ok ? result.profile : null;
  };

  const show = (profile: Profile): void => {
    savedText = formatProfile(profile);
    editor.value = savedText;
    validate();
  };

  const persist = async (profile: Profile, message: string): Promise<void> => {
    try {
      await saveProfile(profile);
      show(profile);
      flashStatus(status, message);
    } catch (err) {
      flashStatus(status, `Could not save: ${err instanceof Error ? err.message : String(err)}`, "error", 6000);
    }
  };

  editor.addEventListener("input", validate);
  save.addEventListener("click", () => {
    const profile = validate();
    if (profile) void persist(profile, "Profile saved");
  });
  format.addEventListener("click", () => {
    const profile = validate();
    if (profile) editor.value = formatProfile(profile);
    validate();
  });
  reset.addEventListener("click", () => void persist(structuredClone(DEMO_PROFILE), "Reset to the demo profile"));

  // Pick up changes made elsewhere (learning, resume import) unless the user has unsaved edits.
  onStorageChanged((changes) => {
    if (changes.profile && editor.value === savedText) show(changes.profile);
  });

  panel.append(
    h("h2", {}, "Profile"),
    h("p", { class: "muted" }, "The facts Ghost fills into forms. Ships with the fictional demo profile (Alex Chen). Passwords, card numbers, and government IDs are never stored."),
    editor,
    error,
    h("div", { class: "row" }, save, format, reset, h("span", { class: "spacer" }), summary, status),
  );
  show(initial);
}

export const profileSection: OptionsSection = { id: "profile", title: "Profile", mount };
