import { getSettings, saveSettings } from "../lib/storage";

const BADGE_ON = "#16a34a";
const BADGE_OFF = "#6b7280";

export async function paintBadge(enabled: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: enabled ? "ON" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? BADGE_ON : BADGE_OFF });
  await chrome.action.setTitle({ title: `Ghost is ${enabled ? "on" : "off"}: click to toggle` });
}

export async function refreshBadge(): Promise<void> {
  const settings = await getSettings();
  await paintBadge(settings.enabled);
}

/** Flips settings.enabled. Content scripts pick the change up through chrome.storage.onChanged. */
export async function toggleEnabled(): Promise<boolean> {
  const enabled = !(await getSettings()).enabled;
  await saveSettings({ enabled });
  await paintBadge(enabled);
  return enabled;
}
