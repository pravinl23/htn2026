import { isSensitive, pathPatternOf, type FactLocator, type StepTarget } from "@shabang/shared";
import { applyLoopTransform, type ServerLoopStep } from "../loop/transforms";
import { isPrivateHost, resolvesPublicly, systemLookup, type HostLookup } from "./netguard";
import { createSemaphore, runPool, type Semaphore } from "./pool";
import { assertConfirmed, fillValue, isEffectStep, isIrreversibleStep, ownVar, report, skippedResult, stopReasonOf, stoppedMessage } from "./steps";
import { ExecutorRefusal, ExecutorUpstreamError, type ExecuteItem, type ExecuteJob, type ExecuteReport, type ItemResult, type LoopExecutor } from "./types";

export { isPrivateHost } from "./netguard";

/**
 * Browserbase REST API, checked against https://docs.browserbase.com/reference/api (create-a-session, update-a-session) on 2026-09-19:
 * POST /v1/sessions { projectId } with header X-BB-API-Key answers 201 { id, connectUrl, status, ... };
 * POST /v1/sessions/{id} { projectId, status: "REQUEST_RELEASE" } ends the session (and its billing) before the timeout.
 * Contexts (https://docs.browserbase.com/features/contexts): `browserSettings: { context: { id, persist } }` on create loads a
 * saved browser profile (cookies, storage). Shabang only ever READS a context (persist: false): parallel sessions that all
 * persisted into one context would overwrite each other. MUST be confirmed against the live docs before the first real run.
 */
export const BROWSERBASE_SESSIONS_URL = "https://api.browserbase.com/v1/sessions";
const HTTP_TIMEOUT_MS = 15_000;
/** Seconds. A loop item takes a few seconds, so a leaked session costs minutes at most. Browserbase's minimum is 60. */
const SESSION_TIMEOUT_S = 300;
const RATE_LIMIT_BACKOFF_MS = [500, 1000, 2000];
export const DEFAULT_CONCURRENCY = 5;
/** Upper bound for BROWSERBASE_CONCURRENCY: every session is billed. */
export const MAX_CONCURRENCY = 10;

export interface BrowserbaseCredentials {
  apiKey: string;
  projectId: string;
  /** BROWSERBASE_CONTEXT_ID: a context the user logged in to once. Without it every cloud browser starts logged out. */
  contextId?: string;
}

export interface BrowserbaseSession {
  id: string;
  connectUrl: string;
}

export interface BrowserbaseApi {
  createSession(): Promise<BrowserbaseSession>;
  releaseSession(id: string): Promise<void>;
}

export interface BrowserbaseApiOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createBrowserbaseApi(creds: BrowserbaseCredentials, options: BrowserbaseApiOptions = {}): BrowserbaseApi {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  async function post(url: string, body: Record<string, unknown>): Promise<Response> {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BB-API-Key": creds.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) await res.body?.cancel().catch(() => undefined);
    return res;
  }

  return {
    async createSession() {
      // 429 means the plan's concurrent-session limit: wait for a lane to free up instead of failing the item.
      for (let attempt = 0; ; attempt++) {
        const context = creds.contextId ? { browserSettings: { context: { id: creds.contextId, persist: false } } } : {};
        const res = await post(BROWSERBASE_SESSIONS_URL, { projectId: creds.projectId, timeout: SESSION_TIMEOUT_S, ...context });
        const backoff = RATE_LIMIT_BACKOFF_MS[attempt];
        if (res.status === 429 && backoff !== undefined) {
          await sleep(backoff);
          continue;
        }
        if (!res.ok) throw new ExecutorUpstreamError("browserbase", `create session responded ${res.status}`, res.status);
        const session = (await res.json()) as Partial<BrowserbaseSession> | null;
        if (typeof session?.id !== "string" || typeof session.connectUrl !== "string") throw new ExecutorUpstreamError("browserbase", "create session answered without id or connectUrl");
        return { id: session.id, connectUrl: session.connectUrl };
      }
    },
    async releaseSession(id) {
      const res = await post(`${BROWSERBASE_SESSIONS_URL}/${encodeURIComponent(id)}`, { projectId: creds.projectId, status: "REQUEST_RELEASE" });
      if (!res.ok) throw new ExecutorUpstreamError("browserbase", `release session responded ${res.status}`, res.status);
    },
  };
}

