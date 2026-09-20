import { detectLoop, synthesizeProgram, type LoopProgram } from "@shabang/shared";
import { describe, expect, it } from "vitest";
import { invoiceFactsByUrl, invoiceSession } from "../../shared/test/helpers/traceBuilder";
import { loadConfig } from "../src/config";
import { BROWSERBASE_SESSIONS_URL, createBrowserbaseApi, createBrowserbaseExecutor, createUrlRewriter, isPrivateHost } from "../src/executors/browserbase";
import { COMPOSIO_EXECUTE_URL, compile, createComposioExecutor, renderArgs, TOOLS } from "../src/executors/composio";
import { createExecutors } from "../src/executors/index";
import { runPool } from "../src/executors/pool";
import { irreversibleEffects } from "../src/executors/steps";
import { createStubExecutor } from "../src/executors/stub";
import { ExecutorRefusal } from "../src/executors/types";
import { DEMO, FakeCloud, PUBLIC_DEMO, fakeBrowserbase, fakeFetch, invoiceItems, invoiceJob, invoiceProgram, isRelease, publicLookup } from "./executors.fixtures";

const CREDS = { apiKey: "bb-test-key", projectId: "proj-1" };
const BB_ENV = { BROWSERBASE_API_KEY: CREDS.apiKey, BROWSERBASE_PROJECT_ID: CREDS.projectId };
const COMPOSIO = { apiKey: "cmp-test-key", userId: "alex", defaults: { spreadsheetId: "sheet-123", sheetRange: "Sheet1", threadId: "t-1", senderEmail: "billing@example.com" } };
const noNetwork = (() => Promise.reject(new Error("the network must not be touched"))) as unknown as typeof fetch;

function sendProgram(overrides: Partial<Extract<LoopProgram["steps"][number], { op: "click" }>> = {}): LoopProgram {
  const at = { origin: DEMO, pathPattern: "/mail/:id" };
  return {
    ...invoiceProgram(),
    iterator: { origin: DEMO, pathPattern: "/mail", listSignature: "ul#threads", stride: 1, nextIndex: 2, itemPathPattern: "/mail/:id" },
    steps: [
      { op: "open-item" },
      { op: "fill", target: { label: "To", kind: "email" }, value: { var: "sender" }, at },
      { op: "fill", target: { label: "Subject", kind: "text" }, value: { const: "Invoice received" }, at },
      { op: "fill", target: { label: "Message", kind: "textarea" }, value: { var: "note" }, at },
      { op: "click", target: { label: "Send", kind: "button" }, locked: true, at, ...overrides },
    ],
    irreversible: [],
  };
}

describe("stubs when keys are missing", () => {
  it("reports both executors unavailable with the key to add", () => {
    const executors = createExecutors(loadConfig({}), { fetch: noNetwork });
    expect(executors.parallel).toMatchObject({ mode: "parallel", available: false, reason: "Add BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID to enable parallel cloud execution" });
    expect(executors.api).toMatchObject({ mode: "api", available: false, reason: "Add COMPOSIO_API_KEY to enable API execution" });
  });

  it("returns a simulated report: every item ok, 0 ms per item, nothing touched", async () => {
    const executors = createExecutors(loadConfig({}), { fetch: noNetwork, now: () => 1_800_000_000_000 });
    for (const mode of ["parallel", "api"] as const) {
      const progress: number[] = [];
      const report = await executors[mode].run(invoiceJob(4), { onProgress: (p) => progress.push(p.done) });
      expect(report).toEqual({ mode, simulated: true, startedAt: 1_800_000_000_000, finishedAt: 1_800_000_000_000, results: [2, 3, 4, 5].map((index) => ({ index, ok: true, steps: 11 })) });
      expect(progress).toEqual([1, 2, 3, 4]);
    }
  });

  it("still refuses an unconfirmed irreversible program, so the demo teaches the real flow", async () => {
    await expect(createStubExecutor("parallel").run(invoiceJob(1, { confirmIrreversible: false }))).rejects.toBeInstanceOf(ExecutorRefusal);
  });
});

