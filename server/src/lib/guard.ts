import type { MiddlewareHandler } from "hono";

export const ALLOWED_ORIGIN = /^(chrome-extension:\/\/[a-z]+|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

function withoutPort(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, "");
}

function isJson(contentType: string | undefined): boolean {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * CORS only hides responses; it never stops a request. This does:
 * - a foreign Origin is refused outright (cross-site pages, including "null" origins);
 * - the Host must be this machine, so a DNS-rebinding page cannot become same-origin;
 * - POST bodies must be application/json, which forces a preflight that the CORS policy then denies.
 */
export function localOnly(bindHost?: string): MiddlewareHandler {
  const hosts = new Set(LOOPBACK_HOSTS);
  if (bindHost && !WILDCARD_HOSTS.has(bindHost)) hosts.add(withoutPort(bindHost));
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !ALLOWED_ORIGIN.test(origin)) return c.json({ error: "origin not allowed" }, 403);
    const named = [c.req.header("host"), new URL(c.req.url).host].filter((h): h is string => Boolean(h));
    if (!named.every((h) => hosts.has(withoutPort(h)))) return c.json({ error: "host not allowed" }, 403);
    if (c.req.method === "POST" && !isJson(c.req.header("content-type"))) return c.json({ error: "Content-Type must be application/json" }, 415);
    return next();
  };
}
