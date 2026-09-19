import { afterEach, describe, expect, it, vi } from "vitest";
import { MASKED_VALUE } from "@ghost/shared";
import type { TraceEvent } from "@ghost/shared";
import { DEMO_ORIGIN, INBOX_LIST, INVOICES, TraceBuilder, invoiceFacts, invoiceSession } from "../../shared/test/helpers/traceBuilder";
import { createMemoryKv, kvStorage, resetMemoryKv } from "../src/background/kvStorage";
import {
  TRACE_EVENTS_KEY, TRACE_FACTS_KEY, TRACE_MAX_EVENTS, TRACE_MAX_URLS, createTraceStore, looksLikeCardNumber,
} from "../src/background/traceStore";
import { INBOX_URL, asContentEvent, inboxFacts } from "./loop-helpers";

const FROM = { tabId: 7, origin: DEMO_ORIGIN };

function sample(): TraceEvent[] {
  return invoiceSession(1).events();
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetMemoryKv();
});

describe("traceStore events", () => {
  it("stamps the sender's tab id and keeps the order", async () => {
    const store = createTraceStore({ storage: createMemoryKv() });
    for (const e of sample()) await store.append({ ...asContentEvent(e), tabId: 999 }, FROM);
    const events = await store.events();
    expect(events).toHaveLength(sample().length);
    expect(new Set(events.map((e) => e.tabId))).toEqual(new Set([7]));
    expect(events.map((e) => e.type)).toEqual(sample().map((e) => e.type));
    expect((await store.recent(3)).map((e) => e.t)).toEqual(events.slice(-3).map((e) => e.t));
  });

  it("re-derives origin and path pattern from the url instead of trusting the report", async () => {
    const store = createTraceStore({ storage: createMemoryKv() });
    const [event] = new TraceBuilder().navigate("/invoices/INV-1001").events();
    const stored = await store.append({ ...event, pathPattern: "/made/up", origin: "https://elsewhere.example" }, FROM);
    expect(stored).toMatchObject({ origin: DEMO_ORIGIN, pathPattern: "/invoices/:id", url: `${DEMO_ORIGIN}/invoices/INV-1001` });
  });

  it("refuses events without a tab, from another origin, with a query string, or on a sensitive target", async () => {
    const store = createTraceStore({ storage: createMemoryKv() });
    const [nav] = new TraceBuilder().navigate("/sheet").events();
    const [secret] = new TraceBuilder().input("Password", "hunter2").events();
    const [card] = new TraceBuilder().input("Card number", "4111 1111 1111 1111").events();
    expect(await store.append(nav, { tabId: undefined, origin: DEMO_ORIGIN })).toBeNull();
    expect(await store.append(nav, { tabId: 1, origin: "https://evil.example" })).toBeNull();
    expect(await store.append({ ...nav, url: `${DEMO_ORIGIN}/sheet?token=abc` }, FROM)).toBeNull();
    expect(await store.append(secret, FROM)).toBeNull();
    expect(await store.append(card, FROM)).toBeNull();
    expect(await store.append("nonsense", FROM)).toBeNull();
    expect(await store.events()).toEqual([]);
  });

  it("masks a value that passes the card checksum even when the label looks harmless", async () => {
    const store = createTraceStore({ storage: createMemoryKv() });
    const [event] = new TraceBuilder().input("Reference", "4111 1111 1111 1111").events();
    expect((await store.append(event, FROM))?.value).toBe(MASKED_VALUE);
    expect(looksLikeCardNumber("1204.50")).toBe(false);
    expect(looksLikeCardNumber("4111111111111112")).toBe(false);
  });

  it("clamps timestamps from the future to the worker's clock", async () => {
    const store = createTraceStore({ storage: createMemoryKv(), now: () => 5000 });
    const [event] = new TraceBuilder({ start: 9000 }).navigate("/sheet").events();
    expect((await store.append(event, FROM))?.t).toBe(5000);
  });

  it("is a ring buffer of 400 events", async () => {
    const storage = createMemoryKv();
    const store = createTraceStore({ storage });
    const tb = new TraceBuilder();
    for (let i = 0; i < TRACE_MAX_EVENTS + 25; i++) tb.click(`Button ${i}`);
    for (const e of tb.events()) await store.append(e, FROM);
    const events = await store.events();
    expect(events).toHaveLength(TRACE_MAX_EVENTS);
    expect(events[0]?.target?.label).toBe("Button 25");
    expect((await storage.get(TRACE_EVENTS_KEY)) as unknown[]).toHaveLength(TRACE_MAX_EVENTS);
  });

  it("hands out copies", async () => {
    const store = createTraceStore({ storage: createMemoryKv() });
    await store.append(sample()[0], FROM);
    const [first] = await store.events();
    if (first) first.url = "changed";
    expect((await store.events())[0]?.url).toBe(`${DEMO_ORIGIN}/invoices`);
  });
});