describe("precedence", () => {
  it("uses the real executor only when its keys are complete", () => {
    expect(createExecutors(loadConfig(BB_ENV)).parallel.available).toBe(true);
    expect(createExecutors(loadConfig({ BROWSERBASE_API_KEY: "k" })).parallel.available).toBe(false);
    expect(createExecutors(loadConfig({ BROWSERBASE_PROJECT_ID: "p" })).parallel.available).toBe(false);
    expect(createExecutors(loadConfig({ COMPOSIO_API_KEY: "k" })).api.available).toBe(true);
    expect(createExecutors(loadConfig({ COMPOSIO_API_KEY: "k" })).parallel.available).toBe(false);
  });

  it("stays simulated in offline (e2e) mode even when keys exist", () => {
    const executors = createExecutors(loadConfig({ ...BB_ENV, COMPOSIO_API_KEY: "k", SHABANG_PROVIDER: "heuristic" }));
    expect([executors.parallel.available, executors.api.available]).toEqual([false, false]);
  });

  it("reads the optional settings", () => {
    const config = loadConfig({ ...BB_ENV, BROWSERBASE_CONCURRENCY: "2", COMPOSIO_API_KEY: "k", COMPOSIO_SPREADSHEET_ID: "abc", SHABANG_PUBLIC_DEMO_URL: PUBLIC_DEMO });
    expect(config.browserbase).toEqual({ ...CREDS, concurrency: 2 });
    expect(config.composio).toMatchObject({ userId: "default", defaults: { sheetRange: "Sheet1", spreadsheetId: "abc" } });
    expect(config.publicDemoUrl).toBe(PUBLIC_DEMO);
    expect(loadConfig({ ...BB_ENV, BROWSERBASE_CONCURRENCY: "lots" }).browserbase?.concurrency).toBeUndefined();
  });
});

describe("irreversible gate", () => {
  it("never trusts the client's locked flag: every click of a server-run batch needs the confirmation", () => {
    expect(irreversibleEffects(invoiceProgram())).toEqual([{ stepIndex: 10, description: "Reply: received" }]);
    expect(irreversibleEffects(sendProgram({ locked: false }))).toEqual([{ stepIndex: 4, description: "Send" }]);
  });

  it("refuses before any session exists when the batch was not confirmed", async () => {
    const bb = fakeBrowserbase();
    const cloud = new FakeCloud();
    const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: PUBLIC_DEMO, fetch: bb.fetch, connect: cloud.connect });
    await expect(executor.run(invoiceJob(2, { confirmIrreversible: false }))).rejects.toMatchObject({ name: "ExecutorRefusal", details: { irreversible: [{ stepIndex: 10, description: "Reply: received" }] } });
    expect(bb.calls).toHaveLength(0);
    expect(cloud.clicks).toHaveLength(0);
  });

  it("runs the locked step once per item after the confirmation", async () => {
    const cloud = new FakeCloud();
    const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: PUBLIC_DEMO, fetch: fakeBrowserbase().fetch, connect: cloud.connect });
    const report = await executor.run(invoiceJob(3));
    expect(report.results).toEqual([2, 3, 4].map((index) => ({ index, ok: true, steps: 11, touched: true })));
    expect(cloud.clicks.map((c) => c.label)).toEqual(["Reply: received", "Reply: received", "Reply: received"]);
  });
});

