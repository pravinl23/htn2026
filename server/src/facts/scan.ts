import { classifyLink, factsFromGitHubProfile, factsFromText, factsFromVCard, sourceId, type DecisionProvider, type FactProposal, type FactSource } from "@ghost/shared";
import type { HostLookup } from "../executors/netguard";
import { extractFactsByRegex } from "../lib/resumeRegex";
import type { LlmClient } from "../llm/client";
import { resolveConflicts, type ConflictReport } from "./conflicts";
import { fetchGitHubProfile } from "./github";
import { extractWithModel, type DocumentKind } from "./modelExtract";
import { completeAll, evidenceFor, mergeProposals, type ScanProposal } from "./propose";
import { redactSensitive } from "./redact";
import { FACT_SCAN_LIMITS, type ScanHints, type ScanRequest, type ScanSource } from "./validation";
import { fetchWebsiteText } from "./website";

/**
 * One scan: read the sources the user named, propose facts, and forget everything else.
 *
 * NOTHING is persisted. No document, no fetched page, no proposal and no value is written to disk, kept
 * in memory between requests or logged. The response is the only place a value ever appears, and it goes
 * straight back to the client that asked, which shows it in the review list before anything enters the
 * graph (docs/profile-sources.md section 2).
 *
 * The pipeline per document, in order: redact -> code extractors -> ONE model call -> code validation ->
 * one Jev call for genuine conflicts. Code runs first and code has the last word.
 */

/** A GitHub profile is structured JSON, not prose: code reads it exactly, so it never costs a model call. */
const RESUME_REGEX_CONFIDENCE = 0.85;

export interface ScanDeps {
  fetch?: typeof fetch;
  lookup?: HostLookup;
  /** Absent (no key configured) means the code extractors answer alone. */
  client?: LlmClient;
  /** Answers the conflict question. The heuristic provider is skipped: it cannot judge whose employer is whose. */
  provider?: DecisionProvider;
  timeoutMs?: { github?: number; website?: number; model?: number; conflicts?: number };
  now?: () => string;
  /** One line and one latency sample per model call, counts only. */
  onModelCall?: (info: { provider: string; latencyMs: number; ok: boolean; questions: number }) => void;
}

export interface ScanSourceReport {
  kind: ScanSource["kind"];
  /** `github:octocat`, `website:https://alexchen.dev`, `file:resume`: what "forget this source" matches on. */
  id: string;
  status: "ok" | "unchanged" | "failed";
  proposals: number;
  /** Sensitive lines, values and model answers this source held. Counted, never kept. */
  sensitive: number;
  /** Values the model returned that are not in the document. */
  unverified: number;
  modelCalls: number;
  latencyMs: number;
  etag?: string;
  /** Short fixed word: timeout, blocked, not found, rate limited, ... Never a value. */
  reason?: string;
}

export interface ScanResult {
  proposals: ScanProposal[];
  sources: ScanSourceReport[];
  conflicts: ConflictReport[];
  /** Which provider answered the conflict question, or "code". */
  provider: string;
  modelCalls: number;
  sensitiveDropped: number;
  latencyMs: number;
}

interface SourceOutcome {
  report: ScanSourceReport;
  proposals: ScanProposal[];
}

function factsFromResume(text: string, source: FactSource): FactProposal[] {
  return Object.entries(extractFactsByRegex(text)).map(([key, value]) => {
    const proposal: FactProposal = { key, value, source, confidence: RESUME_REGEX_CONFIDENCE };
    const evidence = evidenceFor(text, value);
    if (evidence) proposal.evidence = evidence;
    return proposal;
  });
}

function isVCard(text: string): boolean {
  return /^\s*BEGIN:VCARD/i.test(text);
}

/** The page the user pointed Ghost at is itself a fact: their site, or their profile on one. */
function factsFromPage(source: FactSource): FactProposal[] {
  if (source.kind !== "website") return [];
  const key = classifyLink(source.origin);
  return key === null ? [] : [{ key, value: source.origin, source, confidence: 0.7, evidence: "the page you asked Ghost to read" }];
}

/** The code extractors for one document. A vCard is structured, so it is read exactly and nothing is guessed. */
function codeExtract(text: string, source: FactSource, kind: DocumentKind, hints: ScanHints): FactProposal[] {
  if (isVCard(text)) return factsFromVCard(text, source.kind === "file" ? source.name : "contact.vcf");
  const opts: { fullName?: string; preferDomain?: string } = {};
  if (hints.fullName) opts.fullName = hints.fullName;
  if (hints.workDomain) opts.preferDomain = hints.workDomain;
  const fromText = factsFromText(text, source, opts);
  if (kind === "resume") return [...factsFromResume(text, source), ...fromText];
  return [...factsFromPage(source), ...fromText];
}

