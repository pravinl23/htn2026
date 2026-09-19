import { errorMessage, h } from "./dom";
import { readLocal, watchLocal } from "./local-store";
import { METRICS_KEY, buildMetricsView, formatCount, formatMs, formatPercent, normalizeLocalMetrics, normalizeServerMetrics } from "./metrics-math";
import type { LatencyRow, LocalMetrics, MetricsView, ServerMetrics } from "./metrics-math";
import { renderBucketTable, renderReliabilityChart } from "./reliability-chart";
import type { OptionsSection } from "./sections";
import { SECTION_SHOWN } from "./sections";
import { fetchMetrics } from "./server";
import type { ServerDeps } from "./server";

export interface MetricsDeps extends ServerDeps {
  refreshMs?: number;
}

const REFRESH_MS = 5000;

function tile(label: string, value: string, detail: string, testId: string): HTMLElement {
  return h("div", { class: "tile", "data-testid": testId }, h("span", { class: "tile-label" }, label), h("strong", { class: "tile-value" }, value), h("small", {}, detail));
}

function renderTiles(host: HTMLElement, view: MetricsView): void {
  const c = view.counters;
  const shown = c.ghostsShown > 0 ? `${formatCount(c.ghostsAccepted)} of ${formatCount(c.ghostsShown)} ghosts` : "No ghosts shown yet";
  const cache = view.cacheHitRate === null ? "No cacheable calls yet" : `${formatCount(view.cache.hits)} hits, ${formatCount(view.cache.misses)} misses`;
  host.replaceChildren(
    tile("Acceptance rate", formatPercent(view.acceptanceRate), shown, "metric-acceptance"),
    tile("Keystrokes saved", formatCount(c.keystrokesSaved), "Characters Ghost typed for you", "metric-keystrokes"),
    tile("Clicks saved", formatCount(c.clicksSaved), "Selects, checkboxes and buttons", "metric-clicks"),
    tile("Cache hit rate", formatPercent(view.cacheHitRate), cache, "metric-cache"),
  );
}

function latencyCells(row: LatencyRow): HTMLElement[] {
  const num = (value: string): HTMLElement => h("td", { class: "num" }, value);
  return [h("td", { class: "mono" }, row.route), h("td", {}, row.provider), num(formatCount(row.count)), num(formatCount(row.failures)), num(formatMs(row.p50)), num(formatMs(row.p95)), num(formatMs(row.last))];
}

function renderLatency(host: HTMLElement, view: MetricsView, serverError: string | null): void {
  if (serverError) return host.replaceChildren(h("p", { class: "empty", "data-testid": "latency-empty" }, serverError));
  if (view.latency.length === 0) {
    return host.replaceChildren(h("p", { class: "empty", "data-testid": "latency-empty" }, "No prediction calls yet. Open a form on the demo pages and the latency log fills in."));
  }
  const head = h("tr", {}, ...["Route", "Provider", "Calls", "Failed", "p50", "p95", "Last"].map((t, i) => h("th", { scope: "col", class: i > 1 ? "num" : undefined }, t)));
  const body = view.latency.map((row) => h("tr", {}, ...latencyCells(row)));
  host.replaceChildren(h("div", { class: "table-scroll" }, h("table", { class: "data", "data-testid": "latency-table" }, h("thead", {}, head), h("tbody", {}, ...body))));
}

function chartSummary(view: MetricsView): string {
  const ghosts = `${formatCount(view.calibrationPairs)} ghost${view.calibrationPairs === 1 ? "" : "s"}`;
  return `${ghosts} · calibration error ${formatPercent(view.calibrationError)} (0% is perfect)`;
}

/** Skipped when the buckets did not change, so a 5 s refresh never closes the table or drops keyboard focus. */
function renderReliability(host: HTMLElement, view: MetricsView): void {
  const signature = JSON.stringify(view.buckets.map((b) => [b.count, b.accepted, b.meanConfidence]));
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  if (view.calibrationPairs === 0) {
    return host.replaceChildren(h("p", { class: "empty", "data-testid": "reliability-empty" }, "No calibration data yet. Accept or dismiss a few ghosts and the chart fills in."));
  }
  const summary = chartSummary(view);
  const readout = h("p", { class: "chart-readout", role: "status", "data-testid": "reliability-readout" }, summary);
  const chart = renderReliabilityChart(view.buckets, (label) => {
    readout.textContent = label ?? summary;
  });
  const legend = h("p", { class: "chart-legend muted" }, h("span", { class: "key key-dot" }), "Observed, per confidence bucket", h("span", { class: "key key-line" }), "Perfect calibration");
  const table = h("details", {}, h("summary", {}, "Show as a table"), renderBucketTable(view.buckets));
  host.replaceChildren(h("div", { class: "chart-wrap" }, chart), legend, readout, table);
}

function isShown(panel: HTMLElement): boolean {
  return !panel.hidden && !document.hidden;
}

/** Mounts the tab and returns a stop function (tests and teardown). Never awaits the network. */
export function mountMetrics(panel: HTMLElement, deps: MetricsDeps = {}): () => void {
  const tiles = h("div", { class: "tiles" });
  const latency = h("div", {});
  const reliability = h("div", {});
  const updated = h("span", { class: "muted small", role: "status", "data-testid": "metrics-updated" });
  const refreshButton = h("button", { type: "button", "data-testid": "metrics-refresh" }, "Refresh");
  let local: LocalMetrics | null = null;
  let server: ServerMetrics | null = null;
  let serverError: string | null = null;
  let stopped = false;

  const render = (): void => {
    const view = buildMetricsView(local, server);
    renderTiles(tiles, view);
    renderLatency(latency, view, serverError);
    renderReliability(reliability, view);
  };

  const refresh = async (): Promise<void> => {
    const [localRaw, serverRaw] = await Promise.allSettled([readLocal(METRICS_KEY), fetchMetrics(deps)]);
    if (stopped) return;
    if (localRaw.status === "fulfilled") local = normalizeLocalMetrics(localRaw.value);
    server = serverRaw.status === "fulfilled" ? normalizeServerMetrics(serverRaw.value) : null;
    serverError = serverRaw.status === "rejected" ? errorMessage(serverRaw.reason) : null;
    updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    render();
    panel.dataset.loaded = "true";
  };

  const refreshIfShown = (): void => {
    if (isShown(panel)) void refresh();
  };
  const timer = setInterval(refreshIfShown, deps.refreshMs ?? REFRESH_MS);
  const unwatch = watchLocal(METRICS_KEY, (value) => {
    local = normalizeLocalMetrics(value);
    render();
  });
  refreshButton.addEventListener("click", () => void refresh());
  panel.addEventListener(SECTION_SHOWN, refreshIfShown);
  document.addEventListener("visibilitychange", refreshIfShown);

  panel.append(
    h("div", { class: "row" }, h("h2", {}, "Metrics"), h("span", { class: "spacer" }), updated, refreshButton),
    h("p", { class: "muted" }, "Counts only: no field values or profile values are ever recorded. Refreshes every 5 seconds while this tab is open."),
    tiles,
    h("h3", {}, "Latency by route and provider"),
    latency,
    h("h3", {}, "Reliability"),
    h("p", { class: "muted" }, "When Ghost says 80%, is it accepted 80% of the time? Dots on the diagonal mean the confidence can be trusted."),
    reliability,
  );
  render();
  void refresh();

  return () => {
    stopped = true;
    clearInterval(timer);
    unwatch();
    document.removeEventListener("visibilitychange", refreshIfShown);
  };
}

export const metricsSection: OptionsSection = { id: "metrics", title: "Metrics", mount: (panel) => void mountMetrics(panel) };
