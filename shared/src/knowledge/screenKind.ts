// What KIND of screen this is, from STRUCTURE alone (docs/knowledge.md section 2).
//
// The rule that makes Ghost work anywhere: nothing here may know a site, an app, a bundle id or a brand. A screen
// is a tree of boxes with structural roles, and a kind is a shape that tree has: a media node with a controls
// cluster, a repeated grid of similar items, a long run of text with few controls, two panes where one lists and
// one shows, a column of labelled rows each carrying a switch, one editable region that owns the view, a grid of
// small equal cells, a cluster of fields.
//
// The same inference runs over a DOM and over a macOS accessibility tree, because both reduce to the same tree:
// roles, rectangles, how much text a node carries, and which nodes repeat. No node in this file ever carries the
// text itself, a title, a URL or an identifier that names anything.
import type { Rect } from "../types";

export type ScreenKind =
  | "feed"
  | "media"
  | "list"
  | "reader"
  | "commerce"
  | "settings"
  | "editor"
  | "board"
  | "form"
  | "unknown";

export const SCREEN_KINDS: readonly ScreenKind[] = [
  "feed",
  "media",
  "list",
  "reader",
  "commerce",
  "settings",
  "editor",
  "board",
  "form",
  "unknown",
];

/**
 * The generic vocabulary both clients map onto. A DOM walker maps tag + ARIA role onto it; an accessibility
 * walker maps AXRole onto it. Neither mapping may consult a host or a bundle id.
 */
export type StructuralRole =
  | "group" // a plain container
  | "region" // a landmark or a pane
  | "list" // a list or grid container
  | "item" // a repeated member of a list or grid
  | "table"
  | "row"
  | "cell" // one small equal cell of a grid (a board square, a table cell)
  | "text" // a run of static text
  | "heading"
  | "image"
  | "media" // a video or audio node
  | "media-controls" // the controls cluster drawn for a media node
  | "button"
  | "link"
  | "textbox" // single-line entry
  | "textarea" // multi-line entry, or a rich editable region
  | "switch" // a switch, a checkbox, a toggle
  | "select"
  | "slider"
  | "tab"
  | "toolbar"
  | "unknown";

/** One node of the screen. Structure and geometry only: no text, no name, no identifier, no address. */
export interface ScreenNode {
  role: StructuralRole;
  rect?: Rect;
  /** How many characters of running text this node renders. The characters themselves never enter this type. */
  textLength?: number;
  /** The node accepts typing (contenteditable, a text input, an AXTextArea that is not read-only). */
  editable?: boolean;
  /** A currency-shaped value renders here. A SHAPE, detected by the client in any currency: never a word list. */
  price?: boolean;
  /** A media node that is playing right now. */
  playing?: boolean;
  /** Members of one repeated list or grid share this opaque key. Never a signature of anything readable. */
  repeatKey?: string;
  children?: readonly ScreenNode[];
}

/** Why a kind was chosen. Codes only, so an evidence list can be logged without leaking anything. */
export type ScreenEvidence =
  | "media-element"
  | "media-controls"
  | "media-playing"
  | "repeated-items"
  | "many-repeated-items"
  | "large-items"
  | "compact-rows"
  | "two-panes"
  | "detail-pane"
  | "cell-grid"
  | "equal-cells"
  | "toggle-rows"
  | "many-toggle-rows"
  | "labelled-rows"
  | "dominant-editor"
  | "editable-region"
  | "text-region"
  | "long-text-region"
  | "few-controls"
  | "field-cluster"
  | "many-fields"
  | "price-markers"
  | "price-rows"
  | "single-item"
  | "controls-only"
  | "nothing-to-read";

export interface ScreenKindGuess {
  kind: ScreenKind;
  /** How well the shape fits, NOT how likely any prediction is. Ranking turns a kind into a proposal. */
  confidence: number;
  evidence: ScreenEvidence[];
}

