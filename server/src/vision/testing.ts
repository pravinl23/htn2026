/** Test-only helpers for the vision routes: fake Responses API replies and a fictional toolbar image. No network, no keys. */
import { Raster, type Rgb } from "./png";

/** A completed Responses API object whose one message carries `answer` as Structured Outputs JSON text. */
export function responsesJson(answer: unknown, extra: Record<string, unknown> = {}): Response {
  return Response.json({
    id: "resp_test",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "gpt-5.6-luna",
    output: [
      { id: "rs_test", type: "reasoning", summary: [] },
      { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: typeof answer === "string" ? answer : JSON.stringify(answer), annotations: [] }] },
    ],
    usage: { input_tokens: 812, output_tokens: 64, total_tokens: 876 },
    ...extra,
  });
}

export function responsesRefusal(): Response {
  return Response.json({ id: "resp_test", object: "response", status: "completed", error: null, output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }] }] });
}

export function responsesIncomplete(): Response {
  return Response.json({ id: "resp_test", object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
}

export function openaiError(status: number): Response {
  return Response.json({ error: { message: "fake upstream error", type: "invalid_request_error", code: null } }, { status });
}

export interface DemoBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const INK: Rgb = [32, 33, 36];
const BLUE: Rgb = [26, 115, 232];
const WHITE: Rgb = [255, 255, 255];
const GRAY: Rgb = [218, 220, 224];

/**
 * A fictional mail toolbar, 480 x 120: a filled "SEND" button, an outlined "CANCEL" button and an icon-only trash can
 * with no text at all (the case an accessibility tree leaves unlabeled).
 */
export function demoToolbar(): { dataUrl: string; width: number; height: number; boxes: DemoBox[] } {
  const r = new Raster(480, 120, [248, 249, 250]);
  const send = { id: "send", x: 24, y: 36, width: 132, height: 48 };
  const cancel = { id: "cancel", x: 176, y: 36, width: 156, height: 48 };
  const trash = { id: "trash", x: 368, y: 36, width: 48, height: 48 };
  r.fill(send.x, send.y, send.width, send.height, BLUE).text(send.x + (send.width - Raster.textWidth("SEND", 3)) / 2, send.y + 14, "SEND", WHITE, 3);
  r.fill(cancel.x, cancel.y, cancel.width, cancel.height, WHITE).stroke(cancel.x, cancel.y, cancel.width, cancel.height, GRAY, 2);
  r.text(cancel.x + (cancel.width - Raster.textWidth("CANCEL", 3)) / 2, cancel.y + 14, "CANCEL", INK, 3);
  // Trash can: handle, lid, body with three slats.
  const cx = trash.x;
  const cy = trash.y;
  r.fill(cx + 19, cy + 8, 10, 3, INK).fill(cx + 10, cy + 11, 28, 4, INK);
  r.fill(cx + 13, cy + 17, 22, 23, INK).fill(cx + 16, cy + 20, 16, 17, [248, 249, 250]);
  for (const sx of [18, 23, 28]) r.fill(cx + sx, cy + 21, 2, 15, INK);
  return { dataUrl: r.dataUrl(), width: r.width, height: r.height, boxes: [send, cancel, trash] };
}

/** Ink on a dark player bar, and the tinted plate each icon sits on: the "three coloured squares" of the live check. */
const BAR: Rgb = [24, 24, 27];
const PLATE: Rgb[] = [
  [40, 44, 52],
  [52, 40, 44],
  [40, 52, 44],
];

type Draw = (r: Raster, x: number, y: number, size: number, ink: Rgb) => void;

/**
 * Icon-only controls with NO text anywhere, drawn from rectangles, triangles and lines. These are the case Shabang's
 * vision fallback exists for: a DOM or accessibility tree reports "a button" and nothing else.
 */
export const ICONS: Record<string, Draw> = {
  play: (r, x, y, s, ink) => r.triangle(x + s * 0.32, y + s * 0.24, s * 0.42, s * 0.52, ink),
  pause: (r, x, y, s, ink) => r.fill(x + s * 0.32, y + s * 0.26, s * 0.12, s * 0.48, ink).fill(x + s * 0.56, y + s * 0.26, s * 0.12, s * 0.48, ink),
  next: (r, x, y, s, ink) => r.triangle(x + s * 0.24, y + s * 0.26, s * 0.34, s * 0.48, ink).fill(x + s * 0.62, y + s * 0.26, s * 0.1, s * 0.48, ink),
  previous: (r, x, y, s, ink) => r.triangle(x + s * 0.42, y + s * 0.26, s * 0.34, s * 0.48, ink, "left").fill(x + s * 0.28, y + s * 0.26, s * 0.1, s * 0.48, ink),
  // A speaker: a small block, a cone opening to the right, and two sound arcs.
  mute: (r, x, y, s, ink) => {
    r.fill(x + s * 0.24, y + s * 0.42, s * 0.12, s * 0.16, ink).triangle(x + s * 0.36, y + s * 0.28, s * 0.16, s * 0.44, ink, "left");
    r.line(x + s * 0.58, y + s * 0.36, x + s * 0.64, y + s * 0.5, ink, 2).line(x + s * 0.64, y + s * 0.5, x + s * 0.58, y + s * 0.64, ink, 2);
  },
  // A captions plate: a rounded box with two small "C"s, the way a real closed-captions button is drawn.
  captions: (r, x, y, s, ink) => {
    r.stroke(x + s * 0.2, y + s * 0.32, s * 0.6, s * 0.36, ink, 2).text(x + s * 0.3, y + s * 0.4, "CC", ink, Math.max(1, Math.round(s * 0.035)));
  },
  // Four corner brackets: the fullscreen glyph.
  fullscreen: (r, x, y, s, ink) => {
    const [a, b, t, len] = [x + s * 0.26, y + s * 0.3, 3, s * 0.16];
    const [right, bottom] = [x + s * 0.74, y + s * 0.7];
    r.fill(a, b, len, t, ink).fill(a, b, t, len, ink).fill(right - len, b, len, t, ink).fill(right - t, b, t, len, ink);
    r.fill(a, bottom - t, len, t, ink).fill(a, bottom - len, t, len, ink).fill(right - len, bottom - t, len, t, ink).fill(right - t, bottom - len, t, len, ink);
  },
  // Three sliders: the settings glyph.
  settings: (r, x, y, s, ink) => {
    [0.34, 0.5, 0.66].forEach((row, i) => {
      r.fill(x + s * 0.22, y + s * row, s * 0.56, 2, ink).fill(x + s * (0.3 + i * 0.18), y + s * row - 3, 6, 8, ink);
    });
  },
};

/**
 * A row of three icon-only controls on tinted plates, 288 x 96: play, next and fullscreen. Nothing in the image is a
 * word, so a label can only come from the pixels. Used by the live check to prove the affordance mapping end to end.
 */
export function demoIconRow(): { dataUrl: string; width: number; height: number; boxes: DemoBox[] } {
  const r = new Raster(288, 96, BAR);
  const names = ["play", "next", "fullscreen"] as const;
  const boxes = names.map((id, i) => ({ id, x: 24 + i * 88, y: 16, width: 64, height: 64 }));
  boxes.forEach((box, i) => {
    r.fill(box.x, box.y, box.width, box.height, PLATE[i] ?? PLATE[0]!);
    ICONS[names[i]!]!(r, box.x, box.y, box.width, WHITE);
  });
  return { dataUrl: r.dataUrl(), width: r.width, height: r.height, boxes };
}

const GRID_WORDS = ["SEARCH", "CART", "CHECKOUT", "SAVE", "SHARE", "DOWNLOAD", "REPLY", "SEND", "MENU", "SETTINGS", "MORE", "CLOSE", "BACK"] as const;

/**
 * A whole fictional page, 640 x 448 with 20 boxes: a player bar of 7 icon-only controls over a grid of 13 text buttons.
 * The batching case from docs/anywhere.md section 4 (up to 40 boxes in ONE call) and the shape the 20-box latency
 * number in docs/openai.md is measured on.
 */
export function demoMixedPage(): { dataUrl: string; width: number; height: number; boxes: DemoBox[] } {
  const r = new Raster(640, 448, [248, 249, 250]);
  r.fill(0, 0, 640, 96, BAR);
  const bar = ["previous", "play", "next", "mute", "captions", "settings", "fullscreen"] as const;
  const boxes: DemoBox[] = bar.map((id, i) => ({ id, x: 20 + i * 86, y: 18, width: 60, height: 60 }));
  boxes.forEach((box, i) => ICONS[bar[i]!]!(r, box.x, box.y, box.width, WHITE));
  GRID_WORDS.forEach((word, i) => {
    // `btn-` prefixed: the player bar above already owns the bare names (its settings icon and the SETTINGS button).
    const box = { id: `btn-${word.toLowerCase()}`, x: 24 + (i % 4) * 152, y: 128 + Math.floor(i / 4) * 76, width: 132, height: 48 };
    r.fill(box.x, box.y, box.width, box.height, WHITE).stroke(box.x, box.y, box.width, box.height, GRAY, 2);
    r.text(box.x + (box.width - Raster.textWidth(word, 2)) / 2, box.y + 17, word, INK, 2);
    boxes.push(box);
  });
  return { dataUrl: r.dataUrl(), width: r.width, height: r.height, boxes };
}
