import { isSensitive, type FactLocator, type FieldKind, type LoopIterator, type StepPage, type StepTarget } from "@shabang/shared";
import { LOOP_TRANSFORMS, type LoopTransform, type ServerLoopProgram as LoopProgram, type ServerLoopStep as LoopStep } from "../loop/transforms";
import { isRecord } from "../providers/errors";
import { BadRequest, stripQuery } from "../providers/validation";
import type { ExecuteItem, ExecuteJob, ExecutorMode } from "./types";

export const EXECUTE_LIMITS = {
  executeBodyBytes: 1_000_000,
  compileBodyBytes: 256_000,
  items: 200,
  steps: 100,
  varsPerItem: 50,
  varValue: 2000,
  confirmToken: 200,
} as const;

const FIELD_KINDS: ReadonlySet<string> = new Set<FieldKind>([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox", "file", "button", "link", "other",
]);
const LOCATOR_KINDS: ReadonlySet<string> = new Set<FactLocator["by"]>(["testid", "data-field", "id", "label", "css"]);
// The same closed list /v1/loop/synthesize emits, so a program the LLM helped with can run in every mode.
const TRANSFORMS: ReadonlySet<string> = new Set<LoopTransform>(LOOP_TRANSFORMS);
const MODES: ReadonlySet<string> = new Set<ExecutorMode>(["parallel", "api"]);
const VAR_NAME = /^[A-Za-z][\w.-]{0,63}$/;

// Messages name the offending path only, never a value (same rule as providers/validation.ts).

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BadRequest(`${path} must be an object`);
  return value;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new BadRequest(`${path} must be an array`);
  if (value.length > max) throw new BadRequest(`${path} must have at most ${max} items`);
  return value;
}

function str(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new BadRequest(`${path} must be a non-empty string`);
  if (value.length > max) throw new BadRequest(`${path} must be at most ${max} characters`);
  return value;
}

function optionalStr(value: unknown, path: string, max: number): string | undefined {
  return value === undefined || value === null ? undefined : str(value, path, max);
}

function int(value: unknown, path: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw new BadRequest(`${path} must be an integer of at least ${min}`);
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: ReadonlySet<string>): T {
  if (typeof value !== "string" || !allowed.has(value)) throw new BadRequest(`${path} must be one of: ${[...allowed].join(", ")}`);
  return value as T;
}

/** "constructor", "toString", "valueOf"...: a lookup of such a name on a plain object finds an inherited function, not a missing value. */
function varName(value: unknown, path: string): string {
  if (typeof value !== "string" || !VAR_NAME.test(value) || value in Object.prototype) throw new BadRequest(`${path} is not a valid var name`);
  return value;
}

/** http(s) only, and only origin + path: query strings and fragments can carry personal data. */
function httpUrl(value: unknown, path: string): string {
  const raw = stripQuery(str(value, path, 2000));
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {
    // reported below
  }
  throw new BadRequest(`${path} must be an http(s) URL`);
}

function defined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key];
  return value;
}

function parseTarget(raw: unknown, path: string): StepTarget {
  const target = object(raw, path);
  const cell = target.cell == null ? undefined : object(target.cell, `${path}.cell`);
  if (cell && cell.row !== "next-empty") throw new BadRequest(`${path}.cell.row must be "next-empty"`);
  return defined<StepTarget>({
    signature: optionalStr(target.signature, `${path}.signature`, 300),
    label: str(target.label, `${path}.label`, 300),
    kind: oneOf<FieldKind>(target.kind, `${path}.kind`, FIELD_KINDS),
    cell: cell ? { row: "next-empty", colHeader: str(cell.colHeader, `${path}.cell.colHeader`, 200) } : undefined,
  });
}

function parsePage(raw: unknown, path: string): StepPage | undefined {
  if (raw === undefined || raw === null) return undefined;
  const page = object(raw, path);
  return { origin: new URL(httpUrl(page.origin, `${path}.origin`)).origin, pathPattern: str(page.pathPattern, `${path}.pathPattern`, 500) };
}

