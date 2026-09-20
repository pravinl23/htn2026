// Speculative free-text drafts: every essay field of a form starts generating while the user is still on the
// first fields, so the draft is already there when Tab reaches it. One draft per field signature per page load.
import { isSensitive, staysOnThisMachine } from "@ghost/shared";
import type { CapturedField, PastAnswer, Profile } from "@ghost/shared";
import { TEXT_LIMITS, TEXT_PORT, hasContactValue, isTextPortEvent, textFacts } from "../lib/messages";
import type { GhostTextRequest, TextPageContext, TextPortEvent, TextPortStart } from "../lib/messages";

export const MAX_CONCURRENT_DRAFTS = 3;
/** A hostile (or just enormous) page gets this many drafts per load, no more. */
export const MAX_DRAFTS_PER_PAGE = 8;
const MIN_SIMILARITY = 0.25;
const STOPWORDS = new Set(["the", "and", "you", "your", "our", "for", "with", "that", "this", "are", "have", "does", "about", "from", "will", "would", "want"]);

export interface TextStream {
  abort(): void;
}

/** Opens one streamed draft. `onEvent` gets deltas, then exactly one terminal `done` or `error` (never after `abort`). */
export type OpenTextStream = (request: GhostTextRequest, onEvent: (event: TextPortEvent) => void) => TextStream;

export interface DraftJob {
  signature: string;
  /** The field's maxlength: the draft is asked for, shown and filled within it. */
  limit?: number;
  /** Built when the draft really starts, so a queued job never reads the page for nothing. Null: nothing to ask. */
  build(): GhostTextRequest | null;
}

export interface DraftView {
  text: string;
  pending: boolean;
}

/** What the HUD reports about the last finished draft, as the user experienced it (queueing excluded). */
export interface DraftStats {
  provider: string;
  firstTokenMs: number | null;
  totalMs: number;
}

export type DraftChange = "text" | "done" | "failed";
export type DraftOutcome = "done" | "failed" | "timeout";
type DraftListener = (signature: string, change: DraftChange) => void;
type State = "queued" | "streaming" | "done" | "failed" | "aborted";

interface Entry {
  job: DraftJob;
  state: State;
  raw: string;
  startedAt: number;
  firstTokenMs: number | null;
  stream: TextStream | null;
  waiters: Array<(outcome: DraftOutcome) => void>;
}

export interface DraftSchedulerDeps {
  open: OpenTextStream;
  maxConcurrent?: number;
  now?: () => number;
}

export class DraftScheduler {
  private readonly entries = new Map<string, Entry>();
  private queue: Entry[] = [];
  private running = 0;
  private wanted = 0;
  private last: DraftStats | null = null;
  private listener: DraftListener | null = null;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(private readonly deps: DraftSchedulerDeps) {
    this.limit = deps.maxConcurrent ?? MAX_CONCURRENT_DRAFTS;
    this.now = deps.now ?? (() => performance.now());
  }

  /** One consumer: the controller. Null detaches it. */
  subscribe(listener: DraftListener | null): void {
    this.listener = listener;
  }

  /** Asks for a draft once. A field already asked about, typed over or dismissed on this page load is left alone. */
  want(job: DraftJob): void {
    if (this.entries.has(job.signature) || this.wanted >= MAX_DRAFTS_PER_PAGE) return;
    this.wanted++;
    const entry: Entry = { job, state: "queued", raw: "", startedAt: 0, firstTokenMs: null, stream: null, waiters: [] };
    this.entries.set(job.signature, entry);
    this.queue.push(entry);
    this.pump();
  }

  has(signature: string): boolean {
    return this.entries.has(signature);
  }

  /** The draft as a ghost may show it: nothing until the first text, nothing once it failed or was aborted. */
  get(signature: string): DraftView | undefined {
    const entry = this.entries.get(signature);
    if (!entry || (entry.state !== "streaming" && entry.state !== "done")) return undefined;
    const pending = entry.state === "streaming";
    const text = clipDraft(entry.raw, entry.job.limit, pending);
    return text ? { text, pending } : undefined;
  }

