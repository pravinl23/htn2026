import type { Answers, CapturedField, DecisionProvider, DecisionResult, FieldKind, Questions } from "@ghost/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { tracedFetch } from "../src/observability/fetch";
import { describe as describeInit, gitRelease, initObservability } from "../src/observability/instrument";
import { instrumentApp } from "../src/observability/index";
import { confidenceBucket, decideSpanName, routeOf, transactionName, UNKNOWN_ROUTE, workSpanName } from "../src/observability/names";
import { instrumentDecisionProvider } from "../src/observability/provider";
import { attachSdk, detachSdk, isEnabled, span } from "../src/observability/sentry";
import { summarizeForm, summarizeGhostText, summarizeLoop, summarizeVisionLabel } from "../src/observability/summary";
import { recordWalk } from "../src/observability/walkSink";

/**
 * Values that must never reach Sentry. Every assertion below serialises everything the SDK was handed and looks for
 * these; if one of them is findable, the instrumentation leaked it.
 */
const HOSTILE = {
  email: "alex.chen@example.test",
  card: "4111 1111 1111 1111",
  govId: "046-454-286",
  phone: "+1 (555) 010-4477",
  url: "https://jobs.example.test/apply?token=abc123xyz",
  path: "/Users/pravin/Documents/resume.pdf",
  prose: "I lead the inventory rewrite at Northwind Robotics and shipped it in nine weeks with two engineers reporting to me.",
};

const RECT = { x: 0, y: 0, width: 100, height: 20 };
const JSON_HEADERS = { "Content-Type": "application/json" };

function field(signature: string, label: string, kind: FieldKind = "text", extra: Partial<CapturedField> = {}): CapturedField {
  return { signature, label, kind, rect: RECT, ...extra };
}

interface CapturedSpan {
  name: string;
  op?: string;
  parent?: string;
  attributes: Record<string, unknown>;
  ended: boolean;
  status?: unknown;
}

interface CapturedLog {
  level: string;
  message: string;
  attributes?: Record<string, unknown>;
}

interface CapturedMetric {
  kind: "count" | "distribution";
  name: string;
  value: number;
  attributes?: Record<string, unknown>;
}

/**
 * A stand-in for `@sentry/node` that records instead of sending. It is what makes "nothing leaves" testable: every
 * span attribute, log and metric the facade produces lands in one of these arrays and nowhere else, and no socket is
 * ever opened.
 */
function fakeSentry() {
  const spans: CapturedSpan[] = [];
  const logs: CapturedLog[] = [];
  const metrics: CapturedMetric[] = [];
  const exceptions: unknown[] = [];
  const stack: CapturedSpan[] = [];

  const make = (options: { name: string; op?: string; attributes?: Record<string, unknown> }) => {
    const entry: CapturedSpan = {
      name: options.name,
      op: options.op,
      parent: stack[stack.length - 1]?.name,
      attributes: { ...(options.attributes ?? {}) },
      ended: false,
    };
    spans.push(entry);
    const handle = {
      setAttributes: (attributes: Record<string, unknown>) => Object.assign(entry.attributes, attributes),
      setStatus: (status: unknown) => {
        entry.status = status;
      },
      end: () => {
        entry.ended = true;
      },
    };
    return { entry, handle };
  };

  const scoped = <T>(options: { name: string; op?: string; attributes?: Record<string, unknown> }, run: (handle: unknown) => T): T => {
    const { entry, handle } = make(options);
    stack.push(entry);
    const pop = (): void => {
      const at = stack.lastIndexOf(entry);
      if (at >= 0) stack.splice(at, 1);
    };
    let result: T;
    try {
      result = run(handle);
    } catch (err) {
      pop();
      throw err;
    }
    if (result instanceof Promise) return result.finally(pop) as T;
    pop();
    return result;
  };

  const record =
    (kind: CapturedMetric["kind"]) =>
    (name: string, value: number, options?: { attributes?: Record<string, unknown> }): void => {
      metrics.push({ kind, name, value, attributes: options?.attributes });
    };

  const line =
    (level: string) =>
    (message: string, attributes?: Record<string, unknown>): void => {
      logs.push({ level, message, attributes });
    };

  const sdk = {
    isInitialized: () => true,
    startSpan: scoped,
    startSpanManual: scoped,
    startInactiveSpan: (options: { name: string; op?: string; attributes?: Record<string, unknown> }) => make(options).handle,
    logger: { info: line("info"), warn: line("warn"), error: line("error"), debug: line("debug"), trace: line("trace"), fatal: line("fatal") },
    metrics: { count: record("count"), distribution: record("distribution"), gauge: record("count") },
    withScope: (run: (scope: { setContext: () => void }) => void) => run({ setContext: () => undefined }),
    captureException: (err: unknown) => {
      exceptions.push(err);
    },
    flush: async () => true,
  };

  attachSdk(sdk as unknown as Parameters<typeof attachSdk>[0]);
  return {
    spans,
    logs,
    metrics,
    exceptions,
    /** Everything the SDK was handed, as one string. Nothing in HOSTILE may appear in it. */
    everything: () => JSON.stringify({ spans, logs, metrics }),
    find: (name: string) => spans.find((s) => s.name === name),
  };
}

