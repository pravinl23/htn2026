import { shapeKey } from "../trace/shape";
import { MASKED_VALUE } from "../trace/types";
import type { FactsByUrl, TraceEvent } from "../trace/types";
import { alignRuns, findIterator, lastItemState, listIndexes, makeContext } from "./align";
import type { Context, Pair } from "./align";
import { evidenceAt, findSource } from "./sources";
import type { Source } from "./sources";
import type { LoopCandidate, LoopIterator, LoopProgram, LoopStep, StepPage, StepTarget, UnresolvedStep } from "./types";

export interface SynthesizeOptions {
  id?: string;
  name?: string;
  /** Number of items in the list, when the caller already knows it. */
  total?: number;
}

type ExtractStep = Extract<LoopStep, { op: "extract" }>;
type FillStep = Extract<LoopStep, { op: "fill" }>;

interface Draft {
  steps: LoopStep[];
  extracts: Array<{ anchor: number; key: string; step: ExtractStep }>;
  /** First step index at which each page pattern is on screen: extracts are hoisted there. */
  anchors: Map<string, number>;
  vars: Set<string>;
  unresolved: Array<{ step: FillStep; valueA: string; valueB: string }>;
  penalties: number[];
  currentUrl: string | null;
  /** Run A's url of a locked click that is still the newest thing that happened: a submit right there is its own echo. */
  submitCauseUrl: string | null;
  itemPathPattern?: string;
}

/** rowJump: docs/loops.md 3.3 only calls a row that advanced by one an append, so any other move lands below the default threshold. */
const PENALTY = { unresolved: 0.5, singleEvidence: 0.85, transform: 0.95, trim: 0.98, stride: 0.9, rowJump: 0.5 };

