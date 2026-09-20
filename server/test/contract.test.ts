import type { CapturedField } from "@ghost/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { buildFormDecision } from "../src/providers/formQuestions";
import { createJevGatewayProvider, type EvaluateFn } from "../src/providers/jevGateway";
import { sampleFormRequest } from "../src/providers/sampleForm";
import { createTypesafeProvider } from "../src/providers/typesafe";
import { registerPredictRoutes } from "../src/routes/predict";

// The Jev wire format is documented in docs/server-api.md. These tests pin the EXACT bytes we send, so an invented
// field (a classic agent mistake) fails here instead of as a 422 in front of a judge.

const FAKE_KEY = "test-key-not-real";
const RECT = { x: 0, y: 0, width: 100, height: 20 };

const FIELDS: CapturedField[] = [
  { signature: "s0", label: "First name", kind: "text", name: "fname", autocomplete: "given-name", id: "first", value: "typed by user", rect: RECT },
  { signature: "s1", label: "How did you hear about us?", kind: "select", options: [{ value: "hb", label: "Job board" }, { value: "fr", label: "Friend" }], context: "About you", rect: RECT },
  { signature: "s2", label: "Why Northwind?", kind: "textarea", placeholder: "A few sentences", rect: RECT },
];
const FACT_KEYS = ["firstName", "referralSource", "extra.pronouns"];

// Ownership is STATED, never implied: Jev reads criteria literally, so "phone number" legitimately fits
// "Emergency contact phone". Measured live on the 10-field ambiguous form: 53% -> 90%, 4 wrong ghosts
// above the 0.7 gate -> 0. See server/src/providers/formQuestions.ts.
const CRITERIA = {
  firstName: {
    what: "the applicant's own first / given name",
    not_for: "not a manager's, a reference's or anyone else's given name",
  },
  referralSource: "how the applicant themselves heard about the company",
  "extra.pronouns": null,
  needs_text: {
    what: "the applicant must write a free-text answer in their own words",
    not_for: "a short factual value that is already known about the applicant",
  },
  none: {
    what: "the field asks for something that is not a stored fact about the applicant themselves",
    examples: "a different person's contact details, a company's or employer's details, or a fact nobody has recorded about the applicant",
  },
};
const instructions = (i: number) => ({
  task: `The form field \`fields[${i}]\` is being filled in by the applicant. Which stored fact about the applicant belongs in it?`,
  whose:
    "Every option describes a fact about the applicant themselves. Read the field's label to see whose detail it asks for. " +
    "A label naming another person (an emergency contact, a referrer, a manager, a reference) or an organisation (an employer, a company) " +
    "asks for that party's detail, so the applicant's own matching fact is the wrong value: answer none.",
  free_text: "Answer needs_text when the field asks the applicant to write prose in their own words.",
  no_fit: "Answer none when no stored fact about the applicant is the value this field asks for.",
});

const EXPECTED_STATE = {
  page: { origin: "http://localhost:5173" },
  fields: [
    { label: "First name", kind: "text", name: "fname", autocomplete: "given-name" },
    { label: "How did you hear about us?", kind: "select", options: ["Job board", "Friend"], context: "About you" },
    { label: "Why Northwind?", kind: "textarea", placeholder: "A few sentences" },
  ],
};
const EXPECTED_QUESTIONS = {
  f0: { type: "choice", instructions: instructions(0), criteria: CRITERIA },
  f1: { type: "choice", instructions: instructions(1), criteria: CRITERIA },
  f2: { type: "choice", instructions: instructions(2), criteria: CRITERIA },
};

/** The AI SDK types `instructions` as a string, so the gateway path flattens them: task then clauses, in order. */
const flat = (i: number): string => {
  const { task, ...clauses } = instructions(i);
  return [task, ...Object.values(clauses)].join(" ");
};
const GATEWAY_EXPECTED_QUESTIONS = {
  f0: { type: "choice", instructions: flat(0), criteria: CRITERIA },
  f1: { type: "choice", instructions: flat(1), criteria: CRITERIA },
  f2: { type: "choice", instructions: flat(2), criteria: CRITERIA },
};

function typesafeAnswers(names: string[]): Response {
  const answers = Object.fromEntries(names.map((n) => [n, { type: "choice", choice: "none", probabilities: { none: 1 }, confidence: 0.9 }]));
  return new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
}