/** What the executor needs from a remote page. The real one is Playwright over CDP (playwrightConnector.ts); tests use fakes. */
export interface RemotePage {
  goto(url: string): Promise<void>;
  url(): string;
  /** Text at a page-fact locator, or null when nothing matches. */
  readText(locator: FactLocator): Promise<string | null>;
  /** Zero-based index of the first data row after the last filled one in the grid that has this column. */
  nextEmptyRow(colHeader: string): Promise<number>;
  /** Value of the grid cell under `colHeader` in data row `row`, or null when there is no such cell. */
  readCell(colHeader: string, row: number): Promise<string | null>;
  /** Fills by label, or by grid cell when `row` is given. Resolves to the value read back from the element. */
  fill(target: StepTarget, value: string, row?: number): Promise<string>;
  click(target: StepTarget): Promise<void>;
}

export interface RemoteBrowser {
  page(): Promise<RemotePage>;
  close(): Promise<void>;
}

export type CdpConnector = (connectUrl: string) => Promise<RemoteBrowser>;

function parseHttpUrl(raw: string, what: string): URL {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new ExecutorRefusal(`${what} must be an http(s) URL`);
  return url;
}

/**
 * A cloud browser cannot reach this machine. URLs on a PRIVATE `baseUrl` are moved onto `publicDemoUrl`
 * (SHABANG_PUBLIC_DEMO_URL: the same site, deployed or tunnelled); without one the job is refused.
 * A public baseUrl is never rewritten: a loop recorded on a real site must not be replayed against the demo host.
 */
export function createUrlRewriter(baseUrl: string, publicDemoUrl?: string): (url: string) => string {
  const base = parseHttpUrl(baseUrl, "baseUrl");
  const basePrivate = isPrivateHost(base.hostname);
  const replacement = basePrivate && publicDemoUrl ? parseHttpUrl(publicDemoUrl, "SHABANG_PUBLIC_DEMO_URL") : undefined;
  if (replacement && isPrivateHost(replacement.hostname)) throw new ExecutorRefusal("SHABANG_PUBLIC_DEMO_URL must be reachable from the internet, not a local address");
  const unreachable = (origin: string): ExecutorRefusal =>
    new ExecutorRefusal(`Cloud browsers cannot reach ${origin}. Set SHABANG_PUBLIC_DEMO_URL to a public URL serving the same site, or run this loop in visible or background mode.`);
  if (basePrivate && !replacement) throw unreachable(base.origin);

  return (raw) => {
    const url = parseHttpUrl(raw, "step url");
    if (replacement && url.origin === base.origin) return replacement.origin + replacement.pathname.replace(/\/+$/, "") + url.pathname + url.search;
    if (isPrivateHost(url.hostname)) throw unreachable(url.origin);
    return url.href;
  };
}

/**
 * Origins a run may touch: the recorded site plus every constant navigation (`goto`) of the program, i.e. pages the user
 * really went to. A fill or click `at` any other origin is refused. The preview lists these, so they are part of what the user confirms.
 */
export function recordedOrigins(job: Pick<ExecuteJob, "program" | "baseUrl">): string[] {
  const origins = new Set([new URL(job.baseUrl).origin]);
  for (const step of job.program.steps) if (step.op === "goto") origins.add(new URL(step.url).origin);
  return [...origins];
}

