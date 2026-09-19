import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { compile, TOOLS } from "../src/executors/composio";
import { createTicketOffice } from "../src/executors/tickets";
import type { ExecuteJob, ExecuteReport, LoopExecutor } from "../src/executors/types";
import { sseData } from "../src/lib/sse";
import { registerExecuteRoutes, type ExecuteDeps } from "../src/routes/execute";
import { DEMO, FakeCloud, PUBLIC_DEMO, fakeBrowserbase, fakeFetch, invoiceItems, invoiceJob, invoiceProgram, publicLookup } from "./executors.fixtures";

const JSON_HEADERS = { "Content-Type": "application/json" };
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const GHOST_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const OTHER_EXTENSION = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
const EXECUTE_TOKEN = "per-install-secret-0123456789";
const BB_ENV = { BROWSERBASE_API_KEY: "bb-test-key", BROWSERBASE_PROJECT_ID: "proj-1", GHOST_PUBLIC_DEMO_URL: PUBLIC_DEMO };
const COMPOSIO_ENV = { COMPOSIO_API_KEY: "cmp-test-key", COMPOSIO_SPREADSHEET_ID: "sheet-123" };
const PINNED = { GHOST_EXTENSION_ID: EXTENSION_ID };
const noNetwork = (() => Promise.reject(new Error("the network must not be touched"))) as unknown as typeof fetch;

type Body = Record<string, unknown>;
type Json = Record<string, unknown> & { error?: string; confirmToken?: string; runId?: string; report?: ExecuteReport };

function appWith(env: Record<string, string>, deps: ExecuteDeps = {}): Hono {
  const hono = new Hono();
  registerExecuteRoutes(hono, loadConfig(env), { fetch: noNetwork, lookup: publicLookup, ...deps });
  return hono;
}

