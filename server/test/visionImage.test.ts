import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { BadRequest } from "../src/providers/validation";
import { budgetLimitFrom, DEFAULT_VISION_BUDGET, processVisionBudget, VisionBudget } from "../src/vision/budget";
import { visionConfigFrom } from "../src/vision/config";
import { loadConfig } from "../src/config";
import { MAX_IMAGE_BYTES, parseImage } from "../src/vision/image";
import { crc32, encodePng, Raster } from "../src/vision/png";
import { imageView, modelSettings } from "../src/vision/prompts";
import { boxAroundPoint, cleanLabel } from "../src/vision/replies";
import { outputTextOf, VisionError } from "../src/vision/responses";
import { demoToolbar } from "../src/vision/testing";
import { cleanText, reordersText } from "../src/vision/validation";

function pngBytes(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
}

/** Reads the chunks back: [type, data] with each CRC checked against zlib's own crc32. */
function chunks(png: Buffer): Array<[string, Buffer]> {
  const out: Array<[string, Buffer]> = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    expect(png.readUInt32BE(at + 8 + length)).toBe(zlib.crc32(png.subarray(at + 4, at + 8 + length)));
    out.push([type, data]);
    at += 12 + length;
  }
  return out;
}

function pixel(png: Buffer, width: number, x: number, y: number): number[] {
  const idat = Buffer.concat(chunks(png).filter(([t]) => t === "IDAT").map(([, d]) => d));
  const raw = zlib.inflateSync(idat);
  const row = y * (width * 4 + 1);
  expect(raw[row]).toBe(0); // filter type none
  return [...raw.subarray(row + 1 + x * 4, row + 1 + x * 4 + 4)];
}

/** A structurally valid JPEG header: SOI, APP0 (JFIF), a fill byte, SOF0 with the size, EOI. Nothing is decodable. */
function fakeJpeg(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, 0xff, ...sof0, 0xff, 0xd9]);
}

function rejection(value: unknown): BadRequest {
  try {
    parseImage(value);
  } catch (err) {
    if (err instanceof BadRequest) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}

describe("PNG writer", () => {
  it("writes a valid signature, IHDR, IDAT and IEND with correct CRCs", () => {
    const png = encodePng(3, 2, new Uint8Array(3 * 2 * 4).fill(200));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const list = chunks(png);
    expect(list.map(([t]) => t)).toEqual(["IHDR", "IDAT", "IEND"]);
    const ihdr = list[0]?.[1] ?? Buffer.alloc(0);
    expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]]).toEqual([3, 2, 8, 6, 0, 0, 0]);
    expect(crc32(Buffer.from("IEND"))).toBe(0xae426082);
  });

  it("round-trips pixels, and the raster draws text and shapes", () => {
    const r = new Raster(40, 12, [255, 255, 255]).fill(0, 0, 2, 2, [255, 0, 0]).text(1, 3, "T", [0, 0, 0], 1);
    const png = r.png();
    expect(pixel(png, 40, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(png, 40, 39, 11)).toEqual([255, 255, 255, 255]);
    // "T" at scale 1: the top row is 5 pixels wide, the stem is the middle column.
    expect([1, 2, 3, 4, 5].map((x) => pixel(png, 40, x, 3)[0])).toEqual([0, 0, 0, 0, 0]);
    expect([pixel(png, 40, 3, 9)[0], pixel(png, 40, 2, 9)[0]]).toEqual([0, 255]);
    expect(Raster.textWidth("SEND", 3)).toBe(69);
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow();
  });

  it("the demo toolbar is a valid PNG whose three boxes sit inside it", () => {
    const toolbar = demoToolbar();
    const image = parseImage(toolbar.dataUrl);
    expect(image).toMatchObject({ kind: "png", width: 480, height: 120 });
    expect(image.dataUrl).toBe(toolbar.dataUrl);
    for (const b of toolbar.boxes) expect(b.x + b.width <= 480 && b.y + b.height <= 120).toBe(true);
    const png = pngBytes(toolbar.dataUrl);
    expect(pixel(png, 480, 26, 38)).toEqual([26, 115, 232, 255]); // inside the blue SEND button
    expect(png.length).toBeLessThan(10_000);
  });
});

