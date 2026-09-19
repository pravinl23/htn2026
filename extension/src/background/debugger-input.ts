import { SENSITIVE_TEXT_SOURCE } from "@ghost/shared";
import { TARGET_ATTR, TARGET_TOKEN } from "../lib/messages";
import type { DebuggerReply, GhostMessage } from "../lib/messages";

export type DebuggerMessage = Extract<GhostMessage, { type: "ghost:debugger-fill" | "ghost:debugger-click" }>;

const PROTOCOL_VERSION = "1.3";

// Real input lands on whatever is focused, or under the point, when it finally runs: after a message
// hop, a worker wake-up and an attach that can reflow the page (the debugging infobar). So each guard
// re-proves, inside the page and right before the input, that the target is still the element the
// content script validated (its one-shot token) and re-applies rule 3 with the shared patterns.
const SENSITIVE_CHECK = `
  const sensitive = (el) => {
    const attr = (name) => (el.getAttribute(name) || "");
    const type = attr("type").toLowerCase();
    const ac = attr("autocomplete").toLowerCase();
    if (type === "password" || /(^|\\s)(cc-|current-password|new-password|one-time-code)/.test(ac)) return true;
    if (el.closest("[data-ghost-sensitive],[data-sensitive]")) return true;
    const labels = Array.from(el.labels || []).map((label) => label.textContent || "");
    const text = [attr("name"), el.id, attr("placeholder"), attr("aria-label"), attr("title"), ...labels].join(" ")
      .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\\b(\\w)\\./g, "$1");
    return new RegExp(${JSON.stringify(SENSITIVE_TEXT_SOURCE)}, "i").test(text);
  };`;

/** Evaluates to "" when typing may go ahead, otherwise to the reason it may not. */
function fillGuard(token: string): string {
  return `(() => {${SENSITIVE_CHECK}
    const el = document.activeElement;
    if (!el || el.getAttribute(${JSON.stringify(TARGET_ATTR)}) !== ${JSON.stringify(token)}) return "focus moved away from the field";
    if (!/^(INPUT|TEXTAREA)$/.test(el.tagName)) return "focused element is not a text field";
    return sensitive(el) ? "focused field is sensitive" : "";
  })()`;
}

/** Evaluates to the point to click (recomputed after the attach reflow), otherwise to the reason not to. */
function clickGuard(token: string): string {
  return `(() => {${SENSITIVE_CHECK}
    const el = document.querySelector(${JSON.stringify(`[${TARGET_ATTR}="${token}"]`)});
    if (!el) return "target is gone";
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (el.tagName !== "INPUT" || (type !== "checkbox" && type !== "radio")) return "target is not a checkbox or radio";
    if (sensitive(el)) return "target is sensitive";
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (r.width === 0 || r.height === 0 || document.elementFromPoint(x, y) !== el) return "something else is at the click point";
    return { x, y };
  })()`;
}

const queues = new Map<number, Promise<unknown>>();

/** chrome.debugger allows one attach per tab, so requests for the same tab run one after another. */
function enqueue<T>(tabId: number, job: () => Promise<T>): Promise<T> {
  const previous = queues.get(tabId) ?? Promise.resolve();
  const next = previous.then(job, job);
  const settled = next.catch(() => undefined);
  queues.set(tabId, settled);
  void settled.then(() => {
    if (queues.get(tabId) === settled) queues.delete(tabId);
  });
  return next;
}

/** A worker torn down mid-job leaves its session attached; detaching our own stale session once recovers the tab. */
async function attach(target: chrome.debugger.Debuggee): Promise<void> {
  try {
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
  } catch (err) {
    if (!/already attached/i.test(errorText(err))) throw err;
    await chrome.debugger.detach(target).catch(() => undefined);
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
  }
}

async function withDebugger<T>(tabId: number, run: (target: chrome.debugger.Debuggee) => Promise<T>): Promise<T> {
  const target: chrome.debugger.Debuggee = { tabId };
  await attach(target);
  try {
    return await run(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => undefined);
  }
}

async function evaluate(target: chrome.debugger.Debuggee, expression: string): Promise<unknown> {
  const reply = (await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression, returnByValue: true })) as
    | { result?: { value?: unknown } }
    | undefined;
  return reply?.result?.value;
}

export function debuggerFill(tabId: number, value: string, token: string): Promise<void> {
  return enqueue(tabId, () =>
    withDebugger(tabId, async (target) => {
      const refusal = await evaluate(target, fillGuard(token));
      if (refusal !== "") throw new Error(`refused: ${typeof refusal === "string" ? refusal : "could not check the focused field"}`);
      await chrome.debugger.sendCommand(target, "Input.insertText", { text: value });
    }),
  );
}

interface Point {
  x: number;
  y: number;
}

async function clickPoint(target: chrome.debugger.Debuggee, token: string): Promise<Point> {
  const found = await evaluate(target, clickGuard(token));
  const point = found as Partial<Point> | null;
  if (typeof found !== "object" || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`refused: ${typeof found === "string" ? found : "could not find the click target"}`);
  }
  return { x: point.x as number, y: point.y as number };
}

export function debuggerClick(tabId: number, token: string): Promise<void> {
  return enqueue(tabId, () =>
    withDebugger(tabId, async (target) => {
      const first = await clickPoint(target, token);
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", ...first });
      // The page may still be settling from the attach (infobar reflow): press only where the target still is.
      const { x, y } = await clickPoint(target, token);
      if (Math.abs(x - first.x) > 1 || Math.abs(y - first.y) > 1) throw new Error("refused: the page moved under the click point");
      const press = { x, y, button: "left", clickCount: 1 };
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...press });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...press });
    }),
  );
}

export function isDebuggerMessage(message: unknown): message is DebuggerMessage {
  if (typeof message !== "object" || message === null) return false;
  const m = message as Record<string, unknown>;
  if (typeof m.target !== "string" || !TARGET_TOKEN.test(m.target)) return false;
  if (m.type === "ghost:debugger-fill") return typeof m.value === "string";
  if (m.type === "ghost:debugger-click") return Number.isFinite(m.x) && Number.isFinite(m.y);
  return false;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleDebuggerMessage(message: DebuggerMessage, tabId: number | undefined): Promise<DebuggerReply> {
  if (tabId === undefined) return { ok: false, error: "no sender tab" };
  try {
    if (message.type === "ghost:debugger-fill") await debuggerFill(tabId, message.value, message.target);
    else await debuggerClick(tabId, message.target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}