function parseStep(raw: unknown, path: string): LoopStep {
  const step = object(raw, path);
  switch (step.op) {
    case "open-item":
      return { op: "open-item" };
    case "extract": {
      const from = object(step.from, `${path}.from`);
      const locator = object(from.locator, `${path}.from.locator`);
      return {
        op: "extract",
        var: varName(step.var, `${path}.var`),
        from: defined({
          pathPattern: str(from.pathPattern, `${path}.from.pathPattern`, 500),
          locator: { by: oneOf<FactLocator["by"]>(locator.by, `${path}.from.locator.by`, LOCATOR_KINDS), value: str(locator.value, `${path}.from.locator.value`, 500) },
          transform: from.transform == null ? undefined : oneOf<LoopTransform>(from.transform, `${path}.from.transform`, TRANSFORMS),
        }),
      };
    }
    case "goto": {
      const url = httpUrl(step.url, `${path}.url`);
      return { op: "goto", origin: new URL(url).origin, pathPattern: str(step.pathPattern, `${path}.pathPattern`, 500), url };
    }
    case "fill": {
      const target = parseTarget(step.target, `${path}.target`);
      if (isSensitive({ label: target.label })) throw new BadRequest(`${path}.target.label looks sensitive; Shabang never fills sensitive fields`);
      if (target.kind === "button" || target.kind === "link" || target.kind === "file") throw new BadRequest(`${path}.target.kind cannot be filled`);
      const value = object(step.value, `${path}.value`);
      const parsed = typeof value.const === "string" ? { const: value.const.slice(0, EXECUTE_LIMITS.varValue) } : { var: varName(value.var, `${path}.value.var`) };
      return defined<Extract<LoopStep, { op: "fill" }>>({ op: "fill", target, value: parsed, at: parsePage(step.at, `${path}.at`), locked: step.locked === true ? true : undefined });
    }
    case "click": {
      if (typeof step.locked !== "boolean") throw new BadRequest(`${path}.locked must be a boolean`);
      return defined<Extract<LoopStep, { op: "click" }>>({ op: "click", target: parseTarget(step.target, `${path}.target`), locked: step.locked, at: parsePage(step.at, `${path}.at`) });
    }
    default:
      throw new BadRequest(`${path}.op must be one of: open-item, extract, goto, fill, click`);
  }
}

function parseIterator(raw: unknown): LoopIterator {
  const it = object(raw, "program.iterator");
  const stride = int(it.stride, "program.iterator.stride", Number.MIN_SAFE_INTEGER);
  if (stride === 0) throw new BadRequest("program.iterator.stride must not be 0");
  return defined<LoopIterator>({
    origin: new URL(httpUrl(it.origin, "program.iterator.origin")).origin,
    pathPattern: str(it.pathPattern, "program.iterator.pathPattern", 500),
    listSignature: str(it.listSignature, "program.iterator.listSignature", 500),
    stride,
    nextIndex: int(it.nextIndex, "program.iterator.nextIndex", 0),
    total: it.total == null ? undefined : int(it.total, "program.iterator.total", 0),
    itemPathPattern: optionalStr(it.itemPathPattern, "program.iterator.itemPathPattern", 500),
  });
}

/** `unresolved` is dropped on purpose: an executor only needs the steps, and an item either carries the var or fails. */
export function parseProgram(raw: unknown): LoopProgram {
  const program = object(raw, "program");
  const steps = array(program.steps, "program.steps", EXECUTE_LIMITS.steps).map((s, i) => parseStep(s, `program.steps[${i}]`));
  if (steps.length === 0) throw new BadRequest("program.steps must not be empty");
  const irreversible = array(program.irreversible ?? [], "program.irreversible", EXECUTE_LIMITS.steps).map((e, i) => {
    const effect = object(e, `program.irreversible[${i}]`);
    const stepIndex = int(effect.stepIndex, `program.irreversible[${i}].stepIndex`, 0);
    if (stepIndex >= steps.length) throw new BadRequest(`program.irreversible[${i}].stepIndex is not a step of the program`);
    return { stepIndex, description: str(effect.description, `program.irreversible[${i}].description`, 300) };
  });
  const confidence = program.confidence;
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) throw new BadRequest("program.confidence must be a number from 0 to 1");
  return { id: str(program.id, "program.id", 100), name: str(program.name, "program.name", 300), iterator: parseIterator(program.iterator), steps, irreversible, confidence };
}

