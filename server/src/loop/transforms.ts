import { applyTransform, matchesUnder, type FactLocator, type LoopProgram, type LoopStep, type ValueTransform } from "@shabang/shared";

/**
 * The CLOSED list a model may pick from. The first three are the shared heuristic's transforms; the rest only ever
 * enter a program through /v1/loop/synthesize, after code verified them against both runs.
 */
export const LOOP_TRANSFORMS = ["trim", "number", "date-iso", "lowercase", "uppercase", "first-word", "last-word", "digits-only"] as const;
export type LoopTransform = (typeof LOOP_TRANSFORMS)[number];

/** Verification order: the weakest transform that reproduces both values wins. `undefined` means "copy as is". */
export const TRANSFORM_ORDER: readonly (LoopTransform | undefined)[] = [undefined, ...LOOP_TRANSFORMS];

const SHARED_TRANSFORMS: ReadonlySet<string> = new Set<ValueTransform>(["trim", "number", "date-iso"]);

export type ServerExtractStep = { op: "extract"; var: string; from: { pathPattern: string; locator: FactLocator; transform?: LoopTransform } };
export type ServerLoopStep = Exclude<LoopStep, { op: "extract" }> | ServerExtractStep;
/** A LoopProgram whose extract steps may carry one of the extended transforms. */
export type ServerLoopProgram = Omit<LoopProgram, "steps"> & { steps: ServerLoopStep[] };

export function isLoopTransform(value: unknown): value is LoopTransform {
  return typeof value === "string" && (LOOP_TRANSFORMS as readonly string[]).includes(value);
}

function isShared(transform: LoopTransform): transform is ValueTransform {
  return SHARED_TRANSFORMS.has(transform);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function orNull(text: string): string | null {
  return text === "" ? null : text;
}

/**
 * What an executor writes for a fact's text. Null when the text cannot be transformed. Pure, so it can move to shared as is.
 * A transform outside the closed list answers null: the shared applyTransform would silently read it as a date.
 */
export function applyLoopTransform(text: string, transform: LoopTransform | undefined): string | null {
  if (transform !== undefined && !isLoopTransform(transform)) return null;
  if (transform === undefined || isShared(transform)) return applyTransform(text, transform);
  const flat = collapse(text);
  const words = flat === "" ? [] : flat.split(" ");
  switch (transform) {
    case "lowercase":
      return orNull(flat.toLowerCase());
    case "uppercase":
      return orNull(flat.toUpperCase());
    case "first-word":
      // "Chen, Alex" -> "Chen": the separator after the first word is not part of it.
      return orNull((words[0] ?? "").replace(/[,;:]+$/, ""));
    case "last-word":
      return orNull(words[words.length - 1] ?? "");
    case "digits-only":
      return orNull(flat.replace(/\D/g, ""));
  }
}

/**
 * Does `factText` reproduce what the user typed under this transform? The shared transforms keep the heuristic's own
 * matching rules (the extension runs the same code); the extended ones must reproduce the typed text exactly.
 */
export function reproduces(typed: string, factText: string, transform: LoopTransform | undefined): boolean {
  if (typed.trim() === "" || factText.trim() === "") return false;
  if (transform === undefined) return matchesUnder(typed, factText, "exact");
  if (isShared(transform)) return matchesUnder(typed, factText, transform);
  return applyLoopTransform(factText, transform) === collapse(typed);
}
