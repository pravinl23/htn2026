import {
  type CapturedField,
  type FieldKind,
  type FieldOption,
  type FormPredictRequest,
} from "@ghost/shared";
import { COUNTER_NAMES, type CalibrationPair, type Counters } from "../lib/metrics";
import { isRecord } from "./errors";
import type { EpisodicPair, NextCandidate, NextPredictRequest, TraceEvent } from "./nextQuestions";

export const LIMITS = {
  formBodyBytes: 512_000,
  nextBodyBytes: 128_000,
  metricsBodyBytes: 32_000,
  // Every question repeats the full criteria, so fields x factKeys bounds the model call a request can trigger.
  fields: 100,
  factKeys: 64, // far under Jev's 255 options, with room for needs_text and none
  fieldOptions: 100,
  recentActions: 20,
  candidates: 60,
  memory: 5,
  calibrationPairs: 500,
} as const;

const FIELD_KINDS: ReadonlySet<string> = new Set<FieldKind>([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox", "file", "button", "link", "other",
]);
const CANDIDATE_KINDS: ReadonlySet<string> = new Set<NextCandidate["kind"]>(["button", "link", "field"]);
const FACT_KEY = /^[A-Za-z][\w.-]{0,63}$/;
const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0 };

/** Messages name the offending path only. They never echo request values. */
export class BadRequest extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = "BadRequest";
  }
}

interface BodySource {
  header(name: string): string | undefined;
  text(): Promise<string>;
}

export async function readJsonBody(req: BodySource, maxBytes: number): Promise<unknown> {
  if (Number(req.header("content-length") ?? 0) > maxBytes) throw new BadRequest("request body too large", 413);
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw new BadRequest("request body too large", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequest("request body must be valid JSON");
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BadRequest(`${path} must be an object`);
  return value;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new BadRequest(`${path} must be an array`);
  if (value.length > max) throw new BadRequest(`${path} must have at most ${max} items`);
  return value;
}

/** Identifiers must fit (clipping would change identity). */
function id(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value === "") throw new BadRequest(`${path} must be a non-empty string`);
  if (value.length > max) throw new BadRequest(`${path} must be at most ${max} characters`);
  return value;
}

/** Descriptive text is clipped instead of rejected. */
function text(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new BadRequest(`${path} must be a string`);
  return value.slice(0, max);
}

function optionalText(value: unknown, path: string, max: number): string | undefined {
  return value === undefined || value === null ? undefined : text(value, path, max);
}

function optionalFlag(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new BadRequest(`${path} must be a boolean`);
  return value;
}

function defined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key];
  return value;
}

function parseOptions(value: unknown, path: string): FieldOption[] | undefined {
  if (value === undefined || value === null) return undefined;
  return array(value, path, LIMITS.fieldOptions).map((raw, i) => {
    const option = object(raw, `${path}[${i}]`);
    return { value: text(option.value ?? "", `${path}[${i}].value`, 200), label: text(option.label ?? "", `${path}[${i}].label`, 200) };
  });
}

/** The current field value is dropped on purpose: prediction never needs it, so the server never holds it. */
function parseField(raw: unknown, path: string): CapturedField {
  const field = object(raw, path);
  if (typeof field.kind !== "string" || !FIELD_KINDS.has(field.kind)) throw new BadRequest(`${path}.kind is not a known field kind`);
  return defined<CapturedField>({
    signature: id(field.signature, `${path}.signature`, 300),
    label: text(field.label, `${path}.label`, 500),
    kind: field.kind as FieldKind,
    inputType: optionalText(field.inputType, `${path}.inputType`, 40),
    name: optionalText(field.name, `${path}.name`, 200),
    id: optionalText(field.id, `${path}.id`, 200),
    autocomplete: optionalText(field.autocomplete, `${path}.autocomplete`, 100),
    placeholder: optionalText(field.placeholder, `${path}.placeholder`, 300),
    options: parseOptions(field.options, `${path}.options`),
    required: optionalFlag(field.required, `${path}.required`),
    locked: optionalFlag(field.locked, `${path}.locked`),
    context: optionalText(field.context, `${path}.context`, 500),
    rect: ZERO_RECT,
  });
}

export function parseFormRequest(body: unknown): FormPredictRequest {
  const req = object(body, "body");
  const factKeys = array(req.factKeys, "factKeys", LIMITS.factKeys).map((key, i) => {
    if (typeof key !== "string" || !FACT_KEY.test(key)) throw new BadRequest(`factKeys[${i}] is not a valid fact key`);
    return key;
  });
  return {
    origin: id(req.origin, "origin", 300),
    formSignature: id(req.formSignature, "formSignature", 300),
    fields: array(req.fields, "fields", LIMITS.fields).map((f, i) => parseField(f, `fields[${i}]`)),
    factKeys,
  };
}