export interface BrowserbaseExecutorOptions {
  credentials: BrowserbaseCredentials;
  publicDemoUrl?: string;
  concurrency?: number;
  /** Test seams. `connect` defaults to Playwright over CDP, loaded lazily so tests never import it; `lookup` defaults to the system resolver. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  connect?: CdpConnector;
  lookup?: HostLookup;
  now?: () => number;
}

class StepFailure extends Error {}

function pathPatternOfUrl(url: string): string {
  try {
    return pathPatternOf(new URL(url).pathname);
  } catch {
    return "";
  }
}

function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** First line only (Playwright appends a call log that can quote what was typed), with the written value masked. */
function describeError(err: unknown, secret?: string): string {
  if (err instanceof StepFailure || err instanceof ExecutorUpstreamError) return err.message;
  const line = (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 200) ?? "failed";
  return secret && secret.length >= 3 ? line.split(secret).join("***") : line;
}

async function defaultConnector(): Promise<CdpConnector> {
  return (await import("./playwrightConnector")).connectOverCdp;
}

interface Plan {
  rewrite: (url: string) => string;
  /** Origins as the cloud browser sees them (after the rewrite). */
  allowed: Set<string>;
}

const NOT_DURABLE =
  "the row could not be read back from a second cloud browser: the site keeps its state inside the browser, or the session is logged out. Run this loop in visible or background mode.";

export function createBrowserbaseExecutor(options: BrowserbaseExecutorOptions): LoopExecutor {
  const api = createBrowserbaseApi(options.credentials, options);
  const now = options.now ?? Date.now;
  const lookup = options.lookup ?? systemLookup;
  const concurrency = Math.min(Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY) || 1), MAX_CONCURRENCY);
  // Shared by every run of this executor (one per process): parallel requests can never add up to more sessions than this.
  const sessions = createSemaphore(concurrency);

  /** Everything is checked before the first session is created, so a refused job costs nothing. */
  async function plan(job: ExecuteJob): Promise<Plan> {
    const rewrite = createUrlRewriter(job.baseUrl, options.publicDemoUrl);
    const recorded = recordedOrigins(job);
    if (job.program.iterator.origin !== new URL(job.baseUrl).origin) throw new ExecutorRefusal("program.iterator.origin must be baseUrl");
    const targets = new Set<string>();
    for (const item of job.items) targets.add(rewrite(item.url));
    for (const origin of recorded) targets.add(rewrite(`${origin}/`));
    job.program.steps.forEach((step, i) => {
      if (step.op === "goto") targets.add(rewrite(step.url));
      if ((step.op !== "fill" && step.op !== "click") || !step.at) return;
      if (!recorded.includes(step.at.origin)) throw new ExecutorRefusal(`step ${i} happens on an origin the loop never navigates to`, { stepIndex: i });
      targets.add(rewrite(step.at.origin + step.at.pathPattern));
    });
    const hosts = new Set([...targets].map((url) => new URL(url).hostname));
    for (const host of hosts) {
      const verdict = await resolvesPublicly(host, lookup);
      if (verdict === "private") throw new ExecutorRefusal(`Cloud browsers must not be sent to ${host}: it resolves to a private address.`);
      if (verdict === "unresolvable") throw new ExecutorRefusal(`Cannot resolve ${host}.`);
    }
    return { rewrite, allowed: new Set(recorded.map((origin) => new URL(rewrite(`${origin}/`)).origin)) };
  }

  return {
    mode: "parallel",
    available: true,
    async check(job) {
      await plan(job);
    },
    async run(job, { onProgress, signal } = {}) {
      assertConfirmed(job);
      const { rewrite, allowed } = await plan(job);
      const connect = options.connect ?? (await defaultConnector());
      const startedAt = now();
      const allocateRow = createRowAllocator();
      const base = { api, connect, sessions, sleep: options.sleep ?? defaultSleep, job, rewrite, allowed, allocateRow, signal };
      let done = 0;
      let failedIndex: number | undefined;
      let durability: ExecuteReport["durability"] = "unverified";

      const settle = (item: ExecuteItem, result: ItemResult): ItemResult => {
        if (!result.ok && !signal?.aborted) failedIndex ??= item.index;
        onProgress?.({ index: item.index, ok: result.ok, done: ++done, total: job.items.length });
        return result;
      };
      const skip = (item: ExecuteItem): ItemResult => skippedResult(item.index, failedIndex, signal);

      // The first item runs alone, and its row is read back from a SECOND cloud browser before its first irreversible step
      // and before anything else starts: a site that keeps its state in localStorage (or a logged-out session) reports
      // "the value stuck" in its own browser and changes nothing anywhere else.
      const [first, ...rest] = job.items;
      if (!first) return report("parallel", [], startedAt, false, now, signal);
      const canary = await runItem({ ...base, item: first, position: 0, verifyRow: true });
      if (canary.verified) durability = "verified";
      const firstResult = settle(first, canary.result);
      const others = firstResult.ok
        ? await runPool<ExecuteItem, ItemResult>(rest, { limit: concurrency, stopOn: (r) => !r.ok, signal, skipped: skip }, async (item, position) =>
            settle(item, (await runItem({ ...base, item, position: position + 1 })).result),
          )
        : rest.map(skip);
      const results = [firstResult, ...others];
      return { ...report("parallel", results, startedAt, false, now, signal), durability };
    },
  };
}

type RowAllocator = (page: RemotePage, colHeader: string, position: number) => Promise<number>;

/**
 * Parallel sessions that each looked for "the next empty row" of a shared sheet would all pick the same one.
 * The first session to reach a cell finds the base row once; item N of the job then always writes row base + N.
 * Only one server run exists at a time (routes/execute.ts), so two runs never compute the same base.
 */
