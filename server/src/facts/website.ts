import { classifyLink } from "@ghost/shared";
import { isPrivateHost, resolvesPublicly, systemLookup, type HostLookup } from "../executors/netguard";
import { htmlLinks, htmlToText } from "./html";
import { failureFromError, failureFromStatus, readCappedText, startDeadline, USER_AGENT, type FetchFailure } from "./http";
import { FACT_SCAN_LIMITS } from "./validation";

/**
 * ONE read of ONE page the user typed in. This is deliberately not a crawler: no link on the page is
 * followed, nothing is queued, nothing is stored. The fetched bytes live only long enough to become text,
 * the text only long enough to become proposals.
 *
 * Guards, in order: the address must be public (before the socket opens, and again after DNS), the
 * redirect chain may not leave the site, the response must be text, and the read stops at a byte cap.
 */

export const WEBSITE_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 2;
const TEXT_TYPES = /^(text\/html|text\/plain|application\/xhtml\+xml)\b/i;

export type WebsiteFetch = { status: "ok"; text: string; origin: string; url: string } | { status: "failed"; reason: FetchFailure };

export interface WebsiteFetchOptions {
  fetch?: typeof fetch;
  lookup?: HostLookup;
  timeoutMs?: number;
  maxChars?: number;
}

/** www.alexchen.dev and alexchen.dev are the same site; an https upgrade is fine, a downgrade is not. */
function sameSite(from: URL, to: URL): boolean {
  const bare = (host: string): string => host.replace(/^www\./i, "").toLowerCase();
  if (bare(from.hostname) !== bare(to.hostname)) return false;
  if (from.port !== to.port && !(from.port === "" && to.port === "")) return false;
  return to.protocol === from.protocol || (from.protocol === "http:" && to.protocol === "https:");
}

/**
 * The links worth keeping: the user's profile on GitHub, LinkedIn or X, an address behind a `mailto:`,
 * and the site's own pages. A link to somewhere else is not a fact about the user, so it is dropped
 * rather than proposed as their website.
 */
function profileLinks(html: string, page: URL, budget: number): string[] {
  const keep: string[] = [];
  let used = 0;
  for (const link of htmlLinks(html, page.toString())) {
    // A mailto address comes back bare; anything else must be the user's profile on a site Ghost has a key for.
    const kind = link.includes("://") ? classifyLink(link) : "mailto";
    if (kind !== "mailto" && kind !== "github" && kind !== "linkedin" && kind !== "links.twitter") continue;
    used += link.length + 1;
    if (used > budget) break;
    keep.push(link);
  }
  return keep;
}

async function reachable(url: URL, lookup: HostLookup): Promise<boolean> {
  if (isPrivateHost(url.hostname)) return false;
  return (await resolvesPublicly(url.hostname, lookup)) === "public";
}

export async function fetchWebsiteText(rawUrl: string, options: WebsiteFetchOptions = {}): Promise<WebsiteFetch> {
  const doFetch = options.fetch ?? fetch;
  const lookup = options.lookup ?? systemLookup;
  const maxChars = options.maxChars ?? FACT_SCAN_LIMITS.textChars;
  const deadline = startDeadline(options.timeoutMs ?? WEBSITE_TIMEOUT_MS);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    deadline.clear();
    return { status: "failed", reason: "blocked" };
  }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await reachable(url, lookup))) return { status: "failed", reason: "blocked" };
      const res = await doFetch(url.toString(), {
        headers: { Accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "User-Agent": USER_AGENT, "Accept-Language": "en" },
        redirect: "manual",
        signal: deadline.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        if (!location || hop === MAX_REDIRECTS) return { status: "failed", reason: "blocked" };
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { status: "failed", reason: "blocked" };
        }
        // A redirect off the site is where a scan would start reading something the user never named.
        if (!sameSite(url, next)) return { status: "failed", reason: "blocked" };
        url = next;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { status: "failed", reason: failureFromStatus(res.status) };
      }
      const type = res.headers.get("content-type") ?? "text/html";
      if (!TEXT_TYPES.test(type)) {
        await res.body?.cancel().catch(() => undefined);
        return { status: "failed", reason: "not text" };
      }
      const body = await readCappedText(res, FACT_SCAN_LIMITS.fetchBytes);
      const isHtml = /html|xhtml/i.test(type) || /^\s*<(!doctype|html)\b/i.test(body.text);
      // The links are kept out of the character budget's way: a long page must not push the profile links off the end.
      const links = isHtml ? profileLinks(body.text, url, Math.floor(maxChars / 4)) : [];
      const room = Math.max(200, maxChars - links.join("\n").length - 1);
      const text = isHtml ? [htmlToText(body.text, room), ...links].join("\n") : body.text.slice(0, maxChars);
      if (text.trim() === "") return { status: "failed", reason: "not text" };
      return { status: "ok", text, origin: url.origin, url: url.toString() };
    }
    return { status: "failed", reason: "blocked" };
  } catch (err) {
    return { status: "failed", reason: failureFromError(err, deadline.timedOut()) };
  } finally {
    deadline.clear();
  }
}
