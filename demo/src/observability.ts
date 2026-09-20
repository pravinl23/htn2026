/**
 * Sentry for the demo site (Sentry project "ghost-web"): error monitoring, tracing, logs and Session Replay.
 *
 * Why Session Replay is the product beat here: Shabang's claim is that a ghost appears instantly and Tab walks
 * the form. A replay is the only artefact that shows that happening, frame by frame, next to the trace that
 * says how long it took.
 *
 * Two rules this file exists to enforce:
 *
 * 1. **No DSN, no Sentry.** The DSN arrives as `VITE_SENTRY_DSN` at build time (Vercel env var, or
 *    `SENTRY_WEB_DSN` from the repo-root `.env`, mapped in `vite.config.ts`). Without it `initObservability`
 *    returns false and never calls `Sentry.init`, so unit tests and a plain `pnpm dev` make zero network calls.
 * 2. **Names, counts, durations and booleans only.** Replay masks every input, blocks everything marked
 *    sensitive, and captures no request or response bodies. Six hooks scrub what is left, because each
 *    envelope type leaves by a different door: `beforeSend` (errors), `beforeSendTransaction` and
 *    `beforeSendSpan` (traces - browser tracing names its spans after the full URL), `beforeBreadcrumb`,
 *    `beforeSendLog`, `beforeAddRecordingEvent` (the replay's own frames) and one global event processor
 *    for the events that pass none of those, such as a replay event's list of visited URLs. A field value,
 *    a label or a learned answer must never reach Sentry.
 *
 * Known gap: rrweb writes `location.href` into the replay's meta frame before any SDK callback can see it,
 * so a query string someone types into the address bar of the demo reaches that one field. The demo itself
 * never puts a value in a URL (its only parameter is `?reset=1`).
 */
import * as Sentry from "@sentry/react";
import type { Breadcrumb, BrowserOptions, ErrorEvent, Log, ReplayFrameEvent } from "@sentry/react";

/** The deployed demo, watched by the Sentry uptime monitor. */
export const PUBLIC_DEMO_ORIGIN = "https://whitespace-delta.vercel.app";

/** The Shabang extension's overlay host, and the attributes it mirrors its state onto (`extension/src/content/overlay.ts`). */
export const SHABANG_HOST_SELECTOR = "#ghost-overlay-host, [data-ghost-state]";
const GHOST_STATE_ATTR = "data-ghost-state";
const GHOST_COUNT_ATTR = "data-ghost-count";

/** Form controls that count as "the form is ready to be walked". Buttons do not; a field is what a ghost fills. */
const FIELD_SELECTOR = "form input, form textarea, form select";

/**
 * Never recorded in a replay: passwords, payment cards, one-time codes, and anything a page marked sensitive.
 * The same list is used to block (the element becomes an empty placeholder), to mask (text is replaced) and to
 * ignore (input events are not recorded at all), so no single option being wrong can leak one of these.
 */
export const SENSITIVE_SELECTORS: readonly string[] = [
  'input[type="password"]',
  '[autocomplete^="cc-"]',
  '[autocomplete="current-password"]',
  '[autocomplete="new-password"]',
  '[autocomplete="one-time-code"]',
  "[data-ghost-sensitive]",
  "[data-sensitive]",
];

/** Where a browser trace may carry `sentry-trace` / `baggage` so it links up with the Node server's trace. */
export const TRACE_PROPAGATION_TARGETS: readonly (string | RegExp)[] = [
  "localhost",
  "127.0.0.1",
  /^https:\/\/whitespace-delta\.vercel\.app/,
];

/** Custom spans this page emits. Both are value-free: a name, a count and a duration. */
export const SPAN_FORM_READY = "ghost.demo.form-ready";
export const SPAN_FIRST_GHOST = "ghost.demo.first-ghost";

/** After this long with no ghost, stop watching and log the miss (the "why was there no ghost" line). */
export const WALK_WATCH_TIMEOUT_MS = 30_000;
const WALK_POLL_MS = 250;

// ---------- the scrubber ----------

/**
 * Attribute and tag keys that may leave the browser. Everything else is dropped, whatever it holds: the
 * allowlist is the rule, and a new counter has to be added here on purpose.
 */