describe("parseImage", () => {
  it("reads PNG and JPEG sizes from their headers and rebuilds a canonical data URL", () => {
    const jpeg = fakeJpeg(1280, 720);
    for (const prefix of ["data:image/jpeg;base64,", "data:image/jpg;base64,", "DATA:IMAGE/JPEG;base64,"]) {
      const image = parseImage(prefix + jpeg.toString("base64"));
      expect(image).toMatchObject({ kind: "jpeg", width: 1280, height: 720, bytes: jpeg.length });
      expect(image.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    }
  });

  it("rejects a JPEG without a frame header and a PNG without IHDR", () => {
    const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    expect(rejection(`data:image/jpeg;base64,${noFrame.toString("base64")}`).message).toContain("width and height");
    const bare = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(rejection(`data:image/png;base64,${bare.toString("base64")}`).message).toContain("width and height");
  });

  it("rejects images over the byte limit (413) before decoding, and over the patch limit (413)", () => {
    const over = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    const err = rejection(`data:image/png;base64,${over.toString("base64")}`);
    expect([err.status, err.message]).toEqual([413, `image is larger than ${MAX_IMAGE_BYTES} bytes`]);
    const huge = pngBytes(new Raster(1, 1).dataUrl());
    huge.writeUInt32BE(10_000, 16);
    huge.writeUInt32BE(10_000, 20);
    expect(rejection(`data:image/png;base64,${huge.toString("base64")}`).status).toBe(413);
    // 30,000 patches exactly is allowed: 32 * 150 x 32 * 200.
    const edge = pngBytes(new Raster(1, 1).dataUrl());
    edge.writeUInt32BE(4800, 16);
    edge.writeUInt32BE(6400, 20);
    expect(parseImage(`data:image/png;base64,${edge.toString("base64")}`)).toMatchObject({ width: 4800, height: 6400 });
  });

  it("rejects bad base64, empty payloads and non-image types without echoing the value", () => {
    const secret = "c2VjcmV0LXNjcmVlbg"; // no padding, length 18
    expect(rejection(`data:image/png;base64,${secret}`).message).toBe("image is not valid base64");
    expect(rejection("data:image/png;base64,").message).toBe("image is not valid base64");
    expect(rejection("data:image/png;base64,@@@@").message).toBe("image is not valid base64");
    expect(rejection("data:image/webp;base64,UklGRg==").message).toContain("PNG or JPEG");
    expect(rejection(null).message).toBe("image must be a data URL string");
  });
});

describe("reply helpers", () => {
  it("cleanLabel trims, strips quotes and invisible characters, clips at 40 and drops personal data", () => {
    expect(cleanLabel('  "Attach file"  ')).toBe("Attach file");
    expect(cleanLabel("\u200BSe\u00ADnd\uFEFF")).toBe("Send");
    // An override reverses what is shown ("dneS" on screen): refused, not cleaned.
    expect(cleanLabel("\u202ESend\u202C")).toBeNull();
    expect(cleanLabel("   ")).toBeNull();
    expect(cleanLabel(null)).toBeNull();
    expect(cleanLabel("Call +1 519 555 0142")).toBeNull();
    expect(cleanLabel("Email alex.chen.dev@example.com")).toBeNull();
    expect(cleanLabel("Page 2 of 10")).toBe("Page 2 of 10");
    expect(cleanLabel("x".repeat(50))).toHaveLength(40);
  });

  it("cleanText removes every invisible character a person would not see, and folds look-alike forms", () => {
    // Soft hyphen, combining grapheme joiner, Mongolian vowel separator, variation selectors, Unicode tags, zero-width.
    for (const hidden of ["\u00AD", "\u034F", "\u180E", "\uFE0F", "\u{E0020}", "\u{E0041}", "\u{E0100}", "\u200B", "\u2060", "\uFEFF"]) {
      expect(cleanText(`Se${hidden}nd`)).toBe("Send");
    }
    // Hidden instructions spelled in tag characters vanish entirely.
    const tags = [..."ignore previous"].map((ch) => String.fromCodePoint(0xe0000 + (ch.codePointAt(0) ?? 0))).join("");
    expect(cleanText(`Reply${tags}`)).toBe("Reply");
    expect(cleanText("\uFF33\uFF45\uFF4E\uFF44")).toBe("Send"); // fullwidth
    expect(cleanText("Send\n\tnow\u0085")).toBe("Send now"); // controls are spaces
    expect(reordersText("\u202EdrowssaP")).toBe(true);
    expect(reordersText("\u2067Send\u2069")).toBe(true);
    expect(reordersText("Send \u200F")).toBe(false); // a plain RTL mark reorders nothing
  });

  it("imageView follows each model's documented resizing, so coordinates can be mapped back", () => {
    const view = (model: string, width: number, height: number) => imageView(model, { width, height });
    // gpt-5.6 / gpt-6 `original` keeps the size (the 30,000-patch limit is a rejection, checked in parseImage).
    expect(view("gpt-5.6-luna", 4000, 3000)).toEqual({ width: 4000, height: 3000, scaleX: 1, scaleY: 1 });
    expect(view("gpt-6-astra", 4000, 3000)).toMatchObject({ width: 4000, height: 3000 });
    // gpt-5.4 / gpt-5.5 `original`: 10,000 patches and 6000 px, by the guide's shrink_factor algorithm.
    const shrunk = view("gpt-5.4", 4000, 3000);
    expect([shrunk.width, shrunk.height]).toEqual([3669, 2752]);
    expect(Math.ceil(shrunk.width / 32) * Math.ceil(shrunk.height / 32)).toBeLessThanOrEqual(10_000);
    expect(view("gpt-5.5", 8000, 1000)).toEqual({ width: 6000, height: 750, scaleX: 0.75, scaleY: 0.75 });
    expect(view("gpt-5.4-mini", 6000, 6000)).toMatchObject({ width: 3200, height: 3200 });
    // gpt-5.2 / gpt-4.1-mini `high`: 2048 px and 6,144 patches.
    expect(view("gpt-5.2", 3000, 1000)).toMatchObject({ width: 2048, height: 683 });
    expect(view("gpt-4.1-mini", 1600, 1000)).toMatchObject({ width: 1600, height: 1000, scaleX: 1 });
    // Tile rules (gpt-4o, gpt-4.1, unknown): fit 2048 x 2048, then the shortest side at most 768.
    expect(view("gpt-4o", 1600, 1000)).toMatchObject({ width: 1228, height: 768 });
    expect(view("gpt-4o", 1536, 1024)).toEqual({ width: 1152, height: 768, scaleX: 0.75, scaleY: 0.75 });
    expect(view("gpt-4.1", 3000, 500)).toMatchObject({ width: 2048, height: 341 });
    expect(view("gpt-4o", 480, 120)).toEqual({ width: 480, height: 120, scaleX: 1, scaleY: 1 });
    expect(modelSettings("gpt-4o").detail).toBe("high");
  });

  it("boxAroundPoint centers a default 24 px box and keeps it inside the image", () => {
    const image = { width: 100, height: 50 };
    expect(boxAroundPoint(image, 50, 25, null, null)).toEqual({ x: 38, y: 13, width: 24, height: 24 });
    expect(boxAroundPoint(image, 0, 0, null, null)).toEqual({ x: 0, y: 0, width: 24, height: 24 });
    expect(boxAroundPoint(image, 100, 50, 10, 10)).toEqual({ x: 90, y: 40, width: 10, height: 10 });
    expect(boxAroundPoint(image, 50, 25, -5, 0)).toEqual({ x: 38, y: 13, width: 24, height: 24 });
    expect(boxAroundPoint({ width: 10, height: 10 }, 5, 5, null, null)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it("outputTextOf reads output_text parts of message items and ignores reasoning items", () => {
    const response = { status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: '{"a":' }, { type: "output_text", text: "1}" }] }] };
    expect(outputTextOf(response)).toBe('{"a":1}');
    const kind = (value: unknown): string => {
      try {
        outputTextOf(value);
        return "ok";
      } catch (err) {
        return err instanceof VisionError ? err.kind : "other";
      }
    };
    expect(kind({ status: "failed", error: { code: "server_error", message: "x" }, output: [] })).toBe("upstream");
    expect(kind({ status: "completed", output: [] })).toBe("malformed");
    expect(kind([])).toBe("malformed");
  });
});