describe("TypeSafe (Jev) request contract", () => {
  it("sends exactly { model, state, questions } and nothing else", async () => {
    const fetchMock = vi.fn(async () => typesafeAnswers(["f0", "f1", "f2"]));
    const { state, questions } = buildFormDecision("http://localhost:5173", FIELDS, FACT_KEYS);
    await createTypesafeProvider({ apiKey: FAKE_KEY, fetch: fetchMock as unknown as typeof fetch }).decide(state, questions);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${FAKE_KEY}`, "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toStrictEqual({ model: "jev-latest", state: EXPECTED_STATE, questions: EXPECTED_QUESTIONS });
  });

  it("never sends field values, ids, signatures or geometry", async () => {
    const fetchMock = vi.fn(async () => typesafeAnswers(["f0", "f1", "f2"]));
    const { state, questions } = buildFormDecision("http://localhost:5173", FIELDS, FACT_KEYS);
    await createTypesafeProvider({ apiKey: FAKE_KEY, fetch: fetchMock as unknown as typeof fetch }).decide(state, questions);
    const sent = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    for (const leaked of ["typed by user", '"signature"', '"rect"', '"value"', '"id"', FAKE_KEY]) expect(sent).not.toContain(leaked);
  });

  it("the whole route makes ONE request for a 12-field form, with only known question fields", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const fetchMock = vi.fn(async () => typesafeAnswers(names));
    const config = loadConfig({ TYPESAFE_API_KEY: FAKE_KEY, GHOST_FAST_PATH: "0" });
    const app = new Hono();
    registerPredictRoutes(app, config, { provider: createTypesafeProvider({ apiKey: FAKE_KEY, fetch: fetchMock as unknown as typeof fetch }), log: () => undefined });

    const res = await app.request("/v1/predict/form", { method: "POST", body: JSON.stringify(sampleFormRequest()) });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(Object.keys(body)).toEqual(["model", "state", "questions"]);
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.state)).toEqual(["page", "fields"]);
    expect(body.state.fields).toHaveLength(12);
    expect(Object.keys(body.questions)).toEqual(names);
    for (const question of Object.values<Record<string, unknown>>(body.questions)) {
      expect(Object.keys(question).sort()).toEqual(["criteria", "instructions", "type"]);
      expect(question.type).toBe("choice");
      expect(Object.keys(question.criteria as object)).toEqual(expect.arrayContaining(["needs_text", "none"]));
      expect(Object.keys(question.criteria as object).length).toBeLessThanOrEqual(255);
    }
  });
});

describe("Vercel AI Gateway (experimental_evaluate) contract", () => {
  it("passes exactly model, state, questions, abortSignal and maxRetries", async () => {
    const evaluate = vi.fn<EvaluateFn>(async () => ({
      answers: {
        f0: { type: "choice", choice: "firstName", probabilities: { firstName: 1 } },
        f1: { type: "choice", choice: "referralSource", probabilities: { referralSource: 1 } },
        f2: { type: "choice", choice: "needs_text", probabilities: { needs_text: 1 } },
      },
    }));
    const { state, questions } = buildFormDecision("http://localhost:5173", FIELDS, FACT_KEYS);
    await createJevGatewayProvider({ evaluate }).decide(state, questions);

    expect(evaluate).toHaveBeenCalledTimes(1);
    const args = evaluate.mock.calls[0]?.[0];
    expect(Object.keys(args ?? {}).sort()).toEqual(["abortSignal", "maxRetries", "model", "questions", "state"]);
    expect(args).toEqual({
      model: "typesafe-ai/jev",
      state: EXPECTED_STATE,
      // Criteria stay structured here, because this path proxies to the same Jev. Instructions do not:
      // the AI SDK types `instructions` as a string, so they are flattened, wording preserved in order.
      questions: GATEWAY_EXPECTED_QUESTIONS,
      abortSignal: expect.any(AbortSignal),
      maxRetries: 0, // retries are done by the provider on a short backoff, not by the SDK
    });
  });

  it('renames the yes/no type to "boolean" and keeps its criteria', async () => {
    const evaluate = vi.fn<EvaluateFn>(async () => ({ answers: { q: { type: "boolean", probability: 0.5 } } }));
    await createJevGatewayProvider({ evaluate }).decide("state", {
      q: { type: "noul", instructions: "Is it done?", criteria: { true: "done", false: "not done" } },
    });
    expect(evaluate.mock.calls[0]?.[0].questions).toStrictEqual({
      q: { type: "boolean", instructions: "Is it done?", criteria: { true: "done", false: "not done" } },
    });
  });
});