export const ALLOWED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set([
  "ghost.form.fields",
  "ghost.form.ready_ms",
  "ghost.count",
  "ghost.first_ms",
  "ghost.since_form_ms",
  "ghost.seen",
  "ghost.host_present",
  "ghost.surface",
  "demo.route",
  "http.response.status_code",
  "http.request.method",
]);

/** A value small and shaped enough to be a name, a count, a duration or a flag; never prose and never a value. */
const ENUM_STRING = /^[A-Za-z0-9._:/-]{1,40}$/;

export type SafeValue = string | number | boolean;

/** Keeps allowlisted keys whose value is a number, a boolean or a short enum-shaped string. Drops the rest. */
export function safeAttributes(raw: unknown): Record<string, SafeValue> {
  const out: Record<string, SafeValue> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && ENUM_STRING.test(value)) out[key] = value;
  }
  return out;
}

/** Origin and path only: a query string, a fragment and any user info in the URL are dropped. */
export function scrubUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "";
  const path = raw.split("#")[0]?.split("?")[0] ?? "";
  return path.replace(/\/\/[^/@]*@/, "//").slice(0, 200);
}

/**
 * Breadcrumbs are where a browser SDK leaks by accident: console arguments, fetch bodies, full URLs.
 * Console crumbs are dropped outright; the rest keep a scrubbed URL, a method, a status code and nothing else.
 */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category === "console") return null;
  const data = typeof crumb.data === "object" && crumb.data !== null ? (crumb.data as Record<string, unknown>) : null;
  const clean: Record<string, SafeValue> = {};
  if (data) {
    for (const key of ["url", "from", "to"]) {
      const url = scrubUrl(data[key]);
      if (url) clean[key] = url;
    }
    if (typeof data["method"] === "string" && ENUM_STRING.test(data["method"])) clean["method"] = data["method"];
    if (typeof data["status_code"] === "number") clean["status_code"] = data["status_code"];
  }
  const out: Breadcrumb = { ...crumb };
  delete out.data;
  if (Object.keys(clean).length > 0) out.data = clean;
  if (typeof out.message === "string") out.message = out.message.slice(0, 200);
  return out;
}

/**
 * `beforeSend`. Keeps the error itself (that is the point) and throws away everything around it that could
 * carry what the user typed: request body and query string, headers and cookies, user identity, `extra`.
 */
export function scrubEvent<T extends ErrorEvent>(event: T): T | null {
  const out: T = { ...event };
  delete out.user;
  delete out.extra;
  delete out.server_name;
  if (out.request) out.request = { url: scrubUrl(out.request.url) };
  if (typeof out.transaction === "string") out.transaction = scrubUrl(out.transaction);
  if (out.tags) out.tags = safeAttributes(out.tags);
  if (out.breadcrumbs) {
    out.breadcrumbs = out.breadcrumbs
      .map((crumb) => scrubBreadcrumb(crumb))
      .filter((crumb): crumb is Breadcrumb => crumb !== null);
  }
  const trace = out.contexts?.trace;
  if (trace?.data) out.contexts = { ...out.contexts, trace: { ...trace, data: safeAttributes(trace.data) } };
  return out;
}

/** `beforeSendLog`. Our own log lines are constants; their attributes still go through the allowlist. */
export function scrubLog(log: Log): Log | null {
  return { ...log, message: log.message.slice(0, 200), attributes: safeAttributes(log.attributes) };
}

/** Span data keys that hold a URL, and keys that hold a query string or a body and are dropped outright. */
const URL_DATA_KEYS = ["url.full", "http.url", "url", "url.path", "from", "to", "http.request.url"];
const DROP_DATA_KEYS = ["url.query", "http.query", "query", "query_string", "http.request.body", "http.response.body", "body"];

function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/|\/)/.test(value);
}

/** Strips the query string out of every URL an auto-instrumented span carries, and drops bodies. */
export function scrubSpanData(data: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = typeof data === "object" && data !== null ? { ...(data as Record<string, unknown>) } : {};
  for (const key of DROP_DATA_KEYS) delete out[key];
  for (const key of URL_DATA_KEYS) {
    const value = out[key];
    if (typeof value === "string" && looksLikeUrl(value)) out[key] = scrubUrl(value);
  }
  return out;
}

