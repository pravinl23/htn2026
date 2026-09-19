// The worker's draft relay: SSE parsing, what may leave for /v1/ghost-text, per-tab concurrency and aborts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_STREAMS_PER_TAB, createSseParser, createTextStreamHub, toPortEvent } from "../src/background/textStream";
import type { TextPort } from "../src/background/textStream";
import { TEXT_PORT, sanitizeTextRequest } from "../src/lib/messages";
import type { TextPortEvent } from "../src/lib/messages";

const EXTENSION_ID = "ghostghostghostghostghostghostgh";
const REQUEST = {
  fieldLabel: "Why Northwind?",
  fieldSignature: "textarea||whyNorthwind|why-northwind|why northwind|0",
  pageContext: { company: "Northwind Robotics", role: "Software Engineering Intern" },
  facts: { fullName: "Alex Chen", school: "University of Waterloo" },
  pastAnswers: [],
};

interface FakePort extends TextPort {
  posted: TextPortEvent[];
  disconnected: boolean;
  send(message: unknown): void;
  drop(): void;
}

function fakePort(tabId = 1, overrides: Partial<TextPort> = {}): FakePort {
  const onMessage: Array<(message: unknown) => void> = [];
  const onDisconnect: Array<() => void> = [];
  const port: FakePort = {
    name: TEXT_PORT,
    sender: { id: EXTENSION_ID, tab: { id: tabId } },
    posted: [],
    disconnected: false,
    postMessage: (message) => void port.posted.push(message),
    disconnect: () => void (port.disconnected = true),
    onMessage: { addListener: (listener) => void onMessage.push(listener) },
    onDisconnect: { addListener: (listener) => void onDisconnect.push(listener) },
    send: (message) => onMessage.forEach((listener) => listener(message)),
    drop: () => onDisconnect.forEach((listener) => listener()),
    ...overrides,
  };
  return port;
}

/** A server whose SSE body the test writes chunk by chunk. */
function controllableServer() {
  const streams: Array<{ write(text: string): void; close(): void; signal: AbortSignal; body: unknown; url: string }> = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    const signal = init?.signal as AbortSignal;
    signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    streams.push({
      write: (text) => controller.enqueue(encoder.encode(text)),
      close: () => controller.close(),
      signal,
      body: JSON.parse(String(init?.body)),
      url: String(url),
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchMock, streams };
}

const hub = (fetchMock: typeof fetch, maxPerTab?: number) =>
  createTextStreamHub({ extensionId: EXTENSION_ID, fetch: fetchMock, getServerUrl: async () => "http://localhost:8788", maxPerTab });
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SSE parsing", () => {
  it("reassembles events split across chunks, in the middle of a line and of the blank line", () => {
    const seen: string[] = [];
    const parser = createSseParser((data) => seen.push(data));
    parser.push('data: {"del');
    parser.push('ta":"Hel"}\n');
    parser.push('\ndata: {"delta":"lo"}\r\n\r\nda');
    parser.push('ta: {"done":true}');
    expect(seen).toEqual(['{"delta":"Hel"}', '{"delta":"lo"}']);
    parser.flush(); // the body ended without the last blank line
    expect(seen).toEqual(['{"delta":"Hel"}', '{"delta":"lo"}', '{"done":true}']);
  });

  it("joins multi-line data, ignores comments and other fields, and never emits an empty event", () => {
    const seen: string[] = [];
    const parser = createSseParser((data) => seen.push(data));
    parser.push(": keep-alive\n\nevent: message\nid: 7\ndata: one\ndata: two\n\n\n\nretry: 10\n\n");
    expect(seen).toEqual(["one\ntwo"]);
  });

  it("maps server events to port events and drops anything malformed", () => {
    expect(toPortEvent('{"delta":"Hi"}')).toEqual({ type: "delta", delta: "Hi" });
    expect(toPortEvent('{"delta":""}')).toBeNull();
    expect(toPortEvent('{"done":true,"text":"Hi there","provider":"template","latencyMs":12,"firstTokenMs":3}')).toEqual({
      type: "done", text: "Hi there", provider: "template", latencyMs: 12, firstTokenMs: 3,
    });
    expect(toPortEvent('{"done":true,"text":"Hi"}')).toEqual({ type: "done", text: "Hi", provider: "unknown", latencyMs: null, firstTokenMs: null });
    expect(toPortEvent('{"error":"stack trace with /Users/someone/path"}')).toEqual({ type: "error", error: "server error" });
    for (const junk of ["not json", "null", "42", '{"done":true}', '{"delta":5}', "[]"]) expect(toPortEvent(junk)).toBeNull();
  });
});