export function parseCompileRequest(body: unknown): LoopProgram {
  return parseProgram(object(body, "body").program);
}

function parseVars(raw: unknown, path: string): Record<string, string> {
  const entries = Object.entries(raw == null ? {} : object(raw, path));
  if (entries.length > EXECUTE_LIMITS.varsPerItem) throw new BadRequest(`${path} must have at most ${EXECUTE_LIMITS.varsPerItem} entries`);
  // No prototype (so no inherited names) and sorted keys (so the same vars always hash to the same confirmation token).
  const vars = Object.create(null) as Record<string, string>;
  for (const [name, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    varName(name, `${path} key`);
    // Rejected, not clipped: a silently shortened value would be written into someone's sheet.
    if (typeof value !== "string" || value.length > EXECUTE_LIMITS.varValue) throw new BadRequest(`${path}.${name} must be a string of at most ${EXECUTE_LIMITS.varValue} characters`);
    if (!isSensitive({ name })) vars[name] = value;
  }
  return vars;
}

export interface ExecuteRequest {
  mode: ExecutorMode;
  job: ExecuteJob;
  /** Only on /v1/loop/execute: the single-use token /v1/loop/preview issued for exactly this mode, program, items and baseUrl. */
  confirmToken?: string;
}

/**
 * Every page a step names must be on the recorded site or on a site the program itself navigates to (`goto`):
 * a fill or click can never be pointed at an origin the user was not shown in the preview.
 */
function checkOrigins(program: LoopProgram, baseUrl: string): void {
  if (program.iterator.origin !== baseUrl) throw new BadRequest("program.iterator.origin must be baseUrl");
  const recorded = new Set([baseUrl, ...program.steps.flatMap((step) => (step.op === "goto" ? [step.origin] : []))]);
  program.steps.forEach((step, i) => {
    if ((step.op === "fill" || step.op === "click") && step.at && !recorded.has(step.at.origin)) {
      throw new BadRequest(`program.steps[${i}].at.origin must be baseUrl or the origin of a goto step`);
    }
  });
}

/** Shared by /v1/loop/preview and /v1/loop/execute: both must parse to the same job for the confirmation token to match. */
export function parseExecuteRequest(body: unknown): ExecuteRequest {
  const req = object(body, "body");
  const mode = oneOf<ExecutorMode>(req.mode, "mode", MODES);
  const confirmToken = optionalStr(req.confirmToken, "confirmToken", EXECUTE_LIMITS.confirmToken);
  const baseUrl = new URL(httpUrl(req.baseUrl, "baseUrl")).origin;
  const rawItems = array(req.items, "items", EXECUTE_LIMITS.items);
  if (rawItems.length === 0) throw new BadRequest("items must not be empty");
  const seen = new Set<number>();
  const items = rawItems.map((raw, i): ExecuteItem => {
    const item = object(raw, `items[${i}]`);
    const index = int(item.index, `items[${i}].index`, 0);
    if (seen.has(index)) throw new BadRequest(`items[${i}].index is a duplicate`);
    seen.add(index);
    const url = httpUrl(item.url, `items[${i}].url`);
    // An item can only ever open a page of the site the loop was recorded on.
    if (new URL(url).origin !== baseUrl) throw new BadRequest(`items[${i}].url must be on baseUrl`);
    return { index, url, vars: parseVars(item.vars, `items[${i}].vars`) };
  });
  const program = parseProgram(req.program);
  checkOrigins(program, baseUrl);
  // `confirmIrreversible` in a body is ignored on purpose: a caller cannot confirm its own batch (see routes/execute.ts).
  return defined<ExecuteRequest>({ mode, job: { program, items, confirmIrreversible: false, baseUrl }, confirmToken });
}