/**
 * `beforeSendSpan`. Browser tracing names its spans after the full URL, query string included, so this is
 * the hook that keeps `?email=...` out of a trace. It runs on streamed spans as well as on the spans
 * inside a transaction.
 */
export function scrubSpan<T extends { description?: string; data?: unknown }>(span: T): T {
  const out: T = { ...span, data: scrubSpanData(span.data) };
  if (typeof out.description === "string" && looksLikeUrl(out.description)) out.description = scrubUrl(out.description);
  return out;
}

/** `beforeSendTransaction`. The same treatment for the transaction itself and everything hanging off it. */
export function scrubTransaction<T extends { transaction?: string; request?: { url?: string }; user?: unknown; extra?: unknown; spans?: unknown[]; contexts?: Record<string, unknown> }>(event: T): T | null {
  const out: T = { ...event };
  delete out.user;
  delete out.extra;
  if (out.request) out.request = { url: scrubUrl(out.request.url) };
  if (typeof out.transaction === "string" && looksLikeUrl(out.transaction)) out.transaction = scrubUrl(out.transaction);
  if (Array.isArray(out.spans)) out.spans = out.spans.map((span) => scrubSpan(span as { description?: string; data?: unknown }));
  const trace = out.contexts?.["trace"] as { data?: unknown } | undefined;
  if (trace) out.contexts = { ...out.contexts, trace: { ...trace, data: scrubSpanData(trace.data) } };
  return out;
}

// ---------- configuration ----------

export interface DemoEnv {
  /** Empty means "Sentry is off": nothing is initialised and nothing is sent. */
  dsn: string;
  environment: string;
  release?: string;
}

/** Vite replaces `import.meta.env.VITE_SENTRY_DSN` at build time (see `vite.config.ts`). */
export function readEnv(env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>): DemoEnv {
  const dsn = typeof env["VITE_SENTRY_DSN"] === "string" ? env["VITE_SENTRY_DSN"].trim() : "";
  const mode = typeof env["MODE"] === "string" ? env["MODE"] : "development";
  const release = typeof env["VITE_SENTRY_RELEASE"] === "string" ? env["VITE_SENTRY_RELEASE"].trim() : "";
  const out: DemoEnv = { dsn, environment: mode };
  if (release) out.release = release;
  return out;
}

/** An rrweb recording event as it reaches `beforeAddRecordingEvent`. Type 4 is the meta frame, which holds the page URL. */
export interface RecordingEventLike {
  type?: number;
  data?: unknown;
}
const RRWEB_META = 4;
const RRWEB_CUSTOM = 5;

/**
 * The page URL travels inside the recording as well. This cleans the frames the SDK lets us see: its own
 * custom frames (type 5), which is where a navigation span or a breadcrumb carries a full URL. The SDK only
 * offers this callback for custom frames, so rrweb's own meta frame (type 4) is handled here for the day
 * that changes, and is otherwise the one URL the demo cannot rewrite - see the note in the README.
 */
export function scrubRecordingEvent(event: RecordingEventLike): RecordingEventLike {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data) return event;
  if (event.type === RRWEB_META && typeof data["href"] === "string") {
    return { ...event, data: { ...data, href: scrubUrl(data["href"]) } };
  }
  const payload = data["payload"];
  if (event.type !== RRWEB_CUSTOM || typeof payload !== "object" || payload === null) return event;
  const clean: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const key of ["description", "message", "name"]) {
    const value = clean[key];
    if (typeof value === "string" && looksLikeUrl(value)) clean[key] = scrubUrl(value);
  }
  if (clean["data"] !== undefined) clean["data"] = scrubSpanData(clean["data"]);
  return { ...event, data: { ...data, payload: clean } };
}

/**
 * A global event processor, so the events that do not pass through `beforeSend` (a replay event, which
 * carries the list of URLs the session visited) are cleaned as well.
 */
export function scrubProcessedEvent(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...event };
  delete out["user"];
  const request = out["request"] as { url?: unknown } | undefined;
  if (request && typeof request === "object") out["request"] = { url: scrubUrl(request.url) };
  const urls = out["urls"];
  if (Array.isArray(urls)) out["urls"] = urls.map((url) => scrubUrl(url));
  return out;
}

