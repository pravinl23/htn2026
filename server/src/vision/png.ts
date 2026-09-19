import { deflateSync } from "node:zlib";

/**
 * Minimal PNG writer (8-bit RGBA, no interlace, filter 0) and a tiny raster with a 5x7 bitmap font, so tests and the
 * live check can draw fictional buttons without an image dependency or a committed binary.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error("rgba must hold width * height * 4 bytes");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

export type Rgb = readonly [number, number, number];

// 5 columns x 7 rows per glyph, one number per row, most significant of the 5 bits on the left.
const FONT: Record<string, readonly number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31], "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14], "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12], " ": [0, 0, 0, 0, 0, 0, 0],
};

/** Upper-case letters, digits and spaces are drawn; anything else is a blank cell. */
export class Raster {
  readonly rgba: Uint8Array;

  constructor(readonly width: number, readonly height: number, background: Rgb = [255, 255, 255]) {
    this.rgba = new Uint8Array(width * height * 4);
    this.fill(0, 0, width, height, background);
  }

  fill(x: number, y: number, w: number, h: number, [r, g, b]: Rgb): this {
    [x, y, w, h] = [x, y, w, h].map(Math.round) as [number, number, number, number];
    for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row += 1) {
      for (let col = Math.max(0, x); col < Math.min(this.width, x + w); col += 1) this.rgba.set([r, g, b, 255], (row * this.width + col) * 4);
    }
    return this;
  }

  stroke(x: number, y: number, w: number, h: number, color: Rgb, thickness = 2): this {
    return this.fill(x, y, w, thickness, color).fill(x, y + h - thickness, w, thickness, color).fill(x, y, thickness, h, color).fill(x + w - thickness, y, thickness, h, color);
  }

  /** Width in pixels of `text` at `scale` (each glyph is 5 wide plus 1 of spacing). */
  static textWidth(text: string, scale: number): number {
    return Math.max(0, text.length * 6 - 1) * scale;
  }

  text(x: number, y: number, text: string, color: Rgb, scale = 3): this {
    [...text.toUpperCase()].forEach((ch, i) => {
      (FONT[ch] ?? FONT[" "] ?? []).forEach((bits, row) => {
        for (let col = 0; col < 5; col += 1) if (bits & (1 << (4 - col))) this.fill(x + (i * 6 + col) * scale, y + row * scale, scale, scale, color);
      });
    });
    return this;
  }

  png(): Buffer {
    return encodePng(this.width, this.height, this.rgba);
  }

  dataUrl(): string {
    return `data:image/png;base64,${this.png().toString("base64")}`;
  }
}
