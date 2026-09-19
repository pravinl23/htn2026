// The two places a loop run can happen (docs/loops.md 3.5). Visible: the tab itself, with real navigation and the
// ghost cursor. Background: hidden same-origin frames next to the list page (one for the list when the tab moved
// away, one per item, one for each constant page such as the sheet), so 48 items finish in seconds while the
// visible page updates live through the site's own storage events.
import { normalizeUrl } from "@ghost/shared";
import { createIframePool } from "./dryRun";
import type { FramePool, PreviewFrame } from "./dryRun";
import { looksLocked, urlOfDocument } from "./loopExecutor";
import type { LoopSurface, PageRole } from "./loopExecutor";
import { markSynthetic } from "./trace";

const POLL_MS = 25;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function originOf(doc: Document): string {
  return normalizeUrl(doc.location.href)?.origin ?? "";
}

function pageUrl(raw: string, base: string): { href: string; url: string; origin: string } | null {
  try {
    const parsed = new URL(raw, base);
    const where = /^https?:$/.test(parsed.protocol) ? normalizeUrl(parsed.href) : null;
    return where ? { href: parsed.href, url: where.url, origin: where.origin } : null;
  } catch {
    return null;
  }
}

// ---------- visible ----------

export interface VisibleSurfaceDeps {
  doc?: Document;
  showTarget?(el: HTMLElement, locked: boolean): Promise<void>;
  /** Full navigation when the page offers no link to click. Default: location.assign. */
  navigate?(url: string): void;
  /** How long an in-page (SPA) navigation may take. A full page load never gets this far: the script is gone. Default 8000. */
  arriveMs?: number;
}

/** A visible same-origin link that leads exactly to `url` and is safe to click (an SPA keeps its state that way). */
function routeLink(doc: Document, url: string): HTMLElement | null {
  for (const link of doc.querySelectorAll<HTMLElement>("a[href]")) {
    const target = (link.getAttribute("target") ?? "").toLowerCase();
    if ((target !== "" && target !== "_self") || link.hasAttribute("download") || link.closest('[hidden], [aria-hidden="true"]')) continue;
    const to = pageUrl(link.getAttribute("href") ?? "", doc.baseURI);
    if (to && to.url === url && to.href.split("#")[0] === to.url && !looksLocked(link)) return link;
  }
  return null;
}

export function createVisibleSurface(deps: VisibleSurfaceDeps = {}): LoopSurface {
  const doc = deps.doc ?? document;
  const navigate = deps.navigate ?? ((url: string) => doc.location.assign(url));
  const arriveMs = deps.arriveMs ?? 8000;
  const here = (url: string): boolean => urlOfDocument(doc) === url;

  async function arrive(url: string): Promise<boolean> {
    const deadline = Date.now() + arriveMs;
    while (!here(url) && Date.now() < deadline) await sleep(POLL_MS);
    return here(url);
  }

  return {
    framed: false,
    showTarget: deps.showTarget,
    documentAt: (url) => (here(url) ? doc : null),
    documents: () => [doc],
    async open(url) {
      if (here(url)) return true;
      const to = pageUrl(url, doc.baseURI);
      if (!to) return false;
      const link = to.origin === originOf(doc) ? routeLink(doc, to.url) : null;
      if (link) await deps.showTarget?.(link, false);
      markSynthetic(2000); // the recorder tags this navigation as Ghost's own
      if (link) link.click();
      else navigate(to.href);
      return arrive(to.url);
    },
  };
}

// ---------- background ----------

export interface FrameSurface extends LoopSurface {
  /** Removes every frame. */
  dispose(): void;
}

export interface FrameSurfaceDeps {
  doc?: Document;
  /** Default: the dry run's hidden, sandboxed iframes. */
  frames?: FramePool;
  loadTimeoutMs?: number;
}

export function createFrameSurface(deps: FrameSurfaceDeps = {}): FrameSurface {
  const doc = deps.doc ?? document;
  let pool: FramePool | null = deps.frames ?? null;
  let abort = new AbortController();
  /** One frame per role and constant page: the item frame is replaced per item, the sheet stays loaded. */
  const slots = new Map<string, PreviewFrame>();

  function frameDocuments(): Document[] {
    const order = [...slots.entries()].sort(([a], [b]) => rank(a) - rank(b));
    return order.flatMap(([, frame]) => frame.document() ?? []);
  }

  function rank(key: string): number {
    return key === "item" ? 0 : key === "list" ? 2 : 1;
  }

  function slotFor(key: string): PreviewFrame {
    pool ??= createIframePool(doc, deps.loadTimeoutMs);
    const frame = slots.get(key) ?? pool.acquire();
    slots.set(key, frame);
    return frame;
  }

  return {
    framed: true,
    documents: () => [...frameDocuments(), doc],
    documentAt(url) {
      if (urlOfDocument(doc) === url) return doc;
      return frameDocuments().find((d) => urlOfDocument(d) === url) ?? null;
    },
    async open(url: string, role: PageRole) {
      const to = pageUrl(url, doc.baseURI);
      // Only pages of the tab's own origin: anything else could not be read, and is never loaded.
      if (!to || to.origin !== originOf(doc)) return false;
      const frame = slotFor(role === "page" ? `page:${to.url}` : role);
      if (!(await frame.load(to.href, abort.signal))) return false;
      const shown = frame.document();
      return shown !== null && urlOfDocument(shown) === to.url;
    },
    dispose() {
      abort.abort();
      abort = new AbortController();
      for (const frame of slots.values()) frame.dispose();
      slots.clear();
      pool?.destroy();
      pool = deps.frames ?? null;
    },
  };
}
