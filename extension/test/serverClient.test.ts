import { DEMO_PROFILE } from "@ghost/shared";
import type { AgentDecisionRequest, CapturedField } from "@ghost/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS, checkHealth, handleServerMessage, isServerMessage, predictAgent, predictForm } from "../src/background/serverClient";
import type { FetchLike } from "../src/background/serverClient";
import { sanitizeFormRequest, toWireField } from "../src/lib/messages";
import { resetMemoryStorage } from "../src/lib/storage";

const RECT = { x: 10, y: 20, width: 200, height: 32 };
const BASE = "http://localhost:8788";
const PREDICTION = {
  assignments: [{ signature: "first", factKey: "firstName", confidence: 0.97, source: "jev-gateway", calibrated: true }],
  provider: "jev-gateway", calibrated: true, latencyMs: 120, cache: "miss",
};

function field(signature: string, partial: Partial<CapturedField> = {}): CapturedField {
  return { signature, label: signature, kind: "text", rect: RECT, ...partial };
}

function request(fields: CapturedField[] = [field("first", { label: "First name", value: "Sam" }), field("email", { kind: "email" })]) {
  return { origin: "https://jobs.example", formSignature: "form-2-abc", fields, factKeys: ["firstName", "email"] };
}

function jsonFetch(body: unknown, status = 200) {
  return vi.fn<FetchLike>(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function sentBody(fetchMock: ReturnType<typeof jsonFetch>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

const deps = (fetchMock: FetchLike, extra = {}) => ({ fetch: fetchMock, getServerUrl: async () => BASE, ...extra });

afterEach(() => {
  vi.useRealTimers();
  resetMemoryStorage();
});

describe("predictForm", () => {
  it("POSTs JSON to /v1/predict/form and returns a structured result", async () => {
    const fetchMock = jsonFetch(PREDICTION);
    const result = await predictForm(request(), deps(fetchMock));
    expect(result).toEqual({ ok: true, data: { assignments: PREDICTION.assignments, provider: "jev-gateway", calibrated: true, latencyMs: 120 } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/v1/predict/form`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(init?.credentials).toBe("omit");
  });

  it("sends fact KEYS only: no profile value and no field value can leave, whatever the message carried", async () => {
    const fetchMock = jsonFetch(PREDICTION);
    // "Alex" and "Chen" look like keys; only real keys of the stored profile get through.
    const hostile = { ...request(), profile: DEMO_PROFILE, facts: DEMO_PROFILE.facts, factKeys: ["firstName", "Alex", "Chen", "alex.chen.dev@example.com", "+1 519 555 0142", 7] };
    await predictForm(hostile, deps(fetchMock));
    const body = sentBody(fetchMock);
    expect(Object.keys(body).sort()).toEqual(["factKeys", "fields", "formSignature", "origin"]);
    expect(body.factKeys).toEqual(["firstName"]);
    const raw = JSON.stringify(body);
    for (const value of Object.values(DEMO_PROFILE.facts)) if (value.length > 3) expect(raw).not.toContain(value);
    expect(raw).not.toContain("Sam"); // what the user typed into the field stays on the page
    expect(raw).not.toContain('"value":"');
  });

  it("never sends sensitive fields, buttons or links", async () => {
    const fetchMock = jsonFetch(PREDICTION);
    const fields = [
      field("first"), field("pw", { label: "Password", inputType: "password" }), field("card", { label: "Card number", autocomplete: "cc-number" }),
      field("sin", { label: "Social Insurance Number" }), field("go", { label: "Submit", kind: "button", locked: true }), field("home", { label: "Home", kind: "link" }),
    ];
    await predictForm(request(fields), deps(fetchMock));
    expect((sentBody(fetchMock).fields as CapturedField[]).map((f) => f.signature)).toEqual(["first"]);
  });

  it("answers bad-request without calling the server when nothing sendable is left", async () => {
    const fetchMock = jsonFetch(PREDICTION);
    expect(await predictForm({ ...request(), factKeys: [] }, deps(fetchMock))).toEqual({ ok: false, error: "bad-request" });
    expect(await predictForm({ ...request(), factKeys: ["Alex", "Chen"] }, deps(fetchMock))).toEqual({ ok: false, error: "bad-request" });
    expect(await predictForm(request([field("pw", { inputType: "password" })]), deps(fetchMock))).toEqual({ ok: false, error: "bad-request" });
    expect(await predictForm("nonsense", deps(fetchMock))).toEqual({ ok: false, error: "bad-request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives up after 3 seconds", async () => {
    vi.useFakeTimers();
    expect(REQUEST_TIMEOUT_MS).toBe(3000);
    const hanging = vi.fn<FetchLike>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = predictForm(request(), deps(hanging));
    await vi.advanceTimersByTimeAsync(2999);
    expect(hanging.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, error: "timeout" });
  });

  it("reports a server that is down, an HTTP error and a malformed body as short codes", async () => {
    const down = vi.fn<FetchLike>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await predictForm(request(), deps(down))).toEqual({ ok: false, error: "unreachable" });
    expect(await predictForm(request(), deps(jsonFetch({ error: "nope" }, 400)))).toEqual({ ok: false, error: "http-400" });
    expect(await predictForm(request(), deps(jsonFetch({ hello: "world" })))).toEqual({ ok: false, error: "bad-response" });
  });

  it("does not call anything when the server URL setting is unusable", async () => {
    const fetchMock = jsonFetch(PREDICTION);
    expect(await predictForm(request(), { fetch: fetchMock, getServerUrl: async () => null })).toEqual({ ok: false, error: "no-server-url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps fallbackFrom and drops malformed assignments from the reply", async () => {
    const reply = { ...PREDICTION, fallbackFrom: "jev-gateway", assignments: [...PREDICTION.assignments, { signature: "x", factKey: "bad key!", confidence: 2 }, null] };
    const result = await predictForm(request(), deps(jsonFetch(reply)));
    expect(result.ok && result.data.fallbackFrom).toBe("jev-gateway");
    expect(result.ok && result.data.assignments).toEqual(PREDICTION.assignments);
  });
});

describe("checkHealth", () => {
  it("GETs /v1/health", async () => {
    const fetchMock = jsonFetch({ ok: true, provider: "heuristic", calibrated: false, textProvider: "template", version: "0.1.0" });
    expect(await checkHealth(deps(fetchMock))).toEqual({ ok: true, data: { provider: "heuristic", calibrated: false, textProvider: "template", version: "0.1.0" } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/v1/health`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });
});

describe("handleServerMessage", () => {
  it("recognises its three message types only", () => {
    expect(isServerMessage({ type: "ghost:predict-form", request: {} })).toBe(true);
    expect(isServerMessage({ type: "ghost:agent-next", request: {} })).toBe(true);
    expect(isServerMessage({ type: "ghost:health" })).toBe(true);
    expect(isServerMessage({ type: "ghost:debugger-fill" })).toBe(false);
    expect(isServerMessage(null)).toBe(false);
  });

  it("uses the origin Chrome reports for the asking frame, not the one in the message", async () => {
    const fetchMock = jsonFetch(PREDICTION);
    await handleServerMessage({ type: "ghost:predict-form", request: { ...request(), origin: "https://bank.example" } }, { origin: "https://jobs.example" }, deps(fetchMock));
    expect(sentBody(fetchMock).origin).toBe("https://jobs.example");
    await handleServerMessage({ type: "ghost:predict-form", request: request() }, { url: "http://localhost:5173/apply?x=1" }, deps(fetchMock));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).origin).toBe("http://localhost:5173");
  });

  it("refuses a sender without an origin", async () => {
    const fetchMock = jsonFetch(PREDICTION);
    expect(await handleServerMessage({ type: "ghost:predict-form", request: request() }, {}, deps(fetchMock))).toEqual({ ok: false, error: "bad-request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers ghost:health", async () => {
    const fetchMock = jsonFetch({ ok: true, provider: "llm", calibrated: false, textProvider: "openai" });
    const result = await handleServerMessage({ type: "ghost:health" }, {}, deps(fetchMock));
    expect(result).toEqual({ ok: true, data: { provider: "llm", calibrated: false, textProvider: "openai" } });
  });
});

describe("predictAgent", () => {
  const agentRequest: AgentDecisionRequest = {
    goal: "Fill safe fields and stop before Submit",
    page: { origin: "https://spoofed.example", url: "https://spoofed.example/apply?token=secret", title: "Apply" },
    candidates: [
      { id: "first-id", kind: "field", label: "First name", required: true, locked: false, filled: false, operations: ["FILL"] },
      { id: "submit-id", kind: "button", label: "Submit", required: false, locked: true, filled: false, operations: ["CLICK"] },
    ],
    recentActions: [],
  };
  const agentReply = {
    operation: "FILL", targetId: "first-id", confidence: 0.91, operationConfidence: 0.95,
    targetConfidence: 0.91, provider: "typesafe", calibrated: true, latencyMs: 42,
  };

  it("POSTs the value-free request to /v1/agent/next", async () => {
    const fetchMock = jsonFetch(agentReply);
    expect(await predictAgent(agentRequest, deps(fetchMock))).toEqual({ ok: true, data: agentReply });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/v1/agent/next`);
    expect(sentBody(fetchMock)).toEqual(agentRequest);
  });

  it("uses Chrome's page identity and strips its query string", async () => {
    const fetchMock = jsonFetch(agentReply);
    const result = await handleServerMessage(
      { type: "ghost:agent-next", request: agentRequest },
      { origin: "http://localhost:5173", url: "http://localhost:5173/apply?private=yes#form" },
      deps(fetchMock),
    );
    expect(result).toEqual({ ok: true, data: agentReply });
    expect((sentBody(fetchMock).page as Record<string, unknown>)).toMatchObject({ origin: "http://localhost:5173", url: "http://localhost:5173/apply" });
  });

  it("drops widened operations before network", async () => {
    const fetchMock = jsonFetch(agentReply);
    const request = { ...agentRequest, candidates: [{ ...agentRequest.candidates[0], operations: ["DELETE"] }] };
    expect((await predictAgent(request, deps(fetchMock))).ok).toBe(true);
    expect((sentBody(fetchMock).candidates as Array<{ operations: string[] }>)[0]?.operations).toEqual([]);
  });
});

describe("sanitizeFormRequest", () => {
  it("rebuilds fields from an allowlist: geometry zeroed, value and unknown properties gone", () => {
    const wire = toWireField({ ...field("first", { value: "Sam", required: true, options: [{ value: "a", label: "A" }] }), secret: "hunter2" });
    expect(wire).toEqual({ signature: "first", label: "first", kind: "text", rect: { x: 0, y: 0, width: 0, height: 0 }, required: true, options: [{ value: "a", label: "A" }] });
  });

  it("stays inside the server's limits", () => {
    const many = Array.from({ length: 140 }, (_, i) => field(`f${i}`, { options: Array.from({ length: 80 }, (_, o) => ({ value: `${o}`, label: `${o}` })) }));
    const keys = Array.from({ length: 90 }, (_, i) => `fact${i}`);
    const clean = sanitizeFormRequest({ ...request(many), factKeys: keys });
    expect(clean?.fields).toHaveLength(100);
    expect(clean?.fields[0]?.options).toHaveLength(50);
    expect(clean?.factKeys).toHaveLength(64);
  });

  it("rejects an over-long identifier instead of clipping it into another identity", () => {
    expect(sanitizeFormRequest({ ...request(), formSignature: "x".repeat(301) })).toBeNull();
    expect(toWireField(field("s".repeat(301)))).toBeNull();
  });
});
