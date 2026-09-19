import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { registerVisionRoutes } from "../../src/routes/vision";
import { VisionBudget } from "../../src/vision/budget";
import { demoToolbar } from "../../src/vision/testing";

// Live only (pnpm test:live). At most two real Responses API calls per run, enforced by the budget below.
// The image is a fictional toolbar drawn in code (src/vision/testing.ts): SEND, CANCEL and an icon-only trash can.
const hasKey = Boolean(process.env.OPENAI_API_KEY);

function liveApp(): Hono {
  // Only the OpenAI variables: offline switches from a developer's shell must not turn this test into a 503.
  const config = loadConfig({ OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL });
  const app = new Hono();
  registerVisionRoutes(app, config, { env: { OPENAI_VISION_MODEL: process.env.OPENAI_VISION_MODEL }, budget: new VisionBudget(2) });
  return app;
}

async function post(app: Hono, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe.skipIf(!hasKey)("live OpenAI vision", () => {
  const app = hasKey ? liveApp() : new Hono();
  const toolbar = demoToolbar();

  it("labels three boxes on a generated toolbar in ONE call, and code keeps Send locked", async () => {
    const { status, json } = await post(app, "/v1/vision/label", { image: toolbar.dataUrl, boxes: toolbar.boxes, context: { app: "Mail" } });
    const labels = (json.labels ?? []) as Array<{ id: string; label: string | null; role: string; irreversible: boolean; confidence: number }>;
    console.log(
      `[live] vision/label status=${status} model=${String(json.model)} latencyMs=${String(json.latencyMs)} ` +
        labels.map((l) => `${l.id}=${JSON.stringify(l.label)}/${l.role}/locked=${l.irreversible}/${l.confidence.toFixed(2)}`).join(" "),
    );
    expect(status).toBe(200);
    expect(json.provider).toBe("openai");
    expect(labels.map((l) => l.id)).toEqual(["send", "cancel", "trash"]);
    expect(labels[0]?.label ?? "").toMatch(/send/i);
    expect(labels[0]?.irreversible).toBe(true);
    expect(labels[1]?.label ?? "").toMatch(/cancel/i);
    expect(labels[2]?.label).not.toBeNull(); // the icon-only control: the whole point of the vision fallback
  });

  it("locates 'the cancel button' among the supplied boxes", async () => {
    const { status, json } = await post(app, "/v1/vision/locate", { image: toolbar.dataUrl, instruction: "the cancel button", boxes: toolbar.boxes });
    console.log(`[live] vision/locate status=${status} latencyMs=${String(json.latencyMs)} boxId=${String(json.boxId)} confidence=${String(json.confidence)}`);
    expect(status).toBe(200);
    expect(json.boxId).toBe("cancel");
    expect(json.box).toEqual({ x: 176, y: 36, width: 156, height: 48 });
  });
});
