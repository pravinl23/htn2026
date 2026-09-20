import type { Ghost } from "@ghost/shared";
import { TARGET_ATTR } from "../lib/messages";
import type { DebuggerReply, GhostMessage } from "../lib/messages";
import { isElementLocked, isElementSensitive } from "./capture";
import { markSynthetic } from "./trace";

export interface ExecResult {
  ok: boolean;
  method: "native" | "click" | "debugger" | "none";
  reason?: string;
}

type ValueElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type TextElement = HTMLInputElement | HTMLTextAreaElement;

const NOT_TEXT_TYPES = new Set(["file", "hidden", "checkbox", "radio", "submit", "button", "reset", "image", "range", "color"]);
const SETTLE_TIMEOUT_MS = 48;

const refuse = (reason: string): ExecResult => ({ ok: false, method: "none", reason });

/** Performs one ghost. Locked and sensitive targets are refused here even if a caller slips. */
export async function executeGhost(ghost: Ghost, el: HTMLElement): Promise<ExecResult> {
  if (ghost.locked) return refuse("locked");
  if (!el.isConnected) return refuse("detached");
  if (isElementSensitive(el)) return refuse("sensitive");
  switch (ghost.action) {
    case "click":
      return clickElement(el);
    case "check":
      return isCheckable(el) ? setChecked(el, el, ghost.value !== "false") : refuse("unsupported");
    case "fill":
    case "select":
      return writeValue(ghost, el);
  }
}

/**
 * React and similar frameworks shadow `value` on the instance to track it, so a plain assignment
 * makes them swallow the following input event. The prototype setter goes around that.
 */