function camel(label: string): string {
  const parts = label.replace(/#/g, " number ").replace(/%/g, " percent ").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const name = parts.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
  if (name === "") return "value";
  return /^[a-z]/.test(name) ? name : `v${name}`;
}

function freshVar(d: Draft, label: string): string {
  const base = camel(label);
  let name = base;
  for (let i = 2; d.vars.has(name); i++) name = `${base}${i}`;
  d.vars.add(name);
  return name;
}

function useExtract(d: Draft, source: Source, fallbackLabel: string): string {
  const key = `${source.pathPattern}|${source.locator.by}|${source.locator.value}|${source.mode}`;
  const existing = d.extracts.find((x) => x.key === key);
  if (existing) return existing.step.var;
  const name = freshVar(d, source.label || source.locator.value || fallbackLabel);
  const from: ExtractStep["from"] = { pathPattern: source.pathPattern, locator: source.locator };
  if (source.mode !== "exact") from.transform = source.mode;
  const anchor = d.anchors.get(source.pathPattern) ?? d.steps.length;
  d.extracts.push({ anchor, key, step: { op: "extract", var: name, from } });
  return name;
}

function stepTarget(d: Draft, p: Pair): StepTarget | null {
  const ta = p.a.target;
  const tb = p.b.target;
  if (!ta || !tb) return null;
  const label = ta.label === tb.label ? ta.label : (ta.cell?.colHeader ?? ta.label);
  const target: StepTarget = { label, kind: ta.kind };
  if (ta.cell && tb.cell && ta.cell.row !== tb.cell.row) {
    target.cell = { row: "next-empty", colHeader: ta.cell.colHeader };
    if (tb.cell.row - ta.cell.row !== 1) d.penalties.push(PENALTY.rowJump);
  } else if (ta.signature === tb.signature) {
    target.signature = ta.signature;
  }
  return target;
}

function pageOf(e: TraceEvent): StepPage {
  return { origin: e.origin, pathPattern: e.pathPattern };
}

function noteAnchor(d: Draft, pathPattern: string): void {
  if (!d.anchors.has(pathPattern)) d.anchors.set(pathPattern, d.steps.length);
}

function addNavigation(d: Draft, ctx: Context, p: Pair): void {
  d.submitCauseUrl = null;
  if (p.a.url !== p.b.url) {
    // Differs only in the id segment: caused by opening the item, so it carries no step.
    d.itemPathPattern ??= p.a.pathPattern;
    d.currentUrl = null;
  } else if (p.a.url !== d.currentUrl) {
    d.currentUrl = p.a.url;
    const isListPage = p.a.origin === ctx.listPage.origin && p.a.pathPattern === ctx.listPage.pathPattern;
    if (!isListPage) d.steps.push({ op: "goto", origin: p.a.origin, pathPattern: p.a.pathPattern, url: p.a.url });
  }
  noteAnchor(d, p.a.pathPattern);
}

function addClick(d: Draft, p: Pair): void {
  const target = stepTarget(d, p);
  if (!target) return;
  const causedByLastClick = p.a.type === "submit" && d.submitCauseUrl === p.a.url;
  d.submitCauseUrl = null;
  if (causedByLastClick) return; // the locked click that caused this submit is already a step
  const locked = p.a.type === "submit" || isLocked(p);
  d.steps.push({ op: "click", target, locked, at: pageOf(p.a) });
  if (locked && p.a.type === "click") d.submitCauseUrl = p.a.url;
}

/** Locked in either run is locked: when in doubt, lock. */
function isLocked(p: Pair): boolean {
  return p.a.target?.locked === true || p.b.target?.locked === true;
}

function fillStep(target: StepTarget, value: FillStep["value"], p: Pair): FillStep {
  const step: FillStep = { op: "fill", target, value, at: pageOf(p.a) };
  if (isLocked(p)) step.locked = true;
  return step;
}

function addFill(d: Draft, ctx: Context, pos: number, p: Pair): void {
  const target = stepTarget(d, p);
  if (!target) return;
  d.submitCauseUrl = null;
  const valueA = p.a.value ?? "";
  const valueB = p.b.value ?? "";
  if (valueA === valueB) {
    d.steps.push(fillStep(target, { const: valueB }, p));
    return;
  }
  const evidence = evidenceAt(ctx, pos);
  const source = findSource(ctx, evidence, target.cell?.colHeader ?? target.label);
  const name = source ? useExtract(d, source, target.label) : freshVar(d, target.cell?.colHeader ?? target.label);
  const step = fillStep(target, { var: name }, p);
  d.steps.push(step);
  if (!source) d.unresolved.push({ step, valueA, valueB });
  if (!source) d.penalties.push(PENALTY.unresolved);
  else if (source.mode !== "exact") d.penalties.push(source.mode === "trim" ? PENALTY.trim : PENALTY.transform);
  if (source && evidence.length < 2) d.penalties.push(PENALTY.singleEvidence);
}

/** Returns false when the pair cannot be generalized safely and the whole program must be dropped. */
function addPair(d: Draft, ctx: Context, pos: number): boolean {
  const p = ctx.rotated[pos];
  if (!p) return false;
  if (p.a.value === MASKED_VALUE || p.b.value === MASKED_VALUE) return false;
  if (p.a.type === "navigate" || p.a.type === "tabswitch") {
    addNavigation(d, ctx, p);
    return true;
  }
  noteAnchor(d, p.a.pathPattern);
  const moved = listIndexes(p);
  if (moved) {
    const it = ctx.iterator;
    const consistent = moved.listSignature === it.listSignature && moved.indexA === it.indexA && moved.indexB === it.indexB;
    if (!consistent) return false;
    d.steps.push({ op: "open-item" });
    d.currentUrl = null;
    d.submitCauseUrl = null;
    return true;
  }
  if (p.a.type === "click" || p.a.type === "submit") addClick(d, p);
  else addFill(d, ctx, pos, p);
  return true;
}

function assemble(d: Draft): LoopStep[] {
  const out: LoopStep[] = [];
  for (let i = 0; i <= d.steps.length; i++) {
    for (const x of d.extracts) if (x.anchor === i) out.push(x.step);
    const step = d.steps[i];
    if (step) out.push(step);
  }
  while (out[out.length - 1]?.op === "goto") out.pop();
  return out;
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function describeProgram(steps: LoopStep[], iterator: LoopIterator): string {
  const fills = steps.filter((s): s is FillStep => s.op === "fill");
  const copied = fills.filter((f) => "var" in f.value).length;
  const where = fills[0]?.at?.pathPattern ?? "";
  const from = iterator.itemPathPattern ?? iterator.pathPattern;
  const plural = (n: number): string => `${n} field${n === 1 ? "" : "s"}`;
  let name = `Open each item in ${iterator.pathPattern}`;
  if (copied > 0) name = `Copy ${plural(copied)} from ${from} to ${where}`;
  else if (fills.length > 0) name = `Fill ${plural(fills.length)} on ${where}`;
  const click = namingClick(steps);
  return click ? `${name} and click "${click.target.label}"` : name;
}

/**
 * The click the routine is named after: the locked one it ends with, else the last click. The FIRST click is
 * usually how the user got to the page at all ("Open spreadsheet"), which is not what the routine does.
 */
function namingClick(steps: LoopStep[]): Extract<LoopStep, { op: "click" }> | null {
  const clicks = steps.filter((s): s is Extract<LoopStep, { op: "click" }> => s.op === "click");
  for (let i = clicks.length - 1; i >= 0; i--) {
    const click = clicks[i];
    if (click?.locked === true) return click;
  }
  return clicks[clicks.length - 1] ?? null;
}

function describeLocked(s: LoopStep): string | null {
  if ((s.op !== "click" && s.op !== "fill") || s.locked !== true) return null;
  const label = s.target.label.trim();
  if (s.op === "click") return label || "Locked action";
  return "const" in s.value ? `Set ${label || "locked field"} to "${s.value.const}"` : `Set ${label || "locked field"}`;
}

/** Every locked step, click or fill, so the single batch confirmation lists every irreversible effect. */
function irreversibleOf(steps: LoopStep[]): LoopProgram["irreversible"] {
  const out: LoopProgram["irreversible"] = [];
  for (const [stepIndex, s] of steps.entries()) {
    const description = describeLocked(s);
    if (description !== null) out.push({ stepIndex, description });
  }
  return out;
}

function unresolvedOf(d: Draft, steps: LoopStep[]): UnresolvedStep[] {
  return d.unresolved.map((u) => ({
    stepIndex: steps.indexOf(u.step),
    var: "var" in u.step.value ? u.step.value.var : "",
    label: u.step.target.label,
    valueA: u.valueA,
    valueB: u.valueB,
  }));
}

function buildIterator(ctx: Context, d: Draft, total: number | undefined): LoopIterator {
  const stride = ctx.iterator.indexB - ctx.iterator.indexA;
  const iterator: LoopIterator = {
    ...ctx.listPage,
    listSignature: ctx.iterator.listSignature,
    stride,
    nextIndex: lastItemState(ctx) === "opened" ? ctx.iterator.indexB : ctx.iterator.indexB + stride,
  };
  if (total !== undefined) iterator.total = total;
  if (d.itemPathPattern !== undefined) iterator.itemPathPattern = d.itemPathPattern;
  return iterator;
}

/**
 * Aligns the two runs step by step and generalizes them: constants, the list iterator, append-row cells,
 * values copied from page facts (the same locator must explain both runs), implicit item navigations.
 * Returns null when there is no list iterator, nothing to do per item, a masked (sensitive) value is involved,
 * or the newest item is half-done (a clean candidate appears as soon as the user finishes it).
 */
export function synthesizeProgram(candidate: LoopCandidate, factsByUrl: FactsByUrl, opts: SynthesizeOptions = {}): LoopProgram | null {
  const pairs = alignRuns(candidate);
  const hit = pairs ? findIterator(pairs) : null;
  const ctx = pairs && hit ? makeContext(pairs, hit, factsByUrl) : null;
  if (!ctx || lastItemState(ctx) === "half-done") return null;
  const first = ctx.rotated[0];
  const draft: Draft = {
    steps: [], extracts: [], anchors: new Map(), vars: new Set(), unresolved: [], penalties: [],
    currentUrl: first ? first.a.url : null,
    submitCauseUrl: null,
  };
  for (let pos = 0; pos < ctx.rotated.length; pos++) if (!addPair(draft, ctx, pos)) return null;
  const steps = assemble(draft);
  if (!steps.some((s) => s.op === "fill" || s.op === "click")) return null;
  const iterator = buildIterator(ctx, draft, opts.total);
  if (iterator.stride !== 1) draft.penalties.push(PENALTY.stride);
  const confidence = Math.round(draft.penalties.reduce((acc, p) => acc * p, 1) * 100) / 100;
  const keys = ctx.rotated.map((p) => shapeKey(p.a)).join(">");
  return {
    id: opts.id ?? `loop-${hash(`${iterator.origin}>${keys}`)}`,
    name: opts.name ?? describeProgram(steps, iterator),
    iterator,
    steps,
    irreversible: irreversibleOf(steps),
    confidence,
    unresolved: unresolvedOf(draft, steps),
  };
}
