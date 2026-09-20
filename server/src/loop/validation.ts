import { isSensitive, normalizeUrl, type FactLocator, type FactsByUrl, type FieldKind, type LoopCandidate, type PageFact, type TraceEvent, type TraceEventType, type TraceTarget } from "@shabang/shared";
import { isRecord } from "../providers/errors";
import { BadRequest } from "../providers/validation";
import { isIdOrCardNumber } from "./secrets";

export const LOOP_LIMITS = {
  bodyBytes: 1_000_000,
  /** The trace ring holds 400 events, so one run of a tandem repeat can never be longer than this. */
  runEvents: 200,
  urls: 40,
  factsPerUrl: 80,
  factText: 200,
  label: 200,
  value: 500,
  id: 300,
  url: 2000,
  unresolvedHints: 50,
} as const;

export interface SynthesizeRequest {
  candidate: LoopCandidate;
  factsByUrl: FactsByUrl;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<TraceEventType>(["click", "input", "select", "check", "navigate", "tabswitch", "submit"]);
const FIELD_KINDS: ReadonlySet<string> = new Set<FieldKind>([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox", "file", "button", "link", "other",
]);
const LOCATOR_KINDS: ReadonlySet<string> = new Set<FactLocator["by"]>(["testid", "data-field", "id", "label", "css"]);

// Messages name the offending path only. They never echo request values.

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BadRequest(`${path} must be an object`);
  return value;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new BadRequest(`${path} must be an array`);
  if (value.length > max) throw new BadRequest(`${path} must have at most ${max} items`);
  return value;
}

/** Identifiers and typed values must fit: clipping one would change what it identifies or what gets verified. */
function exact(value: unknown, path: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value === "")) throw new BadRequest(`${path} must be a${allowEmpty ? "" : " non-empty"} string`);
  if (value.length > max) throw new BadRequest(`${path} must be at most ${max} characters`);
  return value;
}

/** Descriptive text is clipped instead of rejected. */
function clipped(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new BadRequest(`${path} must be a string`);
  return value.slice(0, max);
}

function integer(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new BadRequest(`${path} must be a non-negative integer`);
  return value;
}

function flag(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new BadRequest(`${path} must be a boolean`);
  return value;
}

/** Query strings and fragments can carry personal data: only origin + pathname is kept, as the trace contract says. */
function pageUrl(value: unknown, path: string): string {
  const where = normalizeUrl(exact(value, path, LOOP_LIMITS.url));
  if (!where) throw new BadRequest(`${path} must be an absolute url`);
  return where.url;
}

function parseTarget(raw: unknown, path: string): TraceTarget {
  const t = object(raw, path);
  if (typeof t.kind !== "string" || !FIELD_KINDS.has(t.kind)) throw new BadRequest(`${path}.kind is not a known field kind`);
  const target: TraceTarget = {
    signature: exact(t.signature, `${path}.signature`, LOOP_LIMITS.id),
    label: clipped(t.label, `${path}.label`, LOOP_LIMITS.label),
    kind: t.kind as FieldKind,
    locked: flag(t.locked, `${path}.locked`),
  };
  if (t.list != null) {
    const list = object(t.list, `${path}.list`);
    target.list = {
      listSignature: exact(list.listSignature, `${path}.list.listSignature`, LOOP_LIMITS.id),
      index: integer(list.index, `${path}.list.index`),
      itemKey: clipped(list.itemKey ?? "", `${path}.list.itemKey`, LOOP_LIMITS.label),
    };
  }
  if (t.cell != null) {
    const cell = object(t.cell, `${path}.cell`);
    target.cell = {
      row: integer(cell.row, `${path}.cell.row`),
      col: integer(cell.col, `${path}.cell.col`),
      colHeader: clipped(cell.colHeader ?? "", `${path}.cell.colHeader`, LOOP_LIMITS.label),
    };
  }
  return target;
}

