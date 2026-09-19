// The worker's answer to "ghost:next-candidates": episodic memory first (zero network), then POST /v1/predict/next.
// Actions reach memory exactly as in production: through the trace router, which remembers every user action.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextCandidate, TraceTarget } from "@ghost/shared";
import { createEpisodicMemory } from "../src/background/episodic";
import { createMemoryKv } from "../src/background/kvStorage";
import type { LoopStateStore } from "../src/background/loopState";
import type { LoopWatcher } from "../src/background/loopWatcher";
import { MEMORY_RACE_MS, createNextClient } from "../src/background/nextClient";
import type { NextClient, NextClientDeps } from "../src/background/nextClient";
import { createTraceRouter } from "../src/background/traceRouter";
import type { LoopSender, TraceRouter } from "../src/background/traceRouter";
import { createTraceStore } from "../src/background/traceStore";
import type { NextPredictionReply } from "../src/lib/loopMessages";

const ID = "ghostghostghostghostghostghostgh";
const ORIGIN = "http://localhost:5173";
const BASE = "http://127.0.0.1:8788";
const TAB = 7;
const sender = (tabId = TAB): LoopSender => ({ id: ID, origin: ORIGIN, url: `${ORIGIN}/mail`, tab: { id: tabId } });

const OPEN_CALENDAR = "a||||open calendar|0";
const BACK = "a||||back to inbox|0";
const SEND = "button|button|||send reply|0";
const REPLY = "textarea||reply|reply|reply|0";
const ROW = "a||||quick chat thursday afternoon|0";

const CANDIDATES: NextCandidate[] = [
  { id: BACK, kind: "link", label: "Back to inbox", locked: false },
  { id: OPEN_CALENDAR, kind: "link", label: "Open calendar", locked: false },
  { id: REPLY, kind: "field", label: "Reply", locked: false },
  { id: SEND, kind: "button", label: "Send reply", locked: true },
];

const TYPED_SECRET = "alex.chen.dev@example.com meet me Thursday 2:30";

let router: TraceRouter;
let clock = 1_800_000_000_000;

function target(signature: string, label: string, kind: TraceTarget["kind"], extra: Partial<TraceTarget> = {}): TraceTarget {
  return { signature, label, kind, locked: false, ...extra };
}

/** One event through the router, as the recorder would report it from tab `tabId` on `origin`. */
async function recordOn(origin: string, type: string, path: string, eventTarget?: TraceTarget, tabId = TAB, value?: string): Promise<void> {
  clock += 1500;
  const event: Record<string, unknown> = { t: clock, type, origin, pathPattern: path, url: `${origin}${path}` };
  if (eventTarget) event.target = eventTarget;
  if (value !== undefined) event.value = value;
  const ok = await router.handle({ type: "ghost:trace-event", event }, { id: ID, origin, url: `${origin}${path}`, tab: { id: tabId } });
  expect(ok).toBe(true);
}

function record(type: string, path: string, eventTarget?: TraceTarget, value?: string, tabId = TAB): Promise<void> {
  return recordOn(ORIGIN, type, path, eventTarget, tabId, value);
}

const openInbox = (tabId = TAB) => record("navigate", "/mail", undefined, undefined, tabId);
const openEmail = async (tabId = TAB): Promise<void> => {
  await record("click", "/mail", target(ROW, "Quick chat Thursday afternoon?", "link", { list: { listSignature: "ul.mail-list", index: 0, itemKey: "Quick chat Thursday afternoon?" } }), undefined, tabId);
  await record("navigate", "/mail/msg-1001", undefined, undefined, tabId);
};
const clickOpenCalendar = async (tabId = TAB): Promise<void> => {
  await record("click", "/mail/msg-1001", target(OPEN_CALENDAR, "Open calendar", "link"), undefined, tabId);
  await record("navigate", "/calendar", undefined, undefined, tabId);
};
/** Browser back twice: the email, then the inbox. */
const goBack = async (tabId = TAB): Promise<void> => {
  await record("navigate", "/mail/msg-1001", undefined, undefined, tabId);
  await record("navigate", "/mail", undefined, undefined, tabId);
};

function makeClient(over: Partial<NextClientDeps> = {}): NextClient {
  const { trace, memory } = router.services;
  return createNextClient({ trace, memory, extensionId: ID, isEnabled: async () => true, getThreshold: async () => 0.7, getServerUrl: async () => null, ...over });
}