/**
 * What the walk measured. A client that already has these numbers (a native agent that walked the AX tree once)
 * can pass them straight to `screenKindFromSignals` instead of rebuilding a tree.
 */
export interface ScreenSignals {
  nodes: number;
  controls: number;
  /** Text entry, selects, switches and sliders: the things a form is made of. */
  fields: number;
  media: number;
  mediaPlaying: boolean;
  mediaControlCluster: boolean;
  headings: number;
  images: number;
  textChars: number;
  /** The longest single run of text. One long run is an article; many short ones are a list of things. */
  maxTextNode: number;
  priceNodes: number;
  /** The largest repeated group of similar children found anywhere in the tree. */
  repeatCount: number;
  /** Share of the root's area one member of that group takes. 0 when the tree carries no rectangles. */
  repeatMemberShare: number;
  repeatWithPrice: number;
  /** Members that carry their own running text: rows of content, as opposed to a rail of navigation. */
  repeatWithText: number;
  repeatRows: number;
  repeatColumns: number;
  /** A repeated group of small equal cells, at least three by three: a board. */
  cellGrid: number;
  cellGridEqual: boolean;
  /** Rows that pair a label with exactly one switch and nothing else: a settings list. */
  toggleRows: number;
  toggleRowsLabelled: number;
  /** Share of the root's area taken by the largest editable node. */
  editorShare: number;
  editableNodes: number;
  /** Two panes side by side, one of which repeats items. */
  twoPanes: boolean;
  detailPane: boolean;
}

const MAX_CONFIDENCE = 0.92;
const MIN_CONFIDENCE = 0.3;

/** A tie goes to the more specific shape: a board of cells that also repeats rows is still a board. */
const PRIORITY: readonly ScreenKind[] = [
  "media",
  "board",
  "editor",
  "settings",
  "commerce",
  "form",
  "list",
  "feed",
  "reader",
  "unknown",
];

const CONTROL_ROLES: readonly StructuralRole[] = ["button", "link", "textbox", "textarea", "switch", "select", "slider", "tab"];
const FIELD_ROLES: readonly StructuralRole[] = ["textbox", "textarea", "switch", "select", "slider"];

function area(rect: Rect | undefined): number {
  if (!rect) return 0;
  const w = Number.isFinite(rect.width) ? Math.max(0, rect.width) : 0;
  const h = Number.isFinite(rect.height) ? Math.max(0, rect.height) : 0;
  return w * h;
}

function childrenOf(node: ScreenNode): readonly ScreenNode[] {
  return node.children ?? [];
}

interface SubtreeTally {
  nodes: number;
  controls: number;
  fields: number;
  media: number;
  mediaPlaying: boolean;
  mediaControls: number;
  headings: number;
  images: number;
  textChars: number;
  /** The longest single run of text. One long run is an article; many short ones are a list of things. */
  maxTextNode: number;
  priceNodes: number;
  editableNodes: number;
  maxEditableArea: number;
  switches: number;
  repeats: number;
}

function emptyTally(): SubtreeTally {
  return {
    nodes: 0,
    controls: 0,
    fields: 0,
    media: 0,
    mediaPlaying: false,
    mediaControls: 0,
    headings: 0,
    images: 0,
    textChars: 0,
    maxTextNode: 0,
    priceNodes: 0,
    editableNodes: 0,
    maxEditableArea: 0,
    switches: 0,
    repeats: 0,
  };
}

