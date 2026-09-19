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
