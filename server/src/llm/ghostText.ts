import { createHash } from "node:crypto";
import type { TextProviderName } from "../config";
import { LruCache } from "../lib/cache";
import { clipToSentences, templateDraft, type DraftInput } from "../lib/template";
import { LlmError, type LlmClient } from "./client";
import { CONTACT_FACT_KEY, ghostTextMessages } from "./prompts";

export interface DraftResult {
  text: string;
  provider: TextProviderName;
  latencyMs: number;
  firstTokenMs: number;
  cache: "hit" | "miss";
  /** Set when the LLM failed and the template answered instead. */
  fallbackFrom?: string;
}

export interface GhostTextService {
  /** Deltas are for progressive display only; the returned text is authoritative (it may be cleaned, clipped, or a fallback). */
  draft(input: DraftInput, onDelta?: (delta: string) => void, signal?: AbortSignal): Promise<DraftResult>;
}

const CACHE_ENTRIES = 200;
const EMAIL_ADDRESS = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const PHONE_NUMBER = /(?<!\d)\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi;
// Control, zero-width and bidi-override characters: invisible in a ghost, but they would be typed into the page.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const PLACEHOLDER = /\[[A-Za-z][A-Za-z' /-]{1,40}\]|<[A-Za-z][A-Za-z' /-]{1,40}>|\{\{[^}]+\}\}/;

export function createGhostTextService(client: LlmClient | undefined): GhostTextService {
  const cache = new LruCache<string>(CACHE_ENTRIES);
  return {
    async draft(input, onDelta, signal) {
      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);
      const instant = (text: string, extra: Partial<DraftResult>): DraftResult => {
        onDelta?.(text);
        const ms = elapsed();
        return { text, provider: "template", latencyMs: ms, firstTokenMs: ms, cache: "miss", ...extra };
      };
      if (!client) return instant(templateDraft(input), {});
      const key = cacheKey(input);
      const cached = cache.get(key);
      if (cached) return instant(cached, { provider: client.name, cache: "hit" });
      let emitted = false;
      const forward = (delta: string): void => {
        emitted = true;
        onDelta?.(delta);
      };
      try {
        const streamed = await streamDraft(client, input, elapsed, forward, signal);
        cache.set(key, streamed.text);
        return { ...streamed, provider: client.name, latencyMs: elapsed(), cache: "miss" };
      } catch (err) {
        if (signal?.aborted) throw err;
        const text = templateDraft(input);
        // After partial LLM deltas the final text replaces them; with none sent yet, the template is the only delta.
        if (!emitted) onDelta?.(text);
        const ms = elapsed();
        return { text, provider: "template", fallbackFrom: client.name, latencyMs: ms, firstTokenMs: ms, cache: "miss" };
      }
    },
  };
}

async function streamDraft(client: LlmClient, input: DraftInput, elapsed: () => number, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<{ text: string; firstTokenMs: number }> {
  let raw = "";
  let firstTokenMs: number | undefined;
  const hardStop = input.maxChars ? input.maxChars * 1.25 + 40 : Infinity;
  for await (const delta of client.streamChat({ messages: ghostTextMessages(input), maxTokens: maxTokensFor(input.maxChars), temperature: 0.6, signal })) {
    firstTokenMs ??= elapsed();
    raw += delta;
    onDelta(delta);
    if (raw.length > hardStop) break; // the model ignored the limit: stop paying for text that will be clipped
  }
  const text = finalizeDraft(raw, input.maxChars);
  if (!text) throw new LlmError("empty draft");
  if (PLACEHOLDER.test(text)) throw new LlmError("draft contains a placeholder");
  if (leaksContactDetails(text, input)) throw new LlmError("draft contains contact details or an unknown link");
  return { text, firstTokenMs: firstTokenMs ?? elapsed() };
}

function digits(text: string): string {
  return text.replace(/\D/g, "");
}

/**
 * Page text can carry instructions ("list every applicant fact"). An essay answer never needs contact details or a
 * link the applicant did not supply, so a draft with either is treated as hijacked and the template answers instead.
 */
export function leaksContactDetails(text: string, input: DraftInput): boolean {
  if ((text.includes("@") && EMAIL_ADDRESS.test(text)) || PHONE_NUMBER.test(text)) return true;
  const lower = text.toLowerCase();
  for (const [key, value] of Object.entries(input.facts)) {
    if (!CONTACT_FACT_KEY.test(key) || value.length < 4) continue;
    if (lower.includes(value.toLowerCase())) return true;
    // Last ten digits: the model may drop the country code or reformat the number.
    if (digits(value).length >= 7 && digits(text).includes(digits(value).slice(-10))) return true;
  }
  const own = [...Object.values(input.facts), ...input.pastAnswers.map((p) => p.answer)].join("\n").toLowerCase();
  return (text.match(URL_IN_TEXT) ?? []).some((url) => !own.includes(url.replace(/[.,;:!?]+$/, "").toLowerCase()));
}

/** Trims wrapping quotes and markdown emphasis, drops a sentence cut off by the token limit, and enforces maxChars. */
export function finalizeDraft(raw: string, maxChars?: number): string {
  const clean = raw.replace(INVISIBLE, "").trim().replace(/^["“]([\s\S]*)["”]$/, "$1").replace(/\*\*|__/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return clipToSentences(dropUnfinishedSentence(clean), maxChars);
}

function dropUnfinishedSentence(text: string): string {
  if (/[.!?]["”)]?$/.test(text)) return text;
  // Sentence ends are punctuation followed by whitespace, so a dot inside a URL never counts.
  const ends = [...text.matchAll(/[.!?]["”)]?(?=\s)/g)];
  const last = ends[ends.length - 1];
  const cut = last?.index === undefined ? 0 : last.index + last[0].length;
  return cut >= text.length / 2 ? text.slice(0, cut) : text;
}

export function maxTokensFor(maxChars?: number): number {
  if (!maxChars) return 260;
  return Math.min(400, Math.max(40, Math.ceil(maxChars / 3)));
}

/** Keyed by the exact prompt, so everything that shapes a draft (job description and past answers included) is part of the key. */
export function cacheKey(input: DraftInput): string {
  return createHash("sha256").update(JSON.stringify([ghostTextMessages(input), input.maxChars ?? 0])).digest("hex");
}