function tallyOf(node: ScreenNode): SubtreeTally {
  const t = emptyTally();
  t.nodes = 1;
  if (CONTROL_ROLES.includes(node.role)) t.controls += 1;
  if (FIELD_ROLES.includes(node.role)) t.fields += 1;
  if (node.role === "media") {
    t.media += 1;
    if (node.playing === true) t.mediaPlaying = true;
  }
  if (node.role === "media-controls") t.mediaControls += 1;
  if (node.role === "heading") t.headings += 1;
  if (node.role === "image") t.images += 1;
  if (node.role === "switch") t.switches += 1;
  if (node.price === true) t.priceNodes += 1;
  const ownText = Math.max(0, Math.floor(node.textLength ?? 0));
  t.textChars += ownText;
  t.maxTextNode = ownText;
  if (node.editable === true || node.role === "textarea") {
    t.editableNodes += 1;
    t.maxEditableArea = area(node.rect);
  }
  return t;
}

function merge(into: SubtreeTally, from: SubtreeTally): void {
  into.nodes += from.nodes;
  into.controls += from.controls;
  into.fields += from.fields;
  into.media += from.media;
  into.mediaPlaying = into.mediaPlaying || from.mediaPlaying;
  into.mediaControls += from.mediaControls;
  into.headings += from.headings;
  into.images += from.images;
  into.textChars += from.textChars;
  into.maxTextNode = Math.max(into.maxTextNode, from.maxTextNode);
  into.priceNodes += from.priceNodes;
  into.editableNodes += from.editableNodes;
  into.maxEditableArea = Math.max(into.maxEditableArea, from.maxEditableArea);
  into.switches += from.switches;
  into.repeats = Math.max(into.repeats, from.repeats);
}

interface RepeatGroup {
  role: StructuralRole;
  count: number;
  /** Largest member area, in square pixels. Turned into a share of the root later. */
  memberArea: number;
  sameSize: boolean;
  rows: number;
  columns: number;
  withPrice: number;
  withImage: number;
  withText: number;
  /** Every member is a small equal box, which is what a board is made of. */
  cellLike: boolean;
}

/** Members of one repeated group look the same: same structural role, same repeat key, same size bucket. */
function groupKey(node: ScreenNode): string {
  const rect = node.rect;
  const bucket = rect ? `${Math.round(rect.width / 8)}x${Math.round(rect.height / 8)}` : "-";
  return `${node.role}|${node.repeatKey ?? ""}|${bucket}`;
}

function distinctPositions(values: readonly number[], tolerance = 4): number {
  const seen: number[] = [];
  for (const value of values) {
    if (!seen.some((v) => Math.abs(v - value) <= tolerance)) seen.push(value);
  }
  return seen.length;
}

const REPEAT_MIN = 3;
/** A member this small, relative to the root, is a cell rather than a card. */
const CELL_MAX_SHARE = 0.03;
/** A member at least this big is a card in a feed rather than a row in a list. */
const CARD_MIN_SHARE = 0.035;

function repeatGroupsOf(node: ScreenNode, tallies: Map<ScreenNode, SubtreeTally>): RepeatGroup[] {
  const children = childrenOf(node);
  if (children.length < REPEAT_MIN) return [];
  const buckets = new Map<string, ScreenNode[]>();
  for (const child of children) {
    const key = groupKey(child);
    const bucket = buckets.get(key) ?? [];
    bucket.push(child);
    buckets.set(key, bucket);
  }
  const groups: RepeatGroup[] = [];
  for (const members of buckets.values()) {
    if (members.length < REPEAT_MIN) continue;
    const first = members[0];
    if (!first) continue;
    const widths = members.map((m) => m.rect?.width ?? 0);
    const heights = members.map((m) => m.rect?.height ?? 0);
    const sameSize = widths.every((w) => Math.abs(w - (widths[0] ?? 0)) <= 2) && heights.every((h) => Math.abs(h - (heights[0] ?? 0)) <= 2);
    let withPrice = 0;
    let withImage = 0;
    let withText = 0;
    for (const member of members) {
      const t = tallies.get(member) ?? emptyTally();
      if (t.priceNodes > 0) withPrice += 1;
      if (t.images > 0) withImage += 1;
      if (t.textChars > 0) withText += 1;
    }
    groups.push({
      role: first.role,
      count: members.length,
      memberArea: Math.max(...members.map((m) => area(m.rect))),
      sameSize,
      rows: distinctPositions(members.map((m) => m.rect?.y ?? 0)),
      columns: distinctPositions(members.map((m) => m.rect?.x ?? 0)),
      withPrice,
      withImage,
      withText,
      cellLike: false,
    });
  }
  return groups;
}

