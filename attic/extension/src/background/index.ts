// Background service worker. MV3 requires every listener to be registered synchronously at startup.
import { onStorageChanged } from "../lib/storage";
import { handleDebuggerMessage, isDebuggerMessage } from "./debugger-input";
import { seedDefaults } from "./install";
import { registerLoopBackground } from "./loopBackground";
import { handleMetricsMessage, isMetricsMessage } from "./metrics";
import { registerNextClient } from "./nextClient";
import { registerPresence } from "./presence";
import { handleServerMessage, isServerMessage } from "./serverClient";
import { createTextStreamHub } from "./textStream";
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
  if (sender.id !== chrome.runtime.id) return false;
  if (isDebuggerMessage(message)) void handleDebuggerMessage(message, sender.tab?.id).then(sendResponse);
  else if (isServerMessage(message)) void handleServerMessage(message, sender).then(sendResponse);
  else if (isMetricsMessage(message)) void handleMetricsMessage(message).then(sendResponse);
  else return false;
  return true; // keep the channel open for the async reply
});

// Free-text drafts stream over a port per draft; the open port also keeps this worker alive while it streams.
const textStreams = createTextStreamHub({ extensionId: chrome.runtime.id });
chrome.runtime.onConnect.addListener((port) => textStreams.onConnect(port));

const loop = registerLoopBackground(); // action trace, loop detection and loop runs (docs/loops.md): its own onMessage listener, registered synchronously
registerNextClient(loop.router.services); // "ghost:next-candidates": episodic memory, then POST /v1/predict/next (docs/loops.md 2)
registerPresence(); // /v1/presence heartbeat so Ghost Desktop stays out of this browser (docs/server-api.md)

refreshBadge().catch(logFailure("badge refresh"));
