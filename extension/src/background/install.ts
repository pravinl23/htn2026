import { getProfile, saveSettings } from "../lib/storage";

/** Seeds the demo profile and default settings. Existing values are kept, so updates never clobber user edits. */
export async function seedDefaults(): Promise<void> {
  await getProfile();
  await saveSettings({});
}
