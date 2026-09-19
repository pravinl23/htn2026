// Background service worker. MV3 requires every listener to be registered synchronously at startup.
import { onStorageChanged } from "../lib/storage";
import { handleDebuggerMessage, isDebuggerMessage } from "./debugger-input";
import { seedDefaults } from "./install";
import { paintBadge, refreshBadge, toggleEnabled } from "./toggle";

const logFailure = (what: string) => (err: unknown) => console.warn(`[ghost] ${what} failed`, err);

chrome.runtime.onInstalled.addListener(() => {
  seedDefaults().then(refreshBadge).catch(logFailure("install seeding"));
});

chrome.runtime.onStartup.addListener(() => {
  refreshBadge().catch(logFailure("badge refresh"));
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-ghost") toggleEnabled().catch(logFailure("toggle"));
});

chrome.action.onClicked.addListener(() => {
  toggleEnabled().catch(logFailure("toggle"));
});

// Keeps the badge right when the options page flips the switch.
onStorageChanged((changes) => {
  if (changes.settings) paintBadge(changes.settings.enabled).catch(logFailure("badge paint"));
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isDebuggerMessage(message)) return false;
  void handleDebuggerMessage(message, sender.tab?.id).then(sendResponse);
  return true; // keep the channel open for the async reply
});

refreshBadge().catch(logFailure("badge refresh"));
