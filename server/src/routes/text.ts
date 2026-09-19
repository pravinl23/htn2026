import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isSensitive, type PastAnswer } from "@ghost/shared";
import type { ServerConfig } from "../config";
import { getMetrics } from "../lib/metrics";
import { sseResponse } from "../lib/sse";
import type { DraftInput } from "../lib/template";
import { createLlmClient } from "../llm/client";
import { createGhostTextService } from "../llm/ghostText";
import { extractProfile } from "../llm/profileExtract";

/** Test seam: the third argument is optional so `registerTextRoutes(app, config)` stays the public signature. */
export interface TextRouteDeps {
  fetch?: typeof fetch;
}

const GHOST_TEXT = "/v1/ghost-text";
const EXTRACT = "/v1/profile/extract";
const LIMITS = { label: 300, signature: 500, name: 200, description: 2000, facts: 50, factKey: 64, factValue: 500, pastAnswers: 3, answer: 2000, resume: 20_000, minMaxChars: 20, maxMaxChars: 5000 };

class BadRequest extends Error {}

export function registerTextRoutes(app: Hono, config: ServerConfig, deps: TextRouteDeps = {}): void {
  const client = config.textProvider !== "template" && config.llm ? createLlmClient(config.llm, { fetch: deps.fetch }) : undefined;
  const ghostText = createGhostTextService(client);
  const metrics = getMetrics(config);
  const tooLarge = (c: Context): Response => c.json({ error: "request body too large" }, 413);

  const record = (route: string, result: { provider: string; latencyMs: number; cache?: "hit" | "miss"; firstTokenMs?: number; fallbackFrom?: string }): void => {
    metrics.recordRequest(route, result);
    // The template path has no cache, so it must not drag the hit rate down.
    if (client && result.cache) metrics.recordCache(result.cache === "hit");
    if (result.provider !== "template" && result.provider !== "regex") logCall(route, result);
  };

  app.post(GHOST_TEXT, bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }), async (c) => {
    const input = await readBody(c, parseGhostTextBody);
    if (input instanceof Response) return input;
    if (c.req.query("stream") === "0") {
      const result = await ghostText.draft(input);
      record(GHOST_TEXT, result);
      return c.json(result);
    }
    return sseResponse(async (send, signal) => {
      const result = await ghostText.draft(input, (delta) => send({ delta }), signal);
      record(GHOST_TEXT, result);
      send({ done: true, ...result });
    });
  });

  app.post(EXTRACT, bodyLimit({ maxSize: 128 * 1024, onError: tooLarge }), async (c) => {
    const resumeText = await readBody(c, parseExtractBody);
    if (resumeText instanceof Response) return resumeText;
    const result = await extractProfile(resumeText, client);
    record(EXTRACT, result);
    return c.json({ ...result, pastAnswers: [] });
  });
}

/** One line per model call: numbers and names only, never field values, profile values or keys. */
function logCall(route: string, r: { provider: string; latencyMs: number; cache?: string; firstTokenMs?: number }): void {
  if (process.env.VITEST) return;
  const firstToken = r.firstTokenMs === undefined ? "" : ` firstTokenMs=${r.firstTokenMs}`;
  console.log(`[ghost] ${r.provider} ${route} ${r.latencyMs}ms${firstToken} calibrated=false cache=${r.cache ?? "miss"}`);
}

async function readBody<T>(c: Context, parse: (body: unknown) => T): Promise<T | Response> {
  try {
    return parse(await c.req.json());
  } catch (err) {
    return c.json({ error: err instanceof BadRequest ? err.message : "body must be valid JSON" }, 400);
  }
}

function parseGhostTextBody(body: unknown): DraftInput {
  const b = asRecord(body, "body");
  const fieldLabel = requiredString(b.fieldLabel, "fieldLabel", LIMITS.label);
  if (isSensitive({ label: fieldLabel })) throw new BadRequest("fieldLabel looks sensitive; Ghost never drafts text for sensitive fields");
  if (b.fieldSignature !== undefined) requiredString(b.fieldSignature, "fieldSignature", LIMITS.signature);
  const page = b.pageContext === undefined ? {} : asRecord(b.pageContext, "pageContext");
  return {
    fieldLabel,
    maxChars: parseMaxChars(b.maxChars),
    pageContext: { company: optionalText(page.company, "pageContext.company", LIMITS.name), role: optionalText(page.role, "pageContext.role", LIMITS.name), description: optionalText(page.description, "pageContext.description", LIMITS.description) },
    facts: parseFacts(b.facts),
    pastAnswers: parsePastAnswers(b.pastAnswers),
  };
}

function parseExtractBody(body: unknown): string {
  const text = asRecord(body, "body").resumeText;
  if (typeof text !== "string" || !text.trim()) throw new BadRequest("resumeText must be a non-empty string");
  if (text.length > LIMITS.resume) throw new BadRequest(`resumeText must be at most ${LIMITS.resume} characters`);
  return text;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadRequest(`${name} must be a JSON object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequest(`${name} must be a non-empty string`);
  if (value.length > max) throw new BadRequest(`${name} must be at most ${max} characters`);
  return value.trim();
}

/** Long context is truncated rather than rejected: a clipped job description still makes a useful draft. */
function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadRequest(`${name} must be a string`);
  return value.trim().slice(0, max) || undefined;
}

function parseMaxChars(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < LIMITS.minMaxChars) throw new BadRequest(`maxChars must be a number of at least ${LIMITS.minMaxChars}`);
  return Math.min(LIMITS.maxMaxChars, Math.floor(value));
}

function parseFacts(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const entries = Object.entries(asRecord(value, "facts"));
  if (entries.length > LIMITS.facts) throw new BadRequest(`facts must have at most ${LIMITS.facts} entries`);
  const facts: Record<string, string> = {};
  for (const [key, v] of entries) {
    if (typeof v !== "string" || key.length > LIMITS.factKey) throw new BadRequest("facts must map short keys to strings");
    // Defence in depth: the extension should never send these, and they must never reach a prompt.
    if (v.trim() && !isSensitive({ name: key })) facts[key] = v.trim().slice(0, LIMITS.factValue);
  }
  return facts;
}

function parsePastAnswers(value: unknown): PastAnswer[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BadRequest("pastAnswers must be an array");
  return value.slice(0, LIMITS.pastAnswers).map((item) => {
    const p = asRecord(item, "pastAnswers[]");
    const question = optionalText(p.question, "pastAnswers[].question", LIMITS.label);
    const answer = optionalText(p.answer, "pastAnswers[].answer", LIMITS.answer);
    if (!question || !answer) throw new BadRequest("pastAnswers[] needs a non-empty question and answer");
    return { question, answer };
  });
}