describe("localhost refusal", () => {
  it("knows which hosts a cloud browser cannot reach", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "0.0.0.0", "10.0.0.4", "192.168.1.20", "172.16.0.1", "172.31.255.1", "[::1]", "printer.local"]) expect(isPrivateHost(host)).toBe(true);
    for (const host of ["example.com", "172.32.0.1", "11.0.0.1", "docs.google.com", "localhost.example.com"]) expect(isPrivateHost(host)).toBe(false);
  });

  it("refuses a localhost baseUrl with a clear error and creates no session", async () => {
    const bb = fakeBrowserbase();
    const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, fetch: bb.fetch, connect: new FakeCloud().connect });
    await expect(executor.run(invoiceJob(2))).rejects.toThrow(/Cloud browsers cannot reach http:\/\/localhost:5173\. Set SHABANG_PUBLIC_DEMO_URL/);
    expect(bb.calls).toHaveLength(0);
  });

  it("moves every URL onto SHABANG_PUBLIC_DEMO_URL when it is set", async () => {
    const cloud = new FakeCloud();
    const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: `${PUBLIC_DEMO}/`, fetch: fakeBrowserbase().fetch, connect: cloud.connect, concurrency: 1 });
    await executor.run(invoiceJob(1));
    // The second /sheet visit is the second cloud browser reading the first item's row back, before the locked reply.
    expect(cloud.visits).toEqual([`${PUBLIC_DEMO}/invoices/INV-1003`, `${PUBLIC_DEMO}/sheet`, `${PUBLIC_DEMO}/sheet`, `${PUBLIC_DEMO}/invoices/INV-1003`]);
  });

  it("refuses a goto into a private network and a private SHABANG_PUBLIC_DEMO_URL", () => {
    expect(() => createUrlRewriter("https://mail.example.com")("http://192.168.1.10/admin")).toThrow(ExecutorRefusal);
    expect(() => createUrlRewriter(DEMO, "http://127.0.0.1:9000")).toThrow(/reachable from the internet/);
    expect(() => createUrlRewriter("file:///etc/passwd")).toThrow(/http\(s\)/);
    expect(createUrlRewriter("https://mail.example.com")("https://docs.google.com/spreadsheets/d/abc/edit")).toBe("https://docs.google.com/spreadsheets/d/abc/edit");
  });
});

describe("concurrency pool", () => {
  it("never runs more workers than the limit and keeps result order", async () => {
    let active = 0;
    let max = 0;
    const results = await runPool([5, 1, 4, 1, 3, 1, 2, 1], { limit: 3, skipped: () => -1 }, async (ms, position) => {
      max = Math.max(max, ++active);
      await new Promise((resolve) => setTimeout(resolve, ms));
      active--;
      return position;
    });
    expect(max).toBe(3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("stops starting items after a failure but lets items in flight finish", async () => {
    const started: number[] = [];
    const results = await runPool([0, 1, 2, 3, 4, 5], { limit: 2, stopOn: (r) => r === "fail", skipped: () => "skipped" }, async (n) => {
      started.push(n);
      await new Promise((resolve) => setTimeout(resolve, n === 1 ? 1 : 10));
      return n === 1 ? "fail" : "ok";
    });
    expect(results).toEqual(["ok", "fail", "skipped", "skipped", "skipped", "skipped"]);
    expect(started).toEqual([0, 1]);
  });

  it("the Browserbase executor opens at most `concurrency` cloud browsers (default 5)", async () => {
    for (const [concurrency, expected] of [[3, 3], [undefined, 5]] as const) {
      const cloud = new FakeCloud({ stepDelayMs: 2 });
      const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: PUBLIC_DEMO, fetch: fakeBrowserbase().fetch, connect: cloud.connect, concurrency });
      const report = await executor.run(invoiceJob(12));
      expect(report.results.every((r) => r.ok)).toBe(true);
      expect(cloud.maxOpen).toBe(expected);
      expect(cloud.open).toBe(0);
    }
  });

  it("gives item N of the job row base + N, so parallel sessions never race for the same empty row", async () => {
    const cloud = new FakeCloud({ baseRow: 7 });
    const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: PUBLIC_DEMO, fetch: fakeBrowserbase().fetch, connect: cloud.connect });
    await executor.run(invoiceJob(4));
    const rows = new Map(cloud.fills.filter((f) => f.label === "Invoice #").map((f) => [f.value, f.row]));
    expect([...rows.entries()].sort()).toEqual([["INV-1003", 7], ["INV-1004", 8], ["INV-1005", 9], ["INV-1006", 10]]);
    expect(new Set(cloud.fills.filter((f) => f.value.startsWith("Vendor 1005") || f.value === "INV-1005").map((f) => f.row))).toEqual(new Set([9]));
  });
});

