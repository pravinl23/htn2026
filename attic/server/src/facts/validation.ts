import type { FactSource } from "@ghost/shared";
import { isPrivateHost } from "../executors/netguard";
import { isRecord } from "../providers/errors";
import { BadRequest } from "../providers/validation";

/**
 * `POST /v1/facts/scan` reads sources the USER names: a GitHub login, one URL, a document they pasted.
 * Nothing here crawls, follows a link found in a document, or reads anything the request did not name.
 * Every limit is small on purpose: a scan is a handful of documents, not an import job.
 */
export const FACT_SCAN_LIMITS = {
  bodyBytes: 256_000,
  sources: 5,
  /** Per document. The résumé route uses the same figure. */
  textChars: 20_000,
  loginChars: 39,
  urlChars: 2048,
  nameChars: 80,
  etagChars: 200,
  hintChars: 120,
  /** Bytes read from a fetched page before the reader stops. */
  fetchBytes: 512_000,
  /** Proposals returned by one scan, across every source. */
  proposals: 60,
} as const;

/** GitHub's own rule: alphanumerics and single inner hyphens, 1 to 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;

/** Where a pasted document came from, so its facts carry honest provenance and "forget this source" works. */
export type DocumentOrigin = "file" | "mail" | "calendar" | "drive";
const DOCUMENT_ORIGINS: readonly DocumentOrigin[] = ["file", "mail", "calendar", "drive"];

export interface GitHubScanSource {
  kind: "github";
  login: string;
  /** The ETag a previous scan returned. GitHub answers 304 when the profile has not changed. */
  etag?: string;
}

export interface WebsiteScanSource {
  kind: "website";
  url: string;
}

export interface DocumentScanSource {
  kind: "text" | "resume";
  text: string;
  source: FactSource;
}

export type ScanSource = GitHubScanSource | WebsiteScanSource | DocumentScanSource;

/** Optional, never required: what the caller already knows, so a signature block can be read as "title at employer". */
export interface ScanHints {
  fullName?: string;
  /** The domain of the user's work email, so an address at it is proposed as the work one. */
  workDomain?: string;
}

export interface ScanRequest {
  sources: ScanSource[];
  hints: ScanHints;
  /** false: code extractors only, zero model calls. Default true (the model still needs a configured key). */
  model: boolean;
}

function string(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new BadRequest(`${path} must be a non-empty string`);
  if (value.length > max) throw new BadRequest(`${path} must be at most ${max} characters`);
  return value.trim();
}

function optionalString(value: unknown, path: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return string(value, path, max);
}

function documentSource(body: Record<string, unknown>, path: string, kind: "text" | "resume"): FactSource {
  const raw = optionalString(body.origin, `${path}.origin`, 16) ?? "file";
  if (!(DOCUMENT_ORIGINS as readonly string[]).includes(raw)) throw new BadRequest(`${path}.origin must be one of ${DOCUMENT_ORIGINS.join(", ")}`);
  const origin = raw as DocumentOrigin;
  const name = optionalString(body.name, `${path}.name`, FACT_SCAN_LIMITS.nameChars) ?? (kind === "resume" ? "resume" : "pasted text");
  if (origin === "file") return { kind: "file", name };
  return { kind: origin, connector: name };
}

/** A URL the user typed. Refused before any socket opens: no credentials, no private address, http(s) only. */
export function parseWebsiteUrl(raw: string, path: string): string {
  if (raw.length > FACT_SCAN_LIMITS.urlChars) throw new BadRequest(`${path} must be at most ${FACT_SCAN_LIMITS.urlChars} characters`);
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new BadRequest(`${path} must be a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BadRequest(`${path} must be an http or https URL`);
  if (url.username !== "" || url.password !== "") throw new BadRequest(`${path} must not carry credentials`);
  if (isPrivateHost(url.hostname)) throw new BadRequest(`${path} must be a public address`);
  url.hash = "";
  return url.toString();
}

function parseSource(raw: unknown, index: number): ScanSource {
  const path = `sources[${index}]`;
  if (!isRecord(raw)) throw new BadRequest(`${path} must be an object`);
  const kind = string(raw.kind, `${path}.kind`, 16);
  if (kind === "github") {
    const login = string(raw.login, `${path}.login`, FACT_SCAN_LIMITS.loginChars);
    if (!GITHUB_LOGIN.test(login)) throw new BadRequest(`${path}.login must be a GitHub username`);
    const etag = optionalString(raw.etag, `${path}.etag`, FACT_SCAN_LIMITS.etagChars);
    return etag === undefined ? { kind: "github", login } : { kind: "github", login, etag };
  }
  if (kind === "website") return { kind: "website", url: parseWebsiteUrl(string(raw.url, `${path}.url`, FACT_SCAN_LIMITS.urlChars), `${path}.url`) };
  if (kind === "text" || kind === "resume") {
    return { kind, text: string(raw.text, `${path}.text`, FACT_SCAN_LIMITS.textChars), source: documentSource(raw, path, kind) };
  }
  throw new BadRequest(`${path}.kind must be one of github, website, text, resume`);
}

export function parseScanRequest(body: unknown): ScanRequest {
  if (!isRecord(body)) throw new BadRequest("body must be a JSON object");
  if (!Array.isArray(body.sources)) throw new BadRequest("sources must be an array");
  if (body.sources.length === 0) throw new BadRequest("sources must have at least one entry");
  if (body.sources.length > FACT_SCAN_LIMITS.sources) throw new BadRequest(`sources must have at most ${FACT_SCAN_LIMITS.sources} entries`);
  const hintsRaw = body.hints === undefined || body.hints === null ? {} : body.hints;
  if (!isRecord(hintsRaw)) throw new BadRequest("hints must be an object");
  const hints: ScanHints = {};
  const fullName = optionalString(hintsRaw.fullName, "hints.fullName", FACT_SCAN_LIMITS.hintChars);
  if (fullName) hints.fullName = fullName;
  const workDomain = optionalString(hintsRaw.workDomain, "hints.workDomain", FACT_SCAN_LIMITS.hintChars);
  if (workDomain) hints.workDomain = workDomain.replace(/^@/, "").toLowerCase();
  if (body.model !== undefined && typeof body.model !== "boolean") throw new BadRequest("model must be a boolean");
  return { sources: body.sources.map(parseSource), hints, model: body.model !== false };
}
