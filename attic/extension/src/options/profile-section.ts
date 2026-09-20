import { DEMO_PROFILE } from "@ghost/shared";
import type { Profile } from "@ghost/shared";
import { getProfile, onStorageChanged, saveProfile } from "../lib/storage";
import { errorMessage, flashStatus, h } from "./dom";
import { createProfileEditor } from "./profile-editor";
import type { OptionsSection } from "./sections";
import { formatProfile, parseProfileJson } from "./validate";

type View = "fields" | "json";

const RESET_LABEL = "Reset to demo profile";
const RESET_CONFIRM_MS = 4000;

function summarize(profile: Profile): string {
  const facts = Object.keys(profile.facts).length;
  const answers = profile.pastAnswers.length;
  return `${facts} fact${facts === 1 ? "" : "s"}, ${answers} past answer${answers === 1 ? "" : "s"}`;
}

/** Destructive, so it takes two clicks: the first arms the button for a few seconds. */
function confirmTwice(button: HTMLButtonElement, action: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    clearTimeout(timer);
    timer = undefined;
    button.textContent = RESET_LABEL;
  };
  button.addEventListener("click", () => {
    if (timer === undefined) {
      button.textContent = "Click again to replace your profile";
      timer = setTimeout(disarm, RESET_CONFIRM_MS);
      return;
    }
    disarm();
    action();
  });
}

async function mount(panel: HTMLElement): Promise<void> {
  const initial = await getProfile();
  let savedText = "";
  let view: View = "fields";
  let fieldsError: string | null = null;

  const editor = h("textarea", { class: "json-editor", spellcheck: "false", rows: "24", "aria-label": "Profile JSON", "data-testid": "profile-json" });
  const error = h("p", { class: "error", role: "alert", "data-testid": "profile-error" });
  const summary = h("span", { class: "muted", "data-testid": "profile-summary" });
  const status = h("span", { class: "status", role: "status", "data-testid": "profile-status" });
  const save = h("button", { type: "button", class: "primary", "data-testid": "profile-save" }, "Save profile");
  const format = h("button", { type: "button", "data-testid": "profile-format" }, "Format");
  const reset = h("button", { type: "button", class: "danger", "data-testid": "profile-reset" }, RESET_LABEL);
  const viewButtons: Record<View, HTMLButtonElement> = {
    fields: h("button", { type: "button", "data-testid": "profile-view-fields" }, "Fields"),
    json: h("button", { type: "button", "data-testid": "profile-view-json" }, "JSON"),
  };

  const validate = (): Profile | null => {
    const result = parseProfileJson(editor.value);
    const message = view === "fields" && fieldsError ? fieldsError : result.ok ? "" : result.error;
    error.textContent = message;
    editor.classList.toggle("invalid", !result.ok);
    save.disabled = message !== "" || editor.value === savedText;
    format.disabled = !result.ok;
    if (result.ok && !message) summary.textContent = summarize(result.profile);
    return result.ok && !message ? result.profile : null;
  };

  // The JSON text is the draft both views share: field edits are serialized into it as they happen.
  const fields = createProfileEditor(() => {
    const result = fields.read();
    fieldsError = result.ok ? null : result.error;
    if (result.ok) editor.value = formatProfile(result.profile);
    validate();
  });

  const showView = (next: View): void => {
    view = next;
    fields.el.hidden = next !== "fields";
    editor.hidden = next !== "json";
    format.hidden = next !== "json";
    for (const key of Object.keys(viewButtons) as View[]) viewButtons[key].setAttribute("aria-pressed", String(key === next));
  };

  // Leaving a view that does not validate would silently drop what is in it, so the switch waits for a fix.
  const switchView = (next: View): void => {
    if (next === view) return;
    const profile = validate();
    if (!profile) return;
    if (next === "fields") fields.show(profile);
    showView(next);
  };

  const show = (profile: Profile): void => {
    savedText = formatProfile(profile);
    editor.value = savedText;
    fieldsError = null;
    fields.show(profile);
    validate();
  };

  const persist = async (profile: Profile, message: string): Promise<void> => {
    try {
      await saveProfile(profile);
      show(profile);
      flashStatus(status, message);
    } catch (err) {
      flashStatus(status, `Could not save: ${errorMessage(err)}`, "error", 6000);
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
  confirmTwice(reset, () => void persist(structuredClone(DEMO_PROFILE), "Reset to the demo profile"));
  for (const key of Object.keys(viewButtons) as View[]) viewButtons[key].addEventListener("click", () => switchView(key));

  // Pick up changes made elsewhere (learning, resume import) unless the user has unsaved edits.
  onStorageChanged((changes) => {
    if (changes.profile && editor.value === savedText && !fieldsError) show(changes.profile);
  });

  panel.append(
    h("div", { class: "row" }, h("h2", {}, "Profile"), h("span", { class: "spacer" }), h("div", { class: "segmented", role: "group", "aria-label": "Editor" }, viewButtons.fields, viewButtons.json)),
    h("p", { class: "muted" }, "The facts Ghost fills into forms. Ships with the fictional demo profile (Alex Chen). Passwords, card numbers, and government IDs are never stored."),
    fields.el,
    editor,
    error,
    h("div", { class: "row" }, save, format, reset, h("span", { class: "spacer" }), summary, status),
  );
  showView("fields");
  show(initial);
}

export const profileSection: OptionsSection = { id: "profile", title: "Profile", mount };
