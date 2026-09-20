import type { FieldKind } from "../types";

export type TraceEventType = "click" | "input" | "select" | "check" | "navigate" | "tabswitch" | "submit";

/** Value recorded when a field became sensitive after capture. Never generalized, never replayed. */
export const MASKED_VALUE = "•••";

export interface TraceListRef {
  listSignature: string;
  index: number;
  itemKey: string;
}

export interface TraceCellRef {
  row: number;
  col: number;
  colHeader: string;
}

export interface TraceTarget {
  /** capture.ts signature */
  signature: string;
  /** Accessible name. Sensitive fields are never recorded at all. */
  label: string;
  kind: FieldKind;
  locked: boolean;
  /** Set when the element sits inside a repeated list/table: stable list selector plus the item's index and key text. */
  list?: TraceListRef;
  /** Grid coordinates when the target is a cell in a table/grid. */
  cell?: TraceCellRef;
}

export interface TraceEvent {
  /** epoch ms */
  t: number;
  tabId: number;
  type: TraceEventType;
  origin: string;
  /** Pathname with volatile segments generalized: /invoices/INV-1042 -> /invoices/:id */
  pathPattern: string;
  /** origin + pathname only, never query strings or fragments */
  url: string;
  target?: TraceTarget;
  /** Final value of an input/select (one event per field edit). MASKED_VALUE if the field became sensitive. */
  value?: string;
  /** Shabang's own programmatic action: ignored by the loop detector, kept for episodic memory. */
  synthetic?: boolean;
}

export type FactLocator =
  | { by: "testid" | "data-field" | "id"; value: string }
  | { by: "label"; value: string }
  | { by: "css"; value: string };

/** A visible labeled value on a page that a user could plausibly copy. */
export interface PageFact {
  locator: FactLocator;
  label: string;
  text: string;
}

/** Latest facts per normalized url (origin + pathname). */
export type FactsByUrl = Record<string, PageFact[]>;
