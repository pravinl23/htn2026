// Reliability diagram as inline SVG: predicted confidence (x) against observed acceptance (y), one dot
// per non-empty bucket, with the diagonal a perfectly calibrated predictor would sit on.
import { h, svg } from "./dom";
import { formatPercent } from "./metrics-math";
import type { ReliabilityBucket } from "./metrics-math";

export interface Plot {
  left: number;
  top: number;
  size: number;
}

// Left margin holds the rotated axis title and the tick labels side by side.
export const PLOT: Plot = { left: 64, top: 12, size: 260 };
const VIEW = { width: 344, height: 316 };
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const DOT_RADIUS = 5;
const HIT_RADIUS = 14;

export interface ChartPoint {
  x: number;
  y: number;
  bucket: ReliabilityBucket;
  label: string;
}

const px = (plot: Plot, value: number): number => plot.left + value * plot.size;
const py = (plot: Plot, value: number): number => plot.top + (1 - value) * plot.size;
const round = (n: number): number => Math.round(n * 10) / 10;

export function describeBucket(b: ReliabilityBucket): string {
  const range = `${Math.round(b.min * 100)}–${Math.round(b.max * 100)}% confidence`;
  return `${range}: predicted ${formatPercent(b.meanConfidence)}, accepted ${formatPercent(b.acceptanceRate)} (${b.accepted} of ${b.count})`;
}

/** Buckets with no observations have no observed rate, so they get no point. */
export function chartPoints(buckets: ReliabilityBucket[], plot: Plot = PLOT): ChartPoint[] {
  return buckets
    .filter((b) => b.count > 0)
    .map((b) => ({ x: round(px(plot, b.meanConfidence)), y: round(py(plot, b.acceptanceRate)), bucket: b, label: describeBucket(b) }));
}

function axes(plot: Plot): SVGElement[] {
  const out: SVGElement[] = [];
  for (const t of TICKS) {
    out.push(svg("line", { class: "grid", x1: px(plot, 0), x2: px(plot, 1), y1: py(plot, t), y2: py(plot, t) }));
    out.push(svg("line", { class: "grid", x1: px(plot, t), x2: px(plot, t), y1: py(plot, 0), y2: py(plot, 1) }));
    out.push(svg("text", { class: "tick", x: px(plot, 0) - 8, y: py(plot, t) + 4, "text-anchor": "end" }, `${t * 100}%`));
    out.push(svg("text", { class: "tick", x: px(plot, t), y: py(plot, 0) + 18, "text-anchor": "middle" }, `${t * 100}%`));
  }
  out.push(svg("text", { class: "axis-title", x: px(plot, 0.5), y: py(plot, 0) + 38, "text-anchor": "middle" }, "Predicted confidence"));
  out.push(svg("text", { class: "axis-title", x: 12, y: py(plot, 0.5), "text-anchor": "middle", transform: `rotate(-90 12 ${py(plot, 0.5)})` }, "Observed acceptance"));
  out.push(svg("text", { class: "zone", x: px(plot, 0) + 8, y: py(plot, 1) + 16 }, "under-confident"));
  out.push(svg("text", { class: "zone", x: px(plot, 1) - 8, y: py(plot, 0) - 8, "text-anchor": "end" }, "over-confident"));
  return out;
}

function pointMark(point: ChartPoint, onFocus: (label: string | null) => void): SVGGElement {
  const group = svg("g", { class: "point", tabindex: 0, role: "img", "aria-label": point.label },
    svg("title", {}, point.label),
    svg("circle", { class: "hit", cx: point.x, cy: point.y, r: HIT_RADIUS }),
    svg("circle", { class: "dot", cx: point.x, cy: point.y, r: DOT_RADIUS }),
  );
  for (const type of ["pointerenter", "focus"]) group.addEventListener(type, () => onFocus(point.label));
  for (const type of ["pointerleave", "blur"]) group.addEventListener(type, () => onFocus(null));
  return group;
}

export function renderReliabilityChart(buckets: ReliabilityBucket[], onFocus: (label: string | null) => void = () => undefined): SVGSVGElement {
  const points = chartPoints(buckets);
  const root = svg("svg", { class: "reliability", viewBox: `0 0 ${VIEW.width} ${VIEW.height}`, role: "group", "aria-label": "Reliability chart: predicted confidence against observed acceptance rate", "data-testid": "reliability-chart" });
  root.append(...axes(PLOT));
  root.append(svg("line", { class: "diagonal", x1: px(PLOT, 0), y1: py(PLOT, 0), x2: px(PLOT, 1), y2: py(PLOT, 1) }));
  if (points.length > 1) root.append(svg("polyline", { class: "series", points: points.map((p) => `${p.x},${p.y}`).join(" ") }));
  root.append(...points.map((p) => pointMark(p, onFocus)));
  return root;
}

function cell(value: string, numeric = true): HTMLTableCellElement {
  return h("td", numeric ? { class: "num" } : {}, value);
}

/** The same data without the picture (screen readers, and anyone who wants the counts). */
export function renderBucketTable(buckets: ReliabilityBucket[]): HTMLTableElement {
  const head = h("tr", {}, ...["Confidence", "Ghosts", "Predicted", "Accepted"].map((t, i) => h("th", { scope: "col", class: i === 0 ? undefined : "num" }, t)));
  const rows = buckets.map((b) => {
    const empty = b.count === 0;
    const range = `${Math.round(b.min * 100)}–${Math.round(b.max * 100)}%`;
    return h("tr", {}, cell(range, false), cell(String(b.count)), cell(empty ? "–" : formatPercent(b.meanConfidence)), cell(empty ? "–" : formatPercent(b.acceptanceRate)));
  });
  return h("table", { class: "data", "data-testid": "reliability-table" }, h("thead", {}, head), h("tbody", {}, ...rows));
}
