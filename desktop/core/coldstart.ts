// Cold start (docs/cold-start.md), the bridge half. The pure rules live in shared/src/coldstart; this file only
// makes them callable from Objective-C through JavaScriptCore: strings in, JSON strings out, no state.
//
// The native side (desktop/src/SBScanSources.m, desktop/src/SBColdStart.m) is the only part that touches the
// machine: it counts with Spotlight, checks what is readable, opens a bounded number of files and hands the TEXT
// in here. Nothing in this file reads a file, opens a database, asks for a permission or makes a network call.
//
// Everything stays on the machine. Only fact KEYS ever reach the prediction server, and never from this path.
import {
  aggregateHabits,
  aggregateSurfaces,
  applyColdStart,
  buildConsentPlan,
  describeKnowledge,
  emptyKnowledgeFile,
  forgetColdStartSource,
  classifyCandidate,
  describePlan,
  extractFromGitRemote,
  extractFromPackageAuthor,
  extractFromResumeText,
  extractFromVCard,
  mergeResults,
} from "@shabang/shared";
import type {
  ApplyColdStartInput,
  ColdStartSourceKind,
  ExtractionResult,
  FactSource,
  GitRemoteOptions,
  HabitOptions,
  HistoryRow,
  PackageAuthor,
  PlanOptions,
  ProposalOrigin,
  ScanCandidate,
  SourceDescriptor,
  SurfaceObservation,
  SurfaceOptions,
  SurfaceTransitionObservation,
  VCardOptions,
} from "@shabang/shared";
// The résumé rules are the server's own pure regex file (server/src/lib/resumeRegex.ts), injected rather than
// copied: shared/ must not depend on server/, and two copies of these rules would drift within a day.
import { extractFactsByRegex } from "../../server/src/lib/resumeRegex";