/** A settings row: a label and exactly one switch, and nothing else worth pressing. */
function isToggleRow(node: ScreenNode, tally: SubtreeTally): boolean {
  if (node.role === "switch") return false;
  return tally.switches === 1 && tally.controls <= 1 && tally.nodes <= 8;
}

interface PaneReading {
  twoPanes: boolean;
  detailPane: boolean;
}

/** Two containers side by side, both tall, one of which repeats items: the list-and-detail shape. */
function readPanes(node: ScreenNode, tallies: Map<ScreenNode, SubtreeTally>, repeats: Map<ScreenNode, number>): PaneReading {
  const parentArea = area(node.rect);
  const children = childrenOf(node).filter((c) => area(c.rect) > 0);
  if (parentArea <= 0 || children.length < 2) return { twoPanes: false, detailPane: false };
  const height = node.rect?.height ?? 0;
  const width = node.rect?.width ?? 0;
  for (let i = 0; i < children.length; i += 1) {
    for (let j = i + 1; j < children.length; j += 1) {
      const a = children[i];
      const b = children[j];
      if (!a?.rect || !b?.rect) continue;
      const left = a.rect.x <= b.rect.x ? a : b;
      const right = left === a ? b : a;
      if (!left.rect || !right.rect) continue;
      const disjoint = left.rect.x + left.rect.width <= right.rect.x + 4;
      const tall = left.rect.height >= height * 0.5 && right.rect.height >= height * 0.5;
      const wide = left.rect.width >= width * 0.12 && right.rect.width >= width * 0.12;
      if (!disjoint || !tall || !wide) continue;
      const leftRepeats = repeats.get(left) ?? 0;
      const rightRepeats = repeats.get(right) ?? 0;
      if (Math.max(leftRepeats, rightRepeats) < 4) continue;
      const other = leftRepeats >= rightRepeats ? right : left;
      const otherTally = tallies.get(other) ?? emptyTally();
      const otherRepeats = leftRepeats >= rightRepeats ? rightRepeats : leftRepeats;
      const shows = otherTally.textChars >= 150 || otherTally.headings > 0;
      if (shows || otherRepeats >= 3) return { twoPanes: true, detailPane: shows && otherRepeats < 3 };
    }
  }
  return { twoPanes: false, detailPane: false };
}

