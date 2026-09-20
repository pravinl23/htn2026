import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import type { ScanResult } from "../../src/facts/scan";
import { registerFactsRoutes } from "../../src/routes/facts";

/**
 * Live only (`pnpm test:live`, which exits early without keys). FOUR real calls at most for the whole
 * file: two to GitHub's public API (the profile, then the same profile with its ETag) and one model call
 * for one short document, plus one decision call for one conflict when a decision provider is configured.
 *
 * "octocat" is GitHub's own example account, so no real person's profile is read. Every other document
 * here is fictional.
 */

const hasAnyKey = Boolean(process.env.TYPESAFE_API_KEY || process.env.AI_GATEWAY_API_KEY || process.env.BASETEN_API_KEY || process.env.OPENAI_API_KEY || process.env.XAI_API_KEY);
const hasTextModel = Boolean(process.env.BASETEN_API_KEY || process.env.OPENAI_API_KEY || process.env.XAI_API_KEY);
/** Only Jev answers the conflict question here: one question is one request. Baseten would fan one decision out to K + H. */
const hasJev = ["typesafe", "jev-gateway"].includes(loadConfig(process.env).decisionProvider);

const SIGNATURE = [
  "Jordan Reyes",
  "Principal Designer at Kestrel Yard Software",
  "jordan.reyes@kestrelyard.test | +1 416 555 0134",
  "Toronto, Ontario",
].join("\n");

function liveApp(): { app: Hono; decisionProvider: string; textProvider: string } {
  const config = loadConfig(process.env);
  const app = new Hono();
  registerFactsRoutes(app, config);
  return { app, decisionProvider: config.decisionProvider, textProvider: config.textProvider };
}

async function scan(app: Hono, body: unknown): Promise<ScanResult> {
  const res = await app.request("/v1/facts/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as ScanResult;
}

function report(name: string, result: ScanResult): void {
  const sources = result.sources.map((s) => `${s.kind}=${s.status}${s.reason ? `(${s.reason})` : ""}/${s.latencyMs}ms`).join(" ");
  console.log(`[live] facts/scan ${name} ${result.latencyMs}ms ${sources} proposals=${result.proposals.length} modelCalls=${result.modelCalls} conflicts=${result.conflicts.length} sensitiveDropped=${result.sensitiveDropped} provider=${result.provider}`);
}

describe.skipIf(!hasAnyKey)("live fact scan", () => {
  it("reads GitHub's example profile with no token, then answers 304 for the same ETag", async () => {
    const { app } = liveApp();
    // Two real calls to api.github.com. model:false keeps the model out of it: a profile is structured already.
    const first = await scan(app, { sources: [{ kind: "github", login: "octocat" }], model: false });
    report("github", first);
    const source = first.sources[0];
    expect(source).toMatchObject({ kind: "github", id: "github:octocat", status: "ok" });
    expect(first.modelCalls).toBe(0);

    const values = Object.fromEntries(first.proposals.map((p) => [p.key, p.value]));
    console.log(`[live] facts/scan github keys=${Object.keys(values).join(",")}`);
    expect(values.github).toBe("https://github.com/octocat");
    expect(first.proposals.length).toBeGreaterThanOrEqual(3);
    expect(first.proposals.every((p) => p.source.kind === "github" && p.confidence > 0 && p.label !== "")).toBe(true);

    const etag = source?.etag;
    expect(etag).toBeTruthy();
    const again = await scan(app, { sources: [{ kind: "github", login: "octocat", etag }], model: false });
    report("github-etag", again);
    expect(again.sources[0]?.status).toBe("unchanged");
    expect(again.proposals).toEqual([]);
  });

  it.skipIf(!hasTextModel)("extracts one short document with ONE model call, and keeps only what the document says", async () => {
    const { app, textProvider } = liveApp();
    const result = await scan(app, { sources: [{ kind: "text", text: SIGNATURE, origin: "mail", name: "live-fixture" }] });
    report(`text(${textProvider})`, result);
    console.log(`[live] facts/scan text keys=${result.proposals.map((p) => `${p.key}@${p.confidence}`).join(",")}`);
    expect(result.modelCalls).toBe(1);
    expect(result.sources[0]).toMatchObject({ status: "ok", modelCalls: 1 });
    const values = Object.fromEntries(result.proposals.map((p) => [p.key, p.value]));
    expect(values.email).toBe("jordan.reyes@kestrelyard.test");
    expect(result.proposals.length).toBeGreaterThanOrEqual(3);
    // The verbatim rule, checked against a real model: nothing it invented can survive.
    const document = SIGNATURE.toLowerCase().replace(/[^a-z0-9@]+/g, "");
    for (const proposal of result.proposals) {
      expect(document).toContain(proposal.value.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9@]+/g, ""));
    }
  });

  it.skipIf(!hasJev)("asks Jev once when two documents disagree", async () => {
    const { app, decisionProvider } = liveApp();
    // model:false so this costs exactly ONE real call: the conflict question.
    const result = await scan(app, {
      sources: [
        { kind: "text", text: "Jordan Reyes\nPrincipal Designer at Kestrel Yard Software\njordan@kestrelyard.test", origin: "mail", name: "old-signature" },
        { kind: "text", text: "Jordan Reyes\nPrincipal Designer at Northwind Robotics\njordan@kestrelyard.test", origin: "mail", name: "new-signature" },
      ],
      model: false,
    });
    report(`conflict(${decisionProvider})`, result);
    const conflict = result.conflicts.find((c) => c.key === "work.employer.current");
    console.log(`[live] facts/scan conflict resolvedBy=${conflict?.resolvedBy} confidence=${conflict?.confidence} provider=${result.provider}`);
    expect(conflict).toMatchObject({ candidates: 2 });
    expect(result.modelCalls).toBe(1);
    expect(["Kestrel Yard Software", "Northwind Robotics"]).toContain(result.proposals.find((p) => p.key === "work.employer.current")?.value);
  });
});