describe("sessions are closed on failure", () => {
  it("releases the session and closes the browser when a value does not stick, then stops the run", async () => {
    const bb = fakeBrowserbase();
    const cloud = new FakeCloud({ stick: (_label, value) => value !== "INV-1003" });
    const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: PUBLIC_DEMO, fetch: bb.fetch, connect: cloud.connect, concurrency: 1 });
    const report = await executor.run(invoiceJob(3));
    expect(report.results).toEqual([
      { index: 2, ok: false, steps: 7, error: "step 7 (fill): the value did not stick", touched: true },
      { index: 3, ok: false, steps: 0, error: "skipped: the run stopped after item 2 failed" },
      { index: 4, ok: false, steps: 0, error: "skipped: the run stopped after item 2 failed" },
    ]);
    expect(cloud.clicks).toHaveLength(0); // the irreversible step never ran after the mismatch
    expect([cloud.open, cloud.closed]).toEqual([0, 1]);
    expect(bb.calls.filter(isRelease).map((c) => c.url)).toEqual([`${BROWSERBASE_SESSIONS_URL}/sess-1`]);
  });

  it("releases the session when the CDP connection itself fails", async () => {
    const bb = fakeBrowserbase();
    const cloud = new FakeCloud({ failConnect: () => true });
    const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: PUBLIC_DEMO, fetch: bb.fetch, connect: cloud.connect });
    const report = await executor.run(invoiceJob(1));
    expect(report.results[0]).toMatchObject({ ok: false, steps: 0, error: "connectOverCDP: websocket closed" });
    expect(bb.calls.filter(isRelease)).toHaveLength(1);
  });

  it("fails the step when the browser lands somewhere else (login wall, 404 redirect)", async () => {
    const cloud = new FakeCloud({ redirect: (url) => (url.endsWith("/sheet") ? `${PUBLIC_DEMO}/login` : url) });
    const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: PUBLIC_DEMO, fetch: fakeBrowserbase().fetch, connect: cloud.connect });
    const report = await executor.run(invoiceJob(1));
    expect(report.results[0]).toEqual({ index: 2, ok: false, steps: 5, error: "step 5 (goto): landed on /login instead of /sheet" });
    expect(cloud.open).toBe(0);
  });

  it("never puts a written value into an error message", async () => {
    const cloud = new FakeCloud();
    const connect: typeof cloud.connect = async (url) => {
      const browser = await cloud.connect(url);
      const page = await browser.page();
      return { ...browser, page: async () => ({ ...page, fill: async (_t, value) => Promise.reject(new Error(`locator.fill: Timeout exceeded\nCall log:\n  - fill("${value}")`)) }) };
    };
    const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: PUBLIC_DEMO, fetch: fakeBrowserbase().fetch, connect });
    const [result] = (await executor.run(invoiceJob(1))).results;
    expect(result?.error).toBe("step 6 (fill): locator.fill: Timeout exceeded");
  });

  it("extracts a var the item did not carry, with the program's transform", async () => {
    const cloud = new FakeCloud({ texts: { total: "$1,204.50" } });
    const executor = createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: PUBLIC_DEMO, fetch: fakeBrowserbase().fetch, connect: cloud.connect });
    const [item] = invoiceItems(1);
    const { total: _total, ...vars } = item!.vars;
    const report = await executor.run(invoiceJob(1, { items: [{ ...item!, vars }] }));
    expect(report.results[0]?.ok).toBe(true);
    expect(cloud.fills.find((f) => f.label === "Total")?.value).toBe("1204.50");
  });
});

