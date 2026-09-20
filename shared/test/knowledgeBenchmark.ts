// The before-and-after benchmark (docs/knowledge.md section 6). The table this produces IS the deliverable:
// proof that one small local graph of habits changes what Ghost proposes, on any screen, without a single rule
// that names a site or an app.
//
// It is a harness, not a test: `shared/test/knowledge.benchmark.test.ts` asserts on it and
// `scripts/bench-knowledge.mjs` prints it. It is scanned by knowledge.privacy.test.ts like every other file in
// the layer, so nothing here may name a place either.
//
// Three conditions, per screen:
//   1. EMPTY      — a graph that knows nothing. The shape-only prior alone decides.
//   2. COLD START — what the first-run local scan could know: how this person behaves on screens of each KIND,
//                   learned from browser history on OTHER places, through the real pipeline
//                   (`aggregateHabits` -> `seedFromColdStart`). It never carries any screen's own answer.
//   3. LEARNED    — after five simulated sessions on the screen itself, with the ranker in the loop: Ghost
//                   proposes, the scripted person accepts it or does something else, and the graph learns.
import {
  PREVIOUS_NONE,
  SCAN_SURFACE,
  aggregateHabits,
  emptyKnowledge,
  knowledgeSizeBytes,
  rankActions,
  recordOutcome,
  recordReplacement,
  recordVisit,
  seedFromColdStart,
  webContext,
} from "../src";
import type { ActionRole, Context, HistoryRow, KnowledgeGraph, RankTier, ScreenKind } from "../src";
import { allSurfaces } from "./helpers/knowledgeFixtures";
import type { SurfaceFixture } from "./helpers/knowledgeFixtures";

/** The day the table is measured on, and the five days before it that the person used these screens. */
export const NOW = "2026-09-19T12:00:00.000Z";
const FIRST_DAY = 15;
export const SESSIONS = 5;

/**
 * How the scripted person behaves on one screen.
 *
 *   consistent — the same action every session, and it is what they do on screens of this kind generally;
 *   noisy      — usually that action, sometimes something else entirely;
 *   unusual    — the same action every session, and it contradicts BOTH the shape prior and their own habit on
 *                screens of this kind. Nothing but learning this screen can get it right.
 */
export type Persona = "consistent" | "noisy" | "unusual";

export interface SessionScript {
  persona: Persona;
  /** The action this person actually wants here: what the benchmark measures the rank of. */
  wants: string;
  /** Plain words for the table. Structure and generic UI English only: never a place. */
  note: string;
  /** Five sessions. Each is the ordered list of candidate ids the person acts on during that visit. */
  sessions: readonly (readonly string[])[];
}

/**
 * What this person does on a KIND of screen, wherever they are. This is the only thing the cold-start scan can
 * learn, because history knows what kind of page was open and what was done there, never which control a
 * particular screen offers. Kinds not listed are ones the scan has no opinion about.
 *
 * Three screens below deviate from it on purpose (the `unusual` persona): that is what separates "Ghost knows
 * this person" from "Ghost knows this screen".
 */
export const KIND_HABITS: Partial<Record<ScreenKind, ActionRole>> = {
  feed: "primary-item",
  media: "fullscreen",
  list: "primary-item",
  reader: "search",
  commerce: "cart",
  settings: "search",
  editor: "save",
  board: "cell",
  form: "field",
};

/** Kinds whose habit the history pipeline cannot express, because its page-kind vocabulary has no word for them. */
export const KINDS_HISTORY_CANNOT_EXPRESS: readonly ScreenKind[] = ["settings", "editor", "board"];

/**
 * One scripted person, over sixteen screens. Ids are the fixtures' own candidate ids: a script that names an id
 * the screen does not offer fails loudly rather than quietly measuring nothing.
 */
