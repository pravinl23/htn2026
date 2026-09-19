// The "You did this twice" bottom sheet (docs/loops.md 3.4): preview grid, execution mode, the ONE batch
// confirmation, then run progress and the final report. Lives in its own closed shadow host; every string that
// came from a page is written with textContent.
import { describeIrreversible } from "@ghost/shared";
import type { LoopProgram } from "@ghost/shared";
import type { LoopItemStatus, LoopMode, LoopRunProgress } from "../lib/loopMessages";
import { loopVariables } from "./dryRun";
import type { DryRunRow, LoopVariable } from "./dryRun";
import { LOOP_HOST_CSS, LOOP_PANEL_CSS, PADLOCK } from "./loopPanelStyle";

export type LoopPanelState = "hidden" | "proposed" | "running" | "done" | "failed";

export interface LoopModeOption {
  mode: LoopMode;
  available: boolean;
  /** Why the mode cannot be used, shown under its label (for example "Add BROWSERBASE_API_KEY"). */
  reason?: string;
}

export interface LoopPanelProposal {
  program: LoopProgram;
  /** List indexes still to do, in list order (LoopProposal.remaining). */
  remaining: readonly number[];
  /** The item's key text in the list (page content: rendered with textContent). */
  itemLabel?(index: number): string;
  /** Dry-run results, streamed in as they finish (previewItems). Without it rows are shown unverified. */
  rows?: AsyncIterable<DryRunRow>;
  /** Rows that are already known, for example when the sheet is rebuilt after a page load. */
  initialRows?: readonly DryRunRow[];
  /** Stops the dry run. Called when the sheet closes or a run starts. */
  abortPreview?(): void;
  /** Overrides per mode. Modes left out: Visible and Background available, Parallel and API unavailable. */
  modes?: readonly LoopModeOption[];
  /** Default: Background for more than 10 items, otherwise Visible. */
  defaultMode?: LoopMode;
}

export interface LoopRunRequest {
  /** Checked list indexes, in list order: what "ghost:loop-start" carries. */
  items: number[];
  mode: LoopMode;
  /** The dry-run rows of those items. */
  rows: DryRunRow[];
}

export interface LoopPanelDeps {
  /** Fired only by an explicit Enter or click on the confirm button. */
  onConfirm(run: LoopRunRequest): void;
  /** "Not now" or Esc on the proposal. */
  onDismiss(): void;
  /** Cancel or Esc during a run. The sheet stays up until the caller reports the final state with update(). */
  onCancel(): void;
  /** The final report was closed. */
  onClose?(): void;
  /** Defaults to `event.isTrusted`: a page must not be able to script the confirmation. Tests override it. */
  isUserEvent?(event: Event): boolean;
}

/** LoopRunProgress as broadcast by the worker; only the state and the item statuses are required. */
export type LoopPanelProgress = Pick<LoopRunProgress, "state" | "items"> & Partial<Pick<LoopRunProgress, "irreversibleDone">>;

interface RowView {
  index: number;
  label: string;
  tr: HTMLTableRowElement;
  check: HTMLInputElement;
  status: HTMLSpanElement;
  cells: Map<string, HTMLTableCellElement>;
  note: HTMLTableCellElement;
  result: DryRunRow | null;
  included: boolean;
  run: LoopItemStatus;
  error: string;
}

interface Session {
  proposal: LoopPanelProposal;
  deps: LoopPanelDeps;
  vars: LoopVariable[];
  rows: Map<number, RowView>;
  modes: LoopModeOption[];
  mode: LoopMode | null;
  state: Exclude<LoopPanelState, "hidden">;
  streaming: boolean;
  cancelled: boolean;
  cancelRequested: boolean;
  irreversibleDone: number | undefined;
  /** Tab was pressed while the confirm button was still disabled: focus it as soon as it can take focus. */
  focusWhenReady: boolean;
}