  /** The user typed here or dismissed the ghost: stop the stream, and never draft this field again on this page. */
  abort(signature: string): void {
    const entry = this.entries.get(signature);
    if (!entry) {
      this.entries.set(signature, tombstone(signature));
      return;
    }
    if (entry.state === "queued") this.end(entry, "aborted");
    if (entry.state !== "streaming") return;
    entry.stream?.abort();
    this.running--;
    this.end(entry, "aborted");
    this.pump();
  }

  /** Resolves when the draft is finished (or never will be), or after `timeoutMs`. */
  settled(signature: string, timeoutMs: number): Promise<DraftOutcome> {
    const entry = this.entries.get(signature);
    if (!entry || entry.state === "failed" || entry.state === "aborted") return Promise.resolve("failed");
    if (entry.state === "done") return Promise.resolve("done");
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      const finish = (outcome: DraftOutcome): void => {
        clearTimeout(timer);
        const at = entry.waiters.indexOf(finish);
        if (at >= 0) entry.waiters.splice(at, 1);
        resolve(outcome);
      };
      entry.waiters.push(finish);
    });
  }

  /** A new page, or Ghost switched off: every stream stops and every draft is forgotten. */
  reset(): void {
    for (const entry of this.entries.values()) {
      if (entry.state === "streaming") entry.stream?.abort();
      if (entry.state === "queued" || entry.state === "streaming") this.end(entry, "aborted");
    }
    this.entries.clear();
    this.queue = [];
    this.running = this.wanted = 0;
    this.last = null;
  }

  stats(): DraftStats | null {
    return this.last;
  }

  active(): number {
    return this.running;
  }

  private pump(): void {
    while (this.running < this.limit) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.state === "queued") this.begin(entry);
    }
  }

  private begin(entry: Entry): void {
    const request = entry.job.build();
    if (!request) return this.end(entry, "failed");
    entry.state = "streaming";
    entry.startedAt = this.now();
    this.running++;
    const stream = this.deps.open(request, (event) => this.onEvent(entry, event));
    if (entry.state === "streaming") entry.stream = stream; // a stream may fail before `open` even returns
  }

  private onEvent(entry: Entry, event: TextPortEvent): void {
    if (entry.state !== "streaming") return; // aborted, or a stream that talks after its terminal event
    if (event.type === "delta") return this.onDelta(entry, event.delta);
    this.running--;
    // The final text is authoritative: the server swaps in its template when a streamed draft fails its safety check.
    if (event.type === "done" && event.text.trim()) {
      entry.raw = event.text;
      this.last = { provider: event.provider, firstTokenMs: entry.firstTokenMs, totalMs: this.now() - entry.startedAt };
      this.end(entry, "done");
    } else {
      this.end(entry, "failed");
    }
    this.pump();
  }

  private onDelta(entry: Entry, delta: string): void {
    if (entry.raw.length >= TEXT_LIMITS.maxMaxChars) return;
    entry.firstTokenMs ??= this.now() - entry.startedAt;
    entry.raw += delta;
    this.listener?.(entry.job.signature, "text");
  }

  /** The listener hears about it first, so a waiter resumes with the ghost already up to date. */
  private end(entry: Entry, state: "done" | "failed" | "aborted"): void {
    const was = entry.state;
    entry.state = state;
    entry.stream = null;
    if (state !== "aborted" && was === "streaming") this.listener?.(entry.job.signature, state);
    for (const waiter of [...entry.waiters]) waiter(state === "done" ? "done" : "failed");
  }
}

function tombstone(signature: string): Entry {
  return { job: { signature, build: () => null }, state: "aborted", raw: "", startedAt: 0, firstTokenMs: null, stream: null, waiters: [] };
}

/** Within maxlength. A finished draft is cut back to its last whole sentence (or word) instead of mid-word. */
export function clipDraft(raw: string, limit: number | undefined, pending: boolean): string {
  const text = raw.replace(/\r\n?/g, "\n").trimStart();
  const max = Math.min(limit ?? TEXT_LIMITS.maxMaxChars, TEXT_LIMITS.maxMaxChars);
  if (text.length <= max) return pending ? text : text.trimEnd();
  const cut = text.slice(0, max);
  if (pending) return cut;
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1).trimEnd();
  const word = cut.lastIndexOf(" ");
  return (word > max * 0.5 ? cut.slice(0, word) : cut).trimEnd();
}

