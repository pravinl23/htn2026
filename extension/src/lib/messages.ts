/**
 * Runtime messages between the content script and the background worker. `target` is a one-shot token
 * the content script stamps on the element (`data-ghost-target`) for the length of the request: real
 * input lands on whatever is focused or under the point when it finally runs, so the worker checks
 * that this is still the element Ghost validated.
 */
export type GhostMessage =
  | { type: "ghost:toggle" }
  | { type: "ghost:debugger-fill"; value: string; target: string }
  | { type: "ghost:debugger-click"; x: number; y: number; target: string };

export const TARGET_ATTR = "data-ghost-target";
export const TARGET_TOKEN = /^[A-Za-z0-9-]{8,64}$/;

/** Reply the background worker sends for the two debugger messages. */
export interface DebuggerReply {
  ok: boolean;
  error?: string;
}

const TYPES: ReadonlySet<string> = new Set(["ghost:toggle", "ghost:debugger-fill", "ghost:debugger-click"]);

export function isGhostMessage(msg: unknown): msg is GhostMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const type = (msg as { type?: unknown }).type;
  return typeof type === "string" && TYPES.has(type);
}