interface Parts {
  host: HTMLDivElement;
  shadow: ShadowRoot;
  sheet: HTMLElement;
  headline: HTMLHeadingElement;
  name: HTMLParagraphElement;
  previewNote: HTMLSpanElement;
  fill: HTMLDivElement;
  progressText: HTMLSpanElement;
  summary: HTMLParagraphElement;
  failures: HTMLUListElement;
  gridWrap: HTMLDivElement;
  headRow: HTMLTableRowElement;
  body: HTMLTableSectionElement;
  selectAll: HTMLInputElement;
  modes: HTMLDivElement;
  effects: HTMLDivElement;
  effectsTitle: HTMLSpanElement;
  effectsList: HTMLUListElement;
  later: HTMLButtonElement;
  cancel: HTMLButtonElement;
  close: HTMLButtonElement;
  confirm: HTMLButtonElement;
  confirmLabel: HTMLSpanElement;
}

const HOST_ID = "ghost-loop-host";
const SVG_NS = "http://www.w3.org/2000/svg";
const ALL_MODES: readonly LoopMode[] = ["visible", "background", "parallel", "api"];
const MODE_LABELS: Record<LoopMode, string> = {
  visible: "Visible", background: "Background", parallel: "Parallel (Browserbase)", api: "API (Composio)",
};
const MODE_DEFAULTS: Record<LoopMode, LoopModeOption> = {
  visible: { mode: "visible", available: true },
  background: { mode: "background", available: true },
  parallel: { mode: "parallel", available: false, reason: "Needs a Browserbase key" },
  api: { mode: "api", available: false, reason: "Needs a Composio key" },
};
/** The worker reports short codes, never page content; anything unknown is shown as the code itself. */
const ERROR_TEXT: Record<string, string> = {
  "target-missing": "the target was not on the page",
  "value-mismatch": "the value did not stick",
  "row-mismatch": "the row was not appended",
  "locked-unconfirmed": "a locked step was not confirmed",
  "navigation-failed": "the page did not open",
  timeout: "the page took too long",
};
const BACKGROUND_ABOVE = 10;

export class LoopPanel {
  private readonly doc: Document;
  private parts: Parts | null = null;
  private session: Session | null = null;
  private listening = false;

  constructor(doc: Document = document) {
    this.doc = doc;
  }

  /** The element carrying the `data-loop-*` test hooks. Null until the first show(). */
  get host(): HTMLElement | null {
    return this.parts?.host ?? null;
  }

  /** Closed to the page; this getter only exists in the isolated world (our own code and unit tests). */
  get shadow(): ShadowRoot | null {
    return this.parts?.shadow ?? null;
  }

  get state(): LoopPanelState {
    return this.session?.state ?? "hidden";
  }

  show(proposal: LoopPanelProposal, deps: LoopPanelDeps): void {
    this.endSession();
    const parts = this.mount();
    const session = newSession(proposal, deps);
    this.session = session;
    buildGrid(this.doc, parts, session, () => this.paint());
    buildModes(this.doc, parts, session, (mode) => this.pickMode(mode));
    for (const row of proposal.initialRows ?? []) applyRow(session, row);
    parts.gridWrap.scrollTop = 0;
    this.listen(true);
    this.paint();
    void this.consume(session);
  }

  /** Run progress from the worker. The first call switches the sheet to the run view, also after a page load (show() first). */
  update(progress: LoopPanelProgress): void {
    const s = this.session;
    if (!s || !this.parts) return;
    if (s.state === "proposed") beginRun(s, new Set(progress.items.map((item) => item.index)));
    for (const item of progress.items) setRunStatus(s.rows.get(item.index), item.status, item.error ?? "");
    s.state = progress.state === "running" ? "running" : progress.state === "done" ? "done" : "failed";
    s.cancelled = progress.state === "cancelled";
    s.irreversibleDone = progress.irreversibleDone;
    this.paint();
    scrollToRunning(this.parts, s);
  }

  /** Closes the sheet without calling back. The host stays, with data-loop-state="hidden". */
  hide(): void {
    this.endSession();
    if (this.parts) paintHidden(this.parts);
  }

  destroy(): void {
    this.endSession();
    this.parts?.host.remove();
    this.parts = null;
  }

  // ---------- session ----------

