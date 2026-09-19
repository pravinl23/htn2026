import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { SynthesizeResult } from "../../src/loop/synthesize";
import { SHORTHAND_INVOICES, synthesizeBody } from "../../src/loop/testing";
import { registerLoopRoutes } from "../../src/routes/loop";

// Live only (pnpm test:live). Exactly ONE real call per run: two open steps in one question.
// Typed "Thistledown" where the page says "Thistledown Textiles" (first-word), typed "2001" where it says "INV-2001" (digits-only).
const config = loadConfig({ ...process.env, GHOST_DECISION_PROVIDER: undefined, GHOST_TEXT_PROVIDER: undefined, GHOST_PROVIDER: undefined });

describe.skipIf(!config.llm)("live: loop synthesis through the LLM", () => {
  it("resolves both shorthand columns in one verified call", async () => {
    const app = new Hono();
    const lines: string[] = [];
    registerLoopRoutes(app, config, { timeoutMs: 20_000, log: (line) => lines.push(line) });
    const res = await app.request("/v1/loop/synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(synthesizeBody(SHORTHAND_INVOICES)) });
    const json = (await res.json()) as SynthesizeResult;
    const picked = (json.program?.steps ?? []).flatMap((s) => (s.op === "extract" ? [`${s.var}<-${s.from.locator.value}:${s.from.transform ?? "none"}`] : []));
    // Names, counts and timings only: never a key, and the fixture is fictional.
    console.log(`[live] loop/synthesize provider=${json.provider} model=${json.model ?? "?"} latencyMs=${json.latencyMs} modelCalls=${json.modelCalls} resolvedByModel=${json.resolvedByModel} unresolved=${json.unresolved.length}${json.fallbackFrom ? ` fallbackFrom=${json.fallbackFrom}` : ""}`);
    console.log(`[live] loop/synthesize extracts=${picked.join(" ")}`);

    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1);
    expect(json.provider).toBe("llm");
    expect(json.modelCalls).toBe(1);
    expect(json.resolvedByModel).toBe(2);
    expect(json.unresolved).toEqual([]);
    expect(picked).toContain("vendor<-vendor:first-word");
    // The page heading ("Invoice INV-2001") verifies under digits-only too, so either locator is a correct, code-checked answer.
    expect(picked.some((p) => p.startsWith("invoiceNumber<-") && p.endsWith(":digits-only"))).toBe(true);
  });
});
