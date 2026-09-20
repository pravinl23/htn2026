import { isSensitive } from "@ghost/shared";
import { isRecord } from "../providers/errors";
import { BadRequest } from "../providers/validation";
import { MAX_IMAGE_BYTES, parseImage, type VisionImage } from "./image";

export const VISION_LIMITS = {
  imageBytes: MAX_IMAGE_BYTES,
  // base64 is 4/3 of the image, plus boxes and context.
  bodyBytes: 2_100_000,
  boxes: 40,
  boxIdChars: 64,
  appChars: 64,
  nearbyText: 20,
  nearbyTextChars: 80,
  instructionChars: 200,
  labelChars: 40,
  pathPatternChars: 200,
} as const;

/** A box in image pixels, clipped to the image. `alias` (b1, b2...) is the only id the model ever sees. */
export interface VisionBox {
  id: string;
  alias: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionContext {
  app?: string;
  nearbyText?: string[];
  /**
   * The client says these boxes sit in a media-controls cluster (a `<video>`'s controls, or an AX group whose
   * descendants include a media element). Never sent to the model: it only tells the affordance classifier that
   * player vocabulary means what it says here. Optional; a batch that holds a fullscreen control works it out anyway.
   */
  mediaControls?: boolean;
}

export interface LabelRequest {
  image: VisionImage;
  boxes: VisionBox[];
  context: VisionContext;
  /** nearbyText lines dropped because they looked sensitive. A count only. */
  droppedText: number;
  /** `page.pathPattern`, when the client opted into the per-page cache. Hashed locally; never sent, never logged. */
  pathPattern?: string;
}

export interface LocateRequest {
  image: VisionImage;
  instruction: string;
  boxes: VisionBox[];
}

// Characters a person does not see but a regex or a model reads: every format character (zero-width, soft hyphen, bidi
// controls, Unicode tags), the combining grapheme joiner, Mongolian and standard variation selectors (plus the supplement),
// and the Hangul fillers. Removed, not spaced, so "Se<soft hyphen>nd" reads as the "Send" it displays as.
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
// Explicit bidi embeddings, overrides and isolates reorder what is displayed, so the text a regex reads is not what a
// person sees ("drowssaP" shown as "Password"). No control is named that way: such text is refused or dropped, not cleaned.
const REORDERING = /[\u202A-\u202E\u2066-\u2069]/u;

/** NFKC folds look-alike forms (fullwidth "Send" is "Send"); controls become spaces; invisible characters are removed. */
export function cleanText(value: string): string {
  return value.normalize("NFKC").replace(/\p{Cc}/gu, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

export function reordersText(value: string): boolean {
  return REORDERING.test(value);
}

/** Account, card and ID numbers are long digit runs; nothing a control is named after. */
export function looksLikePersonalData(text: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text) || (text.match(/\d/g)?.length ?? 0) >= 7;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new BadRequest(`${path} must be a finite number`);
  return value;
}

function parseBoxes(value: unknown, image: VisionImage, required: boolean): VisionBox[] {
  if (value === undefined || value === null) {
    if (required) throw new BadRequest("boxes must be an array");
    return [];
  }
  if (!Array.isArray(value)) throw new BadRequest("boxes must be an array");
  if (required && value.length === 0) throw new BadRequest("boxes must have at least 1 item");
  if (value.length > VISION_LIMITS.boxes) throw new BadRequest(`boxes must have at most ${VISION_LIMITS.boxes} items`);
  const seen = new Set<string>();
  return value.map((raw, i) => {
    const path = `boxes[${i}]`;
    if (!isRecord(raw)) throw new BadRequest(`${path} must be an object`);
    if (typeof raw.id !== "string" || raw.id === "" || raw.id.length > VISION_LIMITS.boxIdChars) throw new BadRequest(`${path}.id must be a string of 1 to ${VISION_LIMITS.boxIdChars} characters`);
    if (seen.has(raw.id)) throw new BadRequest(`${path}.id is a duplicate`);
    seen.add(raw.id);
    const x = finite(raw.x, `${path}.x`);
    const y = finite(raw.y, `${path}.y`);
    const width = finite(raw.width, `${path}.width`);
    const height = finite(raw.height, `${path}.height`);
    if (width <= 0 || height <= 0) throw new BadRequest(`${path} must have a positive width and height`);
    // Accessibility frames overhang a crop by a pixel or two, so the box is clipped; one entirely outside is a client bug.
    const left = Math.max(0, x);
    const top = Math.max(0, y);
    const right = Math.min(image.width, x + width);
    const bottom = Math.min(image.height, y + height);
    if (right - left < 1 || bottom - top < 1) throw new BadRequest(`${path} is outside the ${image.width}x${image.height} image`);
    return { id: raw.id, alias: `b${i + 1}`, x: left, y: top, width: right - left, height: bottom - top };
  });
}

function parseContext(value: unknown): { context: VisionContext; droppedText: number } {
  if (value === undefined || value === null) return { context: {}, droppedText: 0 };
  if (!isRecord(value)) throw new BadRequest("context must be an object");
  // Window titles name documents, threads and people. Refused, not ignored, so a client learns to stop sending them.
  if ("windowTitle" in value) throw new BadRequest("context.windowTitle is not accepted: window titles can be private");
  const context: VisionContext = {};
  if (value.app !== undefined && value.app !== null) {
    if (typeof value.app !== "string") throw new BadRequest("context.app must be a string");
    if (reordersText(value.app)) throw new BadRequest("context.app must not contain bidirectional control characters");
    const app = cleanText(value.app);
    if (app.length > VISION_LIMITS.appChars) throw new BadRequest(`context.app must be at most ${VISION_LIMITS.appChars} characters`);
    if (app) context.app = app;
  }
  if (value.mediaControls !== undefined && value.mediaControls !== null) {
    if (typeof value.mediaControls !== "boolean") throw new BadRequest("context.mediaControls must be a boolean");
    if (value.mediaControls) context.mediaControls = true;
  }
  let droppedText = 0;
  if (value.nearbyText !== undefined && value.nearbyText !== null) {
    if (!Array.isArray(value.nearbyText)) throw new BadRequest("context.nearbyText must be an array");
    if (value.nearbyText.length > VISION_LIMITS.nearbyText) throw new BadRequest(`context.nearbyText must have at most ${VISION_LIMITS.nearbyText} items`);
    const lines: string[] = [];
    value.nearbyText.forEach((raw, i) => {
      if (typeof raw !== "string") throw new BadRequest(`context.nearbyText[${i}] must be a string`);
      const line = cleanText(raw);
      if (line.length > VISION_LIMITS.nearbyTextChars) throw new BadRequest(`context.nearbyText[${i}] must be at most ${VISION_LIMITS.nearbyTextChars} characters`);
      if (!line) return;
      // Rule 3 and "no personal data": a hint is never worth sending a password label's neighbour or an account number.
      // Reordered text is dropped too: what the sensitivity check reads is not what the line shows.
      if (reordersText(raw) || isSensitive({ label: line }) || looksLikePersonalData(line)) droppedText += 1;
      else lines.push(line);
    });
    if (lines.length > 0) context.nearbyText = lines;
  }
  return { context, droppedText };
}

/**
 * `page.pathPattern`: the cache key's other half. A PATTERN, so it is bounded, carries no query string or fragment
 * (those hold tokens and ids) and nothing that looks like personal data. It is hashed in cache.ts and never sent to the
 * model or written to a log, but a client that sends a raw URL is told, not quietly accepted.
 */
function parsePage(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new BadRequest("page must be an object");
  const raw = value.pathPattern;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new BadRequest("page.pathPattern must be a string");
  if (reordersText(raw)) throw new BadRequest("page.pathPattern must not contain bidirectional control characters");
  const pattern = cleanText(raw);
  if (!pattern || pattern.length > VISION_LIMITS.pathPatternChars) throw new BadRequest(`page.pathPattern must be 1 to ${VISION_LIMITS.pathPatternChars} characters`);
  if (/[?#]/.test(pattern)) throw new BadRequest("page.pathPattern must be a path pattern without a query string or fragment (for example /dp/*)");
  if (looksLikePersonalData(pattern)) throw new BadRequest("page.pathPattern must not contain identifiers: replace them with * (for example /orders/*)");
  return pattern;
}

export function parseLabelRequest(body: unknown): LabelRequest {
  if (!isRecord(body)) throw new BadRequest("body must be an object");
  const image = parseImage(body.image);
  const boxes = parseBoxes(body.boxes, image, true);
  const pathPattern = parsePage(body.page);
  return { image, boxes, ...parseContext(body.context), ...(pathPattern ? { pathPattern } : {}) };
}

export function parseLocateRequest(body: unknown): LocateRequest {
  if (!isRecord(body)) throw new BadRequest("body must be an object");
  if (typeof body.instruction !== "string") throw new BadRequest("instruction must be a string");
  if (reordersText(body.instruction)) throw new BadRequest("instruction must not contain bidirectional control characters");
  const instruction = cleanText(body.instruction);
  if (!instruction || instruction.length > VISION_LIMITS.instructionChars) throw new BadRequest(`instruction must be 1 to ${VISION_LIMITS.instructionChars} characters`);
  // Rule 3: Ghost never points at a password, card or government-ID field, so it never asks where one is.
  if (isSensitive({ label: instruction })) throw new BadRequest("instruction refers to a sensitive field");
  const image = parseImage(body.image);
  return { image, instruction, boxes: parseBoxes(body.boxes, image, false) };
}