  private endSession(): void {
    const s = this.session;
    this.session = null;
    this.listen(false);
    s?.proposal.abortPreview?.();
    const parts = this.parts;
    if (parts && this.doc.activeElement === parts.host) (parts.shadow.activeElement as HTMLElement | null)?.blur();
  }

  private async consume(s: Session): Promise<void> {
    try {
      for await (const row of s.proposal.rows ?? []) {
        if (this.session !== s || s.state !== "proposed") break;
        applyRow(s, row);
        this.paint();
      }
    } catch {
      // A preview that breaks leaves the rows it never reached flagged, which is what they are.
    }
    if (this.session !== s || s.state !== "proposed") return;
    s.streaming = false;
    for (const row of s.rows.values()) if (!row.result) applyRow(s, unverified(row.index, s));
    this.paint();
  }

  private pickMode(mode: LoopMode): void {
    const s = this.session;
    if (!s || s.state !== "proposed" || !s.modes.some((m) => m.mode === mode && m.available)) return;
    s.mode = mode;
    this.paint();
  }

  // ---------- user actions ----------

  private confirmRun(event: Event): void {
    const s = this.session;
    const parts = this.parts;
    if (!s || !parts || s.state !== "proposed" || parts.confirm.disabled || s.mode === null || !isUser(s, event)) return;
    const rows = checkedRows(s);
    if (rows.length === 0) return;
    beginRun(s, new Set(rows.map((r) => r.index)));
    s.state = "running";
    this.paint();
    s.deps.onConfirm({ items: rows.map((r) => r.index), mode: s.mode, rows: rows.flatMap((r) => (r.result ? [r.result] : [])) });
  }

  private dismiss(): void {
    const deps = this.session?.deps;
    this.hide();
    deps?.onDismiss();
  }

  private cancel(): void {
    const s = this.session;
    if (!s || s.state !== "running" || s.cancelRequested) return;
    s.cancelRequested = true;
    this.paint();
    s.deps.onCancel();
  }

  private closeReport(): void {
    const deps = this.session?.deps;
    this.hide();
    deps?.onClose?.();
  }

  // ---------- keyboard ----------

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const s = this.session;
    const parts = this.parts;
    if (!s || !parts || event.isComposing || !isUser(s, event)) return;
    if (event.key === "Escape") this.onEscape(event, s);
    else if (event.key === "Tab" && s.state === "proposed") this.onTab(event, s, parts);
  };

  private onEscape(event: KeyboardEvent, s: Session): void {
    event.preventDefault();
    event.stopPropagation();
    if (s.state === "proposed") this.dismiss();
    else if (s.state === "running") this.cancel();
    else this.closeReport();
  }

  /** Tab only ever moves focus onto the locked confirm button. Starting the run takes an explicit Enter or click on it. */
  private onTab(event: KeyboardEvent, s: Session, parts: Parts): void {
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (this.doc.activeElement === parts.host) return; // already inside the sheet: native order through its controls
    event.preventDefault();
    event.stopPropagation();
    s.focusWhenReady = parts.confirm.disabled;
    (parts.confirm.disabled ? parts.sheet : parts.confirm).focus({ preventScroll: true });
  }

  private listen(on: boolean): void {
    const view = this.doc.defaultView;
    if (!view || this.listening === on) return;
    this.listening = on;
    if (on) view.addEventListener("keydown", this.onKeyDown, { capture: true });
    else view.removeEventListener("keydown", this.onKeyDown, { capture: true });
  }

  // ---------- mount + paint ----------

  /** Lazy, so a page that drops our host gets it back on the next show(). */
  private mount(): Parts {
    if (!this.parts) {
      this.doc.getElementById(HOST_ID)?.remove();
      this.parts = buildParts(this.doc);
      this.bind(this.parts);
    }
    const root = this.doc.documentElement;
    if (this.parts.host.parentNode !== root) root.appendChild(this.parts.host);
    return this.parts;
  }

  private bind(parts: Parts): void {
    parts.confirm.addEventListener("click", (event) => this.confirmRun(event));
    // Handled here rather than through the button's synthesized click, so a held key (repeat) can never confirm.
    parts.confirm.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) this.confirmRun(event);
    });
    parts.later.addEventListener("click", () => this.dismiss());
    parts.cancel.addEventListener("click", () => this.cancel());
    parts.close.addEventListener("click", () => this.closeReport());
    parts.selectAll.addEventListener("change", () => this.toggleAll(parts.selectAll.checked));
  }

  private toggleAll(checked: boolean): void {
    const s = this.session;
    if (!s || s.state !== "proposed") return;
    for (const row of s.rows.values()) if (!row.check.disabled) row.check.checked = checked;
    this.paint();
  }

  private paint(): void {
    const s = this.session;
    const parts = this.parts;
    if (!s || !parts) return;
    const counts = countRows(s);
    paintHeader(parts, s, counts);
    paintProgress(parts, s, counts);
    paintReport(parts, s, counts);
    paintFooter(parts, s, counts);
    paintHost(parts, s, counts);
    if (s.focusWhenReady && !parts.confirm.disabled && parts.shadow.activeElement === parts.sheet) {
      s.focusWhenReady = false;
      parts.confirm.focus({ preventScroll: true });
    }
  }
}