describe("Browserbase REST client", () => {
  it("creates a session with X-BB-API-Key and the project id, and releases it by id", async () => {
    const bb = fakeBrowserbase();
    const api = createBrowserbaseApi(CREDS, { fetch: bb.fetch });
    const session = await api.createSession();
    await api.releaseSession(session.id);
    expect(session).toEqual({ id: "sess-1", connectUrl: "wss://connect.browserbase.test/sess-1" });
    expect(bb.calls[0]).toMatchObject({ url: "https://api.browserbase.com/v1/sessions", headers: { "X-BB-API-Key": CREDS.apiKey, "Content-Type": "application/json" }, body: { projectId: "proj-1" } });
    expect(bb.calls[1]).toMatchObject({ url: "https://api.browserbase.com/v1/sessions/sess-1", body: { projectId: "proj-1", status: "REQUEST_RELEASE" } });
  });

  it("waits out a 429 (concurrent session limit) and reports other failures by status only", async () => {
    const slept: number[] = [];
    const limited = fakeFetch((_call, n) => (n < 3 ? { status: 429 } : { status: 201, json: { id: "s", connectUrl: "wss://x" } }));
    await expect(createBrowserbaseApi(CREDS, { fetch: limited.fetch, sleep: async (ms) => void slept.push(ms) }).createSession()).resolves.toMatchObject({ id: "s" });
    expect(slept).toEqual([500, 1000]);

    const denied = fakeFetch(() => ({ status: 401, json: { message: `bad key ${CREDS.apiKey}` } }));
    const err = await createBrowserbaseApi(CREDS, { fetch: denied.fetch }).createSession().catch((e: Error) => e);
    expect(err).toMatchObject({ name: "ExecutorUpstreamError", status: 401, message: "browserbase: create session responded 401" });
  });
});

describe("Composio compile", () => {
  it("maps the canonical invoice program to one append-row call and one reply, with nothing uncovered", () => {
    expect(compile(invoiceProgram())).toEqual({
      tools: [
        {
          tool: "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
          argsTemplate: { spreadsheet_id: "{{spreadsheetId}}", range: "{{sheetRange}}", value_input_option: "USER_ENTERED", values: '[["{{vendor}}","{{invoiceNumber}}","{{date}}","{{total}}"]]' },
          steps: [6, 7, 8, 9],
          irreversible: false,
          columns: ["Vendor", "Invoice #", "Date", "Total"],
        },
        { tool: "GMAIL_REPLY_TO_THREAD", argsTemplate: { thread_id: "{{threadId}}", recipient_email: "{{senderEmail}}", message_body: "Received" }, steps: [10], irreversible: true },
      ],
      uncovered: [],
    });
  });

  it("compiles what the shared synthesizer really emits the same way", () => {
    const session = invoiceSession(2);
    const candidate = detectLoop(session.events(), session.now);
    const program = candidate && synthesizeProgram(candidate, invoiceFactsByUrl());
    expect(program).not.toBeNull();
    expect(compile(program as LoopProgram)).toEqual(compile(invoiceProgram()));
  });

  it("turns To / Subject / Message fills plus a locked Send into one send-email call", () => {
    expect(compile(sendProgram())).toEqual({
      tools: [{ tool: TOOLS.sendEmail, argsTemplate: { recipient_email: "{{sender}}", subject: "Invoice received", body: "{{note}}" }, steps: [1, 2, 3, 4], irreversible: true }],
      uncovered: [],
    });
  });

  it("reads the spreadsheet id from a Google Sheets goto", () => {
    const program = invoiceProgram();
    program.steps[5] = { op: "goto", origin: "https://docs.google.com", pathPattern: "/spreadsheets/d/:id/edit", url: "https://docs.google.com/spreadsheets/d/1AbC_d-9/edit" };
    expect(compile(program).tools[0]?.argsTemplate.spreadsheet_id).toBe("1AbC_d-9");
  });

  it("lists what it cannot cover: clicks outside an email context and unknown actions", () => {
    const noContext = sendProgram();
    noContext.iterator = { ...noContext.iterator, pathPattern: "/orders", listSignature: "ul#orders", itemPathPattern: "/orders/:id" };
    noContext.steps = noContext.steps.map((s) => ("at" in s && s.at ? { ...s, at: { origin: DEMO, pathPattern: "/orders/:id" } } : s));
    noContext.name = "Send payment";
    expect(compile(noContext)).toEqual({ tools: [], uncovered: [1, 2, 3, 4] });

    const extra = invoiceProgram();
    extra.steps.push({ op: "click", target: { label: "Archive", kind: "button" }, locked: false });
    expect(compile(extra).uncovered).toEqual([11]);
  });

  it("substitutes vars after parsing JSON arguments, so a value can never break out of its cell", () => {
    const [sheet] = compile(invoiceProgram()).tools;
    const args = renderArgs(sheet!, { vendor: 'Acme "Quotes" \\ Co', invoiceNumber: "INV-1", date: "2026-09-03", total: "1" }, { spreadsheetId: "s", sheetRange: "Sheet1" });
    expect(args).toEqual({ spreadsheet_id: "s", range: "Sheet1", value_input_option: "USER_ENTERED", values: [['Acme "Quotes" \\ Co', "INV-1", "2026-09-03", "1"]] });
    expect(() => renderArgs(sheet!, { vendor: "x" }, { spreadsheetId: "s", sheetRange: "Sheet1" })).toThrow("no value for {{invoiceNumber}}");
  });
});

