import { createGhostWalkReplayFixture, isReviewableWalk, sanitizeGhostWalkOutcome } from "@ghost/shared";
import type { GhostWalkOutcome, GhostWalkReplayFixture } from "@ghost/shared";
import type { ServerConfig } from "../config";

export interface WalkOutcomeSink {
  readonly enabled: boolean;
  capture(outcome: GhostWalkOutcome, replay?: GhostWalkReplayFixture): Promise<string | undefined>;
}

export class NoopWalkOutcomeSink implements WalkOutcomeSink {
  readonly enabled = false;
  async capture(): Promise<undefined> {
    return undefined;
  }
}

export function createWalkOutcomeSink(config: ServerConfig): WalkOutcomeSink {
  return config.sentry ? new SentryWalkOutcomeSink(config.sentry) : new NoopWalkOutcomeSink();
}

/** A process-local review queue; Sentry remains the durable source when configured. */
export class WalkReplayStore {
  private readonly fixtures: GhostWalkReplayFixture[] = [];

  constructor(private readonly capacity = 100) {}

  add(outcome: GhostWalkOutcome): GhostWalkReplayFixture | undefined {
    if (!isReviewableWalk(outcome)) return undefined;
    const fixture = createGhostWalkReplayFixture(outcome);
    this.fixtures.unshift(fixture);
    if (this.fixtures.length > this.capacity) this.fixtures.length = this.capacity;
    return fixture;
  }

  list(): GhostWalkReplayFixture[] {
    return this.fixtures.map((fixture) => structuredClone(fixture));
  }
}

class SentryWalkOutcomeSink implements WalkOutcomeSink {
  readonly enabled = true;
  private sdkPromise?: Promise<typeof import("@sentry/node")>;

  constructor(private readonly config: NonNullable<ServerConfig["sentry"]>) {}

  async capture(outcome: GhostWalkOutcome, replay?: GhostWalkReplayFixture): Promise<string | undefined> {
    try {
      const sdk = await this.sdk();
      return sdk.withScope((scope) => {
        if (replay) {
          scope.addAttachment({
            filename: `walk-replay-${replay.caseId}.json`,
            data: JSON.stringify(replay),
            contentType: "application/json",
          });
        }
        return sdk.captureEvent({ extra: { walk_outcome: outcome } });
      });
    } catch {
      return undefined;
    }
  }

  private sdk(): Promise<typeof import("@sentry/node")> {
    this.sdkPromise ??= import("@sentry/node").then((sdk) => {
      sdk.init({
        dsn: this.config.dsn,
        environment: this.config.environment,
        release: this.config.release,
        defaultIntegrations: false,
        sendDefaultPii: false,
        tracesSampleRate: 0,
        registerEsmLoaderHooks: false,
        beforeSend: (event) => scrubSentryWalkEvent(event) as typeof event | null,
      });
      return sdk;
    });
    return this.sdkPromise;
  }
}

/**
 * Last outbound boundary: discard the SDK event and rebuild it solely from the validated outcome.
 * This prevents future scope, request, breadcrumb, exception, or user data from hitching a ride.
 */
export function scrubSentryWalkEvent(raw: unknown): Record<string, unknown> | null {
  if (!isObject(raw)) return null;
  const extra = isObject(raw.extra) ? raw.extra : {};
  const outcome = sanitizeGhostWalkOutcome(extra.walk_outcome);
  if (!outcome) return null;
  const reviewable = isReviewableWalk(outcome);
  const replay = reviewable ? createGhostWalkReplayFixture(outcome) : undefined;
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