export const SCRIPTS: Readonly<Record<string, SessionScript>> = {
  s01: {
    persona: "unusual",
    wants: "fav-0",
    note: "favourites the top card instead of opening it",
    sessions: [["fav-0"], ["fav-0"], ["fav-0", "item-0"], ["fav-0"], ["fav-0", "item-1"]],
  },
  s02: {
    persona: "noisy",
    wants: "item-0",
    note: "usually opens the top post, sometimes only reacts",
    sessions: [["item-0"], ["react-0"], ["item-0", "react-0"], ["search", "item-0"], ["item-0"]],
  },
  s03: {
    persona: "unusual",
    wants: "compose",
    note: "opens this list to write, never to read",
    sessions: [["compose"], ["compose"], ["compose", "item-0"], ["compose"], ["compose"]],
  },
  s04: {
    persona: "unusual",
    wants: "archive",
    note: "files the thread away rather than answering it",
    sessions: [["archive"], ["archive"], ["archive"], ["archive"], ["archive"]],
  },
  s05: {
    persona: "noisy",
    wants: "item-0",
    note: "usually opens the first tile, sometimes searches first",
    sessions: [["item-0"], ["item-0"], ["search"], ["item-0"], ["search", "item-0"]],
  },
  s06: {
    persona: "consistent",
    wants: "fullscreen",
    note: "goes full screen every time",
    sessions: [["fullscreen"], ["fullscreen", "captions"], ["fullscreen"], ["fullscreen"], ["fullscreen", "next"]],
  },
  s07: {
    persona: "consistent",
    wants: "search",
    note: "never reads down the page: goes to the search box",
    sessions: [["search"], ["search"], ["search", "nav-0"], ["search"], ["search"]],
  },
  s08: {
    persona: "consistent",
    wants: "add",
    note: "puts the item in the basket",
    sessions: [["add"], ["qty", "add"], ["add"], ["add"], ["add"]],
  },
  s09: {
    persona: "noisy",
    wants: "checkout",
    note: "usually checks out, sometimes edits a line and leaves",
    sessions: [["checkout"], ["qty-0", "checkout"], ["checkout"], ["remove-0"], ["checkout"]],
  },
  s10: {
    persona: "noisy",
    wants: "next",
    note: "usually skips ahead, sometimes shuffles the queue",
    sessions: [["next"], ["next"], ["shuffle"], ["item-3", "next"], ["next"]],
  },
  s11: {
    persona: "consistent",
    wants: "cell-0",
    note: "plays a square (a different one each time)",
    sessions: [["cell-0"], ["cell-3"], ["cell-5"], ["cell-2"], ["cell-7"]],
  },
  s12: {
    persona: "consistent",
    wants: "search",
    note: "searches for the switch instead of hunting down the pane",
    sessions: [["search"], ["search", "toggle-0"], ["search"], ["search", "toggle-3"], ["search"]],
  },
  s13: {
    persona: "consistent",
    wants: "save",
    note: "saves what they wrote",
    sessions: [["save"], ["save"], ["save", "share"], ["save"], ["save"]],
  },
  s14: {
    persona: "noisy",
    wants: "item-0",
    note: "usually opens the top row, sometimes makes a folder",
    sessions: [["item-0"], ["item-0"], ["newfolder"], ["item-0"], ["search", "item-0"]],
  },
  s15: {
    persona: "consistent",
    wants: "field-0",
    note: "starts at the first field and walks down",
    sessions: [
      ["field-0", "field-1", "submit"],
      ["field-0", "field-1", "agree", "submit"],
      ["field-0"],
      ["field-0", "field-1", "submit"],
      ["field-0", "field-1"],
    ],
  },
  s16: {
    persona: "consistent",
    wants: "btn-a",
    note: "presses the left control, whatever it is",
    sessions: [["btn-a"], ["btn-a"], ["btn-a"], ["btn-a"], ["btn-a"]],
  },
};

/**
 * Session `index`, one per day on the five days before the day the table is measured on. Local midday, so the
 * four-hour bucket and the day are the same wherever this runs.
 */
function sessionAt(index: number): Date {
  return new Date(2026, 8, FIRST_DAY + (index % SESSIONS), 12, 0);
}

function contextFor(fixture: SurfaceFixture, previousAction: ActionRole | undefined, at: Date): Context {
  return webContext({
    surface: fixture.surface,
    candidates: fixture.candidates,
    screen: fixture.tree,
    at,
    ...(fixture.state ? { state: fixture.state } : {}),
    ...(previousAction ? { previousAction } : {}),
    ...(fixture.mainListSignature !== undefined ? { mainListSignature: fixture.mainListSignature } : {}),
  });
}