describe("Composio executor", () => {
  it("executes each tool through the REST API in item order", async () => {
    const api = fakeFetch(() => ({ status: 200, json: { successful: true, data: {}, error: null, log_id: "log" } }));
    const executor = createComposioExecutor({ settings: { ...COMPOSIO, connectedAccounts: { gmail: "ca_gmail" } }, fetch: api.fetch });
    const report = await executor.run(invoiceJob(2));
    expect(report).toMatchObject({ mode: "api", simulated: false, results: [{ index: 2, ok: true, steps: 2 }, { index: 3, ok: true, steps: 2 }] });
    expect(api.calls.map((c) => c.url)).toEqual([TOOLS.appendRow, TOOLS.replyEmail, TOOLS.appendRow, TOOLS.replyEmail].map((tool) => `${COMPOSIO_EXECUTE_URL}/${tool}`));
    expect(api.calls[0]).toMatchObject({
      headers: { "x-api-key": COMPOSIO.apiKey },
      body: { user_id: "alex", arguments: { spreadsheet_id: "sheet-123", range: "Sheet1", value_input_option: "USER_ENTERED", values: [["Vendor 1003", "INV-1003", "2026-09-03", "1003.50"]] } },
    });
    expect(api.calls[0]?.body).not.toHaveProperty("connected_account_id");
    expect(api.calls[1]?.body).toMatchObject({ connected_account_id: "ca_gmail", arguments: { thread_id: "t-1", message_body: "Received" } });
  });

  it("stops at the first unsuccessful call, never retries it, and hides upstream error text", async () => {
    const api = fakeFetch((_call, n) => (n === 2 ? { status: 200, json: { successful: false, error: "quota for billing@example.com" } } : { status: 200, json: { successful: true } }));
    const report = await createComposioExecutor({ settings: COMPOSIO, fetch: api.fetch }).run(invoiceJob(3));
    expect(report.results).toEqual([
      { index: 2, ok: false, steps: 1, error: "composio: GMAIL_REPLY_TO_THREAD reported a failure", touched: true },
      { index: 3, ok: false, steps: 0, error: "skipped: the run stopped after item 2 failed" },
      { index: 4, ok: false, steps: 0, error: "skipped: the run stopped after item 2 failed" },
    ]);
    expect(api.calls).toHaveLength(2);
  });

  it("fails an item with a missing value before its first call", async () => {
    const api = fakeFetch(() => ({ status: 200, json: { successful: true } }));
    const report = await createComposioExecutor({ settings: { ...COMPOSIO, defaults: {} }, fetch: api.fetch }).run(invoiceJob(1));
    expect(report.results[0]).toEqual({ index: 2, ok: false, steps: 0, error: "no value for {{spreadsheetId}}" });
    expect(api.calls).toHaveLength(0);
  });

  it("refuses unconfirmed or uncoverable jobs without calling the API", async () => {
    const executor = createComposioExecutor({ settings: COMPOSIO, fetch: noNetwork });
    await expect(executor.run(invoiceJob(1, { confirmIrreversible: false }))).rejects.toBeInstanceOf(ExecutorRefusal);
    const program = invoiceProgram();
    program.steps.push({ op: "click", target: { label: "Archive", kind: "button" }, locked: false });
    await expect(executor.run(invoiceJob(1, { program }))).rejects.toMatchObject({ details: { uncovered: [11] } });
  });
});
