import { isLockedAction, isSensitive } from "@shabang/shared";
import { isRecord } from "../providers/errors";
import { affordanceRolesFor, type AffordanceHints, type AffordanceRole } from "./affordance";
import type { VisionImage } from "./image";
import { VISION_ROLES, type ImageView, type VisionRole } from "./prompts";
import { cleanText, looksLikePersonalData, reordersText, VISION_LIMITS, type VisionBox } from "./validation";
import { VisionError } from "./responses";

export interface VisionLabel {
  id: string;
  label: string | null;
  role: VisionRole;
  /**
   * The affordance role the label implies (docs/anywhere.md section 2), derived in code from the RETURNED label, never
   * asked of the model. A hint for the client's ranker, which also sees layout, page kind and memory.
   */
  affordance: AffordanceRole;
  /** The model's flag OR the shared lock rules on its full label (before clipping): the model can lock, never unlock. */
  irreversible: boolean;
  /** The full label names a password, card or government-ID field (rule 3): never fill it. */
  sensitive: boolean;
  confidence: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocateResult {
  box: Rect | null;
  /** The client's id of the supplied box the model chose, when it chose one. */
  boxId: string | null;
  label: string | null;
  irreversible: boolean;
  sensitive: boolean;
  confidence: number;
}

const ROLES: ReadonlySet<string> = new Set(VISION_ROLES);
/** Size of the ghost target around a bare point, in image pixels. */
export const POINT_BOX = 24;

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

const QUOTES = /^["'\u201C\u201D\u2018\u2019]+|["'\u201C\u201D\u2018\u2019]+$/g;

/**
 * The model's label as a person reads it (invisible characters removed, quotes trimmed), NOT clipped or scrubbed: the
 * lock and sensitivity rules read this, so a keyword past character 40 or inside a label code throws away still counts.
 */
function fullLabel(value: string | null): string | null {
  if (value === null) return null;
  return cleanText(value).replace(QUOTES, "").trim() || null;
}

/** What is returned: clipped to 40 characters. Personal-looking or reordered text is not a control name: null. */
export function cleanLabel(value: string | null): string | null {
  if (value === null || reordersText(value)) return null;
  const text = fullLabel(value);
  if (text === null || looksLikePersonalData(text)) return null;
  return text.length > VISION_LIMITS.labelChars ? text.slice(0, VISION_LIMITS.labelChars).trimEnd() : text;
}

/**
 * Locks and sensitivity from the model's full label (and, for locate, the instruction). A label whose display order
 * differs from its text cannot be read by the rules, so it is treated as both: when in doubt, lock and do not fill.
 */
function codeFlags(raw: string | null, modelIrreversible: boolean, ...also: string[]): { irreversible: boolean; sensitive: boolean } {
  const unreadable = raw !== null && reordersText(raw);
  const full = fullLabel(raw);
  const texts = full === null ? also : [full, ...also];
  return {
    irreversible: modelIrreversible || unreadable || texts.some((text) => isLockedAction({ text })),
    sensitive: unreadable || (full !== null && isSensitive({ label: full })),
  };
}

function confidenceOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : undefined;
}

/**
 * One entry per request box, in request order. An entry that names an unknown or repeated id, a role outside the enum,
 * or has the wrong types is dropped; a box without a valid entry comes back unanswered (label null, confidence 0).
 */
export function validateLabelReply(reply: unknown, boxes: VisionBox[], hints: AffordanceHints = {}): { labels: VisionLabel[]; answered: number } {
  if (!isRecord(reply) || !Array.isArray(reply.labels)) throw new VisionError("malformed", "reply has no labels array");
  const byAlias = new Map(boxes.map((box) => [box.alias, box]));
  const answers = new Map<string, VisionLabel>();
  for (const entry of reply.labels) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const box = byAlias.get(entry.id);
    const confidence = confidenceOf(entry.confidence);
    if (!box || answers.has(box.id) || typeof entry.role !== "string" || !ROLES.has(entry.role)) continue;
    if (typeof entry.irreversible !== "boolean" || confidence === undefined) continue;
    if (entry.label !== null && typeof entry.label !== "string") continue;
    const label = cleanLabel(entry.label);
    answers.set(box.id, {
      id: box.id,
      label,
      role: entry.role as VisionRole,
      affordance: "unknown",
      ...codeFlags(entry.label, entry.irreversible),
      // A label code threw away is no label: nothing about it is confident.
      confidence: label === null && entry.label !== null ? 0 : confidence,
    });
  }
  const unanswered = { label: null, role: "other" as const, affordance: "unknown" as const, irreversible: false, sensitive: false, confidence: 0 };
  const labels: VisionLabel[] = boxes.map((box) => answers.get(box.id) ?? { id: box.id, ...unanswered });
  // One pass over the whole batch, so a player bar's icons see each other (see affordance.ts).
  const roles = affordanceRolesFor(labels, hints);
  for (const label of labels) label.affordance = roles.get(label.id) ?? "unknown";
  return { labels, answered: answers.size };
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A point (plus an optional size) becomes a box centered on it, clamped inside the image. */
export function boxAroundPoint(image: Pick<VisionImage, "width" | "height">, cx: number, cy: number, w: number | null, h: number | null): Rect {
  const width = Math.round(clamp(w !== null && w > 0 ? w : POINT_BOX, 1, image.width));
  const height = Math.round(clamp(h !== null && h > 0 ? h : POINT_BOX, 1, image.height));
  const x = Math.round(clamp(cx - width / 2, 0, image.width - width));
  const y = Math.round(clamp(cy - height / 2, 0, image.height - height));
  return { x, y, width, height };
}

/**
 * A supplied box the model chose wins (its exact rectangle); else a point, mapped from the model's pixel grid back to the
 * image and clamped to it; else nothing. Sensitive targets are never returned (rule 3), and neither is a target without
 * a name code can check (a null label, or one it threw away). Locks: model flag OR shared rules on the full label OR on
 * the instruction.
 */
export function validateLocateReply(reply: unknown, image: VisionImage, boxes: VisionBox[], instruction: string, view?: ImageView): LocateResult {
  if (!isRecord(reply)) throw new VisionError("malformed", "reply is not an object");
  const [x, y, w, h] = [reply.x, reply.y, reply.width, reply.height].map(nullableNumber);
  const confidence = confidenceOf(reply.confidence);
  const boxAlias = reply.boxId;
  if (x === undefined || y === undefined || w === undefined || h === undefined || confidence === undefined) throw new VisionError("malformed", "reply has wrong types");
  if (typeof reply.irreversible !== "boolean" || (boxAlias !== null && typeof boxAlias !== "string")) throw new VisionError("malformed", "reply has wrong types");
  if (reply.label !== null && typeof reply.label !== "string") throw new VisionError("malformed", "reply has wrong types");
  const label = cleanLabel(reply.label);
  const { irreversible, sensitive } = codeFlags(reply.label, reply.irreversible, instruction);
  const chosen = typeof boxAlias === "string" ? boxes.find((b) => b.alias === boxAlias) : undefined;
  const sx = view?.scaleX ?? 1;
  const sy = view?.scaleY ?? 1;
  let box: Rect | null = null;
  if (chosen) box = { x: chosen.x, y: chosen.y, width: chosen.width, height: chosen.height };
  else if (x !== null && y !== null) {
    box = boxAroundPoint(image, clamp(x / sx, 0, image.width), clamp(y / sy, 0, image.height), w === null ? null : w / sx, h === null ? null : h / sy);
  }
  if (!box || sensitive || label === null) return { box: null, boxId: null, label, irreversible, sensitive, confidence: 0 };
  return { box, boxId: chosen?.id ?? null, label, irreversible, sensitive, confidence };
}