// ---------- session model ----------

function newSession(proposal: LoopPanelProposal, deps: LoopPanelDeps): Session {
  const modes = ALL_MODES.map((mode) => proposal.modes?.find((m) => m.mode === mode) ?? MODE_DEFAULTS[mode]);
  return {
    proposal, deps, modes,
    vars: loopVariables(proposal.program),
    rows: new Map(),
    mode: defaultMode(proposal, modes),
    state: "proposed",
    streaming: proposal.rows !== undefined,
    cancelled: false,
    cancelRequested: false,
    irreversibleDone: undefined,
    focusWhenReady: false,
  };
}

function defaultMode(proposal: LoopPanelProposal, modes: LoopModeOption[]): LoopMode | null {
  const usable = (mode: LoopMode | undefined): boolean => modes.some((m) => m.mode === mode && m.available);
  if (usable(proposal.defaultMode)) return proposal.defaultMode ?? null;
  const preferred: LoopMode = proposal.remaining.length > BACKGROUND_ABOVE ? "background" : "visible";
  if (usable(preferred)) return preferred;
  return modes.find((m) => m.available)?.mode ?? null;
}

function isUser(s: Session, event: Event): boolean {
  return s.deps.isUserEvent ? s.deps.isUserEvent(event) : event.isTrusted;
}

/** No dry run reached this row: with values to copy it is a guess (flagged), with none there is nothing to verify. */
function unverified(index: number, s: Session): DryRunRow {
  return { index, url: "", vars: {}, confidence: s.vars.length > 0 ? 0.6 : 1, missing: [] };
}

function checkedRows(s: Session): RowView[] {
  return [...s.rows.values()].filter((r) => r.result !== null && r.result.confidence > 0 && r.check.checked);
}

interface Counts {
  remaining: number;
  previewed: number;
  checked: number;
  total: number;
  done: number;
  failed: number;
}

function countRows(s: Session): Counts {
  const rows = [...s.rows.values()];
  const included = rows.filter((r) => r.included);
  return {
    remaining: rows.length,
    previewed: rows.filter((r) => r.result !== null).length,
    checked: checkedRows(s).length,
    total: included.length,
    done: included.filter((r) => r.run === "done").length,
    failed: included.filter((r) => r.run === "failed").length,
  };
}

function beginRun(s: Session, included: Set<number>): void {
  s.proposal.abortPreview?.();
  s.streaming = false;
  for (const row of s.rows.values()) {
    row.included = included.has(row.index);
    row.tr.dataset.included = String(row.included);
    setRunStatus(row, row.included ? "pending" : "skipped", "");
  }
}

function setRunStatus(row: RowView | undefined, status: LoopItemStatus, error: string): void {
  if (!row || (!row.included && status !== "skipped")) return;
  row.run = status;
  row.error = error;
  row.tr.dataset.status = status;
  row.status.dataset.status = status;
  row.status.setAttribute("aria-label", status);
}

