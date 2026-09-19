// Masthead pill: is the prediction server up, and which decision provider is it running?
import { onStorageChanged } from "../lib/storage";
import { h } from "./dom";
import { fetchHealth } from "./server";
import type { Health, ServerDeps } from "./server";

export const OFFLINE_LABEL = "offline: using built-in heuristic";
const POLL_MS = 10_000;

export function healthLabel(health: Health): string {
  return `${health.provider} · ${health.calibrated ? "calibrated" : "not calibrated"}`;
}

function healthTitle(health: Health): string {
  const model = health.model ? `, model ${health.model}` : "";
  return `Decision provider ${health.provider}${model}; free text from ${health.textProvider}.`;
}

export function mountStatusPill(host: HTMLElement, deps: ServerDeps & { pollMs?: number } = {}): () => void {
  const label = h("span", { "data-testid": "server-status-label" }, "checking…");
  const pill = h("span", { class: "pill", role: "status", "data-state": "checking", "data-testid": "server-status" }, h("span", { class: "pill-dot", "aria-hidden": "true" }), label);
  host.replaceChildren(pill);

  const check = async (): Promise<void> => {
    try {
      const health = await fetchHealth(deps);
      pill.dataset.state = "online";
      pill.title = healthTitle(health);
      label.textContent = healthLabel(health);
    } catch (err) {
      pill.dataset.state = "offline";
      pill.title = err instanceof Error ? err.message : "";
      label.textContent = OFFLINE_LABEL;
    }
  };

  const checkIfVisible = (): void => {
    if (!document.hidden) void check();
  };
  const timer = setInterval(checkIfVisible, deps.pollMs ?? POLL_MS);
  document.addEventListener("visibilitychange", checkIfVisible);
  // A new server URL in Settings should show up here right away.
  const unwatch = onStorageChanged((changes) => {
    if (changes.settings) void check();
  });
  void check();
  return () => {
    clearInterval(timer);
    unwatch();
    document.removeEventListener("visibilitychange", checkIfVisible);
  };
}
