import { createAgentReplayFixture, sanitizeAgentRunOutcome } from "@ghost/shared";
import type { AgentReplayFixture, AgentRunOutcome } from "@ghost/shared";
import type { ServerConfig } from "../config";

export interface AgentOutcomeSink {
  readonly enabled: boolean;
  capture(outcome: AgentRunOutcome, replay?: AgentReplayFixture): Promise<string | undefined>;
}

export class NoopAgentOutcomeSink implements AgentOutcomeSink {
  readonly enabled = false;
  async capture(): Promise<undefined> {
    return undefined;
  }
}

export function createAgentOutcomeSink(config: ServerConfig): AgentOutcomeSink {
  return config.sentry ? new SentryAgentOutcomeSink(config.sentry) : new NoopAgentOutcomeSink();
}

/** A process-local review queue; Sentry remains the durable source when configured. */
export class AgentReplayStore {
  private readonly fixtures: AgentReplayFixture[] = [];

  constructor(private readonly capacity = 100) {}

  add(outcome: AgentRunOutcome): AgentReplayFixture | undefined {
    if (outcome.state !== "blocked") return undefined;
    const fixture = createAgentReplayFixture(outcome);
    this.fixtures.unshift(fixture);
    if (this.fixtures.length > this.capacity) this.fixtures.length = this.capacity;
    return fixture;
  }

  list(): AgentReplayFixture[] {
    return this.fixtures.map((fixture) => structuredClone(fixture));
  }
}

class SentryAgentOutcomeSink implements AgentOutcomeSink {
  readonly enabled = true;
  private sdkPromise?: Promise<typeof import("@sentry/node")>;

  constructor(private readonly config: NonNullable<ServerConfig["sentry"]>) {}

  async capture(outcome: AgentRunOutcome, replay?: AgentReplayFixture): Promise<string | undefined> {
    try {
      const sdk = await this.sdk();
      return sdk.withScope((scope) => {
        if (replay) {
          scope.addAttachment({
            filename: `agent-replay-${replay.caseId}.json`,
            data: JSON.stringify(replay),
            contentType: "application/json",
          });
        }
        return sdk.captureEvent({ extra: { agent_outcome: outcome } });
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
        beforeSend: (event) => scrubSentryAgentEvent(event) as typeof event | null,
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
export function scrubSentryAgentEvent(raw: unknown): Record<string, unknown> | null {
  if (!isObject(raw)) return null;
  const extra = isObject(raw.extra) ? raw.extra : {};
  const outcome = sanitizeAgentRunOutcome(extra.agent_outcome);
  if (!outcome) return null;
  const replay = outcome.state === "blocked" ? createAgentReplayFixture(outcome) : undefined;
  const finalDecision = outcome.decisions.at(-1);
  const provider = finalDecision?.provider ?? "none";
  const operation = finalDecision?.operation ?? "none";
  return compact({
    event_id: safeEventId(raw.event_id),
    timestamp: typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : undefined,
    platform: "node",
    level: outcome.state === "blocked" ? "warning" : "info",
    message: `ghost.agent_run.${outcome.state}`,
    fingerprint: ["ghost.agent_run", outcome.state, outcome.reason, operation, provider],
    tags: {
      feature: "jev-computer-use",
      schema: outcome.schemaVersion,
      state: outcome.state,
      reason: outcome.reason,
      provider,
      operation,
    },
    extra: { agent_outcome: outcome, ...(replay ? { agent_replay: replay } : {}) },
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