function createRowAllocator(): RowAllocator {
  let base: Promise<number> | undefined;
  return (page, colHeader, position) => (base ??= page.nextEmptyRow(colHeader)).then((row) => (row < 0 ? row : row + position));
}

interface ItemRun {
  api: BrowserbaseApi;
  connect: CdpConnector;
  sessions: Semaphore;
  sleep: (ms: number) => Promise<void>;
  /** Set for the first item only: read its row back from another session before its first irreversible step. */
  verifyRow?: boolean;
  job: ExecuteJob;
  item: ExecuteItem;
  position: number;
  rewrite: (url: string) => string;
  allowed: Set<string>;
  allocateRow: RowAllocator;
  signal?: AbortSignal;
}

/** A grid cell an item wrote, remembered so it can be read back from another session. */
interface WrittenCell {
  url: string;
  colHeader: string;
  row: number;
  value: string;
}

interface ItemOutcome {
  result: ItemResult;
  /** True when the item's row was found again from a second session. */
  verified: boolean;
}

/**
 * One billed session, always released: an open session keeps billing until its timeout.
 * `extra` is the verification browser: it opens while the first item still holds its slot, so it cannot wait for one.
 * Nothing else runs at that moment, so at most two sessions are open then, and never more than the limit afterwards.
 */
async function withSession<T>(run: ItemRun, work: (page: RemotePage) => Promise<T>, extra = false): Promise<T> {
  const free = extra ? () => undefined : await run.sessions.acquire();
  let session: BrowserbaseSession | undefined;
  let browser: RemoteBrowser | undefined;
  try {
    const stopped = stopReasonOf(run.signal);
    if (stopped) throw new StepFailure(stoppedMessage(stopped));
    session = await run.api.createSession();
    browser = await run.connect(session.connectUrl);
    return await work(await browser.page());
  } finally {
    await browser?.close().catch(() => undefined);
    if (session) await run.api.releaseSession(session.id).catch(() => undefined);
    free();
  }
}

async function runItem(run: ItemRun): Promise<ItemOutcome> {
  const { job, item } = run;
  const state: ItemState = { vars: Object.assign(Object.create(null) as Record<string, string>, item.vars), cells: [], touched: false };
  let completed = 0;
  let verified = false;
  let writing: string | undefined;
  const verifyRow = async (): Promise<void> => {
    if (!run.verifyRow || verified || state.cells.length === 0) return;
    const problem = await verifyDurable(run, state.cells);
    if (problem !== undefined) throw new StepFailure(problem);
    verified = true;
  };
  try {
    await withSession(run, async (page) => {
      for (const [stepIndex, step] of job.program.steps.entries()) {
        writing = step.op === "fill" ? fillValue(step, state.vars) : undefined;
        // Checked before EVERY step, so a cancelled run never starts another fill, click or locked action.
        const stopped = stopReasonOf(run.signal);
        if (stopped) throw new StepFailure(stoppedMessage(stopped));
        if (isIrreversibleStep(step)) await verifyRow();
        try {
          await runStep(run, page, state, step);
        } catch (err) {
          throw new StepFailure(`step ${stepIndex} (${step.op}): ${describeError(err, writing)}`);
        }
        completed++;
      }
      await verifyRow();
    });
    return { result: { index: item.index, ok: true, steps: completed, ...(state.touched ? { touched: true } : {}) }, verified };
  } catch (err) {
    return { result: { index: item.index, ok: false, steps: completed, error: describeError(err, writing), ...(state.touched ? { touched: true } : {}) }, verified };
  }
}

const VERIFY_ATTEMPTS = 3;
const VERIFY_WAIT_MS = 500;

/** Opens a second session and reads the cells back, allowing an auto-saving sheet a moment to persist. Resolves to the problem, or undefined. */
async function verifyDurable(run: ItemRun, cells: WrittenCell[]): Promise<string | undefined> {
  const missing = async (page: RemotePage): Promise<boolean> => {
    for (const cell of cells) {
      if (page.url() !== cell.url) await navigate(page, cell.url);
      if ((await page.readCell(cell.colHeader, cell.row)) !== cell.value) return true;
    }
    return false;
  };
  try {
    return await withSession(
      run,
      async (page) => {
        for (let attempt = 1; ; attempt++) {
          if (!(await missing(page))) return undefined;
          if (attempt >= VERIFY_ATTEMPTS || run.signal?.aborted) return NOT_DURABLE;
          await run.sleep(VERIFY_WAIT_MS);
          await navigate(page, cells[0]?.url ?? page.url()); // reload: the first read may have raced the save
        }
      },
      true,
    );
  } catch (err) {
    return `could not verify the first item: ${describeError(err)}`;
  }
}