async function call(hono: Hono, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const res = await hono.request(path, { method, headers: { ...JSON_HEADERS, ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Json };
}

/** The request body both routes take. `confirmIrreversible` is sent on purpose: the server must ignore it. */
function jobBody(overrides: Body = {}): Body {
  const { program, items, baseUrl } = invoiceJob(3);
  return { mode: "parallel", program, items, baseUrl, ...overrides };
}

/** The real flow: preview, (the user confirms), execute with the token. */
async function previewAndRun(hono: Hono, body: Body, headers: Record<string, string> = {}, query = ""): Promise<{ status: number; json: Json; preview: Json }> {
  const preview = await call(hono, "POST", "/v1/loop/preview", body, headers);
  if (preview.status !== 200) return { ...preview, preview: preview.json };
  const run = await call(hono, "POST", `/v1/loop/execute${query}`, { ...body, confirmToken: preview.json.confirmToken }, headers);
  return { ...run, preview: preview.json };
}

/** Send To / Subject / Message + a locked Send on a mail site: what the verified attack used. */
function mailBody(): Body {
  const at = { origin: DEMO, pathPattern: "/mail/:id" };
  const program = {
    ...invoiceProgram(),
    name: "mail",
    iterator: { origin: DEMO, pathPattern: "/mail", listSignature: "ul#threads", stride: 1, nextIndex: 2, itemPathPattern: "/mail/:id" },
    steps: [
      { op: "open-item" },
      { op: "fill", target: { label: "To", kind: "email" }, value: { const: "attacker@evil.test" }, at },
      { op: "fill", target: { label: "Subject", kind: "text" }, value: { const: "hello" }, at },
      { op: "fill", target: { label: "Message", kind: "textarea" }, value: { const: "hi" }, at },
      { op: "click", target: { label: "Send", kind: "button" }, locked: true, at },
    ],
    irreversible: [],
  };
  return { mode: "api", program, items: [{ index: 0, url: `${DEMO}/mail/1`, vars: {} }], baseUrl: DEMO };
}

const composioOk = () => fakeFetch(() => ({ status: 200, json: { successful: true } }));

describe("GET /v1/executors and POST /v1/loop/compile", () => {
  it("always lists visible and background, then the two server modes, and tells the caller whether it may use them", async () => {
    const list = async (env: Record<string, string>, headers: Record<string, string> = {}): Promise<unknown[]> => (await (await createApp(loadConfig(env)).request("/v1/executors", { headers })).json()) as unknown[];
    expect(await list({})).toEqual([
      { mode: "visible", available: true },
      { mode: "background", available: true },
      { mode: "parallel", available: false, reason: "Add BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID to enable parallel cloud execution", simulated: true, authorized: true },
      { mode: "api", available: false, reason: "Add COMPOSIO_API_KEY to enable API execution", simulated: true, authorized: true },
    ]);
    const keys = { ...BB_ENV, COMPOSIO_API_KEY: "k" };
    const real = (authorized: boolean): unknown[] => [{ mode: "parallel", available: true, simulated: false, authorized }, { mode: "api", available: true, simulated: false, authorized }];
    expect((await list(keys, { Origin: GHOST_ORIGIN })).slice(2)).toEqual(real(false)); // nothing pinned yet
    expect((await list({ ...keys, ...PINNED }, { Origin: GHOST_ORIGIN })).slice(2)).toEqual(real(true));
    expect((await list({ ...keys, ...PINNED }, { Origin: OTHER_EXTENSION })).slice(2)).toEqual(real(false));
    expect((await list({ ...keys, ...PINNED }, { Origin: "http://localhost:5173" })).slice(2)).toEqual(real(false));
    expect((await list({ ...keys, GHOST_EXECUTE_TOKEN: EXECUTE_TOKEN }, { "X-Ghost-Token": EXECUTE_TOKEN })).slice(2)).toEqual(real(true));
  });

  it("answers the CORS preflight of the pinned extension for DELETE and for the X-Ghost-Token header", async () => {
    const hono = createApp(loadConfig(PINNED));
    const preflight = await hono.request("/v1/loop/execute/some-run", { method: "OPTIONS", headers: { Origin: GHOST_ORIGIN, "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "content-type,x-ghost-token" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(GHOST_ORIGIN);
    expect(preflight.headers.get("access-control-allow-methods")).toMatch(/DELETE/);
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/x-ghost-token/i);
  });

  it("compiles a program, and is closed to web pages like the other loop execution routes", async () => {
    const hono = createApp(loadConfig({}));
    const ok = await call(hono, "POST", "/v1/loop/compile", { program: invoiceProgram() });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual(compile(invoiceProgram()));
    expect((await call(hono, "POST", "/v1/loop/compile", { program: invoiceProgram() }, { Origin: "http://localhost:3000" })).status).toBe(403);
    expect((await call(hono, "POST", "/v1/loop/compile", { program: null })).status).toBe(400);
  });
});

describe("finding 1: who may run a batch, and what counts as a confirmation", () => {
  it("refuses web pages (localhost included) and any extension other than the pinned one, before anything is sent", async () => {
    const api = composioOk();
    const hono = appWith({ ...COMPOSIO_ENV, ...PINNED }, { fetch: api.fetch });
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:5173", OTHER_EXTENSION]) {
      for (const path of ["/v1/loop/preview", "/v1/loop/execute"]) {
        const res = await call(hono, "POST", path, { ...mailBody(), confirmIrreversible: true }, { Origin: origin });
        expect([path, origin, res.status]).toEqual([path, origin, 403]);
      }
      expect((await call(hono, "DELETE", "/v1/loop/execute/some-run", undefined, { Origin: origin })).status).toBe(403);
    }
    expect(api.calls).toHaveLength(0);
  });

  it("runs real executors only for a pinned caller: without GHOST_EXTENSION_ID or a token, any extension gets 403", async () => {
    const api = composioOk();
    const unpinned = appWith(COMPOSIO_ENV, { fetch: api.fetch });
    for (const headers of [{ Origin: GHOST_ORIGIN }, { Origin: OTHER_EXTENSION }, {}] as Record<string, string>[]) {
      const res = await call(unpinned, "POST", "/v1/loop/preview", mailBody(), headers);
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(/GHOST_EXTENSION_ID/);
    }
    expect(api.calls).toHaveLength(0);

    const pinned = await previewAndRun(appWith({ ...COMPOSIO_ENV, ...PINNED }, { fetch: api.fetch }), mailBody(), { Origin: GHOST_ORIGIN });
    expect(pinned.status).toBe(200);
    expect(api.calls.map((c) => c.url.split("/").pop())).toEqual([TOOLS.sendEmail]);
  });

  it("accepts the per-install secret from a caller without an Origin (the desktop daemon), and rejects a wrong one", async () => {
    const api = composioOk();
    const hono = appWith({ ...COMPOSIO_ENV, GHOST_EXECUTE_TOKEN: EXECUTE_TOKEN }, { fetch: api.fetch });
    expect((await call(hono, "POST", "/v1/loop/preview", mailBody(), { "X-Ghost-Token": "wrong-secret-0123456789" })).status).toBe(401);
    expect((await call(hono, "POST", "/v1/loop/preview", mailBody())).status).toBe(403);
    const run = await previewAndRun(hono, mailBody(), { "X-Ghost-Token": EXECUTE_TOKEN });
    expect(run.status).toBe(200);
    expect(api.calls).toHaveLength(1);
    // A short secret is not a secret: it is ignored, so it can never make a caller trusted.
    expect(loadConfig({ GHOST_EXECUTE_TOKEN: "short" }).executeToken).toBeUndefined();
    expect(loadConfig({ GHOST_EXTENSION_ID: "not-an-id" }).extensionId).toBeUndefined();
  });

  it("ignores a caller-asserted confirmIrreversible: only a preview token confirms a batch", async () => {
    const api = composioOk();
    const hono = appWith({ ...COMPOSIO_ENV, ...PINNED }, { fetch: api.fetch });
    const res = await call(hono, "POST", "/v1/loop/execute", { ...mailBody(), confirmIrreversible: true }, { Origin: GHOST_ORIGIN });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: expect.stringMatching(/confirmToken is required/), irreversible: [{ stepIndex: 4, description: "Send", count: 1 }] });
    expect(api.calls).toHaveLength(0);
  });

  it("previews exactly what will be confirmed: every irreversible step with its count, and every site", async () => {
    const { status, json } = await call(appWith({}), "POST", "/v1/loop/preview", jobBody());
    expect(status).toBe(200);
    expect(json).toMatchObject({ mode: "parallel", simulated: true, items: 3, irreversible: [{ stepIndex: 10, description: "Reply: received", count: 3 }], origins: [DEMO] });
    expect(json.confirmToken).toMatch(/^[\w-]{43}$/);
    expect(json.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.expiresAt).toBeGreaterThan(Date.now());
  });

  it("binds the token to the previewed mode, program and items, and lets it be used once", async () => {
    const hono = appWith({});
    const token = async (): Promise<string> => (await call(hono, "POST", "/v1/loop/preview", jobBody())).json.confirmToken as string;

    const moreItems = await call(hono, "POST", "/v1/loop/execute", jobBody({ items: invoiceItems(4), confirmToken: await token() }));
    expect([moreItems.status, moreItems.json.error]).toEqual([409, expect.stringMatching(/different mode, program, items or baseUrl/)]);
    const otherRecipient = jobBody({ confirmToken: await token() });
    (otherRecipient.items as ExecuteJob["items"])[0]!.vars.vendor = "someone else";
    expect((await call(hono, "POST", "/v1/loop/execute", otherRecipient)).status).toBe(409);
    expect((await call(hono, "POST", "/v1/loop/execute", jobBody({ mode: "api", confirmToken: await token() }))).status).toBe(409);
    expect((await call(hono, "POST", "/v1/loop/execute", jobBody({ confirmToken: "made-up" }))).status).toBe(409);

    const good = await token();
    // Var order is not part of the identity of a job.
    const reordered = jobBody({ confirmToken: good });
    reordered.items = (reordered.items as ExecuteJob["items"]).map((item) => ({ ...item, vars: Object.fromEntries(Object.entries(item.vars).reverse()) }));
    expect((await call(hono, "POST", "/v1/loop/execute", reordered)).status).toBe(200);
    const again = await call(hono, "POST", "/v1/loop/execute", jobBody({ confirmToken: good }));
    expect([again.status, again.json.error]).toEqual([409, expect.stringMatching(/already used/)]);
  });

  it("expires a token after five minutes", async () => {
    let clock = 1_800_000_000_000;
    const hono = appWith({}, { tickets: createTicketOffice(() => clock) });
    const { json } = await call(hono, "POST", "/v1/loop/preview", jobBody());
    clock += 5 * 60_000;
    const late = await call(hono, "POST", "/v1/loop/execute", jobBody({ confirmToken: json.confirmToken }));
    expect([late.status, late.json.error]).toEqual([409, expect.stringMatching(/expired/)]);
  });
});

describe("POST /v1/loop/execute", () => {
  it("answers { runId, report }, simulated with no keys, for any extension and for a bare local caller", async () => {
    const hono = createApp(loadConfig({}));
    for (const mode of ["parallel", "api"]) {
      const { status, json, preview } = await previewAndRun(hono, jobBody({ mode }), mode === "api" ? { Origin: OTHER_EXTENSION } : {});
      expect(status).toBe(200);
      expect(json.runId).toBe(preview.runId);
      expect(json.report).toMatchObject({ mode, simulated: true, results: [{ index: 2, ok: true, steps: 11 }, { index: 3, ok: true, steps: 11 }, { index: 4, ok: true, steps: 11 }] });
    }
  });

  it("runs the real executor with injected fakes, logs counts only, and turns a refusal into a 400 at preview time", async () => {
    const cloud = new FakeCloud();
    const bb = fakeBrowserbase();
    const lines: string[] = [];
    const hono = appWith({ ...BB_ENV, ...PINNED }, { fetch: bb.fetch, connect: cloud.connect, log: (l) => lines.push(l) });
    const ok = await previewAndRun(hono, jobBody(), { Origin: GHOST_ORIGIN });
    expect(ok.json.report).toMatchObject({ mode: "parallel", simulated: false, durability: "verified", results: [{ ok: true }, { ok: true }, { ok: true }] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[ghost\] browserbase \/v1\/loop\/execute \d+ms mode=parallel items=3 failed=0 irreversible=1$/);

    const { GHOST_PUBLIC_DEMO_URL: _unset, ...noPublicUrl } = BB_ENV;
    const refused = await call(appWith({ ...noPublicUrl, ...PINNED }, { connect: cloud.connect }), "POST", "/v1/loop/preview", jobBody(), { Origin: GHOST_ORIGIN });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/GHOST_PUBLIC_DEMO_URL/);
    expect(refused.json.confirmToken).toBeUndefined();
  });

  it("validates the body: caps, shapes, origins and sensitive fields", async () => {
    const hono = createApp(loadConfig({}));
    const bad: Array<[Body, RegExp]> = [
      [{ mode: "visible" }, /mode must be one of: parallel, api/],
      [{ items: invoiceItems(201) }, /items must have at most 200 items/],
      [{ items: [] }, /items must not be empty/],
      [{ items: [...invoiceItems(1), ...invoiceItems(1)] }, /items\[1\]\.index is a duplicate/],
      [{ items: [{ index: 2, url: "https://evil.example.com/invoices/INV-1", vars: {} }] }, /items\[0\]\.url must be on baseUrl/],
      [{ items: [{ index: 2, url: `${DEMO}/invoices/INV-1`, vars: { vendor: 7 } }] }, /items\[0\]\.vars\.vendor must be a string/],
      [{ baseUrl: "javascript:alert(1)" }, /baseUrl must be an http\(s\) URL/],
      [{ confirmToken: 7 }, /confirmToken must be a non-empty string/],
      [{ program: { ...invoiceProgram(), steps: [] } }, /program\.steps must not be empty/],
      [{ program: { ...invoiceProgram(), steps: [{ op: "eval" }] } }, /program\.steps\[0\]\.op must be one of/],
      [{ program: { ...invoiceProgram(), irreversible: [{ stepIndex: 99, description: "x" }] } }, /stepIndex is not a step/],
      [{ program: { ...invoiceProgram(), steps: [{ op: "fill", target: { label: "Card number", kind: "text" }, value: { var: "card" } }] } }, /looks sensitive/],
      [{ program: { ...invoiceProgram(), steps: [{ op: "click", target: { label: "Go", kind: "button" } }] } }, /locked must be a boolean/],
    ];
    for (const [overrides, message] of bad) {
      for (const path of ["/v1/loop/preview", "/v1/loop/execute"]) {
        const res = await call(hono, "POST", path, jobBody(overrides));
        expect(res.status).toBe(400);
        expect(res.json.error).toMatch(message);
      }
    }
    expect((await call(hono, "POST", "/v1/loop/execute", "{not json")).status).toBe(400);
  });

  it("enforces the 1 MB body limit, the JSON content type and the global origin rule", async () => {
    const hono = createApp(loadConfig({}));
    for (const path of ["/v1/loop/preview", "/v1/loop/execute"]) {
      expect((await call(hono, "POST", path, jobBody({ padding: "x".repeat(1_000_001) }))).status).toBe(413);
      expect((await hono.request(path, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(jobBody()) })).status).toBe(415);
      expect((await call(hono, "POST", path, jobBody(), { Origin: "https://evil.com" })).status).toBe(403);
    }
  });

  it("drops query strings from item URLs and sensitive-looking vars before they reach an executor", async () => {
    let seen: ExecuteJob | undefined;
    const spy: LoopExecutor = { mode: "parallel", available: false, check: async () => undefined, run: async (job) => ((seen = job), { mode: "parallel", results: [], startedAt: 0, finishedAt: 0, simulated: true }) };
    const items = [{ index: 2, url: `${DEMO}/invoices/INV-1003?token=abc#frag`, vars: { vendor: "Initech", password: "hunter2" } }];
    await previewAndRun(appWith({}, { executors: { parallel: spy } }), jobBody({ items }));
    expect(seen).toMatchObject({ baseUrl: DEMO, confirmIrreversible: true, items: [{ index: 2, url: `${DEMO}/invoices/INV-1003`, vars: { vendor: "Initech" } }] });
    expect(JSON.stringify(seen)).not.toContain("hunter2");
  });
});