export interface ReplayPrivacy {
  maskAllInputs: boolean;
  maskAllText: boolean;
  blockAllMedia: boolean;
  block: string[];
  mask: string[];
  ignore: string[];
  networkDetailAllowUrls: string[];
  networkCaptureBodies: boolean;
}

/**
 * Replay privacy. `maskAllInputs` is what keeps typed and ghost-filled values out of the recording; page text
 * stays visible on purpose, because the demo pages hold fictional content and a masked page would show a judge
 * nothing. Anything sensitive is blocked, masked AND ignored, and no request or response body is ever captured.
 */
export function replayPrivacy(): ReplayPrivacy {
  return {
    maskAllInputs: true,
    maskAllText: false,
    blockAllMedia: true,
    block: [...SENSITIVE_SELECTORS],
    mask: [...SENSITIVE_SELECTORS],
    ignore: [...SENSITIVE_SELECTORS],
    networkDetailAllowUrls: [],
    networkCaptureBodies: false,
  };
}

/** The SDK's own `Integration` type, without depending on where the package happens to export it from. */
export type SentryIntegration = Extract<NonNullable<BrowserOptions["integrations"]>, readonly unknown[]>[number];

/** What the replay integration is given: the privacy config plus the recording-event scrubber. */
export type ReplayOptions = ReplayPrivacy & { beforeAddRecordingEvent: (event: ReplayFrameEvent) => ReplayFrameEvent };

/** The slice of the SDK this module uses, injectable so tests can assert the wiring without a network. */
export interface SentryApi {
  init(options: BrowserOptions): unknown;
  browserTracingIntegration(): SentryIntegration;
  replayIntegration(options: ReplayOptions): SentryIntegration;
  addEventProcessor(processor: (event: Record<string, unknown>) => Record<string, unknown>): void;
}

const DEFAULT_API: SentryApi = {
  init: (options) => Sentry.init(options),
  browserTracingIntegration: () => Sentry.browserTracingIntegration(),
  replayIntegration: (options) => Sentry.replayIntegration(options),
  addEventProcessor: (processor) => Sentry.addEventProcessor((event) => processor(event as unknown as Record<string, unknown>) as unknown as typeof event),
};

/** Everything `Sentry.init` is given. Pure, so a test can read every decision back out of it. */
export function sentryOptions(env: DemoEnv, api: SentryApi = DEFAULT_API): BrowserOptions {
  const options: BrowserOptions = {
    dsn: env.dsn,
    environment: env.environment,
    // The demo is a demo: every session is traced and replayed, so nothing a judge does is missed.
    tracesSampleRate: 1.0,
    replaysSessionSampleRate: 1.0,
    replaysOnErrorSampleRate: 1.0,
    tracePropagationTargets: [...TRACE_PROPAGATION_TARGETS],
    enableLogs: true,
    // No IP address, no cookies, no headers: the browser SDK must not decide on its own what is personal.
    sendDefaultPii: false,
    integrations: [
      api.browserTracingIntegration(),
      api.replayIntegration({
        ...replayPrivacy(),
        beforeAddRecordingEvent: (event) => scrubRecordingEvent(event as unknown as RecordingEventLike) as unknown as ReplayFrameEvent,
      }),
    ],
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubTransaction(event),
    beforeSendSpan: (span) => scrubSpan(span),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    beforeSendLog: (log) => scrubLog(log),
  };
  if (env.release) options.release = env.release;
  return options;
}

/** True when Sentry was initialised. False (and completely silent) when no DSN was built in. */
export function initObservability(env: DemoEnv = readEnv(), api: SentryApi = DEFAULT_API): boolean {
  if (!env.dsn) return false;
  api.init(sentryOptions(env, api));
  api.addEventProcessor(scrubProcessedEvent);
  return true;
}

// ---------- the two walk moments ----------

export interface AttrNode {
  getAttribute(name: string): string | null;
}

export interface QueryRoot {
  querySelector(selectors: string): AttrNode | null;
  querySelectorAll(selectors: string): ArrayLike<unknown>;
}

/** How many fillable controls the page offers. A count, never a label. */
export function countFormFields(root: Pick<QueryRoot, "querySelectorAll">): number {
  try {
    return root.querySelectorAll(FIELD_SELECTOR).length;
  } catch {
    return 0;
  }
}

