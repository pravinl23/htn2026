import { createHash } from "node:crypto";
import type { VisionLabel } from "./replies";
import type { VisionBox } from "./validation";

/**
 * Per-page label cache, so the second visit to a page costs nothing (docs/anywhere.md section 4: "cached by a hash of
 * the box geometry plus the page's path pattern").
 *
 * What is stored: the labels ALREADY validated, clipped, locked and sensitivity-checked by replies.ts. Never an image,
 * never the client's box ids (an AX signature or a DOM id can carry a person's name), never the path pattern itself:
 * the key is a hash, computed here and never sent anywhere. Entries are positional, so a hit re-attaches whatever ids
 * the current request used.
 *
 * Opt-in: a client that sends no `page.pathPattern` gets the old stateless behaviour, one call per request.
 */

export const DEFAULT_CACHE_ENTRIES = 200;
export const DEFAULT_CACHE_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 5_000;

export interface CacheKeyParts {
  /** A PATTERN, not a URL: "/watch", "/dp/*", "/inbox/*". Hashed here; it never leaves this process. */
  pathPattern: string;
  model: string;
  image: { width: number; height: number };
  boxes: ReadonlyArray<Pick<VisionBox, "x" | "y" | "width" | "height">>;
}

/**
 * The same page, the same crop size and the same rectangles in the same order: the same key. A control that moved by a
 * pixel is a different key and costs a call, which is the safe direction: a stale label is a wrong ghost.
 */
export function visionCacheKey(parts: CacheKeyParts): string {
  const geometry = parts.boxes.map((b) => `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`).join(";");
  const material = `v1|${parts.pathPattern}|${parts.model}|${parts.image.width}x${parts.image.height}|${parts.boxes.length}|${geometry}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

interface Entry {
  labels: VisionLabel[];
  expiresAt: number;
}

export interface CacheStats {
  enabled: boolean;
  entries: number;
  hits: number;
  misses: number;
}

/** Bounded, oldest-inserted evicted first (Map keeps insertion order); a re-set moves an entry to the end. */
export class LabelCache {
  private readonly entries = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(
    readonly limit: number = DEFAULT_CACHE_ENTRIES,
    readonly ttlMs: number = DEFAULT_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Labels for THESE boxes, re-keyed to their client ids, or undefined on a miss, an expiry or a count mismatch. */
  get(key: string, boxes: ReadonlyArray<Pick<VisionBox, "id">>): VisionLabel[] | undefined {
    if (this.limit === 0) return undefined;
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now() || entry.labels.length !== boxes.length) {
      if (entry) this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.labels.map((label, i) => ({ ...label, id: boxes[i]?.id ?? label.id }));
  }

  set(key: string, labels: VisionLabel[]): void {
    if (this.limit === 0) return;
    this.entries.delete(key);
    this.entries.set(key, { labels: labels.map((label) => ({ ...label })), expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  stats(): CacheStats {
    return { enabled: this.limit > 0, entries: this.entries.size, hits: this.hits, misses: this.misses };
  }
}

/** SHABANG_VISION_CACHE: a whole number of pages to remember, 0 switches the cache off. Anything unreadable: the default. */
export function cacheLimitFrom(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(n) || n < 0) return DEFAULT_CACHE_ENTRIES;
  return Math.min(n, MAX_CACHE_ENTRIES);
}
