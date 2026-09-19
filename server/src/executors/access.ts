import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

/**
 * The loop execution routes send mail, write sheets and open billed cloud browsers from the user's own accounts, so the
 * access rules of the prediction routes (any extension, any http://localhost page) are not enough here:
 * - a web page never reaches them, not even one on localhost;
 * - with GHOST_EXTENSION_ID set, only that extension's origin does;
 * - a caller without an Origin (the desktop daemon, a script) proves itself with X-Ghost-Token = GHOST_EXECUTE_TOKEN.
 * A caller that proved neither is "untrusted": it may only use the simulated executors, which touch nothing.
 */
export const TOKEN_HEADER = "x-ghost-token";
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-z]+)$/;

export interface AccessConfig {
  /** GHOST_EXTENSION_ID: the id Chrome shows for the Ghost extension on chrome://extensions. */
  extensionId?: string;
  /** GHOST_EXECUTE_TOKEN: a per-install secret shared with the desktop daemon / extension options. */
  executeToken?: string;
}

export type Caller = { trusted: boolean };

function sameSecret(a: string, b: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Who is calling, or why the request is refused. */
export function classifyCaller(access: AccessConfig, origin: string | undefined, token: string | undefined): Caller | { refuse: 401 | 403; error: string } {
  let pinnedOrigin = false;
  if (origin !== undefined) {
    const id = EXTENSION_ORIGIN.exec(origin)?.[1];
    if (id === undefined) return { refuse: 403, error: "loop execution is only available to the Ghost extension, not to web pages" };
    if (access.extensionId && id !== access.extensionId) return { refuse: 403, error: "this extension is not the pinned Ghost extension (GHOST_EXTENSION_ID)" };
    pinnedOrigin = Boolean(access.extensionId);
  }
  if (token !== undefined && !(access.executeToken && sameSecret(token, access.executeToken))) return { refuse: 401, error: "X-Ghost-Token is not valid" };
  return { trusted: pinnedOrigin || (token !== undefined && Boolean(access.executeToken)) };
}

/** The caller, or the refusal to send back. Called first thing by every loop execution route. */
export function admit(c: Context, access: AccessConfig): Caller | Response {
  const verdict = classifyCaller(access, c.req.header("origin"), c.req.header(TOKEN_HEADER));
  return "refuse" in verdict ? c.json({ error: verdict.error }, verdict.refuse) : verdict;
}

export const UNTRUSTED_REAL_RUN =
  "Real batches need a pinned caller: set GHOST_EXTENSION_ID to the Ghost extension's id (chrome://extensions), or GHOST_EXECUTE_TOKEN and send it as X-Ghost-Token.";
