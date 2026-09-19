/**
 * localStorage state shared by /mail, /mail/:id and /calendar. Pure functions over an injected storage so they
 * unit test without a DOM. Writes are announced with the same "ghostdemo:change" event the other demo pages use,
 * because the browser's own "storage" event only reaches OTHER tabs and iframes.
 */
import { isClock, isDayName, slotLabel, type PickedSlot } from "./calendar";
import { findMessage, messagePath } from "./mail";

export const MAIL_PREFIX = "ghostdemo.mail.";
export const MAIL_KEYS = {
  pickedSlot: "ghostdemo.mail.pickedSlot",
  sentReplies: "ghostdemo.mail.sentReplies",
  lastOpenedId: "ghostdemo.mail.lastOpenedId",
} as const;
export const CHANGE_EVENT = "ghostdemo:change";

export interface MailState {
  pickedSlot: PickedSlot | null;
  /** Message id -> the reply text that was "sent" (stored locally, never transmitted). */
  sentReplies: Record<string, string>;
  lastOpenedId: string | null;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

declare global {
  interface Window {
    /** Test hook: the mail/calendar demo state, refreshed on every change (this tab or another). */
    __mail?: MailState;
    /** Test hook: true once "Send reply" really ran for the open message. */
    __mailSent?: boolean;
  }
}

export function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
  };
}

let fallback: StorageLike | undefined;

/** The browser's localStorage, or a per-page memory store when it is blocked (sandboxed iframe, privacy mode). */
export function browserStorage(): StorageLike {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // fall through to memory
  }
  fallback ??= memoryStorage();
  return fallback;
}

function safeGet(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function parse(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Malformed or tampered values come back as null; the label is always rebuilt from day and times. */
export function parsePickedSlot(raw: string | null): PickedSlot | null {
  const value = parse(raw);
  if (!isRecord(value)) return null;
  const { day, start, end } = value;
  if (!isDayName(day) || !isClock(start) || !isClock(end) || start >= end) return null;
  return { day, start, end, label: slotLabel(day, start, end) };
}

export function parseSentReplies(raw: string | null): Record<string, string> {
  const value = parse(raw);
  if (!isRecord(value)) return {};
  const replies: Record<string, string> = {};
  for (const [id, text] of Object.entries(value)) {
    if (typeof text === "string") replies[id] = text;
  }
  return replies;
}

export function readMailState(storage: StorageLike = browserStorage()): MailState {
  const lastOpenedId = safeGet(storage, MAIL_KEYS.lastOpenedId);
  return {
    pickedSlot: parsePickedSlot(safeGet(storage, MAIL_KEYS.pickedSlot)),
    sentReplies: parseSentReplies(safeGet(storage, MAIL_KEYS.sentReplies)),
    lastOpenedId: lastOpenedId === null || lastOpenedId === "" ? null : lastOpenedId,
  };
}

/** Changes whenever any mail key changes, so a snapshot can be cached against it. */
export function rawFingerprint(storage: StorageLike = browserStorage()): string {
  return Object.values(MAIL_KEYS)
    .map((key) => safeGet(storage, key) ?? "")
    .join("\n");
}

function announce(key: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<{ key: string | null }>(CHANGE_EVENT, { detail: { key } }));
}

function write(storage: StorageLike, key: string, value: string | null, quiet = false): boolean {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    return false; // quota or blocked storage: the page keeps working from what it already rendered
  }
  if (!quiet) announce(key);
  return true;
}

export function savePickedSlot(slot: PickedSlot | null, storage: StorageLike = browserStorage()): boolean {
  return write(storage, MAIL_KEYS.pickedSlot, slot === null ? null : JSON.stringify(slot));
}

export function saveSentReply(id: string, text: string, storage: StorageLike = browserStorage()): boolean {
  const replies = { ...parseSentReplies(safeGet(storage, MAIL_KEYS.sentReplies)), [id]: text };
  return write(storage, MAIL_KEYS.sentReplies, JSON.stringify(replies));
}

export function saveLastOpenedId(id: string, storage: StorageLike = browserStorage()): boolean {
  if (safeGet(storage, MAIL_KEYS.lastOpenedId) === id) return true;
  return write(storage, MAIL_KEYS.lastOpenedId, id);
}

/** `quiet` skips the same-document announcement (other tabs still hear the browser's "storage" event). */
export function clearMailState(storage: StorageLike = browserStorage(), quiet = false): void {
  for (const key of Object.values(MAIL_KEYS)) write(storage, key, null, quiet);
}

/** True for "?reset=1" (also "?reset=true" or a bare "?reset"). */
export function wantsReset(search: string): boolean {
  const value = new URLSearchParams(search).get("reset");
  return value !== null && value !== "0" && value !== "false";
}

/**
 * Clears the mail keys when the URL asks for it. Returns whether it did. Runs while the page first renders,
 * before anything in this document has subscribed, so it stays quiet: no events fire during a React render.
 */
export function resetIfRequested(search: string, storage: StorageLike = browserStorage()): boolean {
  if (!wantsReset(search)) return false;
  clearMailState(storage, true);
  return true;
}

/** Where the calendar's "Back to mail" link goes: the message the user came from, else the inbox. */
export function backToMailPath(lastOpenedId: string | null): string {
  const message = findMessage(lastOpenedId ?? undefined);
  return message ? messagePath(message.id) : "/mail";
}

/** "Picked time: Thursday 2:30 PM to 3:00 PM" */
export function pickedSlotText(slot: PickedSlot): string {
  return `Picked time: ${slot.label}`;
}