/** Walk once: every measurement the kind rules need, and nothing that could identify anything. */
export function measureScreen(root: ScreenNode): ScreenSignals {
  const tallies = new Map<ScreenNode, SubtreeTally>();
  const repeats = new Map<ScreenNode, number>();
  const groups: RepeatGroup[] = [];
  let toggleRows = 0;
  let toggleRowsLabelled = 0;
  const rootArea = area(root.rect);

  const visit = (node: ScreenNode): SubtreeTally => {
    const total = tallyOf(node);
    let deepestRepeat = 0;
    for (const child of childrenOf(node)) {
      const childTally = visit(child);
      merge(total, childTally);
      deepestRepeat = Math.max(deepestRepeat, repeats.get(child) ?? 0);
    }
    tallies.set(node, total);
    const own = repeatGroupsOf(node, tallies);
    for (const group of own) groups.push(group);
    const here = own.reduce((best, group) => Math.max(best, group.count), 0);
    repeats.set(node, Math.max(here, deepestRepeat));
    if (isToggleRow(node, total)) {
      toggleRows += 1;
      if (total.textChars > 0 || total.headings > 0) toggleRowsLabelled += 1;
    }
    return total;
  };
  const totals = visit(root);

  for (const group of groups) {
    const share = rootArea > 0 ? group.memberArea / rootArea : 0;
    group.cellLike = group.sameSize && group.rows >= 3 && group.columns >= 3 && (share <= CELL_MAX_SHARE || rootArea === 0);
  }
  const cellGroup = groups.filter((g) => g.cellLike && g.count >= 9).sort((a, b) => b.count - a.count)[0];
  const biggest = groups.sort((a, b) => b.count - a.count || b.memberArea - a.memberArea)[0];
  let panes: PaneReading = { twoPanes: false, detailPane: false };
  const scanPanes = (node: ScreenNode): void => {
    if (panes.twoPanes) return;
    const reading = readPanes(node, tallies, repeats);
    if (reading.twoPanes) {
      panes = reading;
      return;
    }
    for (const child of childrenOf(node)) scanPanes(child);
  };
  scanPanes(root);

  // A settings row's switch is not a form field, and the one editable region of an editor is not one either.
  const toggleFields = toggleRows;
  return {
    nodes: totals.nodes,
    controls: totals.controls,
    fields: Math.max(0, totals.fields - toggleFields),
    media: totals.media,
    mediaPlaying: totals.mediaPlaying,
    mediaControlCluster: totals.mediaControls > 0,
    headings: totals.headings,
    images: totals.images,
    textChars: totals.textChars,
    maxTextNode: totals.maxTextNode,
    priceNodes: totals.priceNodes,
    repeatCount: biggest?.count ?? 0,
    repeatMemberShare: rootArea > 0 ? (biggest?.memberArea ?? 0) / rootArea : 0,
    repeatWithPrice: biggest?.withPrice ?? 0,
    repeatWithText: biggest?.withText ?? 0,
    repeatRows: biggest?.rows ?? 0,
    repeatColumns: biggest?.columns ?? 0,
    cellGrid: cellGroup?.count ?? 0,
    cellGridEqual: cellGroup?.sameSize ?? false,
    toggleRows,
    toggleRowsLabelled,
    editorShare: rootArea > 0 ? totals.maxEditableArea / rootArea : 0,
    editableNodes: totals.editableNodes,
    twoPanes: panes.twoPanes,
    detailPane: panes.detailPane,
  };
}

class KindScores {
  private readonly score = new Map<ScreenKind, number>();
  private readonly evidence = new Map<ScreenKind, ScreenEvidence[]>();

  add(kind: ScreenKind, weight: number, evidence: ScreenEvidence): void {
    this.score.set(kind, (this.score.get(kind) ?? 0) + weight);
    const seen = this.evidence.get(kind) ?? [];
    if (!seen.includes(evidence)) seen.push(evidence);
    this.evidence.set(kind, seen);
  }

  of(kind: ScreenKind): number {
    return this.score.get(kind) ?? 0;
  }

  evidenceOf(kind: ScreenKind): ScreenEvidence[] {
    return [...(this.evidence.get(kind) ?? [])];
  }

  best(): ScreenKind {
    let best: ScreenKind = "unknown";
    let bestScore = 0;
    for (const kind of PRIORITY) {
      const score = this.of(kind);
      if (score > bestScore) {
        best = kind;
        bestScore = score;
      }
    }
    return best;
  }
}

