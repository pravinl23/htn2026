import type { FactLocator, TraceEvent } from "../trace/types";
import type { Context } from "./align";
import { MATCH_MODES, matchesUnder } from "./values";
import type { MatchMode } from "./values";

/** One typed value plus the pages the user had seen for that item, most recent first. */
export interface Evidence {
  value: string;
  urls: string[];
}

export interface Source {
  pathPattern: string;
  locator: FactLocator;
  label: string;
  mode: MatchMode;
}

const LOCATOR_RANK: Record<FactLocator["by"], number> = { "data-field": 0, testid: 0, id: 0, label: 1, css: 2 };

function recentUrls(events: TraceEvent[]): string[] {
  const urls: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const url = events[i]?.url;
    if (url !== undefined && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** A wrapped step of run B belongs to the item opened in run A; run A's wrapped step belongs to an item we never saw. */
export function evidenceAt(ctx: Context, pos: number): Evidence[] {
  const upTo = ctx.rotated.slice(0, pos + 1);
  const pair = ctx.rotated[pos];
  if (!pair) return [];
  if (pos < ctx.wrappedStart) {
    return [
      { value: pair.a.value ?? "", urls: recentUrls(upTo.map((p) => p.a)) },
      { value: pair.b.value ?? "", urls: recentUrls(upTo.map((p) => p.b)) },
    ];
  }
  const seen = upTo.map((p, i) => (i < ctx.wrappedStart ? p.a : p.b));
  return [{ value: pair.b.value ?? "", urls: recentUrls(seen) }];
}

function sameLocator(x: FactLocator, y: FactLocator): boolean {
  return x.by === y.by && x.value === y.value;
}

function explains(ctx: Context, source: Source, ev: Evidence): boolean {
  return ev.urls.some(
    (url) =>
      ctx.patternByUrl.get(url) === source.pathPattern &&
      (ctx.facts[url] ?? []).some((f) => sameLocator(f.locator, source.locator) && matchesUnder(ev.value, f.text, source.mode)),
  );
}

function sourcesFor(ctx: Context, ev: Evidence): Source[] {
  const out: Source[] = [];
  for (const url of ev.urls) {
    const pathPattern = ctx.patternByUrl.get(url);
    if (pathPattern === undefined) continue;
    for (const fact of ctx.facts[url] ?? []) {
      for (const mode of MATCH_MODES) {
        if (matchesUnder(ev.value, fact.text, mode)) out.push({ pathPattern, locator: fact.locator, label: fact.label, mode });
      }
    }
  }
  return out;
}

function words(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ");
}

function affinity(factLabel: string, targetLabel: string): number {
  const f = words(factLabel);
  const t = words(targetLabel);
  if (f === "" || t === "") return 0;
  if (f === t) return 2;
  return f.includes(t) || t.includes(f) ? 1 : 0;
}

/** The same locator (and the same match mode) must explain every piece of evidence. */
export function findSource(ctx: Context, evidence: Evidence[], targetLabel: string): Source | null {
  const [first, ...rest] = evidence;
  if (!first) return null;
  const valid = sourcesFor(ctx, first).filter((s) => rest.every((ev) => explains(ctx, s, ev)));
  const rank = (s: Source): number =>
    -affinity(s.label, targetLabel) * 100 + LOCATOR_RANK[s.locator.by] * 10 + MATCH_MODES.indexOf(s.mode);
  return valid.sort((x, y) => rank(x) - rank(y))[0] ?? null;
}