describe("traceStore page facts", () => {
  it("keeps the latest facts per url and drops sensitive ones", async () => {
    const store = createTraceStore({ storage: createMemoryKv() });
    const [first, second] = INVOICES;
    if (!first || !second) throw new Error("fixtures");
    const url = `${DEMO_ORIGIN}/invoices/${first.id}`;
    await store.setFacts({ url, facts: invoiceFacts(second) }, FROM);
    await store.setFacts({ url, facts: [...invoiceFacts(first), { locator: { by: "id", value: "iban" }, label: "IBAN", text: "DE00 1234" }] }, FROM);
    const facts = (await store.factsByUrl())[url] ?? [];
    expect(facts.find((f) => f.label === "Vendor")?.text).toBe(first.vendor);
    expect(facts.some((f) => f.label === "IBAN")).toBe(false);
    expect(Object.keys(await store.factsByUrl())).toEqual([url]);
  });

  it("refuses a report from another origin or without a tab", async () => {
    const store = createTraceStore({ storage: createMemoryKv() });
    expect(await store.setFacts({ url: INBOX_URL, facts: inboxFacts() }, { tabId: 1, origin: "https://evil.example" })).toBeNull();
    expect(await store.setFacts({ url: INBOX_URL, facts: inboxFacts() }, { tabId: undefined, origin: DEMO_ORIGIN })).toBeNull();
    expect(await store.setFacts({ url: "about:blank", facts: [] }, FROM)).toBeNull();
  });

  it("remembers the last 60 urls, most recently reported last", async () => {
    const store = createTraceStore({ storage: createMemoryKv() });
    for (let i = 0; i < TRACE_MAX_URLS + 5; i++) await store.setFacts({ url: `${DEMO_ORIGIN}/invoices/INV-${2000 + i}`, facts: [] }, FROM);
    await store.setFacts({ url: `${DEMO_ORIGIN}/invoices/INV-2005`, facts: [] }, FROM);
    const urls = Object.keys(await store.factsByUrl());
    expect(urls).toHaveLength(TRACE_MAX_URLS);
    expect(urls).not.toContain(`${DEMO_ORIGIN}/invoices/INV-2004`);
    expect(urls[urls.length - 1]).toBe(`${DEMO_ORIGIN}/invoices/INV-2005`);
  });

  it("reads the list length and the handled indexes out of the facts, and keeps them away from the generalizer", async () => {
    const store = createTraceStore({ storage: createMemoryKv() });
    await store.setFacts({ url: INBOX_URL, facts: [...inboxFacts(50, "0, 1,7,99"), { locator: { by: "css", value: "h1" }, label: "Heading", text: "Inbox" }] }, FROM);
    expect(await store.listInfo(DEMO_ORIGIN, "/invoices", INBOX_LIST)).toEqual({ total: 50, handled: [0, 1, 7] });
    expect(await store.listInfo(DEMO_ORIGIN, "/invoices", "ul#other")).toBeNull();
    expect(await store.listInfo("https://elsewhere.example", "/invoices", INBOX_LIST)).toBeNull();
    expect((await store.factsByUrl())[INBOX_URL]).toEqual([{ locator: { by: "css", value: "h1" }, label: "Heading", text: "Inbox" }]);
  });

  it("ignores a list length that is not a plain count", async () => {
    const store = createTraceStore({ storage: createMemoryKv() });
    await store.setFacts({ url: INBOX_URL, facts: inboxFacts(50).map((f) => ({ ...f, text: "fifty" })) }, FROM);
    expect(await store.listInfo(DEMO_ORIGIN, "/invoices", INBOX_LIST)).toBeNull();
  });
});

