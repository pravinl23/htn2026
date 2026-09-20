import { describe, expect, it } from "vitest";
import { isValueKey, MAX_ATTRIBUTE_CHARS, scrubAttributes, scrubEvent, scrubLog, scrubMetric, scrubString } from "../src/observability/scrub";

/**
 * The backstop. Everything in `observability/` is written so that only counts, names and buckets are ever built, but
 * a library can attach its own data to an event and a future edit can be careless. `beforeSend`, `beforeSendLog` and
 * `beforeSendMetric` run these functions over every payload, so this file is the proof that a value cannot leave even
 * when something upstream hands one over.
 */

/** Real shapes of the things Ghost sees and must never report. */
const VALUES = {
  email: "alex.chen@example.test",
  phone: "+1 (555) 010-4477",
  card: "4111 1111 1111 1111",
  cardTight: "4111111111111111",
  ssn: "046-45-4286",
  sin: "046-454-286",
  url: "https://jobs.example.test/apply?token=abc123xyz",
  plainUrl: "https://billing.example.test/invoices/INV-1003",
  path: "/Users/pravin/Documents/resume.pdf",
  windowsPath: "C:\\Users\\pravin\\resume.pdf",
  nodeModules: "at parse (/repo/node_modules/hono/dist/index.js:12:5)",
  bearer: "Bearer sk-proj-abcdefghijklmnop",
  apiKey: "sk-proj-abcdefghijklmnopqrstuvwx",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  multiline: "line one\nline two",
  prose: "I lead the inventory rewrite at Northwind Robotics".padEnd(MAX_ATTRIBUTE_CHARS + 1, "."),
};

/** Things that MUST survive, or the telemetry is useless. */
const KEEPERS = ["typesafe", "jev-latest", "/v1/predict/form", "POST /v1/predict/form", "decide.jev", "gen_ai.chat", "baseten", "miss", "high", "guess", "api.typesafe.ai", "zai-org/GLM-5.3-Flash"];

describe("scrubString drops anything shaped like a value", () => {
  for (const [what, value] of Object.entries(VALUES)) {
    it(`redacts a ${what}`, () => {
      const scrubbed = scrubString(value);
      expect(scrubbed).toMatch(/^\[redacted:[a-z-]+:\d+\]$/);
      expect(scrubbed).not.toContain(value);
    });
  }

  it("redacts the WHOLE string, not just the match, so the text around it cannot leak", () => {
    expect(scrubString(`Email Alex at ${VALUES.email} about the offer`)).not.toContain("offer");
    expect(scrubString(`Applying at ${VALUES.url}`)).not.toContain("Applying");
  });

  it("keeps the names, codes and buckets the telemetry is made of", () => {
    for (const keeper of KEEPERS) expect(scrubString(keeper)).toBe(keeper);
  });

  it("keeps a summary line, which is counts and words only", () => {
    const line = "answered 12 of 14, 2 guesses, 2 without a fact";
    expect(scrubString(line)).toBe(line);
  });

  it("keeps a short string at the limit and drops the one past it", () => {
    const atLimit = "x".repeat(MAX_ATTRIBUTE_CHARS);
    expect(scrubString(atLimit)).toBe(atLimit);
    expect(scrubString(`${atLimit}x`)).toContain("[redacted:long");
  });
});

describe("a key that promises a value is dropped whatever it holds", () => {
  it("knows which keys are values, including the ones that only end in one", () => {
    for (const key of ["label", "value", "text", "answer", "url", "path", "email", "prompt", "facts", "vars", "locator", "placeholder", "token", "cookie"]) {
      expect(isValueKey(key), key).toBe(true);
    }
    for (const key of ["ghost.field_label", "server_name", "abs_path", "page_url", "user_email", "ghost.typed_value"]) {
      expect(isValueKey(key), key).toBe(true);
    }
  });

  it("drops any key it does not emit itself out of span, log and metric attributes", () => {
    expect(isValueKey("ghost.something_new", true)).toBe(true);
    expect(isValueKey("ghost.provider", true)).toBe(false);
    expect(isValueKey("gen_ai.operation.name", true)).toBe(false);
    expect(isValueKey("server.address", true)).toBe(false);
    // Outside a payload the same key is only content-checked, so the envelope stays readable.
    expect(isValueKey("ghost.something_new")).toBe(false);
  });

  it("lets the keys this instrumentation builds through", () => {
    for (const key of ["ghost.fields", "ghost.provider", "gen_ai.request.model", "http.response.status_code", "server.address", "op", "transaction"]) {
      expect(isValueKey(key), key).toBe(false);
    }
  });

  it("drops a value key even when the value looks harmless", () => {
    const scrubbed = scrubAttributes({ label: "Home address", "ghost.fields": 14 });
    expect(scrubbed?.label).toMatch(/^\[redacted:key:\d+\]$/);
    expect(scrubbed?.["ghost.fields"]).toBe(14);
  });
});

