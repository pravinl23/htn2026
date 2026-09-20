import { createGhostWalkReplayFixture } from "@ghost/shared";
import type { GhostWalkOutcome } from "@ghost/shared";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { sentryClient } from "../src/observability/instrument";
import { createWalkOutcomeSink } from "../src/telemetry/walkOutcomes";

const OUTCOME: GhostWalkOutcome = {
  schemaVersion: "ghost.walk-outcome.v1",
  runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  state: "parked",
  reason: "locked-action",
  duration: "250-999ms",
  provider: "typesafe",
  latency: "100-249ms",
  proposals: [
    {
      index: 1,
      action: "select",
      source: "server",
      calibrated: true,
      confidence: "95-plus",
      locked: false,
      outcome: "typed-over",
      answer: { class: "declaration", source: "guess", needsReview: true },
    },
    { index: 2, action: "click", source: "offline", calibrated: false, confidence: "95-plus", locked: true, outcome: "unresolved" },
  ],
  summary: { shown: 2, accepted: 0, dismissed: 1, locked: 1 },
};

afterAll(async () => {
  await sentryClient()?.close(1_000);
});

describe("real Sentry SDK transport", () => {
  it("delivers a depth-4 walk plus replay attachment to a local ingest without [Object] mangling", async () => {
    const envelopes: string[] = [];
    const ingest = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const bytes = Buffer.concat(chunks);
        envelopes.push(request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8"));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
    try {
      const address = ingest.address();
      if (!address || typeof address === "string") throw new Error("fake ingest did not bind a port");
      const config = loadConfig({
        SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
        SENTRY_ENVIRONMENT: "test",
        SENTRY_RELEASE: "ghost@test",
      });
      const eventId = await createWalkOutcomeSink(config).capture(OUTCOME, createGhostWalkReplayFixture(OUTCOME));
      expect(eventId).toMatch(/^[0-9a-f]{32}$/);
      const sent = envelopes.join("\n");
      expect(sent).toContain("ghost.walk.parked");
      expect(sent).toContain("walk-replay-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json");
      expect(sent).toContain('"class":"declaration"');
      expect(sent).not.toContain("[Object]");
    } finally {
      await new Promise<void>((resolve, reject) => ingest.close((error) => error ? reject(error) : resolve()));
    }
  });
});
