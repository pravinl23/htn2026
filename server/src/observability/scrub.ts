import { createGhostWalkReplayFixture, isReviewableWalk, sanitizeGhostWalkOutcome } from "@ghost/shared";
import type { GhostWalkReplayFixture } from "@ghost/shared";

interface AttachmentHint {
  attachments?: Array<{ filename: string; data: string | Uint8Array; contentType?: string }>;
}

/**
 * The single outbound Sentry boundary. A walk event is discarded and rebuilt from the shared allowlist;
 * attachments are rebuilt here too, so a future scope/request integration cannot smuggle page data out.
 * This process currently sends only learning-loop events: anything else is dropped.
 */
export function scrubSentryEvent(raw: unknown, hint?: AttachmentHint): Record<string, unknown> | null {
  if (!isObject(raw)) return null;
  const extra = isObject(raw.extra) ? raw.extra : {};
  const outcome = sanitizeGhostWalkOutcome(extra.walk_outcome);
  if (!outcome) {
    if (hint) hint.attachments = [];
    return null;
  }
  const reviewable = isReviewableWalk(outcome);
  const replay = reviewable ? createGhostWalkReplayFixture(outcome) : undefined;
  if (hint) hint.attachments = replay ? [replayAttachment(replay)] : [];
  return compact({
    event_id: safeEventId(raw.event_id),
    timestamp: typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : undefined,
    platform: "node",
    level: reviewable ? "warning" : "info",
    message: `ghost.walk.${outcome.state}`,
    fingerprint: ["ghost.walk", outcome.state, outcome.reason, outcome.provider],
    tags: {
      feature: "ghost-walk",
      schema: outcome.schemaVersion,
      state: outcome.state,
      reason: outcome.reason,
      provider: outcome.provider,
    },
    extra: { walk_outcome: outcome, ...(replay ? { walk_replay: replay } : {}) },
    environment: safeConfigLabel(raw.environment),
    release: safeConfigLabel(raw.release),
  });
}

export function replayAttachment(replay: GhostWalkReplayFixture): { filename: string; data: string; contentType: string } {
  return {
    filename: `walk-replay-${replay.caseId}.json`,
    data: JSON.stringify(replay),
    contentType: "application/json",
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeEventId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value) ? value : undefined;
}

function safeConfigLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 100 && /^[A-Za-z0-9._/@-]+$/.test(value) ? value : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
