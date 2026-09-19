import type { FieldKind } from "../types";
import type { FactLocator, TraceEvent } from "../trace/types";

/** Two aligned, consecutive runs of the same key sequence at the tail of the trace. */
export interface LoopCandidate {
  length: number;
  runA: TraceEvent[];
  runB: TraceEvent[];
}

export type ValueTransform = "number" | "date-iso" | "trim";

export interface LoopIterator {
  origin: string;
  /** Page that shows the list. */
  pathPattern: string;
  listSignature: string;
  stride: number;
  nextIndex: number;
  total?: number;
  /** Optional hint beyond docs/loops.md: the page an item opens into (e.g. /invoices/:id). */
  itemPathPattern?: string;
}

/** Optional hint beyond docs/loops.md: the page a fill or click happens on, so an executor can route steps across pages. */
export interface StepPage {
  origin: string;
  pathPattern: string;
}

export type StepTarget = {
  signature?: string;
  label: string;
  kind: FieldKind;
  cell?: { row: "next-empty"; colHeader: string };
};

export type LoopStep =
  | { op: "open-item" }
  | { op: "extract"; var: string; from: { pathPattern: string; locator: FactLocator; transform?: ValueTransform } }
  | { op: "goto"; origin: string; pathPattern: string; url: string }
  /** `locked` (beyond docs/loops.md): the field itself is a locked target, e.g. an auto-saving control, so the fill is listed as irreversible. */
  | { op: "fill"; target: StepTarget; value: { var: string } | { const: string }; at?: StepPage; locked?: boolean }
  | { op: "click"; target: StepTarget; locked: boolean; at?: StepPage };

/** A fill whose differing values no page fact explains in both runs. Its var has no extract step. */
export interface UnresolvedStep {
  stepIndex: number;
  var: string;
  label: string;
  valueA: string;
  valueB: string;
}

export interface LoopProgram {
  id: string;
  name: string;
  iterator: LoopIterator;
  steps: LoopStep[];
  /** From locked targets. */
  irreversible: Array<{ stepIndex: number; description: string }>;
  confidence: number;
  /** Steps the heuristics could not generalize: ask /v1/loop/synthesize or flag the rows low-confidence. */
  unresolved?: UnresolvedStep[];
}
