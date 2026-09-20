// Dry run for the loop preview grid (docs/loops.md 3.4): open every remaining item in a hidden same-origin
// iframe, wait for the program's extract locators, read their text, apply the transform. Nothing is clicked,
// typed or submitted, and the frames are sandboxed so the previewed page cannot submit forms or open dialogs either.
import { applyTransform, isSensitive, pathPatternOf } from "@ghost/shared";
import type { FactLocator, LoopProgram, LoopStep } from "@ghost/shared";
import { isElementSensitive } from "./capture";

/** 1: the program's own locator hit. 0.6: only a fallback explains the value. 0: at least one value is missing. */
export type RowConfidence = 1 | 0.6 | 0;

export interface DryRunRow {
  /** Index of the item in the iterator's list. */
  index: number;
  /** The item's page, or "" when the list item has no usable same-origin link. */
  url: string;
  /** Extracted (and transformed) value per program variable. Missing variables have no key. */
  vars: Record<string, string>;
  confidence: RowConfidence;
  /** Variables with no value: locator not found in time, empty or sensitive, off the item's page, or unresolved by the generalizer. */
  missing: string[];
}

/** One column of the preview grid. */
export interface LoopVariable {
  var: string;
  /** The column header or label of the field the value goes into. */
  header: string;
  /** False when the generalizer found no source for it (LoopProgram.unresolved): it can only be missing. */
  resolved: boolean;
}

/** `resolveLocator` from pageFacts.ts. Injected so this module never depends on how facts are located. */
export type LocatorResolver = (doc: Document, locator: FactLocator) => Element | null;

/** One hidden browsing context. `load` replaces whatever was loaded before. */
export interface PreviewFrame {
  /** Resolves true once the document of `url` finished loading; false on error, timeout or abort. */
  load(url: string, signal: AbortSignal): Promise<boolean>;
  /** The loaded document, or null when it is unreachable (blocked, cross-origin after a redirect, not loaded). */
  document(): Document | null;
  dispose(): void;
}

export interface FramePool {
  acquire(): PreviewFrame;
  /** Removes every frame and the pool's host. */
  destroy(): void;
}

export interface DryRunOptions {
  resolve: LocatorResolver;
  /** Default: `createIframePool(doc)`. previewItems always destroys the pool when it ends. */
  frames?: FramePool;
  doc?: Document;
  /** Only URLs of this origin are loaded. Default: the document's own origin. */
  origin?: string;
  /** List index of each entry of `itemUrls`. Default: its position. */
  indexes?: number[];
  /** Default 4. */
  poolSize?: number;
  /** How long to wait for the locators after the frame loaded. Default 3000. */
  locatorTimeoutMs?: number;
  /** How long a frame may take to load. Default 8000. */
  loadTimeoutMs?: number;
  /** Once every variable has some value but not all are exact, wait this long for the page to finish rendering. Default 250. */
  graceMs?: number;
  /** Variables whose locator is a guess (for example from /v1/loop/synthesize): a hit still only counts as 0.6. */
  fallbackVars?: Iterable<string>;
  signal?: AbortSignal;
}

type ExtractStep = Extract<LoopStep, { op: "extract" }>;
type FillStep = Extract<LoopStep, { op: "fill" }>;

interface Config {
  resolve: LocatorResolver;
  extracts: ExtractStep[];
  unresolved: string[];
  /** Variable names in grid column order: `missing` is reported in the order the user sees the columns. */
  order: string[];
  fallbackVars: Set<string>;
  origin: string;
  base: string;
  locatorTimeoutMs: number;
  loadTimeoutMs: number;
  graceMs: number;
}

interface VarRead {
  value: string | null;
  exact: boolean;
}

interface Job {
  index: number;
  url: string;
}

const POOL_SIZE = 4;
const POLL_MS = 100;
const POOL_HOST_ID = "ghost-dryrun-host";
const FRAME_CSS = "position:absolute;left:-9999px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;";
const POOL_HOST_CSS = "display:block;position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;";

// ---------- program shape ----------

function extractSteps(program: LoopProgram): ExtractStep[] {
  return program.steps.filter((s): s is ExtractStep => s.op === "extract");
}

function headerOf(step: FillStep): string {
  return (step.target.cell?.colHeader || step.target.label || "").trim();
}

