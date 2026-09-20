import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { registerVisionRoutes } from "../../src/routes/vision";
import { VisionBudget } from "../../src/vision/budget";
import { LabelCache } from "../../src/vision/cache";
import { demoIconRow, demoMixedPage, demoToolbar } from "../../src/vision/testing";

/**
 * Live only (`pnpm test:live vision`). THREE real Responses API calls per run, capped by the budget below (a 5xx retry
 * would take the fourth unit). Every image is drawn in code (src/vision/png.ts, src/vision/testing.ts): no binary
 * fixture, no screenshot of anyone's screen, nothing from a real site.
 *
 * What it proves, against the real API:
 * 1. icon-only controls with no text anywhere get names, and those names map onto the affordance roles of
 *    docs/anywhere.md section 2 (`play`, `next`, `fullscreen`): the YouTube case, with no site-specific rule anywhere.
 * 2. the per-page cache answers the second visit with no call at all.
 * 3. 20 boxes are labelled in ONE call, and code re-locks what the model left unlocked.
 * 4. locate points at a named control among supplied boxes.
 */
const hasKey = Boolean(process.env.OPENAI_API_KEY);

interface LiveLabel {
  id: string;
  label: string | null;
  role: string;
  affordance: string;
  irreversible: boolean;
  sensitive: boolean;
  confidence: number;
}

function liveApp(): { app: Hono; budget: VisionBudget } {
  // Only the OpenAI variables: offline switches from a developer's shell must not turn this test into a 503.
  const config = loadConfig({ OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL });
  const app = new Hono();
  const budget = new VisionBudget(4);
  // The server's own log line, printed here: it carries the token counts docs/openai.md quotes its cost numbers from.
  registerVisionRoutes(app, config, {
    env: { OPENAI_VISION_MODEL: process.env.OPENAI_VISION_MODEL },
    budget,
    cache: new LabelCache(),
    log: (line) => console.log(line),
  });
  return { app, budget };
}

async function post(app: Hono, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const labelsOf = (json: Record<string, unknown>): LiveLabel[] => (json.labels ?? []) as LiveLabel[];

const show = (labels: LiveLabel[]): string =>
  labels.map((l) => `${l.id}=${JSON.stringify(l.label)}/${l.affordance}${l.irreversible ? "/LOCKED" : ""}/${l.confidence.toFixed(2)}`).join(" ");

describe.skipIf(!hasKey)("live OpenAI vision", () => {
  const { app, budget } = hasKey ? liveApp() : { app: new Hono(), budget: new VisionBudget(0) };
  const iconRow = demoIconRow();
  const mixed = demoMixedPage();
  const toolbar = demoToolbar();

  it("names three icon-only controls in ONE call and maps them onto affordance roles", async () => {
    const body = { image: iconRow.dataUrl, boxes: iconRow.boxes, context: { app: "Video player", nearbyText: ["0:12 / 3:45"] }, page: { pathPattern: "/watch" } };
    const { status, json } = await post(app, "/v1/vision/label", body);
    const labels = labelsOf(json);
    console.log(`[live] vision/label 3 boxes status=${status} model=${String(json.model)} latencyMs=${String(json.latencyMs)} cached=${String(json.cached)} ${show(labels)}`);
    expect(status).toBe(200);
    expect(json.provider).toBe("openai");
    expect(json.cached).toBe(false);
    expect(labels.map((l) => l.id)).toEqual(["play", "next", "fullscreen"]);
    // Every icon gets a name: an accessibility tree would have none of these.
    expect(labels.every((l) => l.label !== null && l.label.length > 0)).toBe(true);
    expect(labels.map((l) => l.affordance)).toEqual(["play", "next", "fullscreen"]);
    // Nothing on a player bar is irreversible, and nothing here is a field.
    expect(labels.some((l) => l.irreversible || l.sensitive)).toBe(false);

    // Same page, same geometry: the second visit is free (no call, no budget unit).
    const before = budget.remaining();
    const again = await post(app, "/v1/vision/label", body);
    console.log(`[live] vision/label repeat cached=${String(again.json.cached)} latencyMs=${String(again.json.latencyMs)} budget=${budget.remaining()}`);
    expect(again.status).toBe(200);
    expect(again.json.cached).toBe(true);
    expect(labelsOf(again.json)).toEqual(labels);
    expect(budget.remaining()).toBe(before);
  });

  it("labels 20 boxes in ONE call and re-locks what the model left unlocked", async () => {
    const started = Date.now();
    const { status, json } = await post(app, "/v1/vision/label", { image: mixed.dataUrl, boxes: mixed.boxes, context: { app: "Ghost demo page" } });
    const labels = labelsOf(json);
    const byId = new Map(labels.map((l) => [l.id, l]));
    console.log(
      `[live] vision/label 20 boxes status=${status} latencyMs=${String(json.latencyMs)} wallMs=${Date.now() - started} named=${labels.filter((l) => l.label !== null).length}/20\n` +
        `[live] ${show(labels)}`,
    );
    expect(status).toBe(200);
    expect(labels).toHaveLength(20);
    // At least the text buttons must be named; the icons are the hard half.
    expect(labels.filter((l) => l.label !== null).length).toBeGreaterThanOrEqual(16);
    // Rule 2: code re-derives the lock from the label, whatever the model said.
    expect(byId.get("btn-send")?.irreversible).toBe(true);
    expect(byId.get("btn-checkout")?.irreversible).toBe(true);
    expect(byId.get("btn-search")?.irreversible).toBe(false);
    // The affordance taxonomy covers a whole page, not just a form: a shop, a mailbox and a player bar in one call.
    expect(byId.get("btn-search")?.affordance).toBe("search");
    expect(byId.get("btn-cart")?.affordance).toBe("cart");
    expect(byId.get("btn-checkout")?.affordance).toBe("checkout");
    expect(byId.get("play")?.affordance).toBe("play");
    expect(byId.get("fullscreen")?.affordance).toBe("fullscreen");
    // 18 of 20 on the run recorded in docs/openai.md. "More" needs "More options" in the shared vocabulary, and "Back"
    // is suppressed because this whole-page batch reads as a media cluster; a real client crops the player bar alone.
    expect(labels.filter((l) => l.affordance !== "unknown").length).toBeGreaterThanOrEqual(16);
  });

  it("locates 'the cancel button' among the supplied boxes", async () => {
    const { status, json } = await post(app, "/v1/vision/locate", { image: toolbar.dataUrl, instruction: "the cancel button", boxes: toolbar.boxes });
    console.log(`[live] vision/locate status=${status} latencyMs=${String(json.latencyMs)} boxId=${String(json.boxId)} confidence=${String(json.confidence)}`);
    expect(status).toBe(200);
    expect(json.boxId).toBe("cancel");
    expect(json.box).toEqual({ x: 176, y: 36, width: 156, height: 48 });
  });
});