// ---------- what a draft request may carry ----------

/**
 * The body for one field. Facts go through the `textFacts` allowlist (name, school, degree, major, graduation,
 * location, GitHub, website): email, phone and work authorization never reach the text route.
 */
export function buildTextRequest(field: CapturedField, profile: Profile, pageContext: TextPageContext, limit?: number): GhostTextRequest | null {
  const fieldLabel = field.label.trim().slice(0, TEXT_LIMITS.label);
  if (!fieldLabel || isSensitive({ label: fieldLabel, name: field.name, id: field.id, placeholder: field.placeholder, autocomplete: field.autocomplete, inputType: field.inputType })) return null;
  // "Describe the accommodations you need" and "explain the circumstances of any conviction" are free text,
  // but asking a server to draft one discloses the question. The user writes these themselves.
  if (staysOnThisMachine(field)) return null;
  if (field.signature.length > TEXT_LIMITS.signature) return null;
  const request: GhostTextRequest = {
    fieldLabel,
    fieldSignature: field.signature,
    pageContext,
    facts: textFacts(profile.facts),
    pastAnswers: similarPastAnswers(fieldLabel, profile.pastAnswers),
  };
  if (limit !== undefined && limit >= TEXT_LIMITS.minMaxChars) request.maxChars = Math.min(limit, TEXT_LIMITS.maxMaxChars);
  return request;
}

/** Up to three earlier answers whose question shares enough words with this label, closest first. */
export function similarPastAnswers(label: string, pastAnswers: PastAnswer[], max: number = TEXT_LIMITS.pastAnswers): GhostTextRequest["pastAnswers"] {
  const wanted = tokens(label);
  return pastAnswers
    // `isSensitive` covers passwords, cards and government IDs; it has no protected or declaration vocabulary,
    // so a stored answer about disability, a conviction or work authorization needs its own guard here.
    .filter((past) => past.question?.trim() && past.answer?.trim() && !isSensitive({ label: past.question }) && !hasContactValue(past.answer))
    .filter((past) => !staysOnThisMachine({ label: past.question, kind: "textarea" }))
    .map((past) => ({ past, score: overlap(wanted, tokens(past.question)) }))
    .filter(({ score }) => score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ past }) => ({ question: past.question.trim().slice(0, TEXT_LIMITS.question), answer: past.answer.trim().slice(0, TEXT_LIMITS.answer) }));
}

function tokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(words.filter((word) => !STOPWORDS.has(word)));
}

/** Jaccard overlap of the two word sets. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

// ---------- the port to the background worker ----------

/**
 * One `ghost:text` port per draft. The worker fetches the server (a page CSP cannot block it, the page cannot
 * watch it); disconnecting the port aborts the stream, and the open port keeps the MV3 worker alive meanwhile.
 */
export const openTextPort: OpenTextStream = (request, onEvent) => {
  let closed = false;
  const end = (event: TextPortEvent): void => {
    if (closed) return;
    closed = true;
    onEvent(event);
  };
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: TEXT_PORT });
    port.onMessage.addListener((message: unknown) => {
      if (closed || !isTextPortEvent(message)) return;
      if (message.type === "delta") onEvent(message);
      else end(message);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read so Chrome does not log "unchecked runtime.lastError"
      end({ type: "error", error: "disconnected" });
    });
    const start: TextPortStart = { type: "start", request };
    port.postMessage(start);
  } catch {
    // No worker (unit tests, an orphaned content script): there is simply no draft. Async, like every other outcome.
    queueMicrotask(() => end({ type: "error", error: "no-worker" }));
    return { abort: () => void (closed = true) };
  }
  return {
    abort() {
      closed = true;
      try {
        port.disconnect();
      } catch {
        // already gone
      }
    },
  };
};
