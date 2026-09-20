// Options page entry. Add a tab by appending a section here.
import { mountSections } from "./sections";
import type { OptionsSection } from "./sections";
import { metricsSection } from "./metrics-section";
import { learnedSection } from "./learned-section";
import { mountOnboarding } from "./onboarding";
import { profileSection } from "./profile-section";
import { resumeSection } from "./resume-section";
import { settingsSection } from "./settings-section";
import { mountStatusPill } from "./status-pill";

const sections: OptionsSection[] = [profileSection, learnedSection, resumeSection, metricsSection, settingsSection];

async function main(): Promise<void> {
  const nav = document.getElementById("tabs");
  const panels = document.getElementById("panels");
  if (!nav || !panels) return;
  const pill = document.getElementById("server-status");
  if (pill) mountStatusPill(pill);
  const onboarding = document.getElementById("onboarding");
  if (onboarding) await mountOnboarding(onboarding, document.getElementById("show-onboarding"));
  await mountSections(nav, panels, sections);
  document.body.dataset.ready = "true";
}

void main();