function expectNoValues(serialized: string): void {
  for (const [what, value] of Object.entries(HOSTILE)) {
    expect(serialized, `${what} leaked`).not.toContain(value);
  }
  // The distinctive halves too, in case a scrubber only clipped the string.
  for (const fragment of ["alex.chen", "4111", "046-454", "010-4477", "token=abc123", "/Users/pravin", "Northwind Robotics"]) {
    expect(serialized, `${fragment} leaked`).not.toContain(fragment);
  }
}

afterEach(() => {
  detachSdk();
});

describe("no SENTRY_DSN is a complete no-op", () => {
  it("never imports the SDK, never initialises, and reports why", async () => {
    const result = await initObservability({});
    expect(result).toMatchObject({ enabled: false, environment: "dev", profiling: false, reason: "SENTRY_DSN is not set" });
    expect(isEnabled()).toBe(false);
    expect(describeInit(result)).toBe("[ghost] sentry off (SENTRY_DSN is not set)");
  });

  it("treats an empty or whitespace DSN as absent", async () => {
    expect(await initObservability({ SENTRY_DSN: "" })).toMatchObject({ enabled: false });
    expect(await initObservability({ SENTRY_DSN: "   " })).toMatchObject({ enabled: false });
    expect(isEnabled()).toBe(false);
  });

  it("reads GHOST_ENV for the environment", async () => {
    expect(await initObservability({ GHOST_ENV: "demo" })).toMatchObject({ environment: "demo" });
  });

  it("adds no middleware, no wrappers and no dependencies to the app", () => {
    const instrumentation = instrumentApp(loadConfig({}));
    expect(instrumentation.middleware).toBeUndefined();
    expect(instrumentation).toMatchObject({ predict: {}, text: {}, loop: {}, vision: {} });
    const base = vi.fn();
    expect(tracedFetch("decision", base as unknown as typeof fetch)).toBe(base);
    const provider: DecisionProvider = { name: "heuristic", calibrated: false, decide: vi.fn() };
    expect(instrumentDecisionProvider(provider)).toBe(provider);
  });

  it("still runs the work a span would have wrapped", () => {
    expect(span({ name: "predict.form", op: "ghost.predict" }, () => 41 + 1)).toBe(42);
  });

  it("reads the git short sha, or nothing at all, but never something else", () => {
    const release = gitRelease();
    if (release !== undefined) expect(release).toMatch(/^[0-9a-f]{7}$/);
    expect(gitRelease("/nowhere-at-all")).toBeUndefined();
  });
});