export function setNativeValue(el: ValueElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(valuePrototype(el), "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function valuePrototype(el: ValueElement): object {
  const view = el.ownerDocument.defaultView ?? globalThis;
  if (el.tagName === "TEXTAREA") return view.HTMLTextAreaElement.prototype;
  if (el.tagName === "SELECT") return view.HTMLSelectElement.prototype;
  return view.HTMLInputElement.prototype;
}

function writeValue(ghost: Ghost, el: HTMLElement): Promise<ExecResult> | ExecResult {
  const value = ghost.value ?? "";
  if (isInput(el) && el.type === "radio") return chooseRadio(el, ghost);
  if (el.tagName === "SELECT") return chooseOption(el as HTMLSelectElement, ghost);
  if (isTextElement(el)) return fillText(el, value);
  return refuse("unsupported");
}

async function fillText(el: TextElement, value: string): Promise<ExecResult> {
  if (el.disabled || el.readOnly) return refuse("not-editable");
  return whileWriting([el], async () => {
    focus(el);
    writeAndNotify(el, value);
    await settle(el);
    if (holds(el, value)) return { ok: true, method: "native" };
    return debuggerFill(el, value);
  });
}

async function debuggerFill(el: TextElement, value: string): Promise<ExecResult> {
  const send = runtimeSender();
  if (!send) return refuse("verify-failed");
  focus(el);
  selectContents(el);
  const reply = await withTargetToken(el, (target) => send({ type: "ghost:debugger-fill", value, target }));
  await settle(el);
  if (reply.ok && holds(el, value)) return { ok: true, method: "debugger" };
  return { ok: false, method: "debugger", reason: reply.error ?? "verify-failed" };
}

async function chooseOption(select: HTMLSelectElement, ghost: Ghost): Promise<ExecResult> {
  if (select.disabled) return refuse("not-editable");
  const option = findOption(select, ghost);
  if (!option) return refuse("option-missing");
  return whileWriting([select], async () => {
    focus(select);
    writeAndNotify(select, option.value);
    await settle(select);
    return select.value === option.value ? { ok: true, method: "native" } : refuse("verify-failed");
  });
}

function findOption(select: HTMLSelectElement, ghost: Ghost): HTMLOptionElement | null {
  const options = Array.from(select.options).filter((o) => !o.disabled);
  const byValue = options.find((o) => o.value === ghost.value);
  return byValue ?? options.find((o) => labelMatches(o.label || o.text, ghost)) ?? null;
}

async function chooseRadio(first: HTMLInputElement, ghost: Ghost): Promise<ExecResult> {
  const group = radioGroup(first);
  const target =
    group.find((r) => r.value === ghost.value) ?? group.find((r) => labelMatches(r.labels?.[0]?.textContent ?? "", ghost));
  if (!target) return refuse("option-missing");
  if (isElementSensitive(target)) return refuse("sensitive");
  return setChecked(first, target, true);
}

/** Radios sharing a name inside the same form (or the same root when there is no form). */
export function radioGroup(radio: HTMLInputElement): HTMLInputElement[] {
  if (!radio.name) return [radio];
  const scope = (radio.form ?? radio.getRootNode()) as ParentNode;
  const radios = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  return radios.filter((r) => r.name === radio.name && r.form === radio.form);
}

/** `owner` is the element the controller knows the ghost by (first radio of a group). */
async function setChecked(owner: HTMLElement, target: HTMLInputElement, desired: boolean): Promise<ExecResult> {
  if (target.disabled) return refuse("not-editable");
  if (target.checked === desired) return { ok: true, method: "none" };
  if (target.type === "radio" && !desired) return refuse("unsupported");
  return whileWriting([owner, target], async () => {
    focus(target);
    target.click();
    await settle(target);
    if (target.checked === desired) return { ok: true, method: "click" };
    return debuggerClick(target, desired);
  });
}

async function debuggerClick(target: HTMLInputElement, desired: boolean): Promise<ExecResult> {
  const send = runtimeSender();
  const point = send ? safeClickPoint(target) : null;
  if (!send || !point) return refuse("verify-failed");
  const reply = await withTargetToken(target, (token) => send({ type: "ghost:debugger-click", x: point.x, y: point.y, target: token }));
  await settle(target);
  if (reply.ok && target.checked === desired) return { ok: true, method: "debugger" };
  return { ok: false, method: "debugger", reason: reply.error ?? "verify-failed" };
}

/**
 * A real mouse click lands on whatever is at the coordinates, so only hand out a point when we
 * are the top frame (viewport coordinates match) and the target itself is what sits there.
 */
function safeClickPoint(target: HTMLElement): { x: number; y: number } | null {
  const doc = target.ownerDocument;
  const view = doc.defaultView;
  if (!view || !isTopFrame(view)) return null;
  target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const rect = target.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = doc.elementFromPoint?.(x, y) ?? null;
  return hit === target ? { x, y } : null;
}

function isTopFrame(view: Window): boolean {
  try {
    return view.top === view;
  } catch {
    return false;
  }
}

function clickElement(el: HTMLElement): ExecResult {
  // The ghost said unlocked, but the DOM is the source of truth right before an activation.
  if (isElementLocked(el)) return refuse("locked");
  if ((el as HTMLButtonElement).disabled) return refuse("not-editable");
  markSynthetic(); // the trace records this click (and the navigation it causes) as Ghost's own, not the user's
  el.click();
  return { ok: true, method: "click" };
}

function writeAndNotify(el: ValueElement, value: string): void {
  try {
    setNativeValue(el, value);
  } catch {
    return; // some input types reject programmatic values; verification reports the failure
  }
  el.dispatchEvent(inputEvent(el, value));
  el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function inputEvent(el: Element, value: string): Event {
  const init = { bubbles: true, composed: true };
  const view = el.ownerDocument.defaultView;
  if (typeof view?.InputEvent !== "function") return new Event("input", init);
  return new view.InputEvent("input", { ...init, inputType: "insertReplacementText", data: value });
}

/** Flags the elements so the controller can tell our events (even trusted debugger ones) from typing. */
async function whileWriting<T>(els: HTMLElement[], work: () => Promise<T>): Promise<T> {
  for (const el of els) el.dataset.ghostWriting = "1";
  try {
    return await work();
  } finally {
    for (const el of els) delete el.dataset.ghostWriting;
  }
}

/** Lets the background worker prove that what is focused (or under the point) is still this element. */
async function withTargetToken<T>(el: HTMLElement, work: (token: string) => Promise<T>): Promise<T> {
  const token = globalThis.crypto?.randomUUID?.() ?? `t-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  el.setAttribute(TARGET_ATTR, token);
  try {
    return await work(token);
  } finally {
    el.removeAttribute(TARGET_ATTR);
  }
}

/** Waits for framework re-renders (microtasks, then a frame); the timer covers hidden tabs and jsdom. */
function settle(el: Element): Promise<void> {
  const view = el.ownerDocument.defaultView;
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
    if (typeof view?.requestAnimationFrame !== "function") return;
    view.requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function runtimeSender(): ((msg: GhostMessage) => Promise<DebuggerReply>) | null {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") return null;
  return async (msg) => {
    try {
      const reply = (await chrome.runtime.sendMessage(msg)) as DebuggerReply | undefined;
      return reply ?? { ok: false, error: "no-reply" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * Pages reformat what they are given: phone masks, trimming, upper-cased postal codes, dropped country
 * codes. The write held when the field shows our value as the page chose to spell it. Empty, reverted
 * or unrelated content did not hold.
 */
function holds(el: TextElement, value: string): boolean {
  const actual = comparable(el.value);
  const wanted = comparable(value);
  if (wanted === "") return el.value === value; // nothing but punctuation: only the exact text counts
  if (actual === wanted) return true;
  if (actual === "" || actual.length * 2 < wanted.length) return false;
  return actual.includes(wanted) || wanted.includes(actual);
}

function comparable(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function labelMatches(label: string, ghost: Ghost): boolean {
  const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();
  const text = norm(label);
  return text !== "" && (text === norm(ghost.value) || text === norm(ghost.displayText));
}

function focus(el: HTMLElement): void {
  try {
    el.focus({ preventScroll: true });
  } catch {
    // focus is cosmetic here; the write still happens
  }
}

function selectContents(el: TextElement): void {
  try {
    el.select();
  } catch {
    // not selectable: insertText then appends, and verification catches a wrong result
  }
}

function isInput(el: Element): el is HTMLInputElement {
  return el.tagName === "INPUT";
}

function isCheckable(el: Element): el is HTMLInputElement {
  return isInput(el) && (el.type === "checkbox" || el.type === "radio");
}

function isTextElement(el: Element): el is TextElement {
  if (el.tagName === "TEXTAREA") return true;
  return isInput(el) && !NOT_TEXT_TYPES.has(el.type);
}
