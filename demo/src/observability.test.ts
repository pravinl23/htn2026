import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_ATTRIBUTE_KEYS, PUBLIC_DEMO_ORIGIN, SENSITIVE_SELECTORS, countFormFields, ghostCount, ghostHostReady,
  initObservability, readEnv, replayPrivacy, safeAttributes, scrubBreadcrumb, scrubEvent, scrubLog, scrubSpan,
  scrubProcessedEvent, scrubRecordingEvent, scrubTransaction, scrubUrl,
  sentryOptions, watchWalkMoments,
} from "./observability";
import type { AttrNode, ReplayPrivacy, SentryApi, SentryIntegration, SpanLike, WalkSpanApi } from "./observability";
import type { Breadcrumb, BrowserOptions, ErrorEvent, Log } from "@sentry/react";

const DSN = "https://publickey@o0.ingest.sentry.io/1";

function fakeApi(): { api: SentryApi; init: ReturnType<typeof vi.fn>; replay: ReturnType<typeof vi.fn>; processors: Array<(event: Record<string, unknown>) => Record<string, unknown>> } {
  const init = vi.fn();
  const replay = vi.fn((options: ReplayPrivacy) => ({ name: "Replay", options }));
  const processors: Array<(event: Record<string, unknown>) => Record<string, unknown>> = [];
  const api: SentryApi = {
    init: (options: BrowserOptions) => init(options),
    browserTracingIntegration: () => ({ name: "BrowserTracing" }) as unknown as SentryIntegration,
    replayIntegration: (options) => replay(options) as unknown as SentryIntegration,
    addEventProcessor: (processor) => processors.push(processor),
  };
  return { api, init, replay, processors };
}