/** Query strings and fragments can carry personal data, so only origin + path ever reach a model. */
export function stripQuery(url: string): string {
  return url.split(/[?#]/)[0] ?? "";
}

function parseEvent(raw: unknown, path: string): TraceEvent {
  const event = object(raw, path);
  const url = optionalText(event.url, `${path}.url`, 2000);
  return defined<TraceEvent>({
    type: id(event.type, `${path}.type`, 40),
    label: optionalText(event.label, `${path}.label`, 200),
    kind: optionalText(event.kind, `${path}.kind`, 40),
    signature: optionalText(event.signature, `${path}.signature`, 300),
    url: url === undefined ? undefined : stripQuery(url),
  });
}

function parseCandidate(raw: unknown, path: string): NextCandidate {
  const candidate = object(raw, path);
  if (typeof candidate.kind !== "string" || !CANDIDATE_KINDS.has(candidate.kind)) throw new BadRequest(`${path}.kind must be button, link or field`);
  if (typeof candidate.locked !== "boolean") throw new BadRequest(`${path}.locked must be a boolean`);
  return defined<NextCandidate>({
    id: id(candidate.id, `${path}.id`, 300),
    kind: candidate.kind as NextCandidate["kind"],
    label: text(candidate.label, `${path}.label`, 200),
    locked: candidate.locked,
    context: optionalText(candidate.context, `${path}.context`, 300),
  });
}

function parseMemory(raw: unknown, path: string): EpisodicPair {
  const pair = object(raw, path);
  return defined<EpisodicPair>({
    summary: optionalText(pair.summary, `${path}.summary`, 500),
    previousAction: pair.previousAction == null ? undefined : parseEvent(pair.previousAction, `${path}.previousAction`),
    action: parseEvent(pair.action, `${path}.action`),
  });
}

export function parseNextRequest(body: unknown): NextPredictRequest {
  const req = object(body, "body");
  const candidates = array(req.candidates, "candidates", LIMITS.candidates).map((c, i) => parseCandidate(c, `candidates[${i}]`));
  const ids = new Set(candidates.map((c) => c.id));
  if (ids.size !== candidates.length || ids.has("none")) throw new BadRequest('candidates[].id must be unique and must not be "none"');
  // Over-long histories are trimmed (newest kept) rather than rejected: a chatty client should still get predictions.
  const actions = array(req.recentActions, "recentActions", Number.MAX_SAFE_INTEGER).slice(-LIMITS.recentActions);
  const memory = req.memory == null ? [] : array(req.memory, "memory", Number.MAX_SAFE_INTEGER).slice(0, LIMITS.memory);
  return {
    origin: id(req.origin, "origin", 300),
    url: stripQuery(text(req.url, "url", 2000)),
    recentActions: actions.map((e, i) => parseEvent(e, `recentActions[${i}]`)),
    candidates,
    memory: memory.map((m, i) => parseMemory(m, `memory[${i}]`)),
  };
}

export interface MetricsEvent {
  counters: Partial<Counters>;
  calibration: CalibrationPair[];
}

function parseCounters(value: unknown): Partial<Counters> {
  if (value === undefined || value === null) return {};
  const raw = object(value, "counters");
  const known: readonly string[] = COUNTER_NAMES;
  for (const key of Object.keys(raw)) if (!known.includes(key)) throw new BadRequest(`counters has an unknown counter (allowed: ${known.join(", ")})`);
  const out: Partial<Counters> = {};
  for (const name of COUNTER_NAMES) {
    const n = raw[name];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1_000_000) throw new BadRequest(`counters.${name} must be a number from 0 to 1000000`);
    out[name] = n;
  }
  return out;
}

function parsePair(raw: unknown, path: string): CalibrationPair {
  const pair = object(raw, path);
  const { confidence, accepted } = pair;
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) throw new BadRequest(`${path}.confidence must be a number from 0 to 1`);
  if (typeof accepted !== "boolean") throw new BadRequest(`${path}.accepted must be a boolean`);
  return { confidence, accepted };
}

export function parseMetricsEvent(body: unknown): MetricsEvent {
  const req = object(body, "body");
  const counters = parseCounters(req.counters);
  const calibration = req.calibration == null ? [] : array(req.calibration, "calibration", LIMITS.calibrationPairs).map((p, i) => parsePair(p, `calibration[${i}]`));
  if (Object.keys(counters).length === 0 && calibration.length === 0) throw new BadRequest("body must include counters or calibration");
  return { counters, calibration };
}