/** Fills one grid row from its dry-run result: values, the amber flag, and whether it starts checked. */
function applyRow(s: Session, result: DryRunRow): void {
  const row = s.rows.get(result.index);
  if (!row) return;
  row.result = result;
  for (const v of s.vars) paintValue(row.cells.get(v.var), result.vars[v.var], result.missing.includes(v.var));
  const flag = result.confidence === 1 ? "" : result.confidence === 0 ? "missing" : "low";
  row.tr.dataset.flag = flag;
  row.tr.dataset.confidence = String(result.confidence);
  row.check.checked = result.confidence === 1;
  row.check.disabled = result.confidence === 0; // nothing verifiable to run: the user handles this one by hand
  setText(row.note, noteFor(s, result));
}

function paintValue(cell: HTMLTableCellElement | undefined, value: string | undefined, missing: boolean): void {
  if (!cell) return;
  delete cell.dataset.pending;
  if (value === undefined && missing) cell.dataset.missing = "true";
  else delete cell.dataset.missing;
  setText(cell, value ?? (missing ? "missing" : "\u2014"));
  cell.title = value ?? "";
}

function noteFor(s: Session, result: DryRunRow): string {
  if (result.confidence === 1) return "";
  if (result.missing.length > 0) {
    const headers = result.missing.map((name) => s.vars.find((v) => v.var === name)?.header ?? name);
    return `Missing: ${headers.join(", ")}`;
  }
  if (result.confidence === 0) return "Could not preview";
  return result.url === "" ? "Not previewed" : "Check values";
}

function errorText(code: string): string {
  return ERROR_TEXT[code] ?? code;
}

// ---------- painting ----------

