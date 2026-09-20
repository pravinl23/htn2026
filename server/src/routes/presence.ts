import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerConfig } from "../config";
import { isRecord } from "../providers/errors";
import { BadRequest, readJsonBody } from "../providers/validation";

/** A heartbeat is three short strings. Anything bigger is not a heartbeat. */
export const PRESENCE_LIMITS = { bodyBytes: 2_000, browserChars: 32, versionChars: 32, clients: 32 } as const;
/** Heartbeats arrive every 30 s. Shabang Desktop calls one fresh for 90 s; the server forgets it after 5 minutes. */
export const PRESENCE_TTL_MS = 5 * 60_000;

export type PresenceClient = "extension" | "desktop";
const CLIENTS: ReadonlySet<string> = new Set<PresenceClient>(["extension", "desktop"]);
// Names are echoed to other clients and shown in the Desktop menu, so they are a closed alphabet, not free text.
const BROWSER = /^[a-z0-9][a-z0-9 ._-]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;

export interface Heartbeat {
  client: PresenceClient;
  browser?: string;
  version?: string;
}

export interface PresenceEntry {
  client: PresenceClient;
  browser: string | null;
  version: string | null;
  lastSeenMs: number;
  ageMs: number;
}

function optionalName(value: unknown, path: string, max: number, pattern: RegExp, lower: boolean): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadRequest(`${path} must be a string`);
  const name = lower ? value.trim().toLowerCase() : value.trim();
  if (name === "" || name.length > max) throw new BadRequest(`${path} must be 1 to ${max} characters`);
  if (!pattern.test(name)) throw new BadRequest(`${path} has characters that are not allowed`);
  return name;
}

/** Messages name the path only, never the value. */
export function parseHeartbeat(body: unknown): Heartbeat {
  if (!isRecord(body)) throw new BadRequest("body must be an object");
  if (typeof body.client !== "string" || !CLIENTS.has(body.client)) throw new BadRequest('client must be "extension" or "desktop"');
  const browser = optionalName(body.browser, "browser", PRESENCE_LIMITS.browserChars, BROWSER, true);
  const version = optionalName(body.version, "version", PRESENCE_LIMITS.versionChars, VERSION, false);
  return { client: body.client as PresenceClient, ...(browser ? { browser } : {}), ...(version ? { version } : {}) };
}

/** Who is alive right now: one entry per (client, browser), newest heartbeat wins. In memory only. */
export class PresenceRegistry {
  private readonly seen = new Map<string, { beat: Heartbeat; lastSeenMs: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  beat(beat: Heartbeat): void {
    const key = `${beat.client}:${beat.browser ?? ""}`;
    this.seen.delete(key); // re-insert so the map stays ordered oldest to newest
    this.seen.set(key, { beat, lastSeenMs: this.now() });
    this.prune();
  }

  list(): PresenceEntry[] {
    this.prune();
    const now = this.now();
    return [...this.seen.values()]
      .map(({ beat, lastSeenMs }) => ({ client: beat.client, browser: beat.browser ?? null, version: beat.version ?? null, lastSeenMs, ageMs: Math.max(0, now - lastSeenMs) }))
      .reverse();
  }

  private prune(): void {
    const cutoff = this.now() - PRESENCE_TTL_MS;
    for (const [key, entry] of this.seen) if (entry.lastSeenMs < cutoff) this.seen.delete(key);
    // Made-up browser names cannot grow the map: the oldest entry goes first.
    while (this.seen.size > PRESENCE_LIMITS.clients) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}

export interface PresenceDeps {
  registry?: PresenceRegistry;
}

function badRequest(c: Context, err: unknown): Response {
  if (err instanceof BadRequest) return c.json({ error: err.message }, err.status);
  throw err;
}

/** Coexistence: Shabang Desktop stays out of a browser whose extension sent a heartbeat lately (docs/desktop.md). */
export function registerPresenceRoutes(app: Hono, _config: ServerConfig, deps: PresenceDeps = {}): void {
  const registry = deps.registry ?? new PresenceRegistry();

  app.get("/v1/presence", (c) => c.json({ clients: registry.list() }));

  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);
  app.post("/v1/presence", bodyLimit({ maxSize: PRESENCE_LIMITS.bodyBytes, onError: tooLarge }), async (c) => {
    try {
      registry.beat(parseHeartbeat(await readJsonBody(c.req, PRESENCE_LIMITS.bodyBytes)));
      return c.json({ ok: true });
    } catch (err) {
      return badRequest(c, err);
    }
  });
}
