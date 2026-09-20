// The knowledge layer (docs/knowledge.md): a model of ONE PERSON that any predictor can query, on any surface,
// in a browser or in a native app.
//
// Three kinds of knowledge, one file, one API:
//   facts     — what this person puts in a field like this   (shared/src/facts, matched by label, never by key name)
//   surfaces  — what they use, and how much                  (counts and hour buckets, never a page they visited)
//   habits    — here, after that, what they do next          (counters keyed by screen KIND, so they generalize)
//
// The hard rule that keeps it honest: NOTHING in this module names a website, an app, a bundle id or a brand. A
// surface is an opaque grouping key, a screen kind is a shape, and every behaviour is learned and generalized by
// shape. That is the whole difference between "it is good at job forms" and "it works anywhere you go".
//
// Everything stays on the machine. Only fact KEYS ever reach the prediction server, and nothing here holds page
// text, a title, a URL beyond the opaque surface id, a file path or any value the user typed.
import { graphFromJSON, graphToJSON, emptyGraph, pruneRejected } from "../facts/graph";
import type { CapturedField } from "../types";
import type { Context } from "./context";
import { HabitStore, KNOWLEDGE_SCHEMA_VERSION } from "./habits";
import type { KnowledgeGraph, Outcome } from "./habits";
import { matchFactsForField, rankActions, recordOutcome, recordReplacement, recordVisit } from "./rank";
import type { ActionLike, FieldFactMatch, RankOptions, RankedAction } from "./rank";

export * from "./screenKind";
export * from "./context";
export * from "./habits";
export * from "./rank";
export * from "./seed";

/** An unambiguous alias, for callers that already have a `Context` of their own. */
export type KnowledgeContext = Context;

/** docs/storage.md section 1: a brain you can read in a text editor and delete in one click. */
export const KNOWLEDGE_TARGET_BYTES = 200_000;
export const KNOWLEDGE_MAX_BYTES = 1_000_000;

export function emptyKnowledge(now = new Date().toISOString()): KnowledgeGraph {
  return { version: KNOWLEDGE_SCHEMA_VERSION, facts: emptyGraph(now), habits: new HabitStore() };
}

/** The stored shape: the facts section exactly as the facts module writes it, plus the habit counters. */
export function knowledgeToJSON(graph: KnowledgeGraph): string {
  const facts: unknown = JSON.parse(graphToJSON(graph.facts));
  return JSON.stringify({ version: KNOWLEDGE_SCHEMA_VERSION, facts, habits: graph.habits.toJSON() });
}

/** Never throws: a corrupt or foreign file yields an empty brain rather than a broken client. */
export function knowledgeFromJSON(text: string, now = new Date().toISOString()): KnowledgeGraph {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyKnowledge(now);
  }
  if (typeof raw !== "object" || raw === null) return emptyKnowledge(now);
  const record = raw as Record<string, unknown>;
  const facts = record.facts === undefined ? emptyGraph(now) : graphFromJSON(JSON.stringify(record.facts), now);
  const habits = HabitStore.fromJSON(record.habits as never);
  return { version: KNOWLEDGE_SCHEMA_VERSION, facts, habits };
}

/** What the file would weigh right now, in bytes. The options page shows it; the writer enforces it. */
export function knowledgeSizeBytes(graph: KnowledgeGraph): number {
  const text = knowledgeToJSON(graph);
  return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length;
}

/** Pruning, in the order docs/storage.md gives. Runs before a write, so the file never grows past its cap. */
export function pruneKnowledge(graph: KnowledgeGraph, today: Date | number | string = new Date()): { habits: number; rejected: number; bytes: number } {
  const pruned = pruneRejected(graph.facts, typeof today === "string" ? today : new Date(today).toISOString());
  graph.facts = pruned.graph;
  const habits = graph.habits.prune(today);
  return { habits, rejected: pruned.dropped, bytes: knowledgeSizeBytes(graph) };
}

/** "Forget this surface": every habit learned there goes, and nothing else moves (docs/storage.md section 4). */
export function forgetSurface(graph: KnowledgeGraph, surface: string): number {
  return graph.habits.forgetSurface(surface);
}

/**
 * The API exactly as docs/knowledge.md section 5 writes it, bound to one graph. The browser ranker and the native
 * agent hold one of these and never touch a store directly.
 */
export interface Knowledge {
  graph: KnowledgeGraph;
  rankActions(context: Context, options?: RankOptions): RankedAction[];
  matchFactsForField(field: CapturedField): FieldFactMatch[];
  recordOutcome(context: Context, action: ActionLike, outcome: Outcome): void;
  recordReplacement(context: Context, proposed: ActionLike, actual: ActionLike): void;
  recordVisit(context: Context): void;
}

export function bindKnowledge(graph: KnowledgeGraph): Knowledge {
  return {
    graph,
    rankActions: (context, options) => rankActions(context, graph, options),
    matchFactsForField: (field) => matchFactsForField(field, graph),
    recordOutcome: (context, action, outcome) => recordOutcome(graph, context, action, outcome),
    recordReplacement: (context, proposed, actual) => recordReplacement(graph, context, proposed, actual),
    recordVisit: (context) => recordVisit(graph, context),
  };
}