interface ItemState {
  vars: Record<string, string>;
  /** The grid row this item appends into, resolved at its first cell fill. */
  row?: number;
  cells: WrittenCell[];
  touched: boolean;
}

/** A redirect can keep the path and change the site (a public URL bouncing to 169.254.169.254): origin AND path pattern must match. */
async function navigate(page: RemotePage, url: string): Promise<void> {
  await page.goto(url);
  const landed = page.url();
  if (originOfUrl(landed) !== originOfUrl(url)) throw new StepFailure("landed on a different site");
  const [wanted, got] = [pathPatternOfUrl(url), pathPatternOfUrl(landed)];
  if (wanted !== got) throw new StepFailure(`landed on ${got || "an unknown page"} instead of ${wanted}`);
}

/** Nothing is read, written or clicked on a page outside the origins the user confirmed (a click can navigate anywhere). */
function assertAllowedPage(run: ItemRun, page: RemotePage): void {
  const current = new URL(page.url());
  if (!run.allowed.has(current.origin) || isPrivateHost(current.hostname)) throw new StepFailure("the browser is on a site this loop was not recorded on");
}

function isOn(page: RemotePage, url: string): boolean {
  return originOfUrl(page.url()) === originOfUrl(url) && pathPatternOfUrl(page.url()) === pathPatternOfUrl(url);
}

/** Fills and clicks name the page they happen on. Going back to the item's own page is implicit in the program (docs/loops.md 3.3). */
async function ensurePage(run: ItemRun, page: RemotePage, at: { origin: string; pathPattern: string } | undefined): Promise<void> {
  if (!at || isOn(page, run.rewrite(at.origin + at.pathPattern))) return;
  if (at.pathPattern === run.job.program.iterator.itemPathPattern) return navigate(page, run.rewrite(run.item.url));
  if (!at.pathPattern.includes(":id")) return navigate(page, run.rewrite(at.origin + at.pathPattern));
  throw new StepFailure(`expected to be on ${at.pathPattern}`);
}

async function runStep(run: ItemRun, page: RemotePage, state: ItemState, step: ServerLoopStep): Promise<void> {
  // Second line of defence behind assertConfirmed: a locked step never runs without the batch confirmation.
  if (isIrreversibleStep(step) && !run.job.confirmIrreversible) throw new StepFailure("locked step needs the batch confirmation");
  if (isEffectStep(step)) state.touched = true;
  switch (step.op) {
    case "open-item":
      return navigate(page, run.rewrite(run.item.url));
    case "goto":
      return navigate(page, run.rewrite(step.url));
    case "extract": {
      if (ownVar(state.vars, step.var) !== undefined) return; // the preview's dry run already read it
      assertAllowedPage(run, page);
      const text = await page.readText(step.from.locator);
      // The closed list of loop/transforms.ts, exactly as it was verified at synthesis time. An unknown transform is null, never a guess.
      const value = text === null ? null : applyLoopTransform(text, step.from.transform);
      if (value === null) throw new StepFailure(`no value found for ${step.var}`);
      state.vars[step.var] = value;
      return;
    }
    case "fill": {
      if (isSensitive({ label: step.target.label })) throw new StepFailure("sensitive fields are never filled");
      const value = fillValue(step, state.vars);
      if (value === undefined) throw new StepFailure("the item has no value for this field");
      await ensurePage(run, page, step.at);
      assertAllowedPage(run, page);
      if (step.target.cell) {
        state.row ??= await run.allocateRow(page, step.target.cell.colHeader, run.position);
        if (state.row < 0) throw new StepFailure(`no empty row in column ${step.target.cell.colHeader}`);
      }
      const stuck = await page.fill(step.target, value, step.target.cell ? state.row : undefined);
      if (stuck !== value) throw new StepFailure("the value did not stick");
      if (step.target.cell && state.row !== undefined) state.cells.push({ url: page.url(), colHeader: step.target.cell.colHeader, row: state.row, value });
      return;
    }
    case "click":
      await ensurePage(run, page, step.at);
      assertAllowedPage(run, page);
      return page.click(step.target);
  }
}
