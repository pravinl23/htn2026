import type { Answers, AgentDecisionRequest, DecisionProvider, DecisionResult, Questions } from "@ghost/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import type { AgentDecisionState } from "../src/providers/agentQuestions";
import { registerPredictRoutes } from "../src/routes/predict";

const JSON_HEADERS = { "Content-Type": "application/json" };

const REQUEST: AgentDecisionRequest = {
  goal: "Complete the application and stop before Submit application",
  page: {
    origin: "http://localhost:5173",
    url: "http://localhost:5173/apply?private=drop-me#top",
    title: "Apply",
  },
  recentActions: [
    { operation: "FILL", targetId: "secret-signature", targetLabel: "First name", ok: true, changed: true },
  ],
  candidates: [
    { id: "field-name", kind: "field", label: "Last name", context: "Your information", required: true, locked: false, filled: false, operations: ["FILL"] },
    { id: "open-details", kind: "button", label: "Open details", required: false, locked: false, filled: false, operations: ["CLICK"] },
    { id: "submit", kind: "button", label: "Submit application", required: false, locked: true, filled: false, operations: ["CLICK"] },
    { id: "already", kind: "field", label: "Email", required: true, locked: false, filled: true, operations: ["FILL"] },
  ],
};

function provider(script: Record<string, string>) {
  const decide = vi.fn(async (_state: unknown, questions: Questions): Promise<DecisionResult> => {
    const answers: Answers = {};
    for (const [name, question] of Object.entries(questions)) {
      if (question.type !== "choice") throw new Error("agent questions must be choices");
      const selected = script[name] ?? Object.keys(question.criteria)[0] ?? "BLOCKED";
      const confidence = name === "operation" ? 0.94 : 0.88;
      answers[name] = { type: "choice", choice: selected, confidence, probabilities: { [selected]: confidence } };
    }
    return { answers, provider: "mock", calibrated: true, latencyMs: 1 };
  });
  return { decide, value: { name: "mock", calibrated: true, decide } satisfies DecisionProvider };
}

function appWith(decisionProvider: DecisionProvider) {
  const app = new Hono();
  registerPredictRoutes(app, loadConfig({}), { provider: decisionProvider, log: () => undefined });
  return (body: unknown) => app.request("/v1/agent/next", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

describe("POST /v1/agent/next", () => {
  it("chooses operation and compatible target in one provider call", async () => {
    const mock = provider({ operation: "FILL", target_fill: "e1" });
    const response = await appWith(mock.value)(REQUEST);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operation: "FILL",
      targetId: "field-name",
      confidence: 0.88,
      operationConfidence: 0.94,
      targetConfidence: 0.88,
      provider: "mock",
      calibrated: true,
    });
    expect(mock.decide).toHaveBeenCalledTimes(1);

    const [state, questions] = mock.decide.mock.calls[0] as unknown as [AgentDecisionState, Questions];
    expect(Object.keys(questions)).toEqual(["operation", "target_fill"]);
    expect(questions.operation).toMatchObject({ criteria: { FILL: expect.any(String), WAIT: expect.any(String), DONE: expect.any(String), BLOCKED: expect.any(String) } });
    expect((questions.target_fill as { criteria: object }).criteria).toEqual({ e1: "field: Last name — Your information" });
    expect(state.elements.map((element) => ({ index: element.index, label: element.label, locked: element.locked, filled: element.filled }))).toEqual([
      { index: "1", label: "Last name", locked: false, filled: false },
      { index: "2", label: "Open details", locked: false, filled: false },
      { index: "3", label: "Submit application", locked: true, filled: false },
      { index: "4", label: "Email", locked: false, filled: true },
    ]);
  });

  it("does not forward opaque ids, query strings, or sensitive candidates", async () => {
    const mock = provider({ operation: "DONE" });
    const sensitive = { id: "password-id", kind: "field" as const, label: "Password", required: true, locked: false, filled: false, operations: ["FILL" as const] };
    await appWith(mock.value)({ ...REQUEST, candidates: [...REQUEST.candidates, sensitive] });
    const sent = JSON.stringify(mock.decide.mock.calls[0]);
    expect(sent).not.toContain("private=drop-me");
    expect(sent).not.toContain("secret-signature");
    expect(sent).not.toContain("open-details");
    expect(sent).not.toContain("password-id");
    expect(sent).not.toMatch(/password/i);
  });

  it("fails closed when the provider answer is unusable", async () => {
    const mock = provider({ operation: "CLICK", target_click: "not-offered" });
    expect(await (await appWith(mock.value)(REQUEST)).json()).toMatchObject({ operation: "BLOCKED", provider: "heuristic", fallbackFrom: "mock" });
  });

  it("the keyless provider only applies the first locally prepared field value", async () => {
    const app = new Hono();
    registerPredictRoutes(app, loadConfig({ GHOST_DECISION_PROVIDER: "heuristic" }), { log: () => undefined });
    const response = await app.request("/v1/agent/next", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(REQUEST) });
    expect(await response.json()).toMatchObject({ operation: "FILL", targetId: "field-name", provider: "heuristic", calibrated: false });

    const unresolved = {
      ...REQUEST,
      goal: "Complete every required field",
      candidates: [{ id: "consent", kind: "field", label: "Privacy consent", required: true, locked: false, filled: false, operations: [] }],
    };
    expect(await (await app.request("/v1/agent/next", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(unresolved) })).json())
      .toMatchObject({ operation: "BLOCKED", provider: "heuristic" });

    const partial = { ...unresolved, goal: "Fill everything with a safe local value; leave consent untouched" };
    expect(await (await app.request("/v1/agent/next", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(partial) })).json())
      .toMatchObject({ operation: "DONE", provider: "heuristic" });
  });

  it("rejects malformed or widened action spaces", async () => {
    const mock = provider({ operation: "DONE" });
    const post = appWith(mock.value);
    const bad = [
      { ...REQUEST, goal: "" },
      { ...REQUEST, page: { ...REQUEST.page, title: 3 } },
      { ...REQUEST, candidates: [{ ...REQUEST.candidates[0], operations: ["SHELL"] }] },
      { ...REQUEST, candidates: [{ ...REQUEST.candidates[0], filled: "no" }] },
      { ...REQUEST, recentActions: [{ operation: "DELETE", ok: true, changed: true }] },
    ];
    for (const body of bad) expect((await post(body)).status).toBe(400);
    expect(mock.decide).not.toHaveBeenCalled();
  });
});