/** The kind, from measurements alone. Exported so a client that already walked its own tree need not build one. */
export function screenKindFromSignals(signals: ScreenSignals): ScreenKindGuess {
  const scores = new KindScores();
  const s = signals;

  if (s.media > 0) scores.add("media", 0.55, "media-element");
  if (s.mediaControlCluster) scores.add("media", 0.25, "media-controls");
  if (s.mediaPlaying) scores.add("media", 0.08, "media-playing");

  if (s.cellGrid >= 9) scores.add("board", 0.62, "cell-grid");
  if (s.cellGrid >= 16 && s.cellGridEqual) scores.add("board", 0.18, "equal-cells");

  if (s.editorShare >= 0.2) scores.add("editor", 0.6, "dominant-editor");
  if (s.editorShare >= 0.2 && s.fields <= 2) scores.add("editor", 0.12, "few-controls");
  if (s.editorShare >= 0.2 && s.editableNodes === 1) scores.add("editor", 0.08, "editable-region");

  if (s.toggleRows >= 3) scores.add("settings", 0.55, "toggle-rows");
  if (s.toggleRows >= 6) scores.add("settings", 0.12, "many-toggle-rows");
  if (s.toggleRows >= 3 && s.toggleRowsLabelled >= s.toggleRows - 1) scores.add("settings", 0.1, "labelled-rows");

  // A price is a shape, not a word: a currency-shaped value beside repeated rows is a basket, and beside one
  // image with a few controls it is one thing for sale.
  if (s.repeatWithPrice >= 2) scores.add("commerce", 0.55, "price-rows");
  if (s.priceNodes >= 2 && s.repeatWithPrice < 2) scores.add("commerce", 0.45, "price-markers");
  if (s.priceNodes >= 1 && s.images >= 1 && s.repeatCount < 4 && s.textChars < 1200) scores.add("commerce", 0.35, "single-item");

  if (s.fields >= 3 && s.editorShare < 0.2) scores.add("form", 0.5, "field-cluster");
  if (s.fields >= 6 && s.editorShare < 0.2) scores.add("form", 0.12, "many-fields");

  // Two panes where the repeating one holds CONTENT is the list-and-detail shape. A rail of navigation beside a
  // body of text is not: its entries carry no text of their own, and the screen is whatever the body makes it.
  const contentRows = s.repeatWithText >= 3;
  const compact = s.repeatMemberShare > 0 && s.repeatMemberShare < CARD_MIN_SHARE;
  if (s.twoPanes) scores.add("list", contentRows ? 0.55 : 0.3, "two-panes");
  if (s.twoPanes && s.detailPane) scores.add("list", 0.12, "detail-pane");
  if (s.twoPanes && compact && contentRows) scores.add("list", 0.1, "compact-rows");
  // Compact rows are a list even in one pane: a row is small, a card is not.
  if (!s.twoPanes && s.repeatCount >= 5 && compact && contentRows) scores.add("list", 0.42, "compact-rows");

  if (s.repeatCount >= 4) scores.add("feed", 0.45, "repeated-items");
  if (s.repeatCount >= 8) scores.add("feed", 0.1, "many-repeated-items");
  if (s.repeatCount >= 4 && s.repeatMemberShare >= CARD_MIN_SHARE) scores.add("feed", 0.12, "large-items");

  // One long run of text, and not much to press. The length of the LONGEST run is what separates an article from
  // a feed whose cards happen to add up to the same number of characters.
  if (s.maxTextNode >= 400 && s.controls <= 14) scores.add("reader", 0.5, "text-region");
  if (s.maxTextNode >= 400 && s.textChars >= 1500) scores.add("reader", 0.12, "long-text-region");
  if (s.maxTextNode >= 400 && s.controls <= 6) scores.add("reader", 0.1, "few-controls");

  if (s.nodes <= 1) scores.add("unknown", MIN_CONFIDENCE, "nothing-to-read");
  else if (scores.best() === "unknown") scores.add("unknown", s.controls > 0 ? 0.35 : MIN_CONFIDENCE, s.controls > 0 ? "controls-only" : "nothing-to-read");

  const kind = scores.best();
  const confidence = Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, scores.of(kind)));
  return { kind, confidence, evidence: scores.evidenceOf(kind) };
}

/** The kind of a screen, from its tree. One call serves a DOM walk and an accessibility walk alike. */
export function inferScreenKind(root: ScreenNode): ScreenKindGuess {
  return screenKindFromSignals(measureScreen(root));
}
