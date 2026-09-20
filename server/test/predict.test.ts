import type { Answers, CapturedField, DecisionProvider, DecisionResult, FieldKind, Questions } from "@shabang/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { LruCache } from "../src/lib/cache";
import { Metrics } from "../src/lib/metrics";
import { MAX_DECISION_BYTES, type FormPrediction } from "../src/providers/formPredict";
import type { FormState } from "../src/providers/formQuestions";
import type { NextState } from "../src/providers/nextQuestions";
import { sampleFormRequest } from "../src/providers/sampleForm";
import { registerPredictRoutes, type PredictDeps } from "../src/routes/predict";

const RECT = { x: 0, y: 0, width: 100, height: 20 };
const JSON_HEADERS = { "Content-Type": "application/json" };
const FACT_KEYS = ["firstName", "lastName", "email", "linkedin", "website", "school"];

function field(signature: string, label: string, kind: FieldKind = "text", extra: Partial<CapturedField> = {}): CapturedField {
  return { signature, label, kind, rect: RECT, ...extra };
}

/** Answers every choice question with the scripted option (default "none") at 0.93. */
function mockProvider(script: Record<string, string> = {}, confidence = 0.93) {
  const decide = vi.fn(async (_state: unknown, questions: Questions): Promise<DecisionResult> => {
    const answers: Answers = {};
    for (const name of Object.keys(questions)) {
      const choice = script[name] ?? "none";
      answers[name] = { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
    }
    return { answers, provider: "mock", calibrated: true, latencyMs: 1 };
  });
  const provider: DecisionProvider = { name: "mock", calibrated: true, decide };
  return { provider, decide };
}

async function formBody(res: Response | Promise<Response>): Promise<FormPrediction> {
  return (await (await res).json()) as FormPrediction;
}

function appWith(provider: DecisionProvider, env: Record<string, string> = {}, deps: PredictDeps = {}) {
  const app = new Hono();
  const lines: string[] = [];
  registerPredictRoutes(app, loadConfig(env), { provider, log: (line) => lines.push(line), ...deps });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { app, lines, post };
}

const MIXED_FORM = {
  origin: "http://localhost:5173",
  formSignature: "apply-v1",
  factKeys: FACT_KEYS,
  fields: [
    field("s0", "First name", "text", { autocomplete: "given-name" }),
    field("s1", "Email", "email", { autocomplete: "email" }),
    field("s2", "Where can we see your work?"),
    field("s3", "Favourite robot"),
    field("s4", "Resume", "file"),
    field("s5", "Submit application", "button", { locked: true }),
    field("s6", "Privacy policy", "link"),
  ],
};

describe("POST /v1/predict/form", () => {
  it("makes ONE decision call for the whole form and never sends buttons, links or file inputs", async () => {
    const { provider, decide } = mockProvider({ f0: "firstName", f1: "email", f2: "website" });
    const { post } = appWith(provider, { SHABANG_FAST_PATH: "0" });
    const res = await post("/v1/predict/form", MIXED_FORM);
    expect(res.status).toBe(200);
    expect(decide).toHaveBeenCalledTimes(1);

    const [state, questions] = decide.mock.calls[0] as unknown as [FormState, Questions];
    expect(Object.keys(questions)).toEqual(["f0", "f1", "f2", "f3"]);
    expect(state.fields.map((f) => f.label)).toEqual(["First name", "Email", "Where can we see your work?", "Favourite robot"]);

    const body = await formBody(res);
    expect(body).toMatchObject({ provider: "mock", calibrated: true, cache: "miss" });
    expect(body.latencyMs).toEqual(expect.any(Number));
    const model = { source: "mock", calibrated: true };
    const code = { source: "heuristic", calibrated: false };
    expect(body.assignments).toEqual([
      { signature: "s0", factKey: "firstName", confidence: 0.93, ...model },
      { signature: "s1", factKey: "email", confidence: 0.93, ...model },
      { signature: "s2", factKey: "website", confidence: 0.93, ...model },
      { signature: "s3", factKey: "none", confidence: 0.93, ...model },
      { signature: "s4", factKey: "none", confidence: 0.99, ...code },
      { signature: "s5", factKey: "none", confidence: 0.99, ...code },
      { signature: "s6", factKey: "none", confidence: 0.99, ...code },
    ]);
  });

  it("fast path: a form with structural evidence for every field makes zero model calls", async () => {
    const { provider, decide } = mockProvider();
    const { post } = appWith(provider);
    const res = await post("/v1/predict/form", {
      ...MIXED_FORM,
      fields: [
        field("s0", "First name", "text", { autocomplete: "given-name" }),
        field("s1", "Email", "email", { autocomplete: "section-contact email" }),
        field("s2", "I agree to the privacy policy", "checkbox"),
        field("s5", "Submit", "button"),
      ],
    });
    const body = await formBody(res);
    expect(decide).not.toHaveBeenCalled();
    expect(body).toMatchObject({ provider: "heuristic", calibrated: false, fastPath: true, cache: "miss" });
    expect(body.assignments.map((a) => a.factKey)).toEqual(["firstName", "email", "none", "none"]);
  });

  it("fast path never trusts a label regex: confident-looking heuristic matches are still sent to the model", async () => {
    // Each of these scores 0.90 to 0.97 in the shared heuristic, and most of them are wrong.
    const labels = ["Name of your school", "First language", "Last day available", "Country code", "LinkedIn", "Email"];
    const kinds: FieldKind[] = ["text", "text", "text", "text", "url", "checkbox"];
    const { provider, decide } = mockProvider({ f0: "school", f4: "linkedin" });
    const { post } = appWith(provider);
    const body = await formBody(post("/v1/predict/form", { ...MIXED_FORM, fields: labels.map((label, i) => field(`s${i}`, label, kinds[i])) }));
    expect(decide).toHaveBeenCalledTimes(1);
    const [state] = decide.mock.calls[0] as unknown as [FormState];
    expect(state.fields.map((f) => f.label)).toEqual(labels);
    expect(body.assignments.map((a) => a.factKey)).toEqual(["school", "none", "none", "none", "linkedin", "none"]);
    expect(body.fastPath).toBeUndefined();
  });

  it("autocomplete=off is not structural evidence", async () => {
    const { provider, decide } = mockProvider();
    const { post } = appWith(provider);
    await post("/v1/predict/form", { ...MIXED_FORM, fields: [field("s0", "First name", "text", { autocomplete: "off" })] });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("labels each assignment with its source, and a mixed response is not reported as calibrated", async () => {
    const { provider } = mockProvider({ f0: "website" });
    const { post } = appWith(provider);
    const body = await formBody(post("/v1/predict/form", MIXED_FORM));
    expect(body.assignments.slice(0, 4).map((a) => [a.factKey, a.source, a.calibrated])).toEqual([
      ["firstName", "heuristic", false],
      ["email", "heuristic", false],
      ["website", "mock", true],
      ["none", "mock", true],
    ]);
    expect(body).toMatchObject({ provider: "mock", calibrated: false });

    const allModel = await formBody(post("/v1/predict/form", { ...MIXED_FORM, formSignature: "other", fields: MIXED_FORM.fields.slice(2) }));
    expect(allModel.calibrated).toBe(true);
  });

  it("fast path: only the uncertain fields are asked, still in ONE call", async () => {
    const { provider, decide } = mockProvider({ f0: "website" });
    const { post } = appWith(provider);
    const body = await formBody(post("/v1/predict/form", MIXED_FORM));
    expect(decide).toHaveBeenCalledTimes(1);
    const [state, questions] = decide.mock.calls[0] as unknown as [FormState, Questions];
    expect(Object.keys(questions)).toEqual(["f0", "f1"]);
    expect(state.fields.map((f) => f.label)).toEqual(["Where can we see your work?", "Favourite robot"]);
    expect(body.assignments.slice(0, 4).map((a) => a.factKey)).toEqual(["firstName", "email", "website", "none"]);
    expect(body.provider).toBe("mock");
  });

  it("serves a repeat visit from the cache with zero model calls", async () => {
    const { provider, decide } = mockProvider({ f0: "website" });
    const { post } = appWith(provider);
    const first = await formBody(post("/v1/predict/form", MIXED_FORM));
    const second = await formBody(post("/v1/predict/form", { ...MIXED_FORM, factKeys: [...FACT_KEYS].reverse() }));
    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(second.assignments).toEqual(first.assignments);
    expect(second.provider).toBe("mock");
    expect(decide).toHaveBeenCalledTimes(1);

    const otherFacts = await formBody(post("/v1/predict/form", { ...MIXED_FORM, factKeys: ["firstName"] }));
    expect(otherFacts.cache).toBe("miss");
    const otherForm = await formBody(post("/v1/predict/form", { ...MIXED_FORM, formSignature: "apply-v2" }));
    expect(otherForm.cache).toBe("miss");
  });

  it("falls back to the heuristic when the provider throws, says so, and does not cache the fallback", async () => {
    const decide = vi.fn(async () => {
      throw new Error("boom");
    });
    const { post, lines } = appWith({ name: "mock", calibrated: true, decide });
    const body = await formBody(post("/v1/predict/form", MIXED_FORM));
    expect(body).toMatchObject({ provider: "heuristic", calibrated: false, fallbackFrom: "mock", cache: "miss" });
    expect(body.assignments.slice(0, 2).map((a) => a.factKey)).toEqual(["firstName", "email"]);
    expect(lines[0]).toContain("failed=1");

    await post("/v1/predict/form", MIXED_FORM);
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("falls back to the heuristic when the provider is slower than the timeout", async () => {
    const decide = vi.fn(() => new Promise<DecisionResult>(() => undefined));
    const { post } = appWith({ name: "mock", calibrated: true, decide }, {}, { timeoutMs: 20 });
    const body = await formBody(post("/v1/predict/form", MIXED_FORM));
    expect(body).toMatchObject({ provider: "heuristic", fallbackFrom: "mock" });
  });

  it("keeps the heuristic answer for a field when the model picks an option that was not offered", async () => {
    const { provider } = mockProvider({ f0: "creditCardNumber", f1: "school" });
    const { post } = appWith(provider);
    const body = await formBody(post("/v1/predict/form", MIXED_FORM));
    expect(body.assignments[2]).toEqual({ signature: "s2", factKey: "needs_text", confidence: 0.75, source: "heuristic", calibrated: false }); // the shared heuristic's own answer
    expect(body.assignments[3]).toMatchObject({ factKey: "school", source: "mock" });
  });

  it("does not cache an outcome in which the model left a field unanswered", async () => {
    const decide = vi.fn(async (_state: unknown, questions: Questions): Promise<DecisionResult> => {
      const answers: Answers = {};
      // Only the first call drops f0, the way an LLM omits a key or answers "first_name".
      const names = decide.mock.calls.length === 1 ? Object.keys(questions).slice(1) : Object.keys(questions);
      for (const name of names) answers[name] = { type: "choice", choice: "website", probabilities: {}, confidence: 0.8 };
      return { answers, provider: "llm", calibrated: false, latencyMs: 1 };
    });
    const { post } = appWith({ name: "llm", calibrated: false, decide });
    const partial = await formBody(post("/v1/predict/form", MIXED_FORM));
    expect(partial.assignments[2]).toMatchObject({ factKey: "needs_text", confidence: 0.75, source: "heuristic" }); // not none@0
    expect(partial.fallbackFrom).toBeUndefined();
    const retry = await formBody(post("/v1/predict/form", MIXED_FORM));
    expect(retry.cache).toBe("miss");
    expect(retry.assignments[2]).toMatchObject({ factKey: "website", source: "llm" });
    expect((await formBody(post("/v1/predict/form", MIXED_FORM))).cache).toBe("hit");
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("single flight: identical concurrent requests share ONE model call", async () => {
    const { provider, decide } = mockProvider({ f0: "website" });
    const slow: DecisionProvider = { ...provider, decide: (state, questions) => new Promise((resolve) => setTimeout(() => resolve(decide(state, questions)), 30)) };
    const { post } = appWith(slow);
    const bodies = await Promise.all([1, 2, 3].map(() => formBody(post("/v1/predict/form", MIXED_FORM))));
    expect(decide).toHaveBeenCalledTimes(1);
    expect(new Set(bodies.map((b) => JSON.stringify(b.assignments))).size).toBe(1);
    await formBody(post("/v1/predict/form", { ...MIXED_FORM, formSignature: "apply-v2" }));
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("cache cannot be poisoned: the key covers what the fields say, and blocked fields are none on every response", async () => {
    const { provider } = mockProvider({ f0: "email", f1: "email" });
    const { post } = appWith(provider);
    const claim = (fields: CapturedField[]) => ({ origin: "https://jobs.real.example", formSignature: "apply", factKeys: FACT_KEYS, fields });
    const poison = await formBody(post("/v1/predict/form", claim([field("real-comments", "Work email"), field("real-password", "Email")])));
    expect(poison.assignments.map((a) => a.factKey)).toEqual(["email", "email"]);

    const honest = await formBody(post("/v1/predict/form", claim([field("real-comments", "Additional comments"), field("real-password", "Password", "text", { inputType: "password" })])));
    expect(honest.cache).toBe("miss");
    expect(honest.assignments[1]).toEqual({ signature: "real-password", factKey: "none", confidence: 0.99, source: "heuristic", calibrated: false });
  });

  it("answers from the heuristic, with no model call, when the decision would be huge", async () => {
    const { provider, decide } = mockProvider();
    const { post } = appWith(provider);
    const factKeys = Array.from({ length: 64 }, (_, i) => `extra.${"k".repeat(50)}${i}`);
    const fields = Array.from({ length: 100 }, (_, i) => field(`s${i}`, `Question ${i}`));
    const request = { ...MIXED_FORM, factKeys, fields };
    expect(JSON.stringify(request).length * 10).toBeLessThan(MAX_DECISION_BYTES * 2); // a small request...
    const body = await formBody(post("/v1/predict/form", request));
    expect(decide).not.toHaveBeenCalled(); // ...must not become a multi-hundred-kilobyte model call
    expect(body).toMatchObject({ provider: "heuristic", fallbackFrom: "mock" });
    expect((await post("/v1/predict/form", { ...request, factKeys: [...factKeys, "oneTooMany"] })).status).toBe(400);
  });

  it("never sends a sensitive field to the model, even if the client captured one by mistake", async () => {
    const { provider, decide } = mockProvider();
    const { post } = appWith(provider, { SHABANG_FAST_PATH: "0" });
    const body = await formBody(
      post("/v1/predict/form", {
        ...MIXED_FORM,
        fields: [field("s0", "Password", "text", { inputType: "password" }), field("s1", "Card number", "text", { autocomplete: "cc-number" }), field("s2", "Nickname")],
      }),
    );
    const [state] = decide.mock.calls[0] as unknown as [FormState];
    expect(state.fields.map((f) => f.label)).toEqual(["Nickname"]);
    expect(body.assignments.slice(0, 2)).toEqual([
      { signature: "s0", factKey: "none", confidence: 0.99, source: "heuristic", calibrated: false },
      { signature: "s1", factKey: "none", confidence: 0.99, source: "heuristic", calibrated: false },
    ]);
  });

  it("logs one line per model call with no field content", async () => {
    const { provider } = mockProvider();
    const { post, lines } = appWith(provider);
    await post("/v1/predict/form", MIXED_FORM);
    await post("/v1/predict/form", MIXED_FORM); // cache hit: no model call, no line
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[ghost\] mock \/v1\/predict\/form \d+ms questions=2 calibrated=true cache=miss$/);
  });

  it("works end to end with no keys (heuristic provider) on the 12-field sample form", async () => {
    const app = createApp(loadConfig({}));
    const res = await app.request("/v1/predict/form", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(sampleFormRequest()) });
    const body = await formBody(res);
    expect(body).toMatchObject({ provider: "heuristic", calibrated: false, cache: "miss" });
    expect(body.assignments.map((a) => a.factKey)).toEqual([
      "firstName", "lastName", "email", "phone", "linkedin", "github", "website", "school", "degree", "graduationDate", "referralSource", "needs_text",
    ]);
  });

  it("rejects bad input with 400 and never echoes values", async () => {
    const { provider, decide } = mockProvider();
    const { post } = appWith(provider);
    const bad: unknown[] = [
      "{not json",
      [],
      { ...MIXED_FORM, origin: undefined },
      { ...MIXED_FORM, formSignature: "" },
      { ...MIXED_FORM, fields: "nope" },
      { ...MIXED_FORM, fields: [{ signature: "s0", label: "x", kind: "hologram" }] },
      { ...MIXED_FORM, fields: [{ label: "x", kind: "text" }] },
      { ...MIXED_FORM, fields: [{ signature: "s0", label: 42, kind: "text" }] },
      { ...MIXED_FORM, fields: Array.from({ length: 201 }, (_, i) => field(`s${i}`, "x")) },
      { ...MIXED_FORM, factKeys: ["ok", "__proto__"] },
      { ...MIXED_FORM, factKeys: "firstName" },
    ];
    for (const body of bad) {
      const res = await post("/v1/predict/form", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expect.any(String) });
    }
    expect(decide).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies with 413", async () => {
    const { post } = appWith(mockProvider().provider);
    const res = await post("/v1/predict/form", { ...MIXED_FORM, padding: "x".repeat(600_000) });
    expect(res.status).toBe(413);
  });

  it("stops reading a chunked body at the limit instead of buffering all of it", async () => {
    const { app } = appWith(mockProvider().provider);
    const chunk = new TextEncoder().encode("x".repeat(64_000));
    for (const path of ["/v1/predict/form", "/v1/predict/next"]) {
      let pulled = 0;
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 1000) return controller.close(); // 64 MB if nothing stops it
          controller.enqueue(chunk);
        },
      });
      const res = await app.request(new Request(`http://localhost${path}`, { method: "POST", headers: JSON_HEADERS, body: endless, duplex: "half" } as RequestInit));
      expect(res.status).toBe(413);
      expect(pulled).toBeLessThan(20);
    }
  });

  it("metrics: model calls are timed under the real provider (failures included), cache hits under 'cache'", async () => {
    const metrics = new Metrics();
    const { provider, decide } = mockProvider({ f0: "website" });
    const slow: DecisionProvider = { ...provider, decide: (state, questions) => new Promise((resolve) => setTimeout(() => resolve(decide(state, questions)), 40)) };
    const { post } = appWith(slow, {}, { metrics });
    for (let i = 0; i < 5; i += 1) await post("/v1/predict/form", MIXED_FORM);
    const series = () => Object.fromEntries(metrics.snapshot().latency.filter((s) => s.route === "/v1/predict/form").map((s) => [s.provider, s]));
    expect(series().mock).toMatchObject({ count: 1, failures: 0 });
    expect(series().mock?.p50).toBeGreaterThanOrEqual(35); // four 0 ms hits no longer drag the model's p50 to zero
    expect(series().cache).toMatchObject({ count: 4 });
    expect(series().heuristic).toBeUndefined();

    const hung = appWith({ name: "mock", calibrated: true, decide: () => new Promise<DecisionResult>(() => undefined) }, {}, { metrics, timeoutMs: 20 });
    expect(await formBody(hung.post("/v1/predict/form", MIXED_FORM))).toMatchObject({ provider: "heuristic", fallbackFrom: "mock" });
    await hung.post("/v1/predict/next", NEXT_REQUEST);
    expect(series().mock).toMatchObject({ count: 2, failures: 1 }); // the timeout is charged to the provider that timed out
    expect(series().heuristic).toBeUndefined();
    expect(metrics.snapshot().latency.find((s) => s.route === "/v1/predict/next")).toMatchObject({ provider: "mock", count: 1, failures: 1 });
  });
});

const NEXT_REQUEST = {
  origin: "http://localhost:5173",
  url: "http://localhost:5173/mail?thread=42#top",
  recentActions: [
    { type: "click", label: "Inbox", signature: "sig-inbox" },
    { type: "input", label: "Search", value: "should never be forwarded" },
    { type: "click", label: "Open calendar", signature: "sig-cal", url: "http://localhost:5173/calendar?token=abc" },
  ],
  candidates: [
    { id: "button|Archive|0", kind: "button", label: "Archive", locked: false },
    { id: "button|Thursday 2pm|3", kind: "button", label: "Thursday 2pm", locked: false, context: "Free slots" },
    { id: "button|Send|9", kind: "button", label: "Send", locked: true },
  ],
  memory: [{ summary: "meeting request email", previousAction: { type: "click", label: "Open calendar", signature: "sig-cal" }, action: { type: "click", label: "Thursday 2pm" } }],
};

describe("POST /v1/predict/next", () => {
  it("asks ONE choice question over the candidates plus none and maps the answer back to the client id", async () => {
    const { provider, decide } = mockProvider({ next: "c1" });
    const { post } = appWith(provider);
    const res = await post("/v1/predict/next", NEXT_REQUEST);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ candidateId: "button|Thursday 2pm|3", confidence: 0.93, provider: "mock", calibrated: true, latencyMs: expect.any(Number) });

    expect(decide).toHaveBeenCalledTimes(1);
    const [state, questions] = decide.mock.calls[0] as unknown as [NextState, Questions];
    expect(Object.keys(questions)).toEqual(["next"]);
    expect(questions.next).toMatchObject({
      type: "choice",
      criteria: { c0: "button: Archive", c1: "button: Thursday 2pm", c2: "button: Send", none: expect.any(String) },
    });
    expect(state.candidates.map((c) => c.id)).toEqual(["c0", "c1", "c2"]);
  });

  it("never forwards typed values, signatures or URL query strings", async () => {
    const { provider, decide } = mockProvider();
    const { post } = appWith(provider);
    await post("/v1/predict/next", NEXT_REQUEST);
    const sent = JSON.stringify(decide.mock.calls[0]);
    for (const leaked of ["should never be forwarded", "sig-cal", "token=abc", "thread=42"]) expect(sent).not.toContain(leaked);
    const [state] = decide.mock.calls[0] as unknown as [NextState];
    expect(state.page).toEqual({ origin: "http://localhost:5173", url: "http://localhost:5173/mail" });
  });

  it("heuristic provider: picks the candidate that followed the same previous action in memory, else none", async () => {
    const app = createApp(loadConfig({}));
    const post = (body: unknown) => app.request("/v1/predict/next", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    expect(await (await post(NEXT_REQUEST)).json()).toMatchObject({ candidateId: "button|Thursday 2pm|3", confidence: 0.8, provider: "heuristic", calibrated: false });
    expect(await (await post({ ...NEXT_REQUEST, memory: [] })).json()).toMatchObject({ candidateId: "none", provider: "heuristic" });
    expect(await (await post({ ...NEXT_REQUEST, memory: undefined })).json()).toMatchObject({ candidateId: "none" });
  });

  it("never predicts a sensitive control, and never sends one (or actions on one) to the model", async () => {
    const password = { id: "field|Password|1", kind: "field", label: "Password", locked: false };
    const hinted = { id: "field||2", kind: "field", label: "", locked: false, context: "Card number" };
    const request = {
      ...NEXT_REQUEST,
      candidates: [...NEXT_REQUEST.candidates, password, hinted],
      recentActions: [...NEXT_REQUEST.recentActions, { type: "focus", label: "Password" }],
      memory: [{ previousAction: { type: "focus", label: "Password" }, action: { type: "focus", label: "Password" } }, ...NEXT_REQUEST.memory],
    };
    const { provider, decide } = mockProvider({ next: "c3" });
    const { post } = appWith(provider);
    expect(await (await post("/v1/predict/next", request)).json()).toMatchObject({ provider: "heuristic", fallbackFrom: "mock" }); // c3 no longer exists
    expect(JSON.stringify(decide.mock.calls[0])).not.toMatch(/password|card number/i);

    const app = createApp(loadConfig({}));
    const res = await app.request("/v1/predict/next", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ...request, memory: request.memory.slice(0, 1) }) });
    expect(await res.json()).toMatchObject({ candidateId: "none", provider: "heuristic" });
  });

  it("answers none with zero calls when there are no candidates", async () => {
    const { provider, decide } = mockProvider();
    const { post } = appWith(provider);
    expect(await (await post("/v1/predict/next", { ...NEXT_REQUEST, candidates: [] })).json()).toMatchObject({ candidateId: "none" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("falls back to the heuristic on provider errors and unusable answers", async () => {
    const failing = appWith({ name: "mock", calibrated: true, decide: vi.fn(async () => Promise.reject(new Error("boom"))) });
    expect(await (await failing.post("/v1/predict/next", NEXT_REQUEST)).json()).toMatchObject({
      candidateId: "button|Thursday 2pm|3",
      provider: "heuristic",
      fallbackFrom: "mock",
    });
    const confused = appWith(mockProvider({ next: "c99" }).provider);
    expect(await (await confused.post("/v1/predict/next", NEXT_REQUEST)).json()).toMatchObject({ provider: "heuristic", fallbackFrom: "mock" });
  });

  it("keeps only the 20 most recent actions and 5 memories", async () => {
    const { provider, decide } = mockProvider();
    const { post } = appWith(provider);
    const recentActions = Array.from({ length: 30 }, (_, i) => ({ type: "click", label: `step ${i}` }));
    const memory = Array.from({ length: 9 }, () => NEXT_REQUEST.memory[0]);
    await post("/v1/predict/next", { ...NEXT_REQUEST, recentActions, memory });
    const [state] = decide.mock.calls[0] as unknown as [NextState];
    expect(state.recentActions).toHaveLength(20);
    expect(state.recentActions[19]).toEqual({ type: "click", label: "step 29" });
    expect(state.memory).toHaveLength(5);
  });

  it("rejects bad input with 400", async () => {
    const { provider, decide } = mockProvider();
    const { post } = appWith(provider);
    const [first] = NEXT_REQUEST.candidates;
    const bad: unknown[] = [
      "{not json",
      { ...NEXT_REQUEST, url: 7 },
      { ...NEXT_REQUEST, recentActions: "clicks" },
      { ...NEXT_REQUEST, recentActions: [{ label: "no type" }] },
      { ...NEXT_REQUEST, candidates: [{ ...first, kind: "hologram" }] },
      { ...NEXT_REQUEST, candidates: [{ ...first, locked: "yes" }] },
      { ...NEXT_REQUEST, candidates: [first, first] },
      { ...NEXT_REQUEST, candidates: [{ ...first, id: "none" }] },
      { ...NEXT_REQUEST, candidates: Array.from({ length: 61 }, (_, i) => ({ ...first, id: `id${i}` })) },
    ];
    for (const body of bad) expect((await post("/v1/predict/next", body)).status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // touch a, so b is now the oldest
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });
});