describe("hostile attributes never leave", () => {
  /** Everything an upstream mistake could plausibly attach to a span, a log or a metric. */
  const HOSTILE_ATTRIBUTES = {
    "ghost.provider": "typesafe",
    "ghost.fields": 14,
    "ghost.calibrated": true,
    "ghost.confidence.bucket": "high",
    label: "First name",
    value: "Alex Chen",
    "ghost.field_label": "Email address",
    "ghost.value": VALUES.email,
    "ghost.page": VALUES.url,
    "ghost.file": VALUES.path,
    "ghost.card": VALUES.card,
    "ghost.sin": VALUES.sin,
    "ghost.draft": VALUES.prose,
    "ghost.auth": VALUES.bearer,
    nested: { deeper: { answer: "Yes, I am authorised to work in Canada", contact: VALUES.phone } },
    list: [VALUES.email, "high", VALUES.path],
  };

  const FORBIDDEN = [
    VALUES.email,
    VALUES.url,
    VALUES.path,
    VALUES.card,
    VALUES.sin,
    VALUES.bearer,
    VALUES.phone,
    "Alex Chen",
    "First name",
    "Email address",
    "Northwind Robotics",
    "authorised to work",
    "abc123xyz",
    "4111",
    "/Users/pravin",
  ];

  function expectClean(serialized: string): void {
    for (const forbidden of FORBIDDEN) expect(serialized, `${forbidden} leaked`).not.toContain(forbidden);
  }

  it("strips them out of span and log attributes, at every depth and inside arrays", () => {
    const scrubbed = scrubAttributes(HOSTILE_ATTRIBUTES);
    expectClean(JSON.stringify(scrubbed));
    // What is allowed still arrives, or the trace would say nothing.
    expect(scrubbed?.["ghost.provider"]).toBe("typesafe");
    expect(scrubbed?.["ghost.fields"]).toBe(14);
    expect(scrubbed?.["ghost.calibrated"]).toBe(true);
    expect(scrubbed?.["ghost.confidence.bucket"]).toBe("high");
  });

  it("strips them out of a log before it is sent", () => {
    const scrubbed = scrubLog({ level: "info", message: `drafted for ${VALUES.email}`, attributes: HOSTILE_ATTRIBUTES });
    expectClean(JSON.stringify(scrubbed));
    expect(scrubbed.level).toBe("info");
  });

  it("strips them out of a metric without losing its name or its value", () => {
    const scrubbed = scrubMetric({ name: "ghost.decision.latency", value: 412, type: "distribution", unit: "millisecond", attributes: HOSTILE_ATTRIBUTES });
    expectClean(JSON.stringify(scrubbed));
    expect(scrubbed.name).toBe("ghost.decision.latency");
    expect(scrubbed.value).toBe(412);
    expect(scrubbed.unit).toBe("millisecond");
  });

  it("strips them out of a transaction event, which is where span attributes travel", () => {
    const event = {
      type: "transaction",
      transaction: "POST /v1/predict/form",
      environment: "demo",
      release: "45bf176",
      contexts: { trace: { op: "http.server", trace_id: "a".repeat(32), data: HOSTILE_ATTRIBUTES } },
      spans: [
        { op: "ghost.predict", description: "predict.form", data: HOSTILE_ATTRIBUTES },
        { op: "gen_ai.invoke_agent", description: "decide.jev", data: { "gen_ai.request.model": "jev-latest", prompt: VALUES.prose } },
      ],
      request: { url: VALUES.url, headers: { authorization: VALUES.bearer, cookie: "session=abc" } },
      server_name: "pravins-macbook.local",
    };
    const scrubbed = scrubEvent(event);
    expectClean(JSON.stringify(scrubbed));
    expect(scrubbed.transaction).toBe("POST /v1/predict/form");
    expect(scrubbed.release).toBe("45bf176");
    expect(scrubbed.spans[0]?.description).toBe("predict.form");
    expect((scrubbed.spans[1]?.data as Record<string, unknown>)["gen_ai.request.model"]).toBe("jev-latest");
  });

  it("keeps an error readable: the stack survives, the message is still checked", () => {
    const event = {
      type: undefined,
      exception: {
        values: [
          {
            type: "TimeoutError",
            value: "timed out after 2500 ms",
            stacktrace: { frames: [{ filename: "/Users/pravin/Projects/htn2026/server/src/providers/baseten.ts", lineno: 88, function: "decide" }] },
          },
          { type: "Error", value: `could not fill ${VALUES.email}`, stacktrace: { frames: [] } },
        ],
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed.exception.values[0]?.value).toBe("timed out after 2500 ms");
    // The stack is OUR code and is what makes an error actionable, so it is kept verbatim.
    expect(scrubbed.exception.values[0]?.stacktrace.frames[0]?.filename).toContain("baseten.ts");
    // An error message that picked up a value is still redacted.
    expect(scrubbed.exception.values[1]?.value).not.toContain(VALUES.email);
  });

  it("refuses to walk an attribute tree deep enough to hide something", () => {
    let deep: Record<string, unknown> = { answer: VALUES.email };
    for (let i = 0; i < 12; i += 1) deep = { level: deep };
    expectClean(JSON.stringify(scrubAttributes(deep)));
  });

  it("survives the shapes JSON does not have", () => {
    const scrubbed = scrubAttributes({ fn: () => VALUES.email, big: BigInt(4111111111111111), "ghost.ok": null, missing: undefined });
    expect(JSON.stringify(scrubbed)).not.toContain("4111");
    expect(scrubbed?.["ghost.ok"]).toBeNull();
  });
});