describe("finding 4: duplicates, the run lock and the ledger", () => {
  it("runs a double-clicked confirmation once: the second identical request is refused", async () => {
    const api = fakeFetch(() => ({ status: 200, json: { successful: true } }));
    const hono = appWith({ ...COMPOSIO_ENV, ...PINNED, COMPOSIO_SPREADSHEET_ID: "sheet-123" }, { fetch: api.fetch });
    const body = jobBody({ mode: "api", items: invoiceItems(2).map((item) => ({ ...item, vars: { ...item.vars, threadId: "t", senderEmail: "billing@example.com" } })) });
    const headers = { Origin: GHOST_ORIGIN };
    const { json: preview } = await call(hono, "POST", "/v1/loop/preview", body, headers);
    const [a, b] = await Promise.all([1, 2].map(() => call(hono, "POST", "/v1/loop/execute", { ...body, confirmToken: preview.confirmToken }, headers)));
    expect([a?.status, b?.status].sort()).toEqual([200, 409]);
    expect(api.calls.filter((c) => c.url.endsWith(TOOLS.replyEmail))).toHaveLength(2); // one reply per item, not two
  });

  it("allows one server run at a time, even with a second valid token", async () => {
    let release: () => void = () => undefined;
    const slow: LoopExecutor = {
      mode: "parallel",
      available: false,
      check: async () => undefined,
      run: (job) => new Promise((resolve) => (release = () => resolve({ mode: "parallel", results: job.items.map((i) => ({ index: i.index, ok: true, steps: 1 })), startedAt: 0, finishedAt: 0, simulated: true }))),
    };
    const hono = appWith({}, { executors: { parallel: slow } });
    const first = await call(hono, "POST", "/v1/loop/preview", jobBody());
    const second = await call(hono, "POST", "/v1/loop/preview", jobBody());
    const running = call(hono, "POST", "/v1/loop/execute", jobBody({ confirmToken: first.json.confirmToken }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const blocked = await call(hono, "POST", "/v1/loop/execute", jobBody({ confirmToken: second.json.confirmToken }));
    expect(blocked).toMatchObject({ status: 409, json: { error: "another run is in progress", runId: first.json.runId } });
    release();
    expect((await running).status).toBe(200);
    // The refused request did not burn its token, and the lock is free again.
    const retry = call(hono, "POST", "/v1/loop/execute", jobBody({ confirmToken: second.json.confirmToken }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    expect((await retry).status).toBe(200);
  });

  it("never runs an item again once it reached a writing step, for the lifetime of the process", async () => {
    const api = fakeFetch(() => ({ status: 200, json: { successful: true } }));
    const hono = appWith({ ...COMPOSIO_ENV, ...PINNED }, { fetch: api.fetch });
    const items = invoiceItems(2).map((item) => ({ ...item, vars: { ...item.vars, threadId: "t", senderEmail: "billing@example.com" } }));
    const headers = { Origin: GHOST_ORIGIN };
    expect((await previewAndRun(hono, jobBody({ mode: "api", items }), headers)).status).toBe(200);
    const sent = api.calls.length;

    const repeat = await call(hono, "POST", "/v1/loop/preview", jobBody({ mode: "api", items }), headers);
    expect(repeat).toMatchObject({ status: 409, json: { alreadyRun: [2, 3] } });
    expect(api.calls).toHaveLength(sent);
    // Simulated runs touch nothing, so they are never remembered.
    const simulated = appWith({});
    expect((await previewAndRun(simulated, jobBody())).status).toBe(200);
    expect((await previewAndRun(simulated, jobBody())).status).toBe(200);
  });

  it("clamps BROWSERBASE_CONCURRENCY", () => {
    expect(loadConfig({ ...BB_ENV, BROWSERBASE_CONCURRENCY: "500" }).browserbase?.concurrency).toBe(10);
    expect(loadConfig({ ...BB_ENV, BROWSERBASE_CONCURRENCY: "3" }).browserbase?.concurrency).toBe(3);
  });
});

describe("finding 5: cancel, disconnect, deadline and progress", () => {
  const headers = { Origin: GHOST_ORIGIN };
  const env = { ...BB_ENV, ...PINNED, BROWSERBASE_CONCURRENCY: "1" };

  function slowCloud(): { hono: Hono; cloud: FakeCloud; deps: ExecuteDeps } {
    const cloud = new FakeCloud({ stepDelayMs: 15 });
    const deps: ExecuteDeps = { fetch: fakeBrowserbase().fetch, connect: cloud.connect };
    return { hono: appWith(env, deps), cloud, deps };
  }

  it("DELETE /v1/loop/execute/:runId stops the run: no locked step and no new item starts afterwards", async () => {
    const { hono, cloud } = slowCloud();
    const preview = await call(hono, "POST", "/v1/loop/preview", jobBody(), headers);
    const running = call(hono, "POST", "/v1/loop/execute", jobBody({ confirmToken: preview.json.confirmToken }), headers);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await call(hono, "DELETE", `/v1/loop/execute/${preview.json.runId as string}`, undefined, headers)).toMatchObject({ status: 200, json: { cancelled: true } });
    const { status, json } = await running;
    expect(status).toBe(200);
    expect(json.report).toMatchObject({ stopped: "cancelled", results: [{ index: 2, ok: false, error: "stopped: the run was cancelled" }, { index: 3, steps: 0, error: "skipped: the run was cancelled" }, { index: 4, steps: 0 }] });
    expect(cloud.clicks).toHaveLength(0);
    expect(cloud.open).toBe(0);
    expect((await call(hono, "DELETE", `/v1/loop/execute/${preview.json.runId as string}`, undefined, headers)).status).toBe(404);
  });

  it("stops when the client disconnects", async () => {
    const { hono, cloud } = slowCloud();
    const preview = await call(hono, "POST", "/v1/loop/preview", jobBody(), headers);
    const client = new AbortController();
    const running = hono.request(new Request("http://localhost/v1/loop/execute", { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(jobBody({ confirmToken: preview.json.confirmToken })), signal: client.signal }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    client.abort();
    const { report } = (await (await running).json()) as { report: ExecuteReport };
    expect(report.stopped).toBe("disconnected");
    expect(cloud.clicks).toHaveLength(0);
  });

  it("stops at the job deadline", async () => {
    const cloud = new FakeCloud({ stepDelayMs: 15 });
    const hono = appWith(env, { fetch: fakeBrowserbase().fetch, connect: cloud.connect, deadlineMs: 30 });
    const { json } = await previewAndRun(hono, jobBody(), headers);
    expect(json.report?.stopped).toBe("deadline");
    expect(json.report?.results.every((r) => !r.ok)).toBe(true);
    expect(cloud.clicks).toHaveLength(0);
  });

  it("streams the run id, per-item progress and the final report with ?stream=1", async () => {
    const hono = appWith({});
    const preview = await call(hono, "POST", "/v1/loop/preview", jobBody());
    const res = await hono.request("/v1/loop/execute?stream=1", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(jobBody({ confirmToken: preview.json.confirmToken })) });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events: Json[] = [];
    for await (const data of sseData(res.body as ReadableStream<Uint8Array>)) events.push(JSON.parse(data) as Json);
    expect(events[0]).toEqual({ runId: preview.json.runId, total: 3 });
    expect(events.slice(1, 4)).toEqual([1, 2, 3].map((done) => ({ progress: { index: done + 1, ok: true, done, total: 3 } })));
    expect(events[4]).toMatchObject({ done: true, runId: preview.json.runId, report: { simulated: true } });
    // The lock is released when the stream ends.
    expect((await previewAndRun(hono, jobBody())).status).toBe(200);
  });
});