async function scanDocument(
  raw: string,
  source: FactSource,
  kind: DocumentKind,
  req: ScanRequest,
  deps: ScanDeps,
  now: string,
  started: number,
  base: { kind: ScanSource["kind"]; etag?: string },
): Promise<SourceOutcome> {
  const redacted = redactSensitive(raw);
  const code = completeAll(codeExtract(redacted.text, source, kind, req.hints), now);
  let proposals = code.proposals;
  let sensitive = redacted.dropped + code.sensitive;
  let unverified = 0;
  let modelCalls = 0;

  // ONE model call per document, and only for prose: a vCard and a GitHub profile are already structured.
  if (deps.client && req.model && !isVCard(redacted.text)) {
    const model = await extractWithModel({ text: redacted.text, source, kind }, deps.client, { now, ...(deps.timeoutMs?.model ? { timeoutMs: deps.timeoutMs.model } : {}) });
    modelCalls = model.calls;
    sensitive += model.sensitive;
    unverified = model.unverified;
    proposals = mergeProposals(proposals, model.proposals);
    if (model.calls > 0) deps.onModelCall?.({ provider: model.provider, latencyMs: model.latencyMs, ok: model.ok, questions: 1 });
  }

  return {
    proposals,
    report: {
      kind: base.kind,
      id: sourceId(source),
      status: "ok",
      proposals: proposals.length,
      sensitive,
      unverified,
      modelCalls,
      latencyMs: Math.round(performance.now() - started),
      ...(base.etag ? { etag: base.etag } : {}),
    },
  };
}

async function scanSource(source: ScanSource, req: ScanRequest, deps: ScanDeps, now: string): Promise<SourceOutcome> {
  const started = performance.now();
  const failed = (kind: ScanSource["kind"], id: string, reason: string): SourceOutcome => ({
    proposals: [],
    report: { kind, id, status: "failed", proposals: 0, sensitive: 0, unverified: 0, modelCalls: 0, latencyMs: Math.round(performance.now() - started), reason },
  });

  if (source.kind === "github") {
    const id = sourceId({ kind: "github", login: source.login });
    const fetched = await fetchGitHubProfile(source.login, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.timeoutMs?.github ? { timeoutMs: deps.timeoutMs.github } : {}),
      ...(source.etag ? { etag: source.etag } : {}),
    });
    if (fetched.status === "failed") return failed("github", id, fetched.reason);
    if (fetched.status === "unchanged") {
      return {
        proposals: [],
        report: { kind: "github", id, status: "unchanged", proposals: 0, sensitive: 0, unverified: 0, modelCalls: 0, latencyMs: Math.round(performance.now() - started), etag: fetched.etag },
      };
    }
    const batch = completeAll(factsFromGitHubProfile(fetched.profile), now);
    return {
      proposals: batch.proposals,
      report: {
        kind: "github",
        id,
        status: "ok",
        proposals: batch.proposals.length,
        sensitive: batch.sensitive,
        unverified: 0,
        modelCalls: 0,
        latencyMs: Math.round(performance.now() - started),
        ...(fetched.etag ? { etag: fetched.etag } : {}),
      },
    };
  }

  if (source.kind === "website") {
    const fetched = await fetchWebsiteText(source.url, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
      ...(deps.timeoutMs?.website ? { timeoutMs: deps.timeoutMs.website } : {}),
    });
    if (fetched.status === "failed") return failed("website", sourceId({ kind: "website", origin: new URL(source.url).origin }), fetched.reason);
    return scanDocument(fetched.text, { kind: "website", origin: fetched.origin }, "website", req, deps, now, started, { kind: "website" });
  }

  return scanDocument(source.text, source.source, source.kind === "resume" ? "resume" : "text", req, deps, now, started, { kind: source.kind });
}

export async function runScan(req: ScanRequest, deps: ScanDeps = {}): Promise<ScanResult> {
  const started = performance.now();
  const now = deps.now?.() ?? new Date().toISOString();
  const outcomes = await Promise.all(req.sources.map((source) => scanSource(source, req, deps, now)));
  const proposals = outcomes.flatMap((outcome) => outcome.proposals);
  const resolved = await resolveConflicts(proposals, deps.provider, deps.timeoutMs?.conflicts ? { timeoutMs: deps.timeoutMs.conflicts } : {});
  if (resolved.calls > 0) deps.onModelCall?.({ provider: resolved.provider, latencyMs: resolved.latencyMs, ok: resolved.conflicts.some((c) => c.resolvedBy === "model"), questions: resolved.conflicts.length });
  const modelCalls = outcomes.reduce((total, outcome) => total + outcome.report.modelCalls, 0) + resolved.calls;
  return {
    proposals: resolved.proposals.slice(0, FACT_SCAN_LIMITS.proposals),
    sources: outcomes.map((outcome) => outcome.report),
    conflicts: resolved.conflicts,
    provider: resolved.provider,
    modelCalls,
    sensitiveDropped: outcomes.reduce((total, outcome) => total + outcome.report.sensitive, 0),
    latencyMs: Math.round(performance.now() - started),
  };
}