/** Grid columns: variables in the order their fields are filled, then any that are only extracted. */
export function loopVariables(program: LoopProgram): LoopVariable[] {
  const extracted = new Set(extractSteps(program).map((s) => s.var));
  const out = new Map<string, LoopVariable>();
  for (const step of program.steps) {
    if (step.op !== "fill" || !("var" in step.value) || out.has(step.value.var)) continue;
    const name = step.value.var;
    out.set(name, { var: name, header: headerOf(step) || name, resolved: extracted.has(name) });
  }
  for (const name of extracted) if (!out.has(name)) out.set(name, { var: name, header: name, resolved: true });
  return [...out.values()];
}

// ---------- item urls ----------

/** The href of a list item's link: the item itself, the link around it, or the first link inside it. No fragment. */
export function itemUrlFromElement(item: Element): string | null {
  const link = item.closest("a[href]") ?? item.querySelector("a[href]");
  const href = link?.getAttribute("href");
  if (!href) return null;
  try {
    const url = new URL(href, item.ownerDocument.baseURI);
    url.hash = "";
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** One URL per index ("" when the list has no link for it), ready for `previewItems(program, urls, { indexes })`. */
export function resolveItemUrls(indexes: readonly number[], itemUrlAt: (index: number) => string | null): string[] {
  return indexes.map((index) => itemUrlAt(index) ?? "");
}

function sameOriginUrl(raw: string, cfg: Config): string | null {
  if (raw.trim() === "") return null;
  try {
    const url = new URL(raw, cfg.base);
    if (!/^https?:$/.test(url.protocol) || url.origin !== cfg.origin) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

// ---------- reading one document ----------

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A locator that names something sensitive is never resolved, whatever the page puts there. */
function namesSensitive(step: ExtractStep): boolean {
  const { locator } = step.from;
  return isSensitive(locator.by === "label" ? { label: locator.value } : { name: locator.value, label: step.var });
}

/** The same value under the sibling attributes: a page that renamed data-testid to data-field still previews, flagged. */
function fallbackLocators(locator: FactLocator): FactLocator[] {
  if (locator.by === "label" || locator.by === "css") return [];
  const kinds = ["data-field", "testid", "id"] as const;
  return kinds.filter((by) => by !== locator.by).map((by) => ({ by, value: locator.value }));
}

/** Text of the first locator that lands on a non-empty, non-sensitive element. Form control values are never read. */
function locate(doc: Document, step: ExtractStep, resolve: LocatorResolver): { text: string; primary: boolean } | null {
  const locators = [step.from.locator, ...fallbackLocators(step.from.locator)];
  for (const [i, locator] of locators.entries()) {
    const el = safely(() => resolve(doc, locator));
    if (!el) continue;
    if (isElementSensitive(el)) return null;
    const text = collapse(el.textContent ?? "");
    if (text !== "") return { text, primary: i === 0 };
  }
  return null;
}

function readVar(doc: Document, step: ExtractStep, cfg: Config): VarRead {
  if (namesSensitive(step)) return { value: null, exact: false };
  const hit = locate(doc, step, cfg.resolve);
  if (!hit) return { value: null, exact: false };
  const value = applyTransform(hit.text, step.from.transform);
  // Text that will not transform is shown as it is, flagged: the user decides, Ghost does not guess a number or a date.
  if (value === null || value === "") return { value: hit.text, exact: false };
  return { value, exact: hit.primary && !cfg.fallbackVars.has(step.var) };
}

function readAll(doc: Document | null, steps: ExtractStep[], cfg: Config): Map<string, VarRead> {
  const reads = new Map<string, VarRead>();
  for (const step of steps) reads.set(step.var, doc ? readVar(doc, step, cfg) : { value: null, exact: false });
  return reads;
}

function safely<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ---------- waiting for a page to render ----------

/** Calls `tick` on every DOM mutation of the frame's document and every POLL_MS (the document can be swapped under us). */
function watch(frame: PreviewFrame, tick: () => void): () => void {
  let observed: Document | null = null;
  let observer: MutationObserver | null = null;
  const attach = (): void => {
    const doc = frame.document();
    if (doc === observed || typeof MutationObserver === "undefined") return;
    observer?.disconnect();
    observed = doc;
    observer = doc ? new MutationObserver(tick) : null;
    if (doc) observer?.observe(doc, { childList: true, subtree: true, characterData: true, attributes: true });
  };
  attach();
  const timer = setInterval(() => {
    attach();
    tick();
  }, POLL_MS);
  return () => {
    clearInterval(timer);
    observer?.disconnect();
  };
}

/** Resolves as soon as every locator hits exactly, after a short grace once every one has some value, or at the timeout. */
function waitForReads(frame: PreviewFrame, steps: ExtractStep[], cfg: Config, signal: AbortSignal): Promise<Map<string, VarRead>> {
  return new Promise((resolve) => {
    const started = Date.now();
    let graceFrom: number | null = null;
    let stop: () => void = () => undefined;
    const finish = (reads: Map<string, VarRead>): void => {
      stop();
      signal.removeEventListener("abort", tick);
      resolve(reads);
    };
    function tick(): void {
      const reads = readAll(frame.document(), steps, cfg);
      const values = [...reads.values()];
      const now = Date.now();
      if (signal.aborted || values.every((r) => r.exact) || now - started >= cfg.locatorTimeoutMs) return finish(reads);
      if (!values.every((r) => r.value !== null)) graceFrom = null;
      else if (graceFrom === null) graceFrom = now;
      else if (now - graceFrom >= cfg.graceMs) finish(reads);
    }
    stop = watch(frame, tick);
    signal.addEventListener("abort", tick);
    tick();
  });
}

// ---------- one row ----------

function rowFrom(job: Job, reads: Map<string, VarRead>, cfg: Config): DryRunRow {
  const vars: Record<string, string> = {};
  const missing: string[] = [...cfg.unresolved];
  let exact = true;
  for (const [name, read] of reads) {
    if (read.value === null) missing.push(name);
    else vars[name] = read.value;
    exact &&= read.exact;
  }
  missing.sort((a, b) => cfg.order.indexOf(a) - cfg.order.indexOf(b));
  const confidence: RowConfidence = missing.length > 0 ? 0 : exact ? 1 : 0.6;
  return { index: job.index, url: job.url, vars, confidence, missing };
}

function missingRow(job: Job, cfg: Config): DryRunRow {
  return rowFrom(job, readAll(null, cfg.extracts, cfg), cfg);
}

function onItemPage(url: string, cfg: Config): ExtractStep[] {
  const pattern = pathPatternOf(new URL(url).pathname);
  return cfg.extracts.filter((s) => s.from.pathPattern === pattern);
}

async function previewOne(job: Job, getFrame: () => PreviewFrame, cfg: Config, signal: AbortSignal): Promise<DryRunRow> {
  const url = sameOriginUrl(job.url, cfg);
  if (url === null) return { ...missingRow(job, cfg), url: "", confidence: 0 };
  const here = onItemPage(url, cfg);
  const target: Job = { index: job.index, url };
  if (here.length === 0) return missingRow(target, cfg); // nothing to read on this page: no load, extracts elsewhere are missing
  const frame = getFrame();
  const loaded = await frame.load(url, signal);
  const reads = loaded ? await waitForReads(frame, here, cfg, signal) : readAll(null, here, cfg);
  for (const step of cfg.extracts) if (!reads.has(step.var)) reads.set(step.var, { value: null, exact: false });
  return rowFrom(target, reads, cfg);
}

// ---------- the pool ----------

interface Channel<T> {
  push(value: T): void;
  close(): void;
  drain(): AsyncGenerator<T, void, undefined>;
}

function channel<T>(): Channel<T> {
  const items: T[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const signal = (): void => {
    wake?.();
    wake = null;
  };
  return {
    push: (value) => (items.push(value), signal()),
    close: () => ((closed = true), signal()),
    async *drain() {
      for (;;) {
        const next = items.shift();
        if (next !== undefined) yield next;
        else if (closed) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

function configure(program: LoopProgram, opts: DryRunOptions, doc: Document): Config {
  const extracts = extractSteps(program);
  const variables = loopVariables(program);
  return {
    resolve: opts.resolve,
    extracts,
    unresolved: variables.filter((v) => !v.resolved).map((v) => v.var),
    order: variables.map((v) => v.var),
    fallbackVars: new Set(opts.fallbackVars ?? []),
    origin: opts.origin ?? doc.location.origin,
    base: doc.baseURI,
    locatorTimeoutMs: opts.locatorTimeoutMs ?? 3000,
    loadTimeoutMs: opts.loadTimeoutMs ?? 8000,
    graceMs: opts.graceMs ?? 250,
  };
}

function linkSignals(outer: AbortSignal | undefined): AbortController {
  const inner = new AbortController();
  if (outer?.aborted) inner.abort();
  outer?.addEventListener("abort", () => inner.abort(), { once: true });
  return inner;
}

/** Runs the jobs through at most `size` frames at a time; every finished row goes to `out`. */
async function runPool(jobs: Job[], size: number, pool: FramePool, cfg: Config, signal: AbortSignal, out: Channel<DryRunRow>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    const slot: { frame: PreviewFrame | null } = { frame: null }; // acquired on the first item that needs loading
    try {
      while (!signal.aborted) {
        const job = jobs[cursor++];
        if (!job) break;
        const row = await previewOne(job, () => (slot.frame ??= pool.acquire()), cfg, signal).catch(() => missingRow(job, cfg));
        if (!signal.aborted) out.push(row);
      }
    } finally {
      slot.frame?.dispose();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, jobs.length)) }, worker));
}

/**
 * Streams one row per item as its preview finishes (not in list order). Cross-origin, non-http and empty URLs are
 * never loaded: their row has confidence 0. Abort with `opts.signal` or by leaving the `for await`; either way the
 * frames and their host are removed.
 */
export async function* previewItems(program: LoopProgram, itemUrls: readonly string[], opts: DryRunOptions): AsyncGenerator<DryRunRow, void, undefined> {
  const doc = opts.doc ?? document;
  const cfg = configure(program, opts, doc);
  const abort = linkSignals(opts.signal);
  const pool = opts.frames ?? createIframePool(doc, cfg.loadTimeoutMs);
  const out = channel<DryRunRow>();
  const jobs = itemUrls.map((url, i): Job => ({ index: opts.indexes?.[i] ?? i, url }));
  const running = runPool(jobs, opts.poolSize ?? POOL_SIZE, pool, cfg, abort.signal, out)
    .catch(() => undefined)
    .finally(() => out.close());
  try {
    for await (const row of out.drain()) {
      if (abort.signal.aborted) return;
      yield row;
    }
  } finally {
    abort.abort();
    await running;
    pool.destroy();
  }
}

// ---------- real frames ----------

function loadedDocument(el: HTMLIFrameElement | null): Document | null {
  const doc = el ? safely(() => el.contentDocument) : null;
  // about:blank is what a frame holds before its navigation commits: never read it as the item's page.
  return doc && safely(() => doc.location.protocol.startsWith("http")) ? doc : null;
}

function createFrame(doc: Document, root: ShadowRoot, loadTimeoutMs: number): PreviewFrame {
  let el: HTMLIFrameElement | null = null;
  const dispose = (): void => {
    el?.remove();
    el = null;
  };
  return {
    dispose,
    document: () => loadedDocument(el),
    // A fresh iframe per item: a reused one still holds the previous item's document until the next one commits.
    load(url, signal) {
      dispose();
      if (signal.aborted) return Promise.resolve(false);
      const frame = (el = doc.createElement("iframe"));
      frame.setAttribute("sandbox", "allow-same-origin allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.style.cssText = FRAME_CSS;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(false), loadTimeoutMs);
        const onAbort = (): void => settle(false);
        function settle(ok: boolean): void {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(ok && el === frame && loadedDocument(frame) !== null);
        }
        frame.addEventListener("load", () => settle(true), { once: true });
        frame.addEventListener("error", () => settle(false), { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
        frame.src = url;
        root.appendChild(frame);
      });
    },
  };
}

/** Hidden 1px iframes inside their own closed shadow host, so neither the page's CSS nor its scripts reach them. */
export function createIframePool(doc: Document = document, loadTimeoutMs = 8000): FramePool {
  let host: HTMLDivElement | null = null;
  let root: ShadowRoot | null = null;
  const frames: PreviewFrame[] = [];
  // Mounted on first use: a program with nothing to extract never adds a node to the page.
  const mount = (): ShadowRoot => {
    if (root && host?.isConnected) return root;
    doc.getElementById(POOL_HOST_ID)?.remove();
    host = doc.createElement("div");
    host.id = POOL_HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = POOL_HOST_CSS;
    root = host.attachShadow({ mode: "closed" });
    doc.documentElement.appendChild(host);
    return root;
  };
  return {
    acquire() {
      const frame = createFrame(doc, mount(), loadTimeoutMs);
      frames.push(frame);
      return frame;
    },
    destroy() {
      for (const frame of frames.splice(0)) frame.dispose();
      host?.remove();
      host = root = null;
    },
  };
}
