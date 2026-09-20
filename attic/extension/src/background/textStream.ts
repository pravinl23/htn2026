// Relays one streamed draft per `ghost:text` port: POST /v1/ghost-text, parse the SSE body, post deltas
// to the tab. The open port keeps the MV3 worker alive; a disconnect (typing, Escape, navigation) aborts.
import { TEXT_PORT, isTextPortStart, sanitizeTextRequest } from "../lib/messages";
import type { GhostTextRequest, TextPortEvent } from "../lib/messages";
import { openGhostText, serverBaseUrl } from "./serverClient";
import type { FetchLike } from "./serverClient";

export const MAX_STREAMS_PER_TAB = 3;
const STREAM_TIMEOUT_MS = 30_000;

export interface SseParser {
  push(chunk: string): void;
  /** End of body: a last event without its blank line still counts. */
  flush(): void;
}

/** Incremental SSE reader: events end at a blank line, `data:` lines of one event are joined with "\n". */
export function createSseParser(onData: (data: string) => void): SseParser {
  let buffer = "";
  let data: string[] = [];
  const endEvent = (): void => {
    if (data.length > 0) onData(data.join("\n"));
    data = [];
  };
  const readLine = (line: string): void => {
    if (line === "") endEvent();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  };
  return {
    push(chunk) {
      const lines = (buffer + chunk).split(/\r\n|\n|\r/);
      buffer = lines.pop() ?? "";
      lines.forEach(readLine);
    },
    flush() {
      if (buffer) readLine(buffer);
      buffer = "";
      endEvent();
    },
  };
}

/** Maps one server event to what the content script gets. Unknown or malformed events are dropped. */
export function toPortEvent(data: string): TextPortEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.delta === "string") return p.delta === "" ? null : { type: "delta", delta: p.delta };
  if (p.done === true && typeof p.text === "string") {
    return { type: "done", text: p.text, provider: typeof p.provider === "string" ? p.provider : "unknown", latencyMs: ms(p.latencyMs), firstTokenMs: ms(p.firstTokenMs) };
  }
  return typeof p.error === "string" ? { type: "error", error: "server error" } : null;
}

function ms(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The slice of chrome.runtime.Port this module needs; tests pass a fake. */
export interface TextPort {
  name: string;
  sender?: { id?: string; tab?: { id?: number } };
  postMessage(message: TextPortEvent): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface TextStreamDeps {
  extensionId: string;
  fetch?: FetchLike;
  getServerUrl?: () => Promise<string | null>;
  maxPerTab?: number;
}

export interface TextStreamHub {
  onConnect(port: TextPort): void;
  active(tabId: number): number;
}

export function createTextStreamHub(deps: TextStreamDeps): TextStreamHub {
  const slots = new SlotsPerTab(deps.maxPerTab ?? MAX_STREAMS_PER_TAB);
  const getServerUrl = deps.getServerUrl ?? serverBaseUrl;

  const onConnect = (port: TextPort): void => {
    if (port.name !== TEXT_PORT) return;
    // Only our own content scripts and pages: another extension (or a page through externally_connectable) gets nothing.
    if (port.sender?.id !== deps.extensionId) return port.disconnect();
    const tabId = port.sender.tab?.id ?? -1;
    const abort = new AbortController();
    let started = false;
    port.onDisconnect.addListener(() => abort.abort());
    port.onMessage.addListener((message) => {
      if (started || !isTextPortStart(message)) return;
      started = true;
      const request = sanitizeTextRequest(message.request);
      if (!request) return finish(port, { type: "error", error: "invalid request" });
      void slots.run(tabId, abort.signal, () => relay(port, request, abort, { getServerUrl, fetch: deps.fetch }));
    });
  };
  return { onConnect, active: (tabId) => slots.active(tabId) };
}

interface RelayDeps {
  getServerUrl(): Promise<string | null>;
  fetch?: FetchLike;
}

async function relay(port: TextPort, request: GhostTextRequest, abort: AbortController, deps: RelayDeps): Promise<void> {
  const timer = setTimeout(() => abort.abort(), STREAM_TIMEOUT_MS);
  try {
    finish(port, await stream(port, request, abort.signal, deps));
  } catch {
    // Never echo the failure text: it can carry the URL or body. The content script only needs "no draft".
    finish(port, { type: "error", error: abort.signal.aborted ? "aborted" : "server unreachable" });
  } finally {
    clearTimeout(timer);
  }
}

/** Posts deltas as they arrive and returns the terminal event. */
async function stream(port: TextPort, request: GhostTextRequest, signal: AbortSignal, deps: RelayDeps): Promise<TextPortEvent> {
  const base = await deps.getServerUrl();
  if (!base) return { type: "error", error: "server URL is not valid" };
  const response = await openGhostText(base, request, signal, deps.fetch);
  if (!response.ok || !response.body) return { type: "error", error: `server answered ${response.status}` };
  const seen: { terminal: TextPortEvent | null } = { terminal: null };
  const parser = createSseParser((data) => {
    const event = seen.terminal ? null : toPortEvent(data);
    if (event?.type === "delta") post(port, event);
    else if (event) seen.terminal = event;
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    parser.push(done ? decoder.decode() : decoder.decode(value, { stream: true }));
    if (done || seen.terminal) break;
  }
  parser.flush();
  void reader.cancel().catch(() => undefined);
  return seen.terminal ?? { type: "error", error: "stream ended early" };
}

function post(port: TextPort, event: TextPortEvent): void {
  try {
    port.postMessage(event);
  } catch {
    // the tab went away between two chunks; onDisconnect aborts the stream
  }
}

function finish(port: TextPort, event: TextPortEvent): void {
  post(port, event);
  try {
    port.disconnect();
  } catch {
    // already gone
  }
}

/** At most `limit` jobs per tab at once; the rest wait their turn and leave the queue when their port goes away. */
class SlotsPerTab {
  private readonly running = new Map<number, number>();
  private readonly waiting = new Map<number, Array<(granted: boolean) => void>>();

  constructor(private readonly limit: number) {}

  active(tabId: number): number {
    return this.running.get(tabId) ?? 0;
  }

  async run(tabId: number, signal: AbortSignal, job: () => Promise<void>): Promise<void> {
    const granted = this.active(tabId) < this.limit ? this.take(tabId) : await this.wait(tabId, signal);
    if (!granted) return;
    try {
      if (!signal.aborted) await job();
    } finally {
      this.release(tabId);
    }
  }

  private take(tabId: number): boolean {
    this.running.set(tabId, this.active(tabId) + 1);
    return true;
  }

  private wait(tabId: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const queue = this.waiting.get(tabId) ?? [];
      this.waiting.set(tabId, queue);
      queue.push(resolve);
      signal.addEventListener("abort", () => {
        const at = queue.indexOf(resolve);
        if (at >= 0) queue.splice(at, 1);
        resolve(false); // a no-op when the slot was already handed over; run() then releases it unused
      }, { once: true });
    });
  }

  /** A waiting job inherits the slot directly, so a newcomer can never slip in between and make it four. */
  private release(tabId: number): void {
    const next = this.waiting.get(tabId)?.shift();
    if (this.waiting.get(tabId)?.length === 0) this.waiting.delete(tabId);
    if (next) return next(true);
    const left = this.active(tabId) - 1;
    if (left > 0) this.running.set(tabId, left);
    else this.running.delete(tabId);
  }
}