describe("replay privacy", () => {
  it("never records what is typed into an input", () => {
    const privacy = replayPrivacy();
    expect(privacy.maskAllInputs).toBe(true);
    expect(privacy.networkCaptureBodies).toBe(false);
    expect(privacy.networkDetailAllowUrls).toEqual([]);
    expect(privacy.blockAllMedia).toBe(true);
  });

  it("blocks, masks and ignores every sensitive selector", () => {
    const privacy = replayPrivacy();
    for (const selector of SENSITIVE_SELECTORS) {
      expect(privacy.block).toContain(selector);
      expect(privacy.mask).toContain(selector);
      expect(privacy.ignore).toContain(selector);
    }
    expect(SENSITIVE_SELECTORS).toContain('input[type="password"]');
    expect(SENSITIVE_SELECTORS).toContain('[autocomplete^="cc-"]');
    expect(SENSITIVE_SELECTORS).toContain("[data-ghost-sensitive]");
  });

  it("hands exactly that privacy config to replayIntegration", () => {
    const { api, replay } = fakeApi();
    sentryOptions({ dsn: DSN, environment: "test" }, api);
    expect(replay.mock.calls[0]?.[0]).toMatchObject(replayPrivacy());
    expect(typeof replay.mock.calls[0]?.[0]?.beforeAddRecordingEvent).toBe("function");
  });

  it("takes the query string out of the URL the recording itself carries", () => {
    const meta = { type: 4, data: { href: "https://demo.test/apply?email=alex%40chen.dev", width: 1200, height: 800 } };
    expect(scrubRecordingEvent(meta)).toEqual({ type: 4, data: { href: "https://demo.test/apply", width: 1200, height: 800 } });
    const incremental = { type: 3, data: { source: 2, id: 7 } };
    expect(scrubRecordingEvent(incremental)).toBe(incremental);
  });

  it("scrubs the events that never reach beforeSend, like a replay event", () => {
    const { api, processors } = fakeApi();
    initObservability({ dsn: DSN, environment: "test" }, api);
    expect(processors).toHaveLength(1);
    const out = processors[0]?.({
      type: "replay_event",
      urls: ["https://demo.test/apply?email=alex%40chen.dev", "https://demo.test/sheet"],
      request: { url: "https://demo.test/apply?token=secret", headers: { Cookie: "s=1" } },
      user: { email: "alex@chen.dev" },
    });
    expect(out?.["urls"]).toEqual(["https://demo.test/apply", "https://demo.test/sheet"]);
    expect(out?.["request"]).toEqual({ url: "https://demo.test/apply" });
    expect(out?.["user"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("alex");
  });
});

describe("init", () => {
  it("makes no call at all without a DSN", () => {
    const { api, init, replay } = fakeApi();
    expect(initObservability({ dsn: "", environment: "test" }, api)).toBe(false);
    expect(init).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
  });

  it("initialises once with tracing, replay and logs when a DSN is built in", () => {
    const { api, init } = fakeApi();
    expect(initObservability({ dsn: DSN, environment: "production", release: "abc123" }, api)).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0]?.[0] as BrowserOptions;
    expect(options.dsn).toBe(DSN);
    expect(options.release).toBe("abc123");
    expect(options.tracesSampleRate).toBe(1.0);
    expect(options.replaysSessionSampleRate).toBe(1.0);
    expect(options.replaysOnErrorSampleRate).toBe(1.0);
    expect(options.enableLogs).toBe(true);
    expect(options.sendDefaultPii).toBe(false);
    expect((options.integrations as Array<{ name: string }>).map((i) => i.name)).toEqual(["BrowserTracing", "Replay"]);
  });

  it("propagates the trace to localhost and to the public demo", () => {
    const targets = sentryOptions({ dsn: DSN, environment: "test" }, fakeApi().api).tracePropagationTargets ?? [];
    expect(targets).toContain("localhost");
    expect(targets.some((t) => t instanceof RegExp && t.test(`${PUBLIC_DEMO_ORIGIN}/apply`))).toBe(true);
  });

  it("reads an empty DSN out of an env without one", () => {
    expect(readEnv({}).dsn).toBe("");
    expect(readEnv({ VITE_SENTRY_DSN: "  " }).dsn).toBe("");
    expect(readEnv({ VITE_SENTRY_DSN: DSN, MODE: "production" })).toEqual({ dsn: DSN, environment: "production" });
  });
});

describe("the scrubber", () => {
  it("drops the query string, the fragment and any user info in a URL", () => {
    expect(scrubUrl("https://demo.test/apply?email=alex%40chen.dev&token=abc#name")).toBe("https://demo.test/apply");
    expect(scrubUrl("https://alex:hunter2@demo.test/apply")).toBe("https://demo.test/apply");
    expect(scrubUrl(undefined)).toBe("");
    expect(scrubUrl(12)).toBe("");
  });

  it("keeps only allowlisted, enum-shaped attributes", () => {
    const hostile = {
      "ghost.count": 3,
      "ghost.seen": true,
      "ghost.form.fields": Number.NaN,
      "ghost.surface": "web",
      "ghost.value": "Alex Chen",
      "field.label": "Email address",
      "demo.route": "/apply",
      __proto__: { polluted: true },
    };
    expect(safeAttributes(hostile)).toEqual({ "ghost.count": 3, "ghost.seen": true, "ghost.surface": "web", "demo.route": "/apply" });
    expect(safeAttributes("not an object")).toEqual({});
    expect(safeAttributes(null)).toEqual({});
    for (const key of ["ghost.value", "field.label", "answer", "url"]) expect(ALLOWED_ATTRIBUTE_KEYS.has(key)).toBe(false);
  });

  it("refuses an allowlisted key whose value reads like prose", () => {
    expect(safeAttributes({ "ghost.surface": "the user typed alex@chen.dev into the email field" })).toEqual({});
  });

  it("strips the body, the identity and the console out of an error event", () => {
    const event = {
      type: undefined,
      user: { email: "alex@chen.dev", ip_address: "1.2.3.4" },
      extra: { value: "Alex Chen" },
      server_name: "laptop",
      transaction: "/apply?email=alex%40chen.dev",
      tags: { "ghost.count": 2, "ghost.value": "Alex Chen" },
      request: { url: "https://demo.test/apply?token=abc", query_string: "token=abc", data: { fullName: "Alex Chen" }, headers: { Cookie: "s=1" } },
      breadcrumbs: [
        { category: "console", message: "filled fullName with Alex Chen" },
        { category: "fetch", data: { url: "https://demo.test/api?q=alex%40chen.dev", method: "POST", status_code: 200, body: "{\"fullName\":\"Alex Chen\"}" } },
      ],
      contexts: { trace: { trace_id: "t", span_id: "s", data: { "ghost.count": 1, "ghost.value": "Alex Chen" } } },
    } as unknown as ErrorEvent;

    const out = scrubEvent(event);
    const json = JSON.stringify(out);
    expect(json).not.toContain("alex@chen.dev");
    expect(json).not.toContain("Alex Chen");
    expect(json).not.toContain("token=abc");
    expect(out?.user).toBeUndefined();
    expect(out?.extra).toBeUndefined();
    expect(out?.request).toEqual({ url: "https://demo.test/apply" });
    expect(out?.transaction).toBe("/apply");
    expect(out?.tags).toEqual({ "ghost.count": 2 });
    expect(out?.breadcrumbs).toHaveLength(1);
    expect(out?.breadcrumbs?.[0]?.data).toEqual({ url: "https://demo.test/api", method: "POST", status_code: 200 });
    expect(out?.contexts?.trace?.data).toEqual({ "ghost.count": 1 });
  });

  it("keeps the query string out of an auto-instrumented span", () => {
    const span = {
      op: "browser.request",
      description: "http://localhost:5199/apply?email=alex%40chen.dev&token=secret",
      data: {
        "url.full": "http://localhost:5199/apply?email=alex%40chen.dev",
        "url.query": "?email=alex%40chen.dev",
        "http.response.status_code": 200,
        "server.address": "localhost:5199",
        body: "{\"fullName\":\"Alex Chen\"}",
      },
    };
    const out = scrubSpan(span);
    expect(out.description).toBe("http://localhost:5199/apply");
    expect(out.data).toEqual({ "url.full": "http://localhost:5199/apply", "http.response.status_code": 200, "server.address": "localhost:5199" });
    expect(JSON.stringify(out)).not.toContain("alex");
    expect(JSON.stringify(out)).not.toContain("Alex Chen");
  });

  it("leaves a description that is not a URL alone", () => {
    expect(scrubSpan({ description: "Main UI thread blocked", data: {} }).description).toBe("Main UI thread blocked");
  });

  it("scrubs the transaction, its trace data and every span under it", () => {
    const event = {
      transaction: "/apply?email=alex%40chen.dev",
      request: { url: "http://localhost:5199/apply?token=secret" },
      user: { email: "alex@chen.dev" },
      extra: { typed: "Alex Chen" },
      contexts: { trace: { data: { "url.full": "http://localhost:5199/apply?token=secret", "sentry.op": "pageload" } } },
      spans: [{ op: "resource.link", description: "http://localhost:5199/a.css?v=alex%40chen.dev", data: { "url.query": "?v=alex" } }],
    };
    const out = scrubTransaction(event);
    const json = JSON.stringify(out);
    expect(json).not.toContain("alex");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("Alex Chen");
    expect(out?.transaction).toBe("/apply");
    expect((out?.contexts?.["trace"] as { data: Record<string, unknown> }).data).toEqual({ "url.full": "http://localhost:5199/apply", "sentry.op": "pageload" });
  });

  it("wires all five scrub hooks into init", () => {
    const options = sentryOptions({ dsn: DSN, environment: "test" }, fakeApi().api);
    expect(typeof options.beforeSend).toBe("function");
    expect(typeof options.beforeSendTransaction).toBe("function");
    expect(typeof options.beforeSendSpan).toBe("function");
    expect(typeof options.beforeBreadcrumb).toBe("function");
    expect(typeof options.beforeSendLog).toBe("function");
  });

  it("drops console breadcrumbs outright", () => {
    expect(scrubBreadcrumb({ category: "console", message: "Alex Chen" } as Breadcrumb)).toBeNull();
  });

  it("allowlists log attributes too", () => {
    const log = { level: "info", message: "first ghost visible", attributes: { "ghost.count": 4, "ghost.value": "Alex Chen" } } as unknown as Log;
    expect(scrubLog(log)?.attributes).toEqual({ "ghost.count": 4 });
  });
});

describe("walk moments", () => {
  const host = (attrs: Record<string, string>): AttrNode => ({ getAttribute: (name) => attrs[name] ?? null });

  it("reads the overlay's public state, not its contents", () => {
    expect(ghostHostReady(null)).toBe(false);
    expect(ghostHostReady(host({}))).toBe(false);
    expect(ghostHostReady(host({ "data-ghost-state": "idle", "data-ghost-count": "0" }))).toBe(false);
    expect(ghostHostReady(host({ "data-ghost-state": "ready" }))).toBe(true);
    expect(ghostHostReady(host({ "data-ghost-count": "7" }))).toBe(true);
    expect(ghostCount(host({ "data-ghost-count": "7" }))).toBe(7);
    expect(ghostCount(host({ "data-ghost-count": "nope" }))).toBe(0);
  });

  it("counts fields without reading them", () => {
    expect(countFormFields({ querySelectorAll: () => ({ length: 12 }) })).toBe(12);
    expect(countFormFields({ querySelectorAll: () => { throw new Error("detached"); } })).toBe(0);
  });

  it("ends both spans with counts and durations only", () => {
    const spans = new Map<string, { attributes: Record<string, unknown>; ended: boolean }>();
    const logs: Array<{ level: string; message: string; attributes: Record<string, unknown> }> = [];
    let clock = 1000;
    let ready = false;
    const api: WalkSpanApi = {
      startSpan: (name) => {
        const span = { attributes: {} as Record<string, unknown>, ended: false };
        spans.set(name, span);
        const like: SpanLike = {
          setAttributes: (attributes) => Object.assign(span.attributes, attributes),
          end: () => { span.ended = true; },
        };
        return like;
      },
      log: (level, message, attributes) => { logs.push({ level, message, attributes }); },
      now: () => clock,
    };
    const doc = {
      documentElement: {},
      querySelectorAll: () => ({ length: 9 }),
      querySelector: () => (ready ? host({ "data-ghost-state": "ready", "data-ghost-count": "9" }) : null),
    } as unknown as Document;

    const stop = watchWalkMoments(doc, { api, pollMs: 1, timeoutMs: 60_000 });
    expect(spans.get("ghost.demo.form-ready")?.ended).toBe(true);
    expect(spans.get("ghost.demo.form-ready")?.attributes).toEqual({ "ghost.form.fields": 9, "ghost.form.ready_ms": 0 });
    expect(spans.get("ghost.demo.first-ghost")?.ended).toBe(false);

    clock = 1180;
    ready = true;
    watchWalkMoments(doc, { api, pollMs: 1, timeoutMs: 60_000 })();
    const first = spans.get("ghost.demo.first-ghost");
    expect(first?.ended).toBe(true);
    expect(first?.attributes).toEqual({ "ghost.count": 9, "ghost.first_ms": 0, "ghost.seen": true, "ghost.since_form_ms": 0 });
    for (const entry of logs) expect(Object.keys(entry.attributes).every((key) => ALLOWED_ATTRIBUTE_KEYS.has(key))).toBe(true);
    stop();
  });

  it("says once, in a log, that no ghost ever appeared", () => {
    vi.useFakeTimers();
    const logs: Array<{ level: string; message: string; attributes: Record<string, unknown> }> = [];
    const spans: SpanLike[] = [];
    const api: WalkSpanApi = {
      startSpan: () => {
        const span: SpanLike = { setAttributes: () => undefined, end: () => { throw new Error("must not end a span for a ghost that never came"); } };
        spans.push(span);
        return span;
      },
      log: (level, message, attributes) => { logs.push({ level, message, attributes }); },
      now: () => 0,
    };
    const doc = { documentElement: {}, querySelectorAll: () => ({ length: 0 }), querySelector: () => null } as unknown as Document;

    watchWalkMoments(doc, { api, pollMs: 1000, timeoutMs: 100 });
    vi.advanceTimersByTime(500);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "warn", message: "no ghost appeared" });
    expect(logs[0]?.attributes).toEqual({ "ghost.form.fields": 0, "ghost.host_present": false, "ghost.seen": false });
    vi.useRealTimers();
  });
});
