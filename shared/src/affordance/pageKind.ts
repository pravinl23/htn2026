// What KIND of place this is (docs/anywhere.md section 2, one level up from a single affordance). A feed, a player,
// a shop, a document and a form want completely different defaults, and a flat candidate list hides that.
// Same rule as roles.ts: derived from what the page offers, never from who serves it.
import { classifyAll } from "./roles";
import type { AffordanceCandidate, AffordanceContext, AffordanceRole, ClassifiedCandidate } from "./roles";

export type PageKind = "feed" | "media" | "commerce" | "reader" | "mail" | "form" | "app" | "unknown";

export type PageKindEvidence =
  | "media-element" | "media-controls" | "media-roles"
  | "repeated-items" | "item-roles" | "search-affordance"
  | "price-signals" | "cart-role" | "buy-role"
  | "mail-roles"
  | "field-count" | "submit-role"
  | "text-density" | "few-controls"
  | "path-pattern" | "app-bundle" | "has-controls" | "no-candidates";

export interface PageSignals {
  candidates?: readonly AffordanceCandidate[];
  /** Already-classified candidates, when the caller has them: saves classifying the same list twice. */
  classified?: readonly ClassifiedCandidate[];
  hasMediaElement?: boolean;
  /** How many repeated items the list/grid detector found in the main region. */
  mainRegionRepeats?: number;
  /** 0 to 1: how much of the main region is running text rather than controls and media. */
  textDensity?: number;
  pathPattern?: string;
  /** Native side only. Grouping key, never matched against a vendor name. */
  appBundleId?: string;
}

export interface PageKindGuess {
  kind: PageKind;
  confidence: number;
  evidence: PageKindEvidence[];
}

/** Generic path words per kind. A path alone never decides: it adds a nudge to a kind the page already suggests. */
const PATH_HINTS: readonly { kind: PageKind; re: RegExp }[] = [
  { kind: "media", re: /\b(watch|video|videos|play|player|episode|stream|listen|track|album|movie|clip|shorts)\b/ },
  { kind: "commerce", re: /\b(cart|basket|bag|checkout|product|products|item|items|shop|store|order|orders|deal|deals)\b/ },
  { kind: "feed", re: /\b(feed|home|results|search|browse|explore|discover|trending|timeline)\b/ },
  { kind: "mail", re: /\b(mail|inbox|messages|message|thread|threads|chat|conversation|conversations)\b/ },
  { kind: "reader", re: /\b(article|articles|post|posts|blog|docs|doc|wiki|story|stories|read|news|guide)\b/ },
  { kind: "form", re: /\b(apply|application|form|signup|register|checkout|survey|onboarding)\b/ },
];

/** Ties go to the more specific place: a shop that also repeats items is a shop. */
const PRIORITY: readonly PageKind[] = ["commerce", "media", "mail", "form", "feed", "reader", "app", "unknown"];

const MAX_CONFIDENCE = 0.92;
const MIN_CONFIDENCE = 0.3;
/** Below this nothing specific was recognized, so the page falls back to the generic "app" floor. */
const SPECIFIC_FLOOR = 0.45;

class KindScores {
  private readonly score = new Map<PageKind, number>();
  private readonly evidence = new Map<PageKind, PageKindEvidence[]>();

  add(kind: PageKind, weight: number, evidence: PageKindEvidence): void {
    this.score.set(kind, (this.score.get(kind) ?? 0) + weight);
    const seen = this.evidence.get(kind) ?? [];
    if (!seen.includes(evidence)) seen.push(evidence);
    this.evidence.set(kind, seen);
  }

  of(kind: PageKind): number {
    return this.score.get(kind) ?? 0;
  }

  evidenceOf(kind: PageKind): PageKindEvidence[] {
    return [...(this.evidence.get(kind) ?? [])];
  }

  /** Nothing scored at all means nothing was recognized, which is exactly `unknown`. */
  best(): PageKind {
    let best: PageKind = "unknown";
    let bestScore = 0;
    for (const kind of PRIORITY) {
      const score = this.of(kind);
      if (score > bestScore) {
        best = kind;
        bestScore = score;
      }
    }
    return best;
  }
}