/** Ghosts currently drawn, read off the overlay host's own test hooks. */
export function ghostCount(host: AttrNode | null): number {
  if (!host) return 0;
  const raw = host.getAttribute(GHOST_COUNT_ATTR);
  const count = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/** True once the overlay says at least one ghost is on screen. */
export function ghostHostReady(host: AttrNode | null): boolean {
  if (!host) return false;
  return host.getAttribute(GHOST_STATE_ATTR) === "ready" || ghostCount(host) > 0;
}

export interface SpanLike {
  setAttributes(attributes: Record<string, SafeValue>): unknown;
  end(): void;
}

export interface WalkSpanApi {
  startSpan(name: string): SpanLike;
  log(level: "info" | "warn", message: string, attributes: Record<string, SafeValue>): void;
  now(): number;
}

export const defaultWalkSpanApi: WalkSpanApi = {
  // forceTransaction: the first ghost often arrives after the pageload span has closed, and a child of a
  // closed root is dropped. Its own transaction keeps the same trace id, so the trace still lines up.
  startSpan: (name) => Sentry.startInactiveSpan({ name, op: "ui.ghost", forceTransaction: true }),
  log: (level, message, attributes) => {
    if (level === "warn") Sentry.logger.warn(message, attributes);
    else Sentry.logger.info(message, attributes);
  },
  now: () => Date.now(),
};

export interface WalkWatchOptions {
  api?: WalkSpanApi;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Times the demo page's own two moments and reports them as spans: the form being ready to walk, and the
 * first ghost becoming visible. Both carry counts and durations only. Returns a stop function.
 *
 * The page cannot see inside the extension, so "first ghost" is read from the overlay host's public
 * `data-ghost-state` / `data-ghost-count` attributes. When no ghost ever appears, that is logged once, which
 * is the demo-side half of "why was there no ghost".
 */
export function watchWalkMoments(doc: Document, options: WalkWatchOptions = {}): () => void {
  const api = options.api ?? defaultWalkSpanApi;
  const started = api.now();
  const formSpan = api.startSpan(SPAN_FORM_READY);
  const ghostSpan = api.startSpan(SPAN_FIRST_GHOST);
  let formReadyAt: number | null = null;
  let fields = 0;
  let stopped = false;

  const observer = typeof MutationObserver === "function" ? new MutationObserver(() => check()) : null;
  const timer = setInterval(() => check(), options.pollMs ?? WALK_POLL_MS);
  const deadline = setTimeout(() => {
    if (stopped) return;
    const host = doc.querySelector(SHABANG_HOST_SELECTOR);
    api.log("warn", "no ghost appeared", {
      "ghost.form.fields": fields,
      "ghost.host_present": host !== null,
      "ghost.seen": false,
    });
    stop();
  }, options.timeoutMs ?? WALK_WATCH_TIMEOUT_MS);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    clearInterval(timer);
    clearTimeout(deadline);
  }

  function check(): void {
    if (stopped) return;
    if (formReadyAt === null) {
      const count = countFormFields(doc);
      if (count > 0) {
        formReadyAt = api.now();
        fields = count;
        formSpan.setAttributes({ "ghost.form.fields": count, "ghost.form.ready_ms": Math.round(formReadyAt - started) });
        formSpan.end();
        api.log("info", "demo form ready", { "ghost.form.fields": count, "ghost.form.ready_ms": Math.round(formReadyAt - started) });
      }
    }
    const host = doc.querySelector(SHABANG_HOST_SELECTOR);
    if (!ghostHostReady(host)) return;
    const at = api.now();
    const attributes: Record<string, SafeValue> = {
      "ghost.count": ghostCount(host),
      "ghost.first_ms": Math.round(at - started),
      "ghost.seen": true,
    };
    if (formReadyAt !== null) attributes["ghost.since_form_ms"] = Math.round(at - formReadyAt);
    ghostSpan.setAttributes(attributes);
    ghostSpan.end();
    api.log("info", "first ghost visible", attributes);
    stop();
  }

  observer?.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [GHOST_STATE_ATTR, GHOST_COUNT_ATTR],
  });
  check();
  return stop;
}