function parseEvent(raw: unknown, path: string): TraceEvent {
  const e = object(raw, path);
  if (typeof e.type !== "string" || !EVENT_TYPES.has(e.type)) throw new BadRequest(`${path}.type is not a known event type`);
  if (typeof e.t !== "number" || !Number.isFinite(e.t)) throw new BadRequest(`${path}.t must be a number`);
  const url = pageUrl(e.url, `${path}.url`);
  const event: TraceEvent = {
    t: e.t,
    tabId: typeof e.tabId === "number" && Number.isFinite(e.tabId) ? e.tabId : 0,
    type: e.type as TraceEventType,
    origin: exact(e.origin, `${path}.origin`, LOOP_LIMITS.id),
    pathPattern: exact(e.pathPattern, `${path}.pathPattern`, LOOP_LIMITS.url),
    url,
  };
  if (e.target != null) event.target = parseTarget(e.target, `${path}.target`);
  if (e.value != null) event.value = exact(e.value, `${path}.value`, LOOP_LIMITS.value, true);
  if (e.synthetic != null && flag(e.synthetic, `${path}.synthetic`)) event.synthetic = true;
  return event;
}

function parseRun(raw: unknown, path: string): TraceEvent[] {
  const run = array(raw, path, LOOP_LIMITS.runEvents);
  if (run.length === 0) throw new BadRequest(`${path} must not be empty`);
  return run.map((e, i) => parseEvent(e, `${path}[${i}]`));
}

function parseLocator(raw: unknown, path: string): FactLocator {
  const locator = object(raw, path);
  if (typeof locator.by !== "string" || !LOCATOR_KINDS.has(locator.by)) throw new BadRequest(`${path}.by is not a known locator kind`);
  return { by: locator.by as FactLocator["by"], value: exact(locator.value, `${path}.value`, LOOP_LIMITS.id) };
}

function parseFact(raw: unknown, path: string): PageFact {
  const fact = object(raw, path);
  return {
    locator: parseLocator(fact.locator, `${path}.locator`),
    label: clipped(fact.label ?? "", `${path}.label`, LOOP_LIMITS.label),
    text: clipped(fact.text, `${path}.text`, LOOP_LIMITS.factText),
  };
}

/** Defence in depth: the extension never extracts sensitive-looking facts, and one must never reach the heuristic or a prompt. */
function isSensitiveFact(fact: PageFact): boolean {
  // The label can be innocent ("Reference") while the text is an SSN or a card number: the text is screened too.
  if (isIdOrCardNumber(fact.text)) return true;
  // A css locator is structure ("div.pin > span"), not a name, so only named locators are probed.
  return isSensitive({ label: fact.label, name: fact.locator.by === "css" ? undefined : fact.locator.value });
}

function parseFactsByUrl(raw: unknown): FactsByUrl {
  const entries = Object.entries(object(raw ?? {}, "factsByUrl"));
  if (entries.length > LOOP_LIMITS.urls) throw new BadRequest(`factsByUrl must have at most ${LOOP_LIMITS.urls} urls`);
  const out: FactsByUrl = {};
  for (const [i, [rawUrl, rawFacts]] of entries.entries()) {
    const url = pageUrl(rawUrl, `factsByUrl key ${i}`);
    const facts = array(rawFacts, `factsByUrl[${i}]`, LOOP_LIMITS.factsPerUrl).map((f, j) => parseFact(f, `factsByUrl[${i}][${j}]`));
    out[url] = [...(out[url] ?? []), ...facts.filter((f) => !isSensitiveFact(f))].slice(0, LOOP_LIMITS.factsPerUrl);
  }
  return out;
}

/** The client's own unresolved list is a hint only: the server recomputes it with the same shared code, so it is checked and dropped. */
function checkUnresolvedHint(raw: unknown): void {
  if (raw == null) return;
  for (const [i, hint] of array(raw, "unresolved", LOOP_LIMITS.unresolvedHints).entries()) object(hint, `unresolved[${i}]`);
}

export function parseSynthesizeRequest(body: unknown): SynthesizeRequest {
  const req = object(body, "body");
  const candidate = object(req.candidate, "candidate");
  const runA = parseRun(candidate.runA, "candidate.runA");
  const runB = parseRun(candidate.runB, "candidate.runB");
  if (runA.length !== runB.length) throw new BadRequest("candidate.runA and candidate.runB must have the same length");
  checkUnresolvedHint(req.unresolved);
  return { candidate: { length: runA.length, runA, runB }, factsByUrl: parseFactsByUrl(req.factsByUrl) };
}
