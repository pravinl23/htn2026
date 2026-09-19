// Options page entry. Add later tabs ("Resume import", "Metrics") by appending a section here.
import { mountSections } from "./sections";
import type { OptionsSection } from "./sections";
import { profileSection } from "./profile-section";
import { settingsSection } from "./settings-section";

const sections: OptionsSection[] = [profileSection, settingsSection];

async function main(): Promise<void> {
  const nav = document.getElementById("tabs");
  const panels = document.getElementById("panels");
  if (!nav || !panels) return;
  await mountSections(nav, panels, sections);
  document.body.dataset.ready = "true";
}

void main();
