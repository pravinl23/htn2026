import { BadRequest } from "../providers/validation";

/** Decoded bytes, not data-URL characters: 1.5 MB is a full Retina window crop as PNG. */
export const MAX_IMAGE_BYTES = 1_500_000;
/**
 * OpenAI covers images with 32 x 32 px patches and REJECTS (does not resize) an image that needs more than 30,000 of them
 * after its detail-level resizing (docs/openai.md). Checking here keeps a guaranteed upstream 400 from costing a call.
 */
export const MAX_IMAGE_PATCHES = 30_000;

export type ImageKind = "png" | "jpeg";

export interface VisionImage {
  kind: ImageKind;
  /** Canonical data URL rebuilt from the validated bytes: exactly what was checked is what is sent. */
  dataUrl: string;
  bytes: number;
  width: number;
  height: number;
}

const DATA_URL = /^data:image\/(png|jpeg|jpg);base64,/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function sniff(bytes: Uint8Array): ImageKind | undefined {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return undefined;
}

function u16(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
}

function u32(b: Uint8Array, at: number): number {
  return (((b[at] ?? 0) << 24) >>> 0) + ((b[at + 1] ?? 0) << 16) + ((b[at + 2] ?? 0) << 8) + (b[at + 3] ?? 0);
}

/** The first chunk of every PNG is IHDR: width and height are its first two big-endian words. */
function pngSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 24 || String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0) !== "IHDR") return undefined;
  return { width: u32(b, 16), height: u32(b, 20) };
}

// Start-of-frame markers carry the size. C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding) share the range but are not frames.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Walks the JPEG marker segments up to the first frame header. Nothing is decoded. */
function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let at = 2;
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) return undefined;
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // standalone markers have no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // end of image or start of scan before any frame header
    const length = u16(b, at + 2);
    if (length < 2) return undefined;
    if (SOF.has(marker)) return at + 8 < b.length ? { height: u16(b, at + 5), width: u16(b, at + 7) } : undefined;
    at += 2 + length;
  }
  return undefined;
}

/**
 * `data:image/png;base64,...` or `data:image/jpeg;base64,...`, at most MAX_IMAGE_BYTES decoded. The magic bytes decide the
 * type, and they must agree with the data URL. Messages never echo the image.
 */
export function parseImage(value: unknown, path = "image"): VisionImage {
  if (typeof value !== "string") throw new BadRequest(`${path} must be a data URL string`);
  const head = DATA_URL.exec(value.slice(0, 32));
  if (!head) throw new BadRequest(`${path} must be a base64 data URL of a PNG or JPEG image (data:image/png;base64,...)`);
  const payload = value.slice(head[0].length);
  if (payload.length === 0 || payload.length % 4 !== 0 || !BASE64.test(payload)) throw new BadRequest(`${path} is not valid base64`);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  if ((payload.length / 4) * 3 - padding > MAX_IMAGE_BYTES) throw new BadRequest(`${path} is larger than ${MAX_IMAGE_BYTES} bytes`, 413);
  const bytes = Buffer.from(payload, "base64");
  const kind = sniff(bytes);
  if (!kind) throw new BadRequest(`${path} is not a PNG or JPEG image`);
  const declared = (head[1] ?? "").toLowerCase() === "png" ? "png" : "jpeg";
  if (kind !== declared) throw new BadRequest(`${path} bytes do not match its declared type`);
  const size = kind === "png" ? pngSize(bytes) : jpegSize(bytes);
  if (!size || size.width < 1 || size.height < 1) throw new BadRequest(`${path} has no readable width and height`);
  if (Math.ceil(size.width / 32) * Math.ceil(size.height / 32) > MAX_IMAGE_PATCHES) throw new BadRequest(`${path} has too many pixels (at most ${MAX_IMAGE_PATCHES} patches of 32 x 32)`, 413);
  const mime = kind === "png" ? "image/png" : "image/jpeg";
  return { kind, dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, bytes: bytes.length, ...size };
}