describe("route names never carry a URL", () => {
  it("strips query strings, fragments and path parameters", () => {
    expect(routeOf("/v1/predict/form?origin=https://jobs.example.test")).toBe("/v1/predict/form");
    expect(routeOf("/v1/predict/form#alex")).toBe("/v1/predict/form");
    expect(routeOf("/v1/loop/execute/3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("/v1/loop/execute/:runId");
    expect(routeOf("/v1/walk/outcomes?runId=3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("/v1/walk/outcomes");
    // /v1/workflows/* moved to attic/, so a path that once parameterised now carries an address and must be <other>.
    expect(routeOf("/v1/workflows/alex.chen@example.test")).toBe(UNKNOWN_ROUTE);
  });

  it("names anything it does not recognise <other> rather than after its URL", () => {
    expect(routeOf(`/${HOSTILE.email}`)).toBe(UNKNOWN_ROUTE);
    expect(routeOf("/wp-admin/../../etc/passwd")).toBe(UNKNOWN_ROUTE);
    expect(transactionName("post", `/${HOSTILE.email}`)).toBe(`POST ${UNKNOWN_ROUTE}`);
  });

  it("maps a route to its work span and a provider to its decide span", () => {
    expect(workSpanName("/v1/predict/form")).toBe("predict.form");
    expect(workSpanName("/v1/health")).toBeUndefined();
    expect(decideSpanName("typesafe")).toBe("decide.jev");
    expect(decideSpanName("jev-gateway")).toBe("decide.jev");
    expect(decideSpanName("baseten")).toBe("decide.baseten");
    expect(decideSpanName("heuristic")).toBe("decide.heuristic");
  });

  it("buckets confidence the way docs/always-propose.md does", () => {
    expect(confidenceBucket(0.93)).toBe("high");
    expect(confidenceBucket(0.85)).toBe("high");
    expect(confidenceBucket(0.7)).toBe("guess");
    expect(confidenceBucket(0.69)).toBe("weak");
    expect(confidenceBucket(0)).toBe("none");
  });
});

describe("summaries read counts, never values", () => {
  it("turns a form prediction into an outcome line with no label, fact or value in it", () => {
    const summary = summarizeForm({
      assignments: [
        { signature: HOSTILE.path, factKey: "firstName", confidence: 0.93, source: "typesafe", calibrated: true },
        { signature: "s1", factKey: "email", confidence: 0.78, source: "typesafe", calibrated: true },
        { signature: "s2", factKey: "website", confidence: 0.4, source: "heuristic", calibrated: false },
        { signature: "s3", factKey: "none", confidence: 0.99, source: "heuristic", calibrated: false },
      ],
      provider: "typesafe",
      calibrated: false,
      cache: "miss",
      latencyMs: 412,
    });
    expect(summary.message).toBe("answered 3 of 4, 2 guesses, 1 without a fact");
    expect(summary.attributes).toMatchObject({
      "ghost.fields": 4,
      "ghost.answered": 3,
      "ghost.without_fact": 1,
      "ghost.guesses": 2,
      "ghost.confidence.high": 1,
      "ghost.confidence.guess": 1,
      "ghost.confidence.weak": 1,
      "ghost.from_model": 2,
      "ghost.from_heuristic": 1,
      "ghost.provider": "typesafe",
      "ghost.cache": "miss",
      "ghost.fast_path": false,
    });
    expectNoValues(JSON.stringify(summary));
  });

  it("marks a fallback as degraded so it becomes a warning", () => {
    const summary = summarizeForm({ assignments: [], provider: "heuristic", fallbackFrom: "baseten", cache: "miss", latencyMs: 2501 });
    expect(summary.degraded).toBe(true);
    expect(summary.attributes["ghost.fallback_from"]).toBe("baseten");
  });

  it("measures a draft instead of reading it", () => {
    const summary = summarizeGhostText({ text: HOSTILE.prose, provider: "baseten", latencyMs: 900, firstTokenMs: 210, cache: "miss" });
    expect(summary.attributes["ghost.draft_chars"]).toBe(HOSTILE.prose.length);
    expectNoValues(JSON.stringify(summary));
  });

  it("counts vision labels without reading one", () => {
    const summary = summarizeVisionLabel({
      labels: [
        { id: "ax-1", label: "Send", irreversible: true, sensitive: false },
        { id: "ax-2", label: HOSTILE.email, irreversible: false, sensitive: true },
        { id: "ax-3", label: null },
      ],
      provider: "openai",
      model: "gpt-5.6-luna",
      cached: false,
      latencyMs: 740,
    });
    expect(summary.message).toBe("named 2 of 3 controls, 1 locked");
    expectNoValues(JSON.stringify(summary));
  });

  it("counts loop steps without reading a locator or a typed value", () => {
    const summary = summarizeLoop({
      program: { id: "p1", steps: [{ kind: "goto" }, { kind: "fill", value: HOSTILE.card }] },
      provider: "llm",
      unresolved: [{ stepIndex: 1 }],
      resolvedByModel: 1,
      modelCalls: 1,
      cache: "miss",
      latencyMs: 3100,
    });
    expect(summary.attributes).toMatchObject({ "ghost.steps": 2, "ghost.unresolved": 1, "ghost.resolved_by_model": 1 });
    expectNoValues(JSON.stringify(summary));
  });
});

describe("the model call is its own span", () => {
  function mockProvider(name: string, result: Partial<DecisionResult> = {}): DecisionProvider {
    const decide = async (_state: unknown, questions: Questions): Promise<DecisionResult> => {
      const answers: Answers = {};
      for (const key of Object.keys(questions)) answers[key] = { type: "choice", choice: "firstName", probabilities: { firstName: 0.93 }, confidence: 0.93 };
      return { answers, provider: name, model: "jev-latest", calibrated: true, latencyMs: 12, usage: { inputTokens: 629, outputTokens: 87 }, ...result };
    };
    return { name, calibrated: true, decide };
  }

  const questions: Questions = {
    f0: { type: "choice", instructions: "Which profile fact fills `fields[0]`?", criteria: { firstName: null, none: null } },
    f1: { type: "choice", instructions: "Which profile fact fills `fields[1]`?", criteria: { email: null, none: null } },
  };

  it("carries the provider, the model, the question count and the token counts, and nothing else", async () => {
    const sentry = fakeSentry();
    const provider = instrumentDecisionProvider(mockProvider("typesafe"));
    await provider.decide({ page: { origin: HOSTILE.url }, fields: [{ label: HOSTILE.email }] }, questions);
    const decide = sentry.find("decide.jev");
    expect(decide?.op).toBe("gen_ai.invoke_agent");
    expect(decide?.attributes).toMatchObject({
      "gen_ai.system": "typesafe",
      "gen_ai.operation.name": "decide",
      "gen_ai.request.model": "jev-latest",
      "gen_ai.usage.input_tokens": 629,
      "gen_ai.usage.output_tokens": 87,
      "ghost.questions": 2,
      "ghost.answers": 2,
      "ghost.confidence.high": 2,
    });
    expect(sentry.metrics).toContainEqual(
      expect.objectContaining({ kind: "distribution", name: "ghost.decision.latency", attributes: expect.objectContaining({ "ghost.provider": "typesafe" }) }),
    );
    expectNoValues(sentry.everything());
  });

  it("warns and marks the span failed when the provider throws, and still rethrows", async () => {
    const sentry = fakeSentry();
    const failing: DecisionProvider = {
      name: "baseten",
      calibrated: false,
      decide: async () => {
        const error = new Error("timed out after 2500 ms");
        error.name = "TimeoutError";
        throw error;
      },
    };
    await expect(instrumentDecisionProvider(failing).decide("state", questions)).rejects.toThrow("timed out");
    const decide = sentry.find("decide.baseten");
    expect(decide?.attributes["ghost.failure"]).toBe("TimeoutError");
    expect(decide?.status).toMatchObject({ code: 2 });
    expect(sentry.logs.map((l) => l.level)).toContain("warn");
    expect(sentry.metrics).toContainEqual(
      expect.objectContaining({ name: "ghost.decision", attributes: expect.objectContaining({ "ghost.ok": false }) }),
    );
  });

  it("warns when a decision creeps up on its deadline", async () => {
    const sentry = fakeSentry();
    const slow: DecisionProvider = {
      name: "baseten",
      calibrated: false,
      decide: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { answers: {}, provider: "baseten", calibrated: false, latencyMs: 30 };
      },
    };
    await instrumentDecisionProvider(slow, 20).decide("state", {});
    expect(sentry.logs.some((l) => l.level === "warn" && l.message.includes("deadline"))).toBe(true);
  });
});

describe("the outbound model call is a span with its time to first token", () => {
  it("records the host, method and model of a plain chat call, never the prompt", async () => {
    const sentry = fakeSentry();
    const base = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const traced = tracedFetch("loop", base as unknown as typeof fetch);
    await traced("https://api.openai.com/v1/chat/completions?key=abc123xyz", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: HOSTILE.prose }] }),
    });
    const call = sentry.find("llm.chat");
    expect(call?.op).toBe("gen_ai.chat");
    expect(call?.attributes).toMatchObject({
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.request.messages": 1,
      "server.address": "api.openai.com",
      "http.request.method": "POST",
      "http.response.status_code": 200,
    });
    expectNoValues(sentry.everything());
  });

  it("times the first token of a streamed draft and ends both spans when the stream does", async () => {
    const sentry = fakeSentry();
    const chunks = ['data: {"delta":"I "}\n\n', 'data: {"delta":"lead"}\n\n'];
    const base = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const traced = tracedFetch("ghost-text", base as unknown as typeof fetch);
    const response = await traced("https://inference.baseten.co/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "zai-org/GLM-5.3-Flash", stream: true, messages: [{ role: "user", content: HOSTILE.prose }] }),
    });
    await response.text();
    const stream = sentry.find("llm.stream");
    const firstToken = sentry.find("llm.first-token");
    expect(stream?.attributes["gen_ai.system"]).toBe("baseten");
    expect(stream?.attributes["gen_ai.request.streaming"]).toBe(true);
    expect(stream?.attributes["gen_ai.response.time_to_first_token_ms"]).toEqual(expect.any(Number));
    expect(stream?.ended).toBe(true);
    expect(firstToken?.parent).toBe("llm.stream");
    expect(firstToken?.ended).toBe(true);
    expectNoValues(sentry.everything());
  });

  it("ends the spans when a stream is cancelled rather than leaving them open forever", async () => {
    const sentry = fakeSentry();
    const base = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
            },
          }),
          { status: 200 },
        ),
    );
    const response = await tracedFetch("ghost-text", base as unknown as typeof fetch)("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "grok-4.20-non-reasoning", stream: true }),
    });
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(sentry.find("llm.stream")?.ended).toBe(true);
    expect(sentry.find("llm.first-token")?.ended).toBe(true);
  });
});