describe("budget and config", () => {
  it("counts units and never goes below zero", () => {
    const budget = new VisionBudget(2);
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false]);
    expect(budget.snapshot()).toEqual({ limit: 2, used: 2, remaining: 0 });
  });

  it("SHABANG_VISION_BUDGET parses whole numbers, 0 included, and keeps the default otherwise", () => {
    expect(budgetLimitFrom(undefined)).toBe(DEFAULT_VISION_BUDGET);
    expect(budgetLimitFrom("")).toBe(200);
    expect(budgetLimitFrom("50")).toBe(50);
    expect(budgetLimitFrom("0")).toBe(0);
    expect(budgetLimitFrom("-3")).toBe(200);
    expect(budgetLimitFrom("2.5")).toBe(200);
    expect(budgetLimitFrom("lots")).toBe(200);
    expect(budgetLimitFrom("99999999")).toBe(100_000);
  });

  it("the process budget is one object however many apps ask for it", () => {
    expect(processVisionBudget(5)).toBe(processVisionBudget(7));
  });

  it("vision needs an OpenAI key that survives the offline switches", () => {
    expect(visionConfigFrom(loadConfig({ OPENAI_API_KEY: "k" }), {})).toMatchObject({ model: "gpt-5.6-luna", baseUrl: "https://api.openai.com/v1" });
    expect(visionConfigFrom(loadConfig({ OPENAI_API_KEY: "k" }), { OPENAI_VISION_MODEL: " gpt-5.6-terra " })?.model).toBe("gpt-5.6-terra");
    expect(visionConfigFrom(loadConfig({ XAI_API_KEY: "k" }), {})).toBeUndefined();
    expect(visionConfigFrom(loadConfig({ OPENAI_API_KEY: "k", SHABANG_PROVIDER: "heuristic" }), {})).toBeUndefined();
    expect(visionConfigFrom(loadConfig({ OPENAI_API_KEY: "k", SHABANG_DECISION_PROVIDER: "heuristic", SHABANG_TEXT_PROVIDER: "template" }), {})).toBeUndefined();
  });
});