/** The context the table is measured in: the screen as it opens, on the day the benchmark is run. */
export function openingContext(fixture: SurfaceFixture): Context {
  return contextFor(fixture, fixture.previousAction, new Date(2026, 8, FIRST_DAY + SESSIONS - 1, 12, 0));
}

// ---------- condition 2: the cold-start scan ----------

/**
 * The history a scan would find: six evenings on each of two places per screen kind, with the role this person
 * reaches for there. Hosts are opaque tokens under the reserved `.invalid` suffix, which cannot be a real name —
 * the aggregator only requires a dotted host, and nothing downstream ever parses one.
 */
function historyRows(): HistoryRow[] {
  const paths: Partial<Record<ScreenKind, string>> = {
    feed: "/feed",
    media: "/watch",
    list: "/inbox",
    reader: "/article",
    commerce: "/product",
    form: "/signup",
  };
  const rows: HistoryRow[] = [];
  for (const [kind, role] of Object.entries(KIND_HABITS) as [ScreenKind, ActionRole][]) {
    const path = paths[kind];
    if (path === undefined) continue; // no word for this kind in the history vocabulary; seeded below instead.
    for (let place = 0; place < 2; place += 1) {
      for (let visit = 0; visit < 4; visit += 1) {
        rows.push({
          origin: `p${kind.slice(0, 2)}${place}.invalid`,
          pathPattern: path,
          visitedAt: Date.UTC(2026, 7, 10 + visit, 20, 0),
          actionsAfterArrival: [{ role: role as never, count: 2 }],
        });
      }
    }
  }
  return rows;
}

export interface ColdStartFacts {
  /** Rows the scan aggregated, and what came out of them. */
  rows: number;
  origins: number;
  seededSurfaces: number;
  seededHabits: number;
  observations: number;
  /** Kinds seeded directly because the history vocabulary has no word for them. */
  seededByHand: readonly ScreenKind[];
}

/**
 * Day one: the scan's aggregates, through the same adapter the native agent uses. Nothing in here is keyed to a
 * screen in the benchmark — only to a KIND of screen — so the middle column is generalization and not a memory
 * of the answer.
 */
export function coldStartGraph(): { graph: KnowledgeGraph; facts: ColdStartFacts } {
  const graph = emptyKnowledge(NOW);
  const rows = historyRows();
  const aggregate = aggregateHabits(rows, { minVisits: 3, timeZoneOffsetMinutes: 0 });
  const seeded = seedFromColdStart(graph, aggregate, NOW);

  // The three kinds a browser history cannot name: a settings pane, an editor and a board are shapes a native
  // window has and a URL path does not. A window scan would seed them the same way, so they are recorded here on
  // the same reserved scan surface, with the same counts.
  for (const kind of KINDS_HISTORY_CANNOT_EXPRESS) {
    const role = KIND_HABITS[kind];
    if (!role) continue;
    graph.habits.record({ surface: SCAN_SURFACE, screenKind: kind, previousAction: PREVIOUS_NONE, action: role }, "taken", {
      at: NOW,
      count: 8,
    });
  }
  return {
    graph,
    facts: {
      rows: rows.length,
      origins: aggregate.origins.length,
      seededSurfaces: seeded.surfaces,
      seededHabits: graph.habits.size,
      observations: seeded.observations,
      seededByHand: KINDS_HISTORY_CANNOT_EXPRESS,
    },
  };
}

// ---------- condition 3: five sessions, with the ranker in the loop ----------

export interface SessionLog {
  surface: string;
  /** How often Ghost's top proposal was the control the person then used. */
  accepted: number;
  /** How often they used a different control instead. */
  otherControl: number;
  /** Of those, how often it was a different KIND of control: the only ones that demote what was proposed. */
  otherRole: number;
  actions: number;
}

/**
 * Play the script. Ghost proposes, the person acts, and every outcome is recorded exactly as a client would
 * record it: an accepted proposal is `taken`, and anything else is a replacement, which demotes what was
 * proposed and teaches what was chosen in one call.
 */