describe("a whole request, end to end, through the app", () => {
  const HOSTILE_FORM = {
    origin: "http://localhost:5173",
    formSignature: "apply-v1",
    factKeys: ["firstName", "email", "website"],
    fields: [
      field("s0", "First name", "text", { autocomplete: "given-name" }),
      field("s1", "Email", "email", { autocomplete: "email", placeholder: HOSTILE.email }),
      field("s2", "Home address", "text", { placeholder: HOSTILE.path }),
      field("s3", "Why do you want to work here?", "textarea", { context: HOSTILE.prose }),
      field("s4", "Submit application", "button", { locked: true }),
    ],
  };

  it("produces one transaction with the route's work inside it, and no value anywhere", async () => {
    const sentry = fakeSentry();
    const app = createApp(loadConfig({ GHOST_PROVIDER: "heuristic" }));
    const res = await app.request("/v1/predict/form", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(HOSTILE_FORM) });
    expect(res.status).toBe(200);

    const transaction = sentry.find("POST /v1/predict/form");
    expect(transaction?.op).toBe("http.server");
    expect(transaction?.attributes).toMatchObject({ "http.request.method": "POST", "ghost.route": "/v1/predict/form", "http.response.status_code": 200 });

    const work = sentry.find("predict.form");
    expect(work?.parent).toBe("POST /v1/predict/form");
    expect(work?.attributes).toMatchObject({
      "ghost.route": "/v1/predict/form",
      "ghost.fields": 5,
      "ghost.request.fields": 5,
      "ghost.request.fact_keys": 3,
      "ghost.provider": "heuristic",
      "ghost.cache": "miss",
    });

    const decision = sentry.logs.find((l) => l.message.startsWith("/v1/predict/form:"));
    expect(decision?.level).toBe("info");
    expect(decision?.message).toMatch(/^\/v1\/predict\/form: answered \d+ of 5, \d+ guess(es)?, \d+ without a fact$/);
    expect(sentry.metrics.some((m) => m.name === "ghost.proposed" && m.attributes?.["ghost.class"] === "form-field")).toBe(true);
    expectNoValues(sentry.everything());
  });

  it("names a request to an unknown path after the route it is not, and still traces it", async () => {
    const sentry = fakeSentry();
    const app = createApp(loadConfig({ GHOST_PROVIDER: "heuristic" }));
    await app.request(`/v1/${HOSTILE.email}`, { method: "GET" });
    expect(sentry.find(`GET ${UNKNOWN_ROUTE}`)).toBeDefined();
    expectNoValues(sentry.everything());
  });

  it("forwards the client's own counters as proposed / accepted / corrected", async () => {
    const sentry = fakeSentry();
    const app = createApp(loadConfig({ GHOST_PROVIDER: "heuristic" }));
    const res = await app.request("/v1/metrics/event", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        counters: { ghostsShown: 14, ghostsAccepted: 12 },
        calibration: [
          { confidence: 0.93, accepted: true },
          { confidence: 0.72, accepted: false },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const names = sentry.metrics.map((m) => `${m.name}:${String(m.attributes?.["ghost.confidence.bucket"] ?? "")}`);
    expect(names).toContain("ghost.proposed:");
    expect(names).toContain("ghost.accepted:high");
    expect(names).toContain("ghost.corrected:guess");
  });

  it("keeps a streamed answer's transaction open until the last token, and still delivers the stream", async () => {
    const sentry = fakeSentry();
    const app = createApp(loadConfig({ GHOST_PROVIDER: "heuristic" }));
    const res = await app.request("/v1/ghost-text", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ fieldLabel: "Why do you want to work here?", facts: { firstName: "Alex" }, pageContext: { company: "Northwind" } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const transaction = sentry.find("POST /v1/ghost-text");
    // The headers are out, but the model is still writing: ending here would cut the trace at a few milliseconds.
    expect(transaction?.ended).toBe(false);
    const body = await res.text();
    expect(body).toContain('"done":true');
    expect(transaction?.ended).toBe(true);
    expect(transaction?.attributes["http.response.status_code"]).toBe(200);
    expect(sentry.find("ghost.text")).toBeDefined();
    expectNoValues(sentry.everything());
  });

  it("captures an unhandled route error as an event, marks the transaction failed, and still lets it through", async () => {
    const sentry = fakeSentry();
    const app = createApp(loadConfig({ GHOST_PROVIDER: "heuristic" }));
    app.get("/v1/boom", () => {
      throw new Error("boom");
    });
    const res = await app.request("/v1/boom");
    expect(res.status).toBe(500);
    const transaction = sentry.find(`GET ${UNKNOWN_ROUTE}`);
    expect(transaction?.status).toMatchObject({ code: 2 });
    expect(transaction?.ended).toBe(true);
    expect(sentry.exceptions).toHaveLength(1);
  });
});

describe("the walk sink", () => {
  it("counts every ghost once as proposed and once by its outcome, by class and source", () => {
    const sentry = fakeSentry();
    recordWalk([
      { ghostClass: "form-field", source: "fact", bucket: "high", outcome: "accepted", surface: "extension" },
      { ghostClass: "form-field", source: "guess", bucket: "weak", outcome: "corrected", surface: "extension" },
    ]);
    const proposed = sentry.metrics.filter((m) => m.name === "ghost.proposed");
    expect(proposed).toHaveLength(2);
    expect(sentry.metrics.some((m) => m.name === "ghost.accepted" && m.attributes?.["ghost.source"] === "fact")).toBe(true);
    expect(sentry.metrics.some((m) => m.name === "ghost.corrected" && m.attributes?.["ghost.confidence.bucket"] === "weak")).toBe(true);
    expect(sentry.logs[0]?.message).toBe("walk: 1 accepted, 1 corrected of 2 ghosts");
  });

  it("does nothing at all when Sentry is off", () => {
    detachSdk();
    expect(() => recordWalk([{ ghostClass: "command", source: "prior", bucket: "guess", outcome: "skipped" }])).not.toThrow();
  });
});
