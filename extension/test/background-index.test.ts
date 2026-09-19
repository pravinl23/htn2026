// The worker's message router: who may ask, and that server messages get an answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEY } from "../src/lib/storage";
import { createChromeStorageMock } from "./chrome-mock";

type Listener = (message: unknown, sender: { id?: string; origin?: string }, sendResponse: (reply: unknown) => void) => boolean;

const EXTENSION_ID = "ghostghostghostghostghostghostgh";

async function loadWorker(fetchMock: typeof fetch) {
  const storage = createChromeStorageMock();
  storage.store.set(SETTINGS_KEY, { serverUrl: "http://localhost:8788" });
  const event = () => ({ addListener: vi.fn() });
  const onMessage = event();
  const onConnect = event();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    ...storage.chrome,
    runtime: { id: EXTENSION_ID, onInstalled: event(), onStartup: event(), onMessage, onConnect },
    commands: { onCommand: event() },
    action: { onClicked: event(), setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined), setTitle: vi.fn(async () => undefined) },
  });
  vi.resetModules();
  await import("../src/background/index");
  return { listener: onMessage.addListener.mock.calls[0]?.[0] as Listener, onConnect };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background message router", () => {
  it("answers ghost:health from our own content script through the configured server", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, provider: "heuristic", calibrated: false, textProvider: "template" })));
    const { listener } = await loadWorker(fetchMock);
    const reply = await new Promise((resolve) => {
      expect(listener({ type: "ghost:health" }, { id: EXTENSION_ID }, resolve)).toBe(true);
    });
    expect(reply).toEqual({ ok: true, data: { provider: "heuristic", calibrated: false, textProvider: "template" } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8788/v1/health");
  });

  it("ignores every message from another extension or a web page", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { listener } = await loadWorker(fetchMock);
    const sendResponse = vi.fn();
    expect(listener({ type: "ghost:health" }, { id: "someone-else" }, sendResponse)).toBe(false);
    expect(listener({ type: "ghost:predict-form", request: {} }, {}, sendResponse)).toBe(false);
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("forwards redacted outcomes even though they intentionally carry no page origin", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ accepted: true, captured: false })));
    const { listener } = await loadWorker(fetchMock);
    const outcome = {
      schemaVersion: "ghost.agent-run.v1",
      runId: "44444444-4444-4444-8444-444444444444",
      state: "done",
      reason: "completed",
      duration: "under-250ms",
      steps: 0,
      decisions: [],
      actions: [],
    };
    const reply = await new Promise((resolve) => {
      expect(listener({ type: "ghost:agent-outcome", outcome }, { id: EXTENSION_ID }, resolve)).toBe(true);
    });
    expect(reply).toEqual({ ok: true, data: { accepted: true, captured: false } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8788/v1/agent/outcomes");
  });

  it("leaves unknown messages unanswered and registers exactly one port listener", async () => {
    const { listener, onConnect } = await loadWorker(vi.fn<typeof fetch>());
    expect(listener({ type: "ghost:toggle" }, { id: EXTENSION_ID }, vi.fn())).toBe(false);
    expect(onConnect.addListener).toHaveBeenCalledTimes(1);
  });
});