function countRoles(classified: readonly ClassifiedCandidate[]): Map<AffordanceRole, number> {
  const counts = new Map<AffordanceRole, number>();
  for (const { affordance } of classified) counts.set(affordance.role, (counts.get(affordance.role) ?? 0) + 1);
  return counts;
}

/**
 * The place, from the affordances plus a few page-level measurements. Confidence is how well the evidence fits,
 * not how likely a prediction is: priors are what turns a kind into a proposal.
 */
export function inferPageKind(signals: PageSignals): PageKindGuess {
  const context: AffordanceContext = { pathPattern: signals.pathPattern, hasMediaElement: signals.hasMediaElement, appBundleId: signals.appBundleId };
  const classified = signals.classified ?? classifyAll(signals.candidates ?? [], context);
  const counts = countRoles(classified);
  const has = (role: AffordanceRole): number => counts.get(role) ?? 0;
  const repeats = signals.mainRegionRepeats ?? 0;
  const density = signals.textDensity ?? 0;
  const prices = classified.filter((c) => c.candidate.nearbyPrice === true).length;
  const fields = classified.filter((c) => c.affordance.role === "field").length;
  const controls = classified.filter((c) => c.candidate.kind !== "field").length;
  const mediaRoles = ["play", "pause", "fullscreen", "next", "previous", "mute", "captions", "speed"].reduce((n, role) => n + has(role as AffordanceRole), 0);
  const scores = new KindScores();

  if (signals.hasMediaElement === true) scores.add("media", 0.55, "media-element");
  if (classified.some((c) => c.candidate.insideMediaControls === true)) scores.add("media", 0.25, "media-controls");
  if (mediaRoles >= 2) scores.add("media", 0.2, "media-roles");

  // Only a shop has a cart, so one is nearly enough on its own: it clears the generic "app" floor by itself.
  if (has("cart") > 0) scores.add("commerce", 0.45, "cart-role");
  if (has("checkout") + has("buy") > 0) scores.add("commerce", 0.3, "buy-role");
  if (prices >= 2) scores.add("commerce", 0.25, "price-signals");

  // Compose/reply/send are what a mailbox has and a feed does not, so they outweigh the repeated rows themselves.
  if (has("compose") > 0 || has("reply") > 0) scores.add("mail", 0.5, "mail-roles");
  if (has("send") > 0) scores.add("mail", 0.3, "mail-roles");
  if ((has("compose") > 0 || has("reply") > 0) && repeats >= 4) scores.add("mail", 0.3, "repeated-items");

  if (repeats >= 4) scores.add("feed", 0.4, "repeated-items");
  if (repeats >= 8) scores.add("feed", 0.1, "repeated-items");
  if (has("primary-item") >= 3) scores.add("feed", 0.2, "item-roles");
  if (has("search") > 0 && repeats >= 4) scores.add("feed", 0.1, "search-affordance");

  if (fields >= 3) scores.add("form", 0.45, "field-count");
  if (fields >= 6) scores.add("form", 0.1, "field-count");
  if (fields >= 3 && has("submit") > 0) scores.add("form", 0.25, "submit-role");

  if (density >= 0.6) scores.add("reader", 0.5, "text-density");
  if (density >= 0.6 && controls <= 8) scores.add("reader", 0.2, "few-controls");
  if (density >= 0.6 && repeats <= 2) scores.add("reader", 0.1, "repeated-items");

  const path = (signals.pathPattern ?? "").toLowerCase();
  if (path !== "") {
    for (const hint of PATH_HINTS) if (scores.of(hint.kind) > 0 && hint.re.test(path)) scores.add(hint.kind, 0.08, "path-pattern");
  }

  // The floor: a window that offers controls at all is at least an app, so Ghost always has SOME place to reason about.
  if (classified.length >= 1) scores.add("app", classified.length >= 2 ? SPECIFIC_FLOOR : 0.35, "has-controls");
  if (typeof signals.appBundleId === "string" && signals.appBundleId !== "") scores.add("app", 0.08, "app-bundle");
  if (classified.length === 0) scores.add("unknown", MIN_CONFIDENCE, "no-candidates");

  const kind = scores.best();
  const confidence = Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, scores.of(kind)));
  return { kind, confidence, evidence: scores.evidenceOf(kind) };
}