export function playSessions(graph: KnowledgeGraph, fixture: SurfaceFixture, script: SessionScript, cycles = 1): SessionLog {
  const log: SessionLog = { surface: fixture.surface, accepted: 0, otherControl: 0, otherRole: 0, actions: 0 };
  const plan = Array.from({ length: Math.max(1, cycles) }, () => script.sessions).flat();
  for (const [index, session] of plan.entries()) {
    const at = sessionAt(index);
    let previous = fixture.previousAction;
    let context = contextFor(fixture, previous, at);
    recordVisit(graph, context, at);
    for (const id of session) {
      const chosen = context.candidates.find((candidate) => candidate.id === id);
      if (!chosen) throw new Error(`benchmark: ${fixture.surface} has no candidate "${id}"`);
      const top = rankActions(context, graph, { now: at })[0];
      log.actions += 1;
      if (top && top.id !== id) {
        log.otherControl += 1;
        if (top.role !== chosen.role) log.otherRole += 1;
        recordReplacement(graph, context, top.id, id, { at });
      } else {
        log.accepted += 1;
        recordOutcome(graph, context, id, "taken", { at });
      }
      previous = chosen.role;
      context = contextFor(fixture, previous, at);
    }
  }
  return log;
}

// ---------- measuring ----------

export interface Measurement {
  /** Where the action this person wants came in the ranking. 1 is the top proposal. */
  rank: number;
  /** What the top proposal was leaning on: a learned habit (`surface`/`kind`) or the shape alone. */
  topTier: RankTier;
  topScore: number;
}

export type ConditionName = "empty" | "cold" | "learned";

export interface BenchmarkRow {
  surface: string;
  shape: string;
  kind: ScreenKind;
  persona: Persona;
  note: string;
  candidates: number;
  empty: Measurement;
  cold: Measurement;
  learned: Measurement;
  log: SessionLog;
}

export interface ConditionTotals {
  topOne: number;
  meanRank: number;
  /** How many of the top proposals came from a learned habit, and how many from the shape prior alone. */
  learnedTop: number;
  priorTop: number;
}

export interface BenchmarkResult {
  rows: BenchmarkRow[];
  totals: Record<ConditionName, ConditionTotals>;
  coldStart: ColdStartFacts;
  /** The whole brain after the benchmark, in bytes. */
  sizeBytes: number;
  sessions: number;
}

function measure(fixture: SurfaceFixture, script: SessionScript, graph: KnowledgeGraph): Measurement {
  const rows = rankActions(openingContext(fixture), graph, { now: NOW });
  const rank = rows.findIndex((row) => row.id === script.wants) + 1;
  if (rank === 0) throw new Error(`benchmark: ${fixture.surface} did not rank "${script.wants}" at all`);
  const top = rows[0];
  return { rank, topTier: top?.tier ?? "guess", topScore: top?.score ?? 0 };
}

function scriptFor(fixture: SurfaceFixture): SessionScript {
  const script = SCRIPTS[fixture.surface];
  if (!script) throw new Error(`benchmark: no session script for ${fixture.surface}`);
  return script;
}

function totalsOf(rows: readonly BenchmarkRow[], condition: ConditionName): ConditionTotals {
  const learnedTop = rows.filter((row) => row[condition].topTier === "surface" || row[condition].topTier === "kind").length;
  return {
    topOne: rows.filter((row) => row[condition].rank === 1).length,
    meanRank: rows.reduce((sum, row) => sum + row[condition].rank, 0) / (rows.length || 1),
    learnedTop,
    priorTop: rows.length - learnedTop,
  };
}

export interface BenchmarkOptions {
  /** Play the five-session script this many times over, for the convergence check. One by default. */
  cycles?: number;
}