function ask(client: NextClient, candidates: unknown = CANDIDATES, from: LoopSender = sender()): Promise<NextPredictionReply> {
  const reply = client.handle({ type: "ghost:next-candidates", url: `${ORIGIN}/mail/msg-1001`, pathPattern: "/mail/:id", candidates }, from);
  if (!reply) throw new Error("the client ignored the message");
  return reply;
}

/** Asks from tab `tabId` on another origin and path. */
function askOn(client: NextClient, origin: string, path: string, candidates: NextCandidate[], tabId: number): Promise<NextPredictionReply> {
  const reply = client.handle({ type: "ghost:next-candidates", url: `${origin}${path}`, pathPattern: path, candidates }, { id: ID, origin, url: `${origin}${path}`, tab: { id: tabId } });
  if (!reply) throw new Error("the client ignored the message");
  return reply;
}

function serverReply(body: unknown, delayMs = 0): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  });
}

function sentBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  clock = 1_800_000_000_000;
  const services = {
    trace: createTraceStore({ storage: createMemoryKv(), now: () => clock + 60_000 }),
    memory: createEpisodicMemory({ storage: createMemoryKv() }),
    loopState: {} as LoopStateStore,
    watcher: { onEvent: vi.fn(), onFacts: vi.fn(), dismiss: vi.fn(async () => undefined), cancel: vi.fn() } as unknown as LoopWatcher,
  };
  router = createTraceRouter({ services, extensionId: ID, isEnabled: async () => true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("episodic memory answers first, with zero network", () => {
  it("learns the action the user actually chose instead of its unseen-state guess", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = makeClient({ fetch: fetchMock });

    await openInbox();
    await openEmail();
    expect(await ask(client)).toMatchObject({ ok: true, candidateId: BACK, confidence: 0.25 }); // unseen: safest first best guess

    await clickOpenCalendar();
    await goBack();
    await openEmail();
    expect(await ask(client)).toMatchObject({ ok: true, candidateId: OPEN_CALENDAR, confidence: 0.75, provider: "memory", calibrated: false });

    await clickOpenCalendar();
    await goBack();
    await openEmail();
    expect(await ask(client)).toMatchObject({ ok: true, candidateId: OPEN_CALENDAR, confidence: 0.9, provider: "memory" });
    expect(fetchMock).not.toHaveBeenCalled(); // no server configured: memory only
  });

  it("does not propose from a different state (the calendar was opened from the inbox, not from the email)", async () => {
    const client = makeClient();
    await openInbox();
    await openEmail();
    await clickOpenCalendar();
    await record("navigate", "/mail");
    await record("navigate", "/mail/msg-1002"); // a different route into the email: another state
    expect(await ask(client)).toMatchObject({ ok: true, candidateId: BACK, confidence: 0.25 });
  });

  it("keeps the state per tab: another tab's actions in between do not hide the memory", async () => {
    const client = makeClient();
    await openInbox();
    await openEmail();
    await clickOpenCalendar();
    await goBack();
    await record("click", "/mail", target(ROW, "Quick chat Thursday afternoon?", "link", { list: { listSignature: "ul.mail-list", index: 0, itemKey: "Quick chat Thursday afternoon?" } }));
    await record("navigate", "/sheet", undefined, undefined, 9); // tab 9 does something unrelated
    await record("click", "/sheet", target("input||cell|x|x|0", "Vendor", "text"), undefined, 9);
    await record("navigate", "/mail/msg-1001");
    expect(await ask(client)).toMatchObject({ ok: true, candidateId: OPEN_CALENDAR, confidence: 0.75 });
  });

  it("proposes a locked target only as data (the content script decides; it is never clicked there)", async () => {
    const client = makeClient();
    await openInbox();
    await openEmail();
    await record("click", "/mail/msg-1001", target(SEND, "Send reply", "button", { locked: true }));
    await goBack();
    await openEmail();
    const reply = await ask(client);
    expect(reply).toMatchObject({ ok: true, candidateId: SEND, confidence: 0.75 });
  });
});

describe("POST /v1/predict/next", () => {
  /** Open calendar was done once from this state; on the calendar the user typed something private. */
  async function memorised(): Promise<void> {
    await openInbox();
    await openEmail();
    await clickOpenCalendar();
    await record("input", "/calendar", target("input|text|note|note|note|0", "Note", "text"), TYPED_SECRET);
    await goBack();
    await openEmail();
  }

  it("sends the tab's last 20 actions WITHOUT values, the candidates and at most 5 memories, as JSON", async () => {
    await memorised();
    const fetchMock = serverReply({ candidateId: OPEN_CALENDAR, confidence: 0.93, provider: "typesafe", calibrated: true, latencyMs: 120 });
    const reply = await ask(makeClient({ fetch: fetchMock, getServerUrl: async () => BASE }));
    expect(reply).toMatchObject({ ok: true, candidateId: OPEN_CALENDAR, confidence: 0.93, provider: "typesafe", calibrated: true });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/v1/predict/next`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    const raw = String(init?.body);
    expect(raw).not.toContain("alex.chen");
    expect(raw).not.toContain("Thursday 2:30");
    expect(raw).not.toContain('"value"');
    const body = sentBody(fetchMock);
    // Places go out as origin + path PATTERN: the record id in /mail/msg-1001 stays home.
    expect(body).toMatchObject({ origin: ORIGIN, url: `${ORIGIN}/mail/:id`, candidates: CANDIDATES });
    expect(raw).not.toContain("msg-1001");
    const actions = body.recentActions as Array<Record<string, unknown>>;
    expect(actions.length).toBeLessThanOrEqual(20);
    expect(actions.at(-1)).toEqual({ type: "navigate", url: `${ORIGIN}/mail/:id` });
    expect(actions.find((a) => a.type === "input")).toEqual({ type: "input", url: `${ORIGIN}/calendar`, label: "Note", kind: "text", signature: "input|text|note|note|note|0" });
    const memory = body.memory as Array<Record<string, unknown>>;
    expect(memory.length).toBeGreaterThan(0);
    expect(memory.length).toBeLessThanOrEqual(5);
    expect(memory[0]).toMatchObject({ action: { type: "click", label: "Open calendar", kind: "link", signature: OPEN_CALENDAR }, previousAction: { type: "navigate" } });
  });

  it("caps recentActions at 20 even after a long session", async () => {
    await openInbox();
    for (let i = 0; i < 15; i++) await openEmail();
    const fetchMock = serverReply({ candidateId: "none", confidence: 0.6, provider: "heuristic", calibrated: false, latencyMs: 1 });
    await ask(makeClient({ fetch: fetchMock, getServerUrl: async () => BASE }));
    expect((sentBody(fetchMock).recentActions as unknown[]).length).toBe(20);
  });

  it("never offers a sensitive candidate to the server", async () => {
    await openInbox();
    const fetchMock = serverReply({ candidateId: "none", confidence: 0.6, provider: "heuristic", calibrated: false, latencyMs: 1 });
    await ask(makeClient({ fetch: fetchMock, getServerUrl: async () => BASE }), [...CANDIDATES, { id: "input|password|pw||password|0", kind: "field", label: "Password", locked: false }]);
    expect(JSON.stringify(sentBody(fetchMock))).not.toContain("assword");
  });

  it("a confident memory wins when the server is slower than 800 ms", async () => {
    await memorised();
    vi.useFakeTimers();
    const fetchMock = serverReply({ candidateId: BACK, confidence: 0.99, provider: "typesafe", calibrated: true, latencyMs: 2000 }, 2000);
    const pending = ask(makeClient({ fetch: fetchMock, getServerUrl: async () => BASE }));
    await vi.advanceTimersByTimeAsync(MEMORY_RACE_MS + 1);
    await expect(pending).resolves.toMatchObject({ ok: true, candidateId: OPEN_CALENDAR, confidence: 0.75, provider: "memory" });
    await vi.advanceTimersByTimeAsync(3000); // the late answer lands and is ignored
  });

  it("a confident memory wins when the server is down or answers an id it was never offered", async () => {
    await memorised();
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await ask(makeClient({ fetch: down, getServerUrl: async () => BASE }))).toMatchObject({ candidateId: OPEN_CALENDAR, provider: "memory" });
    const invented = serverReply({ candidateId: "button|delete everything|0", confidence: 0.99, provider: "llm", calibrated: false, latencyMs: 5 });
    expect(await ask(makeClient({ fetch: invented, getServerUrl: async () => BASE }))).toMatchObject({ candidateId: OPEN_CALENDAR, provider: "memory" });
  });

  it("an uncalibrated 'none' from the server's heuristic does not overrule a memory that saw this state", async () => {
    await memorised();
    const fetchMock = serverReply({ candidateId: "none", confidence: 0.6, provider: "heuristic", calibrated: false, latencyMs: 1 });
    expect(await ask(makeClient({ fetch: fetchMock, getServerUrl: async () => BASE }))).toMatchObject({ candidateId: OPEN_CALENDAR, provider: "memory" });
  });

  it("without a confident memory, the server's answer is the answer (Jev's calibrated confidence)", async () => {
    await openInbox();
    await openEmail();
    const fetchMock = serverReply({ candidateId: OPEN_CALENDAR, confidence: 0.82, provider: "typesafe", calibrated: true, latencyMs: 300 });
    expect(await ask(makeClient({ fetch: fetchMock, getServerUrl: async () => BASE }))).toMatchObject({ ok: true, candidateId: OPEN_CALENDAR, confidence: 0.82, provider: "typesafe", calibrated: true });
  });
});

describe("one site never learns about another", () => {
  const BANK = "https://bank.example";
  const TRANSFER = target("button|button|||transfer to priya nair|0", "Transfer to Priya Nair", "button");

  async function bankVisit(tabId = TAB): Promise<void> {
    await recordOn(BANK, "navigate", "/accounts/00123456789", undefined, tabId);
    await recordOn(BANK, "click", "/accounts/00123456789", TRANSFER, tabId);
    await recordOn(BANK, "navigate", "/accounts/00123456789/done", undefined, tabId);
  }

  it("sends only this origin's actions, as path patterns, and no memory learned on another site", async () => {
    await bankVisit();
    await bankVisit(); // the bank pair is now a memory, and a similar-looking one (navigate > /accounts/:id)
    await openInbox();
    await openEmail();
    const fetchMock = serverReply({ candidateId: "none", confidence: 0.6, provider: "heuristic", calibrated: false, latencyMs: 1 });
    await ask(makeClient({ fetch: fetchMock, getServerUrl: async () => BASE }));
    const raw = String(fetchMock.mock.calls[0]?.[1]?.body);
    for (const never of ["bank.example", "00123456789", "accounts", "Transfer", "Priya Nair", "transfer to"]) expect(raw).not.toContain(never);
    const body = sentBody(fetchMock);
    const actions = body.recentActions as Array<{ url: string }>;
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action.url.startsWith(`${ORIGIN}/`)).toBe(true);
    expect(body.memory).toEqual([]);
  });

  it("a click learned on site A never becomes a ghost on site B, however alike the pages", async () => {
    const A = "http://a.localhost:5173";
    const B = "http://b.localhost:5173";
    const DOCS = "a||||docs|0";
    const docs: NextCandidate[] = [{ id: DOCS, kind: "link", label: "Docs", locked: false }, { id: "a||||blog|0", kind: "link", label: "Blog", locked: false }];
    const client = makeClient();
    await recordOn(A, "navigate", "/", undefined, 1);
    await recordOn(A, "click", "/", target(DOCS, "Docs", "link"), 1);
    await recordOn(A, "navigate", "/docs", undefined, 1);

    await recordOn(B, "navigate", "/", undefined, 2); // same path, same shape, another site
    expect(await askOn(client, B, "/", docs, 2)).toMatchObject({ ok: true, candidateId: DOCS, confidence: 0.25 });

    await recordOn(A, "navigate", "/", undefined, 3); // back on A (a new tab): its own memory still works
    expect(await askOn(client, A, "/", docs, 3)).toMatchObject({ ok: true, candidateId: DOCS, confidence: 0.75 });
  });

  it("counts a demonstration only on the site it happened: once on A and once on B is 'once' on B (0.75, not 0.9)", async () => {
    const A = "http://a.localhost:5173";
    const B = "http://b.localhost:5173";
    const DOCS = "a||||docs|0";
    const docs: NextCandidate[] = [{ id: DOCS, kind: "link", label: "Docs", locked: false }];
    const client = makeClient();
    /** Home, About, Home: three events, so the state (the last three) is all this site's, and alike on both. */
    const arrive = async (origin: string, tabId: number): Promise<void> => {
      for (const path of ["/", "/about", "/"]) await recordOn(origin, "navigate", path, undefined, tabId);
    };
    await arrive(A, 1);
    await recordOn(A, "click", "/", target(DOCS, "Docs", "link"), 1);
    await arrive(B, 2);
    await recordOn(B, "click", "/", target(DOCS, "Docs", "link"), 2); // the same state as on A: one pair, count 2
    expect((await router.services.memory.retrieve("/ > navigate|/| > navigate|/about| > navigate|/|", 5))[0]).toMatchObject({ count: 2 });
    await arrive(B, 4);
    expect(await askOn(client, B, "/", docs, 4)).toMatchObject({ ok: true, candidateId: DOCS, confidence: 0.75 });
  });

  it("the cross-tab summary is only tried when every event in it is this site's", async () => {
    const A = "http://a.localhost:5173";
    const DOCS = "a||||docs|0";
    const docs: NextCandidate[] = [{ id: DOCS, kind: "link", label: "Docs", locked: false }];
    const client = makeClient();
    // On A, Docs was clicked right after the user did something on the bank in another tab.
    await recordOn(BANK, "navigate", "/accounts/00123456789", undefined, 5);
    await recordOn(BANK, "click", "/accounts/00123456789", TRANSFER, 5);
    await recordOn(A, "navigate", "/", undefined, 1);
    await recordOn(A, "click", "/", target(DOCS, "Docs", "link"), 1);
    // The same interleaving again: the cross-tab state (last three events of all tabs) matches the remembered one
    // exactly, but it holds the bank's actions, so it is not used, and a page on A cannot learn about the bank.
    await recordOn(BANK, "navigate", "/accounts/00123456789", undefined, 5);
    await recordOn(BANK, "click", "/accounts/00123456789", TRANSFER, 5);
    await recordOn(A, "navigate", "/", undefined, 6);
    const fetchMock = serverReply({ candidateId: "none", confidence: 0.6, provider: "heuristic", calibrated: false, latencyMs: 1 });
    const reply = await askOn(makeClient({ fetch: fetchMock, getServerUrl: async () => BASE }), A, "/", docs, 6);
    expect(reply).toMatchObject({ candidateId: DOCS, confidence: 0.25 });
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain("Transfer");
    expect(await askOn(client, A, "/", docs, 6)).toMatchObject({ candidateId: DOCS, confidence: 0.25 });
  });
});

describe("SSN- and card-shaped text never leaves the worker", () => {
  const SSN_LINK = "a||||123-45-6789|0";
  const CARD_LINK = "a||||4111 1111 1111 1111|0";

  it("drops candidates, recent actions' targets and memories whose label or id has the shape", async () => {
    await openInbox();
    await record("click", "/mail", target(SSN_LINK, "123-45-6789", "link"));
    await record("navigate", "/mail/msg-1001");
    await record("click", "/mail/msg-1001", target(CARD_LINK, "4111 1111 1111 1111", "link"));
    await record("navigate", "/mail/msg-1001");
    const fetchMock = serverReply({ candidateId: "none", confidence: 0.6, provider: "heuristic", calibrated: false, latencyMs: 1 });
    await ask(makeClient({ fetch: fetchMock, getServerUrl: async () => BASE }), [
      ...CANDIDATES,
      { id: SSN_LINK, kind: "link", label: "123-45-6789", locked: false },
      { id: CARD_LINK, kind: "link", label: "4111 1111 1111 1111", locked: false },
      { id: "a||||employee|3", kind: "link", label: "Employee", locked: false, context: "SSN 123-45-6789" },
    ]);
    const raw = String(fetchMock.mock.calls[0]?.[1]?.body);
    for (const never of ["123-45-6789", "4111 1111 1111 1111", "4111"]) expect(raw).not.toContain(never);
    const body = sentBody(fetchMock);
    expect((body.candidates as NextCandidate[]).find((c) => c.label === "Employee")).toEqual({ id: "a||||employee|3", kind: "link", label: "Employee", locked: false });
    expect((body.recentActions as Array<Record<string, unknown>>).filter((a) => a.type === "click")).toEqual([
      { type: "click", url: `${ORIGIN}/mail` },
      { type: "click", url: `${ORIGIN}/mail/:id` },
    ]);
  });
});

describe("who may ask", () => {
  it("ignores other extensions and other message types", () => {
    const client = makeClient();
    expect(client.handle({ type: "ghost:next-candidates", url: `${ORIGIN}/mail`, pathPattern: "/mail", candidates: CANDIDATES }, { ...sender(), id: "someone-else" })).toBeNull();
    expect(client.handle({ type: "ghost:trace-event", event: {} }, sender())).toBeNull();
    expect(client.handle({ type: "ghost:health" }, sender())).toBeNull();
  });

  it("refuses a url that is not the asking frame's origin, a sender without a tab, and a disabled Ghost", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = makeClient({ fetch: fetchMock, getServerUrl: async () => BASE });
    expect(await ask(client, CANDIDATES, { id: ID, origin: "https://evil.example", tab: { id: TAB } })).toEqual({ ok: false, error: "bad-origin" });
    expect(await ask(client, CANDIDATES, { id: ID, origin: ORIGIN })).toEqual({ ok: false, error: "bad-request" });
    expect(await ask(makeClient({ isEnabled: async () => false }))).toEqual({ ok: false, error: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers none without a server call when no usable candidate is left", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const reply = await ask(makeClient({ fetch: fetchMock, getServerUrl: async () => BASE }), [{ id: "x", kind: "field", label: "Card number", locked: false }, "junk"]);
    expect(reply).toMatchObject({ ok: true, candidateId: "none" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
