// Content script entry: capture -> predict -> controller -> overlay + execute.
import type { FormPredictRequest, GhostSettings, Profile } from "@ghost/shared";
import { ghostEvents } from "../lib/events";
import { readCachedForm, saveCachedForm } from "../lib/formCache";
import { isGhostMessage, isServerResult, parseFormPrediction } from "../lib/messages";
import type { FormPrediction, GhostMessage, ServerResult } from "../lib/messages";
import { getMetrics, getProfile, getSettings, onStorageChanged } from "../lib/storage";
import { GhostController } from "./controller";
import { DraftScheduler, openTextPort } from "./freeText";
import { Learner } from "./learning";
import { LearnToast } from "./learnToast";
import { startLoopContent } from "./loopContent";
import { watchForOrphan } from "./lifecycle";
import { MetricsReporter, savedTitle, sendMetricsToWorker } from "./metricsReporter";
import { Overlay } from "./overlay";
import { createFormPredictor } from "./predict";
import { createServedLedger, observePredictions } from "./servedLedger";
import type { ServedLedger } from "./servedLedger";
import { syncLoopCapture } from "./trace";

const LOADED_FLAG = "__ghostContentLoaded";

interface Session {
  profile: Profile;
  settings: GhostSettings;
  overlay: Overlay;
  controller: GhostController;
  running: boolean;
}

const MIN_FRAME_WIDTH = 200;
const MIN_FRAME_HEIGHT = 80;

function isTopFrame(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

/** Embedded application forms (Greenhouse, Lever, Ashby) live in iframes; ad slots and tracking pixels do not get a Ghost. */
function worthRunningIn(): boolean {
  return isTopFrame() || (window.innerWidth >= MIN_FRAME_WIDTH && window.innerHeight >= MIN_FRAME_HEIGHT);
}

function claimPage(): boolean {
  if (!/^https?:$/.test(location.protocol) || !worthRunningIn()) return false;
  // The isolated world is shared by every injection of this extension, so a global marks the page as taken.
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope[LOADED_FLAG]) return false;
  scope[LOADED_FLAG] = true;
  return true;
}

/** The worker makes the request: the page's CSP cannot block it and the page cannot watch it. */
async function askWorker(request: FormPredictRequest): Promise<ServerResult<FormPrediction>> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return { ok: false, error: "no-worker" };
  const message: GhostMessage = { type: "ghost:predict-form", request };
  const reply: unknown = await chrome.runtime.sendMessage(message);
  if (!isServerResult(reply)) return { ok: false, error: "bad-reply" };
  if (!reply.ok) return reply;
  const data = parseFormPrediction(reply.data);
  return data ? { ok: true, data } : { ok: false, error: "bad-reply" };
}

function apply(session: Session): void {
  const wasRunning = session.running;
  session.running = session.settings.enabled;
  syncLoopCapture(session.running); // action trace + page facts (docs/loops.md section 1), only while Ghost is enabled
  if (!session.running) {
    session.controller.stop();
    session.overlay.destroy(); // the constructor mounts the host; a disabled Ghost leaves no trace on the page
  } else if (wasRunning) {
    session.controller.rescan(); // pick up a new profile, threshold or HUD setting
  } else {
    session.controller.start();
  }
}

function listenForToggle(session: Session): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isGhostMessage(message) || message.type !== "ghost:toggle") return;
    // Storage is the source of truth for `enabled`; the message only says "look again".
    void getSettings().then((settings) => {
      session.settings = settings;
      apply(session);
    });
  });
}

/** Learning (opt-in) and metrics listen to the controller's events; neither is known to the controller. Returns the stop function. */
function startSubscribers(session: Session, ledger: ServedLedger): () => void {
  const toast = new LearnToast({ root: () => (session.running ? session.overlay.shadow : null) });
  const learner = new Learner({
    events: ghostEvents,
    getSettings: () => session.settings,
    getProfile: () => session.profile,
    served: ledger.get,
    toast: (request) => toast.show(request),
  });
  const reporter = new MetricsReporter({
    events: ghostEvents,
    send: sendMetricsToWorker,
    isCalibrated: (signature) => ledger.get(signature)?.calibrated === true,
    loadTotals: getMetrics,
    onTotals: (totals) => session.overlay.setSavedTitle(savedTitle(totals)),
  });
  learner.start();
  reporter.start();
  return () => {
    learner.stop();
    reporter.stop();
    toast.hide();
  };
}

async function boot(): Promise<void> {
  const [profile, settings] = await Promise.all([getProfile(), getSettings()]);
  const overlay = new Overlay();
  const ledger = createServedLedger();
  const session: Session = {
    profile,
    settings,
    overlay,
    running: false,
    controller: new GhostController({
      overlay,
      getProfile: () => session.profile,
      // One HUD per tab: frames keep their ghosts but leave the status chip to the top document.
      getSettings: () => (isTopFrame() ? session.settings : { ...session.settings, showHud: false }),
      predictForm: observePredictions(createFormPredictor({ readCache: readCachedForm, saveCache: saveCachedForm, askServer: askWorker }), ledger),
      // Essay drafts stream through the worker too, one `ghost:text` port per field, at most three at a time.
      drafts: new DraftScheduler({ open: openTextPort }),
    }),
  };
  onStorageChanged((changes) => {
    if (changes.profile) session.profile = changes.profile;
    if (changes.settings) session.settings = changes.settings;
    apply(session);
  });
  listenForToggle(session);
  const stopSubscribers = startSubscribers(session, ledger);
  watchForOrphan(() => {
    stopSubscribers();
    retire(session);
  });
  apply(session);
  startLoopContent({ overlay, isEnabled: () => session.running, pauseGhosts: (paused) => (paused ? session.controller.stop() : void (session.running && session.controller.start())) }); // loop sheet + executor (docs/loops.md 3.4, 3.5)
}

/** The extension was reloaded or updated under us: hand the page back and let a fresh injection claim it. */
function retire(session: Session): void {
  session.running = false;
  syncLoopCapture(false);
  session.controller.stop();
  session.overlay.destroy();
  (globalThis as unknown as Record<string, unknown>)[LOADED_FLAG] = false;
}

if (claimPage()) {
  // A reloaded extension invalidates chrome.* in old content scripts; failing quietly beats breaking the page.
  boot().catch((error: unknown) => console.debug("[ghost] content script did not start", error));
}
