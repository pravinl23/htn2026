import type { Answers, DecisionProvider, DecisionResult, Questions } from "@shabang/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_TIMEOUT_MS, type CommandPrediction, type CommandState } from "../src/command/predict";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Metrics } from "../src/lib/metrics";
import { createTypesafeProvider } from "../src/providers/typesafe";
import { commandProvider, registerCommandRoutes, type CommandDeps } from "../src/routes/command";

const JSON_HEADERS = { "Content-Type": "application/json" };
const FAKE_KEY = "test-key-not-real";

/** Answers the command question with the scripted option (default "none"). */
function mockProvider(choice = "none", confidence = 0.91) {
  const decide = vi.fn(async (_state: unknown, questions: Questions): Promise<DecisionResult> => {
    const answers: Answers = {};
    for (const name of Object.keys(questions)) answers[name] = { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
    return { answers, provider: "mock", calibrated: true, latencyMs: 1 };
  });
  const provider: DecisionProvider = { name: "mock", calibrated: true, decide };
  return { provider, decide };
}

function appWith(provider: DecisionProvider, deps: CommandDeps = {}) {
  const app = new Hono();
  const lines: string[] = [];
  registerCommandRoutes(app, loadConfig({}), { provider, log: (line) => lines.push(line), ...deps });
  const post = (body: unknown, headers: Record<string, string> = JSON_HEADERS) =>
    app.request("/v1/predict/command", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const predict = async (body: unknown) => {
    const res = await post(body);
    expect(res.status).toBe(200);
    return (await res.json()) as CommandPrediction;
  };
  return { app, lines, post, predict };
}

const GIT = { branch: "main", dirty: true, ahead: 0, behind: 0, untracked: 1 };
const SESSION = {
  cwd: "/Users/alex/Projects/northwind-app",
  git: GIT,
  history: ["pnpm install", "pnpm build", "pnpm test", "git status", "git add -A"],
  projectScripts: ["pnpm dev", "pnpm test", "pnpm build"],
  lastExitCode: 0,
};

describe("POST /v1/predict/command", () => {
  it("asks ONE choice question over candidate ids plus none, with state { cwd, git, lastCommands, lastExitCode }", async () => {
    const { provider, decide } = mockProvider("c0");
    const { predict } = appWith(provider);
    const body = await predict(SESSION);
    expect(body).toMatchObject({ command: 'git commit -m ""', confidence: 0.91, provider: "mock", calibrated: true, cache: "miss", latencyMs: expect.any(Number) });

    expect(decide).toHaveBeenCalledTimes(1);
    const [state, questions] = decide.mock.calls[0] as unknown as [CommandState, Questions];
    expect(state).toStrictEqual({ cwd: "northwind-app", git: GIT, lastCommands: SESSION.history, lastExitCode: 0 });
    expect(Object.keys(questions)).toEqual(["next_command"]);
    const question = questions.next_command;
    expect(question?.type).toBe("choice");
    if (question?.type !== "choice") return;
    expect(question.criteria).toMatchObject({ c0: 'git commit -m ""  (commits the changes that were just staged)', none: expect.any(String) });
    expect(Object.values(question.criteria).join("\n")).not.toContain("`"); // backticks are reserved for state paths
    expect(Object.keys(question.criteria)).toContain("none");
    expect(Object.keys(question.criteria).length).toBeLessThanOrEqual(61);
    expect(question.instructions).toContain("`lastCommands`");
    expect(question.instructions).toContain("`lastExitCode`");
  });

  it("maps none to command null", async () => {
    const { predict } = appWith(mockProvider("none", 0.88).provider);
    expect(await predict(SESSION)).toMatchObject({ command: null, confidence: 0.88, provider: "mock" });
  });

  it("sends the exact Jev wire format, in ONE request, with nothing secret in it", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ model: "jev-latest", answers: { next_command: { type: "choice", choice: "c0", probabilities: { c0: 0.9, none: 0.1 }, confidence: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }),
    );
    const provider = createTypesafeProvider({ apiKey: FAKE_KEY, fetch: fetchMock as unknown as typeof fetch });
    const { predict } = appWith(provider);
    const history = ["export OPENAI_API_KEY=abc123", "pnpm test", "git add -A"];
    expect(await predict({ cwd: "/home/alex/app", history, git: { ...GIT, ahead: 2 } })).toMatchObject({ command: 'git commit -m ""', provider: "typesafe" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["model", "questions", "state"]);
    expect(sent.model).toBe("jev-latest");
    expect(sent.state).toStrictEqual({ cwd: "app", git: { ...GIT, ahead: 2 }, lastCommands: ["pnpm test", "git add -A"] });
    const questions = sent.questions as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions)).toEqual(["next_command"]);
    expect(Object.keys(questions.next_command ?? {}).sort()).toEqual(["criteria", "instructions", "type"]);
    for (const leaked of ["OPENAI_API_KEY", "abc123", "/home/alex", FAKE_KEY]) expect(init.body as string).not.toContain(leaked);
  });

  it("never offers a destructive command to the model, even when it always followed", async () => {
    const { provider, decide } = mockProvider("c0");
    const { predict } = appWith(provider);
    const history = ["pnpm build", "rm -rf dist", "pnpm build", "git push --force", "pnpm build"];
    const body = await predict({ cwd: "app", history });
    const sent = JSON.stringify(decide.mock.calls[0]?.[1]);
    expect(sent).not.toContain("rm -rf");
    expect(sent).not.toContain("--force");
    expect(body.command === null || !/rm -rf|--force/.test(body.command)).toBe(true);
  });

  it("keeps secret-looking history out of the model call entirely", async () => {
    const { provider, decide } = mockProvider();
    const { predict } = appWith(provider);
    await predict({ cwd: "app", history: ["pnpm i", "curl -H 'Authorization: Bearer abc' api", "ssh-keygen -t ed25519", "my-passphrase", "git status"] });
    const sent = JSON.stringify(decide.mock.calls[0]);
    for (const leaked of ["Authorization", "Bearer", "ssh-keygen", "my-passphrase"]) expect(sent).not.toContain(leaked);
  });

  it("a secret-looking prefix is answered null without any model call", async () => {
    const { provider, decide } = mockProvider("c0");
    const { predict } = appWith(provider);
    expect(await predict({ ...SESSION, prefix: "export GITHUB_TOKEN=" })).toMatchObject({ command: null, provider: "heuristic", candidates: 0 });
    expect(decide).not.toHaveBeenCalled();
  });

  it("a prefix typed right after ssh-keygen / gpg / security (maybe a pasted passphrase) is never used", async () => {
    const { provider, decide } = mockProvider("c0");
    const { predict } = appWith(provider);
    const afterGpg = { ...SESSION, history: [...SESSION.history, "gpg -c notes.txt"] };
    expect(await predict({ ...afterGpg, prefix: "pnpm" })).toMatchObject({ command: null, provider: "heuristic", candidates: 0 });
    expect(decide).not.toHaveBeenCalled();
    // The same prefix after an ordinary command is asked about, and so is the empty line after gpg.
    expect((await predict({ ...SESSION, prefix: "pnpm" })).command).not.toBeNull();
    await predict(afterGpg);
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("filters candidates by prefix before asking", async () => {
    const { provider, decide } = mockProvider("c0");
    const { predict } = appWith(provider);
    expect(await predict({ ...SESSION, prefix: "pnpm d" })).toMatchObject({ command: "pnpm dev", candidates: 1 });
    const [, questions] = decide.mock.calls[0] as unknown as [CommandState, Questions];
    const criteria = questions.next_command?.type === "choice" ? questions.next_command.criteria : {};
    expect(criteria).toStrictEqual({ c0: "pnpm dev  (a script defined by this project)", none: expect.any(String) });
  });

  it("answers null with zero model calls when no candidate is left", async () => {
    const { provider, decide } = mockProvider("c0");
    const { predict } = appWith(provider);
    expect(await predict({ cwd: "app", history: [] })).toMatchObject({ command: null, candidates: 0 });
    expect(await predict({ cwd: "app", history: ["ls"], prefix: "zzz" })).toMatchObject({ command: null, candidates: 0 });
    expect(decide).not.toHaveBeenCalled();
  });

  it("falls back to the heuristic when the provider fails or misses the 1.5 s deadline, and says so", async () => {
    expect(COMMAND_TIMEOUT_MS).toBe(1500);
    const failing: DecisionProvider = { name: "mock", calibrated: true, decide: async () => Promise.reject(new Error("HTTP 529")) };
    expect(await appWith(failing).predict(SESSION)).toMatchObject({ command: 'git commit -m ""', confidence: 0.8, provider: "heuristic", calibrated: false, fallbackFrom: "mock" });

    const hung: DecisionProvider = { name: "mock", calibrated: true, decide: () => new Promise<DecisionResult>(() => undefined) };
    const started = Date.now();
    expect(await appWith(hung, { timeoutMs: 30 }).predict(SESSION)).toMatchObject({ provider: "heuristic", fallbackFrom: "mock" });
    expect(Date.now() - started).toBeLessThan(1000);

    const unknownOption = mockProvider("c999").provider;
    expect(await appWith(unknownOption).predict(SESSION)).toMatchObject({ provider: "heuristic", fallbackFrom: "mock" });
  });

  it("without a Jev key the heuristic answers and nothing is called", async () => {
    expect(commandProvider(loadConfig({})).name).toBe("heuristic");
    expect(commandProvider(loadConfig({ SHABANG_PROVIDER: "heuristic", TYPESAFE_API_KEY: FAKE_KEY })).name).toBe("heuristic");
    expect(commandProvider(loadConfig({ TYPESAFE_API_KEY: FAKE_KEY })).name).toBe("typesafe");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = createApp(loadConfig({ SHABANG_PROVIDER: "heuristic" }));
    const res = await app.request("/v1/predict/command", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(SESSION) });
    expect(await res.json()).toMatchObject({ command: 'git commit -m ""', provider: "heuristic", calibrated: false, cache: "miss" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("only Jev answers terminal requests: rate-limited or slow providers get the heuristic", () => {
    expect(commandProvider(loadConfig({ BASETEN_API_KEY: FAKE_KEY, SHABANG_TEXT_PROVIDER: "template" })).name).toBe("heuristic");
    expect(commandProvider(loadConfig({ OPENAI_API_KEY: FAKE_KEY })).name).toBe("heuristic");
  });
});

describe("cache", () => {
  it("replays an identical request from the cache and keys on the prefix", async () => {
    const { provider, decide } = mockProvider("c0");
    const { predict } = appWith(provider);
    expect((await predict(SESSION)).cache).toBe("miss");
    expect(await predict(SESSION)).toMatchObject({ cache: "hit", command: 'git commit -m ""' });
    expect(decide).toHaveBeenCalledTimes(1);
    await predict({ ...SESSION, prefix: "git" });
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("keys on the last 3 commands, the git summary, the directory and the exit status", async () => {
    const { provider, decide } = mockProvider("c0");
    const { predict } = appWith(provider);
    await predict(SESSION);
    await predict({ ...SESSION, history: ["ls", ...SESSION.history] }); // older history only: same key
    expect(decide).toHaveBeenCalledTimes(1);
    await predict({ ...SESSION, git: { ...GIT, ahead: 1 } });
    await predict({ ...SESSION, cwd: "/other/place" });
    await predict({ ...SESSION, lastExitCode: 1 });
    await predict({ ...SESSION, history: [...SESSION.history, "git status"] });
    expect(decide).toHaveBeenCalledTimes(5);
  });

  it("does not replay a cached command that is no longer a candidate", async () => {
    const { provider, decide } = mockProvider("c0");
    const { predict } = appWith(provider);
    const history = ["git status", "git add -A"];
    expect(await predict({ ...SESSION, history, prefix: "pnpm", projectScripts: ["pnpm dev"] })).toMatchObject({ command: "pnpm dev" });
    const second = await predict({ ...SESSION, history, prefix: "pnpm", projectScripts: ["pnpm lint"] });
    expect(second).toMatchObject({ cache: "miss", command: "pnpm lint" });
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it("never caches a fallback, and identical concurrent requests share one model call", async () => {
    let calls = 0;
    const flaky: DecisionProvider = {
      name: "mock",
      calibrated: true,
      decide: async (_s, questions) => {
        calls += 1;
        if (calls === 1) throw new Error("HTTP 529");
        return { answers: { [Object.keys(questions)[0] ?? ""]: { type: "choice", choice: "c0", probabilities: { c0: 0.9 }, confidence: 0.9 } }, provider: "mock", calibrated: true, latencyMs: 1 };
      },
    };
    const { predict } = appWith(flaky);
    expect(await predict(SESSION)).toMatchObject({ fallbackFrom: "mock" });
    expect(await predict(SESSION)).toMatchObject({ provider: "mock", cache: "miss" });

    const { provider, decide } = mockProvider("c0");
    const shared = appWith(provider);
    const results = await Promise.all([shared.predict(SESSION), shared.predict(SESSION), shared.predict(SESSION)]);
    expect(decide).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.command).toBe('git commit -m ""');
  });
});

describe("validation and access rules", () => {
  it("rejects malformed bodies with messages that name the path, never the value", async () => {
    const { post } = appWith(mockProvider().provider);
    const secret = "hunter2-do-not-echo";
    const bad: unknown[] = [
      [],
      { cwd: "app" },
      { cwd: "app", history: secret },
      { cwd: "app", history: [1] },
      { cwd: "app", history: Array.from({ length: 31 }, () => "ls") },
      { cwd: "app", history: [], prefix: secret.repeat(40) },
      { cwd: "app", history: [], git: { branch: secret } },
      { cwd: "app", history: [], git: { branch: "main", dirty: true, ahead: -1 } },
      { cwd: "app", history: [], lastExitCode: 300 },
      { cwd: "app", history: [], projectScripts: [secret.repeat(20)] },
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(secret);
    }
    expect((await post("{not json")).status).toBe(400);
  });

  it("accepts null for optional fields and ignores unknown keys", async () => {
    const { predict } = appWith(mockProvider().provider);
    expect(await predict({ cwd: null, history: ["ls"], git: null, prefix: null, projectScripts: null, lastExitCode: null, shell: "zsh" })).toMatchObject({ command: null });
  });

  it("goes through the same guards as every route: JSON only, local Host, no foreign Origin, 32 KB", async () => {
    const app = createApp(loadConfig({ SHABANG_PROVIDER: "heuristic" }));
    const body = JSON.stringify(SESSION);
    const call = (headers: Record<string, string>, payload = body, url = "http://localhost/v1/predict/command") => app.request(url, { method: "POST", headers, body: payload });
    expect((await call({ "Content-Type": "text/plain" })).status).toBe(415);
    expect((await call({ ...JSON_HEADERS, Origin: "https://evil.example" })).status).toBe(403);
    expect((await call(JSON_HEADERS, body, "http://evil.example/v1/predict/command")).status).toBe(403);
    expect((await call(JSON_HEADERS, JSON.stringify({ ...SESSION, pad: "x".repeat(40_000) }))).status).toBe(413);
    expect((await call(JSON_HEADERS)).status).toBe(200);
  });
});

describe("logging and metrics", () => {
  it("logs numbers and names only, and times the model call under its provider", async () => {
    const metrics = new Metrics();
    const { provider } = mockProvider("c0");
    const { predict, lines } = appWith(provider, { metrics });
    await predict(SESSION);
    await predict(SESSION);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[ghost\] mock \/v1\/predict\/command \d+ms questions=1 calibrated=true cache=miss$/);
    const series = metrics.snapshot().latency.filter((s) => s.route === "/v1/predict/command");
    expect(series.find((s) => s.provider === "mock")).toMatchObject({ count: 1 });
    expect(series.find((s) => s.provider === "cache")).toMatchObject({ count: 1 });
  });
});
