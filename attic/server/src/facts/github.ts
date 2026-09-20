import type { GitHubProfile } from "@ghost/shared";
import { failureFromError, failureFromStatus, readCappedText, startDeadline, USER_AGENT, type FetchFailure } from "./http";

/**
 * One read of a PUBLIC GitHub profile, for a login the user typed. No token is ever sent (this must work
 * for a user who has no GitHub key, and a token here would spend their rate limit on a scan), so this is
 * the unauthenticated endpoint: 60 requests per hour per address, which is far more than a scan needs.
 *
 * ETag-friendly: the caller keeps the ETag a scan returned and sends it back next time, and an unchanged
 * profile answers 304 — no body, no proposals, and no rate-limit unit on GitHub's side.
 */

const API = "https://api.github.com/users/";
const MAX_BYTES = 128_000;
export const GITHUB_TIMEOUT_MS = 5_000;

export type GitHubFetch =
  | { status: "ok"; profile: GitHubProfile; etag?: string }
  | { status: "unchanged"; etag: string }
  | { status: "failed"; reason: FetchFailure };

export interface GitHubFetchOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The ETag from a previous scan of this login. */
  etag?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Only the public fields Ghost can turn into facts. Everything else GitHub returns is ignored, not stored. */
function toProfile(raw: unknown, login: string): GitHubProfile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const profile: GitHubProfile = { login: text(r.login) ?? login };
  const name = text(r.name);
  if (name) profile.name = name;
  const email = text(r.email);
  if (email) profile.email = email;
  const blog = text(r.blog);
  if (blog) profile.blog = blog;
  const company = text(r.company);
  if (company) profile.company = company;
  const location = text(r.location);
  if (location) profile.location = location;
  const twitter = text(r.twitter_username);
  if (twitter) profile.twitter_username = twitter;
  const bio = text(r.bio);
  if (bio) profile.bio = bio.slice(0, 300);
  return profile;
}

export async function fetchGitHubProfile(login: string, options: GitHubFetchOptions = {}): Promise<GitHubFetch> {
  const doFetch = options.fetch ?? fetch;
  const deadline = startDeadline(options.timeoutMs ?? GITHUB_TIMEOUT_MS);
  try {
    const res = await doFetch(`${API}${encodeURIComponent(login)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        ...(options.etag ? { "If-None-Match": options.etag } : {}),
      },
      redirect: "follow",
      signal: deadline.signal,
    });
    if (res.status === 304) {
      await res.body?.cancel().catch(() => undefined);
      return { status: "unchanged", etag: res.headers.get("etag") ?? options.etag ?? "" };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { status: "failed", reason: failureFromStatus(res.status) };
    }
    const body = await readCappedText(res, MAX_BYTES);
    if (body.truncated) return { status: "failed", reason: "too large" };
    const profile = toProfile(JSON.parse(body.text) as unknown, login);
    if (!profile) return { status: "failed", reason: "malformed" };
    const etag = res.headers.get("etag");
    return etag ? { status: "ok", profile, etag } : { status: "ok", profile };
  } catch (err) {
    return { status: "failed", reason: failureFromError(err, deadline.timedOut()) };
  } finally {
    deadline.clear();
  }
}