describe("text stream hub", () => {
  it("POSTs the sanitized request as a stream and relays deltas, then done, then disconnects", async () => {
    const { fetchMock, streams } = controllableServer();
    const port = fakePort();
    hub(fetchMock).onConnect(port);
    port.send({ type: "start", request: REQUEST });
    await flush();
    expect(streams[0]?.url).toBe("http://localhost:8788/v1/ghost-text");
    expect(streams[0]?.body).toEqual(REQUEST);
    const init = vi.mocked(fetchMock).mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json", Accept: "text/event-stream" });
    expect(init?.credentials).toBe("omit");

    streams[0]?.write(sse({ delta: "I want " }));
    streams[0]?.write(sse({ delta: "to build robots." }));
    await flush();
    expect(port.posted).toEqual([{ type: "delta", delta: "I want " }, { type: "delta", delta: "to build robots." }]);
    expect(port.disconnected).toBe(false);

    streams[0]?.write(sse({ done: true, text: "I want to build robots.", provider: "template", latencyMs: 9, firstTokenMs: 2 }));
    await flush();
    expect(port.posted.at(-1)).toEqual({ type: "done", text: "I want to build robots.", provider: "template", latencyMs: 9, firstTokenMs: 2 });
    expect(port.disconnected).toBe(true);
  });

  it("never lets email, phone, work authorization or unknown fields out, whatever the content script sent", async () => {
    const { fetchMock, streams } = controllableServer();
    const port = fakePort();
    hub(fetchMock).onConnect(port);
    port.send({
      type: "start",
      request: {
        ...REQUEST,
        facts: {
          fullName: "Alex Chen", email: "alex.chen.dev@example.com", phone: "+1 519 555 0142", workAuthorization: "yes",
          requiresSponsorship: "no", linkedin: "https://linkedin.com/in/alexchen-dev", location: "alex.chen.dev@example.com",
          website: "+1 (519) 555-0142",
        },
        pastAnswers: [
          { question: "Why us?", answer: "Reach me at alex.chen.dev@example.com" },
          { question: "What is your password?", answer: "hunter2 hunter2" },
          { question: "Tell us about a project", answer: "I built a robot arm.", origin: "https://secret.example", savedAt: "2026-01-01" },
        ],
        profile: { facts: { email: "alex.chen.dev@example.com" } },
        pageContext: { company: "Northwind", cookie: "session=abc" },
      },
    });
    await flush();
    const body = streams[0]?.body as Record<string, unknown>;
    expect(body.facts).toEqual({ fullName: "Alex Chen" });
    expect(body.pastAnswers).toEqual([{ question: "Tell us about a project", answer: "I built a robot arm." }]);
    expect(body.pageContext).toEqual({ company: "Northwind" });
    expect(Object.keys(body).sort()).toEqual(["facts", "fieldLabel", "fieldSignature", "pageContext", "pastAnswers"]);
    expect(JSON.stringify(body)).not.toMatch(/example\.com|555|hunter2|session=|secret\.example/);
  });

  it("refuses a sensitive or malformed request without calling the server", async () => {
    const { fetchMock } = controllableServer();
    for (const request of [{ ...REQUEST, fieldLabel: "Card number" }, { ...REQUEST, fieldLabel: "" }, null, "text"]) {
      const port = fakePort();
      hub(fetchMock).onConnect(port);
      port.send({ type: "start", request });
      await flush();
      expect(port.posted).toEqual([{ type: "error", error: "invalid request" }]);
      expect(port.disconnected).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sanitizeTextRequest({ ...REQUEST, maxChars: 5 })?.maxChars).toBeUndefined();
    expect(sanitizeTextRequest({ ...REQUEST, maxChars: 280.7 })?.maxChars).toBe(280);
  });

  it("serves only our own extension, only ghost:text ports, and only the first start message", async () => {
    const { fetchMock, streams } = controllableServer();
    const h = hub(fetchMock);
    const stranger = fakePort(1, { sender: { id: "someone-else", tab: { id: 1 } } });
    h.onConnect(stranger);
    stranger.send({ type: "start", request: REQUEST });
    const other = fakePort(1, { name: "devtools" });
    h.onConnect(other);
    other.send({ type: "start", request: REQUEST });
    await flush();
    expect(stranger.disconnected).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    const port = fakePort();
    h.onConnect(port);
    port.send({ type: "hello" });
    port.send({ type: "start", request: REQUEST });
    port.send({ type: "start", request: { ...REQUEST, fieldLabel: "Second question on the same port" } });
    await flush();
    expect(streams).toHaveLength(1);
  });

  it("aborts the fetch when the port disconnects (typing, Escape, navigation) and frees the slot", async () => {
    const { fetchMock, streams } = controllableServer();
    const h = hub(fetchMock);
    const port = fakePort(7);
    h.onConnect(port);
    port.send({ type: "start", request: REQUEST });
    await flush();
    streams[0]?.write(sse({ delta: "Half a " }));
    await flush();
    expect(h.active(7)).toBe(1);
    port.drop();
    await flush();
    expect(streams[0]?.signal.aborted).toBe(true);
    expect(h.active(7)).toBe(0);
  });

  it("runs at most three streams per tab: the fourth waits for a slot, other tabs are not held back", async () => {
    const { fetchMock, streams } = controllableServer();
    const h = hub(fetchMock);
    const ports = [1, 2, 3, 4].map(() => fakePort(1));
    for (const port of ports) {
      h.onConnect(port);
      port.send({ type: "start", request: REQUEST });
    }
    const elsewhere = fakePort(2);
    h.onConnect(elsewhere);
    elsewhere.send({ type: "start", request: REQUEST });
    await flush();
    expect(MAX_STREAMS_PER_TAB).toBe(3);
    expect(h.active(1)).toBe(3);
    expect(h.active(2)).toBe(1);
    expect(streams).toHaveLength(4); // three of tab 1, one of tab 2

    streams[0]?.write(sse({ done: true, text: "First draft.", provider: "template" }));
    await flush();
    expect(streams).toHaveLength(5); // the fourth inherited the slot
    expect(h.active(1)).toBe(3);
  });

  it("drops a queued stream whose port went away before its turn", async () => {
    const { fetchMock, streams } = controllableServer();
    const h = hub(fetchMock, 1);
    const [first, second] = [fakePort(1), fakePort(1)];
    for (const port of [first, second]) {
      h.onConnect(port);
      port.send({ type: "start", request: REQUEST });
    }
    await flush();
    second.drop();
    streams[0]?.write(sse({ done: true, text: "Done.", provider: "template" }));
    await flush();
    expect(streams).toHaveLength(1);
    expect(h.active(1)).toBe(0);
  });

  it("reports a short error code, never the failure text, when the server is down, answers badly or ends early", async () => {
    const down = fakePort();
    hub(vi.fn(async () => Promise.reject(new TypeError("fetch failed: http://localhost:8788 secret"))) as unknown as typeof fetch).onConnect(down);
    down.send({ type: "start", request: REQUEST });
    await flush();
    expect(down.posted).toEqual([{ type: "error", error: "server unreachable" }]);

    const bad = fakePort();
    hub(vi.fn(async () => new Response("nope", { status: 415 })) as unknown as typeof fetch).onConnect(bad);
    bad.send({ type: "start", request: REQUEST });
    await flush();
    expect(bad.posted).toEqual([{ type: "error", error: "server answered 415" }]);

    const { fetchMock, streams } = controllableServer();
    const early = fakePort();
    hub(fetchMock).onConnect(early);
    early.send({ type: "start", request: REQUEST });
    await flush();
    streams[0]?.write(sse({ delta: "Half" }));
    streams[0]?.close();
    await flush();
    expect(early.posted.at(-1)).toEqual({ type: "error", error: "stream ended early" });
    expect(early.disconnected).toBe(true);
  });
});
