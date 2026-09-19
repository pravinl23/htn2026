const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const API_VERSION = /^v\d{1,2}$/i;
const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i;

export const ID_SEGMENT = ":id";

export interface NormalizedUrl {
  origin: string;
  pathname: string;
  pathPattern: string;
  /** origin + pathname, no query string, no fragment, no credentials */
  url: string;
}

/** The hex digits of a percent escape (%20, %C3%A9) are not part of an id. A malformed escape stays as written. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment.replace(/%[0-9a-f]{2}/gi, "");
  }
}

/** True for path segments that identify one record: numbers, uuids, hashes, ids containing digits (INV-1042). */
export function isVolatileSegment(segment: string): boolean {
  const s = decodeSegment(segment);
  if (s === "" || API_VERSION.test(s)) return false;
  if (UUID.test(s) || LONG_HEX.test(s)) return true;
  return /\d/.test(s);
}

/** /invoices/INV-1042/ -> /invoices/:id */
export function pathPatternOf(pathname: string): string {
  const path = (pathname.split(/[?#]/)[0] ?? "").replace(/\/+$/, "");
  const segments = path.split("/").filter((s) => s !== "");
  return "/" + segments.map((s) => (isVolatileSegment(s) ? ID_SEGMENT : s)).join("/");
}

/** Parses without the URL global so it stays usable anywhere. Returns null for urls without an authority (about:blank). */
export function normalizeUrl(raw: string): NormalizedUrl | null {
  const m = URL_PARTS.exec(raw.trim());
  if (!m) return null;
  const host = (m[2] ?? "").split("@").pop() ?? "";
  if (host === "") return null;
  const origin = `${(m[1] ?? "").toLowerCase()}://${host.toLowerCase()}`;
  const pathname = m[3] === undefined || m[3] === "" ? "/" : m[3];
  return { origin, pathname, pathPattern: pathPatternOf(pathname), url: origin + pathname };
}