/** Run all three conditions over every screen. Pure: same numbers every time, on any machine. */
export function runBenchmark(options: BenchmarkOptions = {}): BenchmarkResult {
  const cycles = Math.max(1, Math.floor(options.cycles ?? 1));
  const fixtures = allSurfaces();
  const empty = emptyKnowledge(NOW);
  const cold = coldStartGraph();
  const learned = coldStartGraph().graph;

  const logs = new Map<string, SessionLog>();
  for (const fixture of fixtures) logs.set(fixture.surface, playSessions(learned, fixture, scriptFor(fixture), cycles));

  const rows = fixtures.map((fixture): BenchmarkRow => {
    const script = scriptFor(fixture);
    const opening = openingContext(fixture);
    return {
      surface: fixture.surface,
      shape: fixture.shape,
      kind: opening.screenKind,
      persona: script.persona,
      note: script.note,
      candidates: opening.candidates.length,
      empty: measure(fixture, script, empty),
      cold: measure(fixture, script, cold.graph),
      learned: measure(fixture, script, learned),
      log: logs.get(fixture.surface) ?? { surface: fixture.surface, accepted: 0, otherControl: 0, otherRole: 0, actions: 0 },
    };
  });

  return {
    rows,
    totals: { empty: totalsOf(rows, "empty"), cold: totalsOf(rows, "cold"), learned: totalsOf(rows, "learned") },
    coldStart: cold.facts,
    sizeBytes: knowledgeSizeBytes(learned),
    sessions: SESSIONS * cycles,
  };
}

// ---------- the table ----------

const PERSONA_MARK: Record<Persona, string> = { consistent: "steady", noisy: "noisy", unusual: "unusual" };

function pct(part: number, whole: number): string {
  return `${Math.round((part / (whole || 1)) * 100)}%`;
}

/** The markdown block that goes into docs/knowledge.md section 6, and that the script prints. */
export function formatTable(result: BenchmarkResult): string {
  const { rows, totals } = result;
  const lines: string[] = [
    `| shape | kind | person | candidates | empty | cold start | after ${result.sessions} sessions |`,
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.shape} | ${row.kind} | ${PERSONA_MARK[row.persona]} | ${row.candidates} | ${row.empty.rank} | ${row.cold.rank} | ${row.learned.rank} |`,
    ),
    "",
    "| overall | empty | cold start | learned |",
    "| --- | --- | --- | --- |",
    `| top proposal right | ${totals.empty.topOne}/${rows.length} (${pct(totals.empty.topOne, rows.length)}) | ${totals.cold.topOne}/${rows.length} (${pct(totals.cold.topOne, rows.length)}) | ${totals.learned.topOne}/${rows.length} (${pct(totals.learned.topOne, rows.length)}) |`,
    `| mean rank of the right action | ${totals.empty.meanRank.toFixed(2)} | ${totals.cold.meanRank.toFixed(2)} | ${totals.learned.meanRank.toFixed(2)} |`,
    `| top proposal came from a learned habit | ${totals.empty.learnedTop}/${rows.length} | ${totals.cold.learnedTop}/${rows.length} | ${totals.learned.learnedTop}/${rows.length} |`,
    `| top proposal came from the shape alone | ${totals.empty.priorTop}/${rows.length} | ${totals.cold.priorTop}/${rows.length} | ${totals.learned.priorTop}/${rows.length} |`,
  ];
  return lines.join("\n");
}

/** Everything the table cannot hold: who each person is, and what the scan had to work with. */
export function formatDetail(result: BenchmarkResult): string {
  const lines: string[] = [
    `cold start: ${result.coldStart.rows} history rows -> ${result.coldStart.origins} places -> ${result.coldStart.seededHabits} habit rows, ${result.coldStart.observations} observations`,
    `            ${result.coldStart.seededByHand.join(", ")} seeded directly: a page path has no word for those shapes`,
    `graph after ${result.rows.length * result.sessions} sessions: ${result.sizeBytes} bytes`,
    "",
    "| shape | person | what they do | proposal taken | used another control | of a different kind |",
    "| --- | --- | --- | --- | --- | --- |",
    ...result.rows.map(
      (row) =>
        `| ${row.shape} | ${PERSONA_MARK[row.persona]} | ${row.note} | ${row.log.accepted}/${row.log.actions} | ${row.log.otherControl} | ${row.log.otherRole} |`,
    ),
  ];
  return lines.join("\n");
}