function plural(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

function headlineFor(s: Session, c: Counts): string {
  if (s.state === "proposed") return `You did this twice. Ghost can do the remaining ${c.remaining}.`;
  if (s.state === "running") return s.cancelRequested ? "Cancelling the run" : `Ghost is running ${plural(c.total)}`;
  if (s.state === "done") return `Done. Ghost finished ${plural(c.done)}.`;
  return s.cancelled ? "Run cancelled" : "Ghost stopped the run";
}

function paintHeader(parts: Parts, s: Session, c: Counts): void {
  setText(parts.headline, headlineFor(s, c));
  setText(parts.name, s.proposal.program.name);
  parts.name.title = s.proposal.program.name;
  parts.previewNote.dataset.streaming = String(s.streaming);
  setText(parts.previewNote, s.streaming ? `Previewing ${c.previewed} of ${c.remaining}` : `${c.checked} of ${c.remaining} selected`);
}

function paintProgress(parts: Parts, s: Session, c: Counts): void {
  const settled = c.done + c.failed;
  const percent = c.total === 0 ? 0 : Math.round((settled / c.total) * 100);
  parts.fill.style.width = `${s.state === "done" ? 100 : percent}%`;
  setText(parts.progressText, `${c.done} / ${c.total}`);
}

function summaryFor(s: Session, c: Counts): string {
  const notRun = c.total - c.done - c.failed;
  const bits = [`${c.done} of ${c.total} done`];
  if (c.failed > 0) bits.push(`${c.failed} failed`);
  if (notRun > 0) bits.push(`${notRun} not run`);
  return `${bits.join(", ")}.`;
}

function paintReport(parts: Parts, s: Session, c: Counts): void {
  if (s.state !== "done" && s.state !== "failed") return;
  setText(parts.summary, summaryFor(s, c));
  const failed = [...s.rows.values()].filter((r) => r.included && r.run === "failed");
  const lines = failed.map((r) => `${r.label} failed: ${errorText(r.error || "unknown")}`);
  syncList(parts.failures, lines);
}

function effectLines(s: Session, c: Counts): string[] {
  if (s.state === "proposed") return describeIrreversible(s.proposal.program, c.checked);
  const single = s.proposal.program.irreversible.length === 1 && s.irreversibleDone !== undefined;
  return describeIrreversible(s.proposal.program, single ? s.irreversibleDone ?? 0 : c.done);
}

function paintFooter(parts: Parts, s: Session, c: Counts): void {
  const lines = effectLines(s, c);
  parts.effects.hidden = lines.length === 0;
  setText(parts.effectsTitle, s.state === "proposed" ? "Irreversible, runs after you confirm" : "Irreversible actions performed");
  syncList(parts.effectsList, lines);
  setText(parts.confirmLabel, `Run ${plural(c.checked)}`);
  parts.confirm.disabled = s.state !== "proposed" || s.streaming || c.checked === 0 || s.mode === null;
  parts.cancel.disabled = s.cancelRequested;
  setText(parts.cancel, s.cancelRequested ? "Cancelling" : "Cancel");
  paintSelectAll(parts.selectAll, s);
  for (const button of parts.modes.querySelectorAll<HTMLButtonElement>(".mode")) {
    button.setAttribute("aria-checked", String(button.dataset.mode === s.mode));
  }
}

function paintSelectAll(box: HTMLInputElement, s: Session): void {
  const usable = [...s.rows.values()].filter((r) => !r.check.disabled && r.result !== null);
  const on = usable.filter((r) => r.check.checked).length;
  box.disabled = usable.length === 0;
  box.checked = usable.length > 0 && on === usable.length;
  box.indeterminate = on > 0 && on < usable.length;
}

function paintHost(parts: Parts, s: Session, c: Counts): void {
  parts.sheet.dataset.open = "true";
  parts.sheet.dataset.view = s.state;
  const attrs: Record<string, string> = {
    "data-loop-state": s.state,
    "data-loop-remaining": String(c.remaining),
    "data-loop-checked": String(c.checked),
    "data-loop-progress": `${c.done}/${s.state === "proposed" ? c.checked : c.total}`,
    "data-loop-preview": s.streaming ? "streaming" : "ready",
    "data-loop-previewed": String(c.previewed),
    "data-loop-mode": s.mode ?? "",
    "data-loop-cancelled": String(s.cancelled),
  };
  for (const [name, value] of Object.entries(attrs)) setAttr(parts.host, name, value);
}

function paintHidden(parts: Parts): void {
  parts.sheet.dataset.open = "false";
  setAttr(parts.host, "data-loop-state", "hidden");
}

function scrollToRunning(parts: Parts, s: Session): void {
  const row = [...s.rows.values()].find((r) => r.run === "running");
  if (!row) return;
  // Only the grid's own scroll box moves: scrollIntoView could scroll the page under the user.
  parts.gridWrap.scrollTop = Math.max(0, row.tr.offsetTop - parts.gridWrap.clientHeight / 2);
}

// ---------- building ----------

function buildGrid(doc: Document, parts: Parts, s: Session, onChange: () => void): void {
  parts.headRow.replaceChildren(parts.selectAll.parentElement ?? make(doc, "th", "pick"), make(doc, "th", "num", "#"), make(doc, "th", "item", "Item"));
  for (const v of s.vars) parts.headRow.appendChild(make(doc, "th", "val", v.header));
  parts.headRow.appendChild(make(doc, "th", "note"));
  parts.body.replaceChildren();
  for (const index of s.proposal.remaining) {
    if (s.rows.has(index)) continue;
    const row = buildRow(doc, s, index, onChange);
    s.rows.set(index, row);
    parts.body.appendChild(row.tr);
  }
}

function buildRow(doc: Document, s: Session, index: number, onChange: () => void): RowView {
  const label = (s.proposal.itemLabel?.(index) ?? "").trim() || `Item ${index + 1}`;
  const tr = make(doc, "tr");
  tr.dataset.index = String(index);
  const check = make(doc, "input");
  check.type = "checkbox";
  check.disabled = true; // until its preview arrives
  check.setAttribute("aria-label", `Include ${label}`);
  check.addEventListener("change", onChange);
  const status = make(doc, "span", "status");
  const pick = make(doc, "td", "pick");
  pick.append(check, status);
  const item = make(doc, "td", "item", label);
  item.title = label;
  tr.append(pick, make(doc, "td", "num", String(index + 1)), item);
  const cells = new Map<string, HTMLTableCellElement>();
  for (const v of s.vars) {
    const cell = make(doc, "td", "val");
    cell.dataset.pending = "true";
    cell.dataset.var = v.var;
    cells.set(v.var, cell);
    tr.appendChild(cell);
  }
  const note = make(doc, "td", "note");
  tr.appendChild(note);
  return { index, label, tr, check, status, cells, note, result: null, included: true, run: "pending", error: "" };
}

function buildModes(doc: Document, parts: Parts, s: Session, onPick: (mode: LoopMode) => void): void {
  parts.modes.replaceChildren();
  for (const option of s.modes) {
    const button = make(doc, "button", "mode");
    button.type = "button";
    button.dataset.mode = option.mode;
    button.disabled = !option.available;
    button.setAttribute("role", "radio");
    button.append(make(doc, "span", "mode-label", MODE_LABELS[option.mode]), make(doc, "span", "reason", option.available ? "" : option.reason ?? "Unavailable"));
    button.addEventListener("click", () => onPick(option.mode));
    parts.modes.appendChild(button);
  }
}

function buildParts(doc: Document): Parts {
  const host = make(doc, "div");
  host.id = HOST_ID;
  host.style.cssText = LOOP_HOST_CSS;
  host.setAttribute("data-loop-state", "hidden");
  const shadow = host.attachShadow({ mode: "closed" });
  adoptStyles(doc, shadow);
  const top = buildTop(doc);
  const middle = buildMiddle(doc);
  const foot = buildFoot(doc);
  const sheet = make(doc, "section", "sheet");
  sheet.tabIndex = -1;
  sheet.dataset.open = "false";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Ghost loop proposal");
  sheet.append(top.root, middle.progress, middle.report, middle.parts.gridWrap, foot.root);
  const dock = make(doc, "div", "dock");
  dock.appendChild(sheet);
  shadow.appendChild(dock);
  return { host, shadow, sheet, ...top.parts, ...middle.parts, ...foot.parts };
}

function buildTop(doc: Document): { root: HTMLElement; parts: Pick<Parts, "headline" | "name" | "previewNote"> } {
  const root = make(doc, "header", "top");
  const brand = make(doc, "span", "brand");
  brand.append(make(doc, "span", "dot"), "Ghost");
  const headline = make(doc, "h2", "headline");
  const name = make(doc, "p", "name");
  const titles = make(doc, "div", "titles");
  titles.append(headline, name);
  const previewNote = make(doc, "span", "preview-note");
  previewNote.setAttribute("aria-live", "polite");
  root.append(brand, titles, previewNote);
  return { root, parts: { headline, name, previewNote } };
}

type MiddleParts = Pick<Parts, "fill" | "progressText" | "summary" | "failures" | "gridWrap" | "headRow" | "body" | "selectAll">;

function buildMiddle(doc: Document): { progress: HTMLElement; report: HTMLElement; parts: MiddleParts } {
  const progress = make(doc, "div", "progress");
  const bar = make(doc, "div", "bar");
  const fill = make(doc, "div", "fill");
  bar.appendChild(fill);
  const progressText = make(doc, "span", "progress-text");
  progressText.setAttribute("aria-live", "polite");
  progress.append(bar, progressText);
  const report = make(doc, "div", "report");
  const summary = make(doc, "p", "summary");
  const failures = make(doc, "ul", "failures");
  report.append(summary, failures);
  return { progress, report, parts: { fill, progressText, summary, failures, ...buildTable(doc) } };
}

function buildTable(doc: Document): Pick<Parts, "gridWrap" | "headRow" | "body" | "selectAll"> {
  const gridWrap = make(doc, "div", "grid-wrap");
  const table = make(doc, "table", "grid");
  const head = make(doc, "thead");
  const headRow = make(doc, "tr");
  const selectAll = make(doc, "input");
  selectAll.type = "checkbox";
  selectAll.setAttribute("aria-label", "Include every row");
  const pick = make(doc, "th", "pick");
  pick.appendChild(selectAll);
  headRow.appendChild(pick);
  head.appendChild(headRow);
  const body = make(doc, "tbody");
  table.append(head, body);
  gridWrap.appendChild(table);
  return { gridWrap, headRow, body, selectAll };
}

type FootParts = Pick<Parts, "modes" | "effects" | "effectsTitle" | "effectsList" | "later" | "cancel" | "close" | "confirm" | "confirmLabel">;

function buildFoot(doc: Document): { root: HTMLElement; parts: FootParts } {
  const root = make(doc, "footer", "foot");
  const modes = make(doc, "div", "modes");
  modes.setAttribute("role", "radiogroup");
  modes.setAttribute("aria-label", "Execution mode");
  const effects = make(doc, "div", "effects");
  const effectsTitle = make(doc, "span", "effects-title");
  const effectsList = make(doc, "ul", "effects-list");
  const effectsText = make(doc, "div", "effects-text");
  effectsText.append(effectsTitle, effectsList);
  effects.append(padlock(doc, 14), effectsText);
  const actions = buildActions(doc);
  root.append(modes, effects, actions.root);
  return { root, parts: { modes, effects, effectsTitle, effectsList, ...actions.parts } };
}

function buildActions(doc: Document): { root: HTMLElement; parts: Pick<Parts, "later" | "cancel" | "close" | "confirm" | "confirmLabel"> } {
  const root = make(doc, "div", "actions");
  const hint = make(doc, "span", "hint");
  hint.append(make(doc, "kbd", undefined, "Tab"), "then", make(doc, "kbd", undefined, "Enter"), "to confirm");
  const later = button(doc, "btn later", "Not now");
  const cancel = button(doc, "btn cancel", "Cancel");
  const close = button(doc, "btn close", "Close");
  const confirm = button(doc, "btn confirm");
  // Every Ghost component treats this attribute as "locked": Tab never activates it, only Enter or a click does.
  confirm.setAttribute("data-ghost-lock", "");
  confirm.disabled = true;
  const confirmLabel = make(doc, "span", "confirm-label");
  confirm.append(padlock(doc, 13), confirmLabel);
  root.append(hint, later, cancel, close, confirm);
  return { root, parts: { later, cancel, close, confirm, confirmLabel } };
}

function button(doc: Document, className: string, text?: string): HTMLButtonElement {
  const el = make(doc, "button", className, text);
  el.type = "button";
  return el;
}

function padlock(doc: Document, size: number): SVGElement {
  const svg = svgEl(doc, "svg", { width: String(size), height: String(size), viewBox: PADLOCK.viewBox, "aria-hidden": "true" });
  svg.append(svgEl(doc, "rect", PADLOCK.body), svgEl(doc, "path", PADLOCK.shackle));
  return svg;
}

/** Constructed sheets are exempt from the page's CSP; the <style> fallback covers jsdom and old engines. */
function adoptStyles(doc: Document, shadow: ShadowRoot): void {
  try {
    const Sheet = doc.defaultView?.CSSStyleSheet;
    if (Sheet && "replaceSync" in Sheet.prototype && "adoptedStyleSheets" in shadow) {
      const sheet = new Sheet();
      sheet.replaceSync(LOOP_PANEL_CSS);
      shadow.adoptedStyleSheets = [sheet];
      return;
    }
  } catch {
    // fall through to the <style> element
  }
  shadow.appendChild(make(doc, "style", undefined, LOOP_PANEL_CSS));
}

// ---------- tiny DOM helpers ----------

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function svgEl(doc: Document, tag: string, attrs: Readonly<Record<string, string>>): SVGElement {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Skips identical writes: attribute mutations on the host are visible to the page and to our own rescan observer. */
function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function syncList(list: HTMLUListElement, lines: string[]): void {
  const doc = list.ownerDocument;
  if ([...list.children].map((li) => li.textContent).join("\n") === lines.join("\n")) return;
  list.replaceChildren(...lines.map((line) => make(doc, "li", undefined, line)));
}
