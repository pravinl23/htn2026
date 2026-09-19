import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF guard for cloud browsers: a job may only ever point one at a PUBLIC address.
 * Hostnames are canonicalised by the URL parser first (it folds "2130706433", "0x7f.1" and "127.1" into 127.0.0.1 and
 * compresses IPv6), then IP literals are parsed numerically. Anything that cannot be parsed counts as private.
 */

/** Resolves a hostname to every address it has. Injected in tests, so no test ever touches DNS. */
export type HostLookup = (hostname: string) => Promise<string[]>;

export const systemLookup: HostLookup = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** [first octet, second octet mask, second octet value] style tables are unreadable: ranges are written as CIDR and compiled once. */
const PRIVATE_V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
].map((cidr) => {
  const [base = "", bits = "32"] = cidr.split("/");
  return { base: v4ToInt(base.split(".").map(Number)), bits: Number(bits) };
});

/** Names that never leave the local network, and wildcard DNS services whose names resolve to whatever IP they spell. */
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|home\.arpa|nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me)$/;

function v4ToInt(octets: number[]): number {
  return octets.reduce((acc, o) => acc * 256 + o, 0);
}

function parseV4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function isPrivateV4(octets: number[]): boolean {
  const ip = v4ToInt(octets);
  return PRIVATE_V4.some(({ base, bits }) => Math.floor(ip / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

/** Eight 16-bit groups, or null. Accepts "::" compression and a dotted IPv4 tail. */
function parseV6(host: string): number[] | null {
  let text = host;
  const tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (tail) {
    const v4 = parseV4(tail[2] ?? "");
    if (!v4) return null;
    text = `${tail[1]}${(((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16)}:${(((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out = part.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
    return out.some(Number.isNaN) ? null : out;
  };
  const head = groups(halves[0] ?? "");
  const rest = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  return fill < 1 ? null : [...head, ...new Array<number>(fill).fill(0), ...rest];
}

function embeddedV4(groups: number[], at: number): number[] {
  const [hi = 0, lo = 0] = [groups[at], groups[at + 1]];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

function isPrivateV6(g: number[]): boolean {
  const first = g[0] ?? 0;
  const leadingZeros = g.slice(0, 5).every((x) => x === 0);
  if (leadingZeros && g[5] === 0xffff) return isPrivateV4(embeddedV4(g, 6)); // ::ffff:a.b.c.d (IPv4-mapped)
  if (leadingZeros && g[5] === 0) return true; // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  if (first === 0x64 && g[1] === 0xff9b) return g[2] !== 0 || g[3] !== 0 || g[4] !== 0 || g[5] !== 0 || isPrivateV4(embeddedV4(g, 6)); // NAT64
  if (first === 0x2002) return isPrivateV4(embeddedV4(g, 1)); // 6to4 carries an IPv4 address
  if (first === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true; // link-local, site-local
  return (first & 0xff00) === 0xff00; // multicast
}

/** True for an address (as DNS or a socket reports it) that is not publicly routable. Unparseable input is private. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = parseV4(bare);
  if (v4) return isPrivateV4(v4);
  const v6 = bare.includes(":") ? parseV6(bare) : null;
  return v6 ? isPrivateV6(v6) : true;
}

/** Hostname as the URL parser sees it: lower case, numeric IPv4 forms folded, IPv6 compressed. Null when it is not a valid host. */
function canonicalHost(hostname: string): string | null {
  const bare = hostname.trim().replace(/^\[|\]$/g, "");
  try {
    return new URL(`http://${bare.includes(":") ? `[${bare}]` : bare}/`).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** True when a cloud browser must never be sent there: private, loopback, link-local, CGNAT and metadata addresses, and names that only resolve locally. */
export function isPrivateHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  if (host === null || host === "") return true;
  if (host.includes(":") || parseV4(host)) return isPrivateAddress(host);
  if (/^[\d.]+$/.test(host)) return true; // a numeric host the parser did not fold into an IPv4 address
  if (!host.includes(".")) return true; // single-label names ("intranet", "router") only resolve inside a network
  return PRIVATE_SUFFIX.test(host);
}

export function isIpLiteral(hostname: string): boolean {
  const host = canonicalHost(hostname);
  return host !== null && (host.includes(":") || parseV4(host) !== null);
}

export type ResolutionVerdict = "public" | "private" | "unresolvable";

/**
 * A public-looking name can still point at a private address (A record for 127.0.0.1, split-horizon DNS).
 * Best effort: the cloud browser resolves the name again on its own, so this cannot stop DNS rebinding against Browserbase.
 */
export async function resolvesPublicly(hostname: string, lookup: HostLookup): Promise<ResolutionVerdict> {
  if (isIpLiteral(hostname)) return isPrivateHost(hostname) ? "private" : "public";
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch {
    return "unresolvable";
  }
  if (addresses.length === 0) return "unresolvable";
  return addresses.some(isPrivateAddress) ? "private" : "public";
}