function parse<T>(json: string, what: string): T {
  if (typeof json !== "string") throw new TypeError(`GhostCore: ${what} must be a JSON string`);
  return JSON.parse(json) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ sourceKind, fileName? }` from the native side becomes the provenance the graph stores. */
function asOrigin(json: string): ProposalOrigin {
  const raw = parse<unknown>(json, "origin");
  const object = isObject(raw) ? raw : {};
  const sourceKind = (typeof object.sourceKind === "string" ? object.sourceKind : "spotlight") as ColdStartSourceKind;
  if (isObject(object.source) && typeof object.source.kind === "string") {
    return { source: object.source as unknown as FactSource, sourceKind };
  }
  // A file name is the only provenance a local scan has. It stays on the machine: the report the user (or an
  // agent) sees is written value-free by SBColdStart, and only the private pending store keeps it.
  const name = typeof object.fileName === "string" && object.fileName !== "" ? object.fileName : "local file";
  return { source: { kind: "file", name }, sourceKind };
}

function emptyResult(): ExtractionResult {
  return { proposals: [], skipped: 0, skippedCounts: {} };
}

// ---------- the consent panel (plan.ts) ----------

/**
 * The first-run panel, in data: one row per source in tier order, what it reads, what it yields, how many items
 * this scan would open, an estimate and the caps. `descriptorsJson` is `SourceDescriptor[]` — what
 * SBScanSources counted and, for each source, whether its permission is there and whether the user switched it on.
 */
export function coldStartPlan(descriptorsJson: string, optionsJson?: string): string {
  const raw = parse<unknown>(descriptorsJson, "descriptors");
  const descriptors = (Array.isArray(raw) ? raw : []).filter(isObject) as unknown as SourceDescriptor[];
  const options = optionsJson ? (parse<unknown>(optionsJson, "options") as PlanOptions) : {};
  return JSON.stringify(buildConsentPlan(descriptors, isObject(options) ? options : {}));
}

/** "3 sources, about 12 s, 2 need permission" — the line under the switches. */
export function coldStartPlanSummary(planJson: string): string {
  return describePlan(parse(planJson, "plan"));
}

// ---------- the gate (sensitiveScan.ts) ----------

/** One candidate through the sensitivity gate before anything is opened or proposed. Reason codes, never values. */
export function coldStartClassify(candidateJson: string): string {
  const raw = parse<unknown>(candidateJson, "candidate");
  // When in doubt, sensitive: a malformed candidate is refused rather than guessed at.
  if (!isObject(raw)) return JSON.stringify({ sensitive: true, reason: "sensitive-label", detail: "malformed" });
  return JSON.stringify(classifyCandidate(raw as unknown as ScanCandidate));
}

// ---------- the extractors (extract.ts) ----------

export function coldStartVCard(text: string, originJson: string, optionsJson?: string): string {
  const options = optionsJson ? (parse<unknown>(optionsJson, "options") as VCardOptions) : {};
  return JSON.stringify(extractFromVCard(String(text ?? ""), asOrigin(originJson), isObject(options) ? options : {}));
}

/** Résumé text (already extracted from pdf/docx by the native side) -> proposals, through the server's regex rules. */
export function coldStartResumeText(text: string, originJson: string, optionsJson?: string): string {
  const raw = optionsJson ? parse<unknown>(optionsJson, "options") : {};
  const fileName = isObject(raw) && typeof raw.fileName === "string" ? raw.fileName : undefined;
  const result = extractFromResumeText(String(text ?? ""), asOrigin(originJson), {
    extractFacts: extractFactsByRegex,
    ...(fileName === undefined ? {} : { fileName }),
  });
  return JSON.stringify(result);
}

export function coldStartGitRemote(remote: string, originJson: string, optionsJson?: string): string {
  const options = optionsJson ? (parse<unknown>(optionsJson, "options") as GitRemoteOptions) : {};
  return JSON.stringify(extractFromGitRemote(String(remote ?? ""), asOrigin(originJson), isObject(options) ? options : {}));
}

/**
 * `author` as package.json carries it: a string ("Name <mail> (url)") or an object. A bare string is not valid
 * JSON on its own everywhere, so the caller may also wrap it: `{ "author": ... }`.
 */
export function coldStartPackageAuthor(authorJson: string, originJson: string): string {
  const parsed = parse<unknown>(authorJson, "author");
  const raw = isObject(parsed) && "author" in parsed ? parsed.author : parsed;
  const author = (typeof raw === "string" || isObject(raw) ? raw : undefined) as PackageAuthor;
  return JSON.stringify(extractFromPackageAuthor(author, asOrigin(originJson)));
}

/** Several extraction results into one: proposals merged, support counted, skipped counts added up. */
export function coldStartMerge(resultsJson: string): string {
  const raw = parse<unknown>(resultsJson, "results");
  const results = (Array.isArray(raw) ? raw : []).filter(isObject) as unknown as ExtractionResult[];
  if (results.length === 0) return JSON.stringify(emptyResult());
  return JSON.stringify(mergeResults(results));
}

// ---------- the habits (habits.ts) ----------

/**
 * History rows -> aggregates. The one-way door: the caller deletes its copy of the history the moment this
 * returns, and nothing that comes back can rebuild a browsing list (bare hosts above the visit threshold,
 * time-of-day buckets, counts).
 */
export function coldStartHabits(rowsJson: string, optionsJson?: string): string {
  const raw = parse<unknown>(rowsJson, "rows");
  const rows = (Array.isArray(raw) ? raw : []).filter(isObject) as unknown as HistoryRow[];
  const options = optionsJson ? (parse<unknown>(optionsJson, "options") as HabitOptions) : {};
  return JSON.stringify(aggregateHabits(rows, isObject(options) ? options : {}));
}

// ---------- the surfaces (surfaces.ts) ----------

/**
 * Observations from the no-permission sources (the Dock, login items, how recently an application was used, what
 * is installed) -> surface records. The native side normalises nothing and decides nothing: it hands over what it
 * read and gets back counters. An id that does not reduce to an opaque token is dropped here, not there.
 */
export function coldStartSurfaces(observationsJson: string, transitionsJson?: string, optionsJson?: string): string {
  const rawObservations = parse<unknown>(observationsJson, "observations");
  const observations = (Array.isArray(rawObservations) ? rawObservations : []).filter(isObject) as unknown as SurfaceObservation[];
  const rawTransitions = transitionsJson ? parse<unknown>(transitionsJson, "transitions") : [];
  const transitions = (Array.isArray(rawTransitions) ? rawTransitions : []).filter(isObject) as unknown as SurfaceTransitionObservation[];
  const options = optionsJson ? (parse<unknown>(optionsJson, "options") as SurfaceOptions) : {};
  return JSON.stringify(aggregateSurfaces(observations, transitions, isObject(options) ? options : {}));
}

// ---------- the one small file (graph.ts) ----------

/**
 * A scan into the file (docs/storage.md). `inputJson` is `{ file?, history?, surfaces?, facts?, skipped?, now? }`;
 * what comes back carries the new file text, which the native side writes atomically at mode 0600 and nowhere
 * else. The caps are applied here, so the text can never come back over them.
 */
export function coldStartGraphApply(inputJson: string): string {
  const raw = parse<unknown>(inputJson, "input");
  const input = (isObject(raw) ? raw : {}) as unknown as ApplyColdStartInput;
  return JSON.stringify(applyColdStart(input));
}

/** What Shabang knows: counts per screen kind, per source, the file size, and the most used surfaces. */
export function coldStartGraphDescribe(fileText: string, topJson?: string): string {
  const top = topJson === undefined ? 10 : Number.parseInt(topJson, 10);
  return JSON.stringify(describeKnowledge(typeof fileText === "string" ? fileText : "", Number.isFinite(top) ? top : 10));
}

/** "Forget this source": exactly what it produced goes, and a surface another source also found stays. */
export function coldStartGraphForget(fileText: string, kind: string): string {
  return JSON.stringify(forgetColdStartSource(typeof fileText === "string" ? fileText : "", String(kind ?? "")));
}

/** "Delete everything": an empty brain, so the file is never left in an in-between state. */
export function coldStartGraphEmpty(): string {
  return emptyKnowledgeFile();
}