describe("traceStore persistence", () => {
  it("survives a service worker restart", async () => {
    const storage = createMemoryKv();
    const before = createTraceStore({ storage });
    for (const e of sample()) await before.append(e, FROM);
    await before.setFacts({ url: INBOX_URL, facts: inboxFacts(50, "3") }, FROM);

    const after = createTraceStore({ storage }); // a fresh worker: nothing in memory
    expect(await after.events()).toEqual(await before.events());
    expect(await after.factsByUrl()).toEqual(await before.factsByUrl());
    expect(await after.listInfo(DEMO_ORIGIN, "/invoices", INBOX_LIST)).toEqual({ total: 50, handled: [3] });
    await after.append(sample()[0], FROM);
    expect(await after.events()).toHaveLength(sample().length + 1);
  });

  it("re-validates what it reads back", async () => {
    const storage = createMemoryKv();
    const [good] = sample();
    const [secret] = new TraceBuilder().input("Password", "hunter2").events();
    await storage.set(TRACE_EVENTS_KEY, [good, secret, { type: "click" }, 42]);
    await storage.set(TRACE_FACTS_KEY, [{ url: INBOX_URL, tabId: 1, t: 1, facts: "nope", lists: { [INBOX_LIST]: { total: -4 } } }, null]);
    const store = createTraceStore({ storage });
    expect(await store.events()).toEqual([good]);
    expect(await store.factsByUrl()).toEqual({ [INBOX_URL]: [] });
    expect(await store.listInfo(DEMO_ORIGIN, "/invoices", INBOX_LIST)).toBeNull();
  });

  it("keeps working when storage fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = { get: vi.fn().mockRejectedValue(new Error("gone")), set: vi.fn().mockRejectedValue(new Error("quota")), remove: vi.fn().mockRejectedValue(new Error("gone")) };
    const store = createTraceStore({ storage });
    await store.append(sample()[0], FROM);
    expect(await store.events()).toHaveLength(1);
    await store.clear();
    expect(await store.events()).toEqual([]);
    warn.mockRestore();
  });

  it("clear wipes memory and storage", async () => {
    const storage = createMemoryKv();
    const store = createTraceStore({ storage });
    for (const e of sample()) await store.append(e, FROM);
    await store.setFacts({ url: INBOX_URL, facts: inboxFacts() }, FROM);
    await store.clear();
    expect(await store.events()).toEqual([]);
    expect(await store.factsByUrl()).toEqual({});
    expect(await storage.get(TRACE_EVENTS_KEY)).toBeUndefined();
    expect(await storage.get(TRACE_FACTS_KEY)).toBeUndefined();
    expect(await createTraceStore({ storage }).events()).toEqual([]);
  });

  it("uses chrome.storage.session when chrome is there, and memory when it is not", async () => {
    const session = new Map<string, unknown>();
    const area = {
      get: vi.fn(async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => void Object.entries(items).forEach(([k, v]) => session.set(k, v))),
      remove: vi.fn(async (key: string) => void session.delete(key)),
    };
    vi.stubGlobal("chrome", { storage: { session: area } });
    await createTraceStore().append(sample()[0], FROM);
    expect(session.get(TRACE_EVENTS_KEY)).toHaveLength(1);
    expect(await createTraceStore().events()).toHaveLength(1);

    vi.unstubAllGlobals();
    expect(await createTraceStore().events()).toEqual([]);
    await createTraceStore().append(sample()[0], FROM);
    expect(await kvStorage("session").get(TRACE_EVENTS_KEY)).toHaveLength(1);
    expect(area.set).toHaveBeenCalledTimes(1);
  });
});
