import { createGhostWalkReplayFixture, isReviewableWalk } from "@ghost/shared";
import type { GhostWalkOutcome, GhostWalkReplayFixture } from "@ghost/shared";
import type { ServerConfig } from "../config";
import { initializeObservability, sentryClient } from "../observability/instrument";
export { scrubSentryEvent as scrubSentryWalkEvent } from "../observability/scrub";
import { replayAttachment } from "../observability/scrub";

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
  return config.sentry ? new SentryWalkOutcomeSink(config) : new NoopWalkOutcomeSink();
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
  constructor(private readonly config: ServerConfig) {}

  async capture(outcome: GhostWalkOutcome, replay?: GhostWalkReplayFixture): Promise<string | undefined> {
    try {
      initializeObservability(this.config);
      const sdk = sentryClient();
      if (!sdk) return undefined;
      const eventId = sdk.captureEvent(
        { extra: { walk_outcome: outcome } },
        { attachments: replay ? [replayAttachment(replay)] : [] },
      );
      // captureEvent returns an id before beforeSend/transport runs. Only report success once the real SDK
      // accepted, scrubbed and drained the event; this prevents the old captured:true false positive.
      return await sdk.flush(2_000) ? eventId : undefined;
    } catch {
      return undefined;
    }
  }
}
