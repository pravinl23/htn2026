/**
 * The only place the rest of the server touches Sentry.
 *
 * Two properties this facade must keep:
 *  1. With no SENTRY_DSN, every function here is a no-op that allocates nothing and imports nothing. The SDK is loaded
 *     lazily by `instrument.ts`, so a unit test, the e2e run and a developer without keys never pay for it and never
 *     open a socket.
 *  2. Nothing reaches the SDK unscrubbed. `beforeSend`/`beforeSendLog` are the backstop; scrubbing here as well means
 *     a value cannot even sit in the SDK's buffers, and it makes the guarantee testable without a live client.
 */
import { scrubAttributes, scrubString } from "./scrub";

/** What a span may carry: names, counts, durations, provider names, confidence buckets, booleans. Never a value. */
export type Attrs = Record<string, string | number | boolean | undefined>;

export interface GhostSpan {
  setAttributes(attributes: Attrs): void;
  setStatus(ok: boolean, message?: string): void;
  end(): void;
}

type SentryNode = typeof import("@sentry/node");

const NOOP_SPAN: GhostSpan = { setAttributes: () => undefined, setStatus: () => undefined, end: () => undefined };

let sdk: SentryNode | undefined;

/** Called once by `instrument.ts` after a successful `Sentry.init`. */
export function attachSdk(loaded: SentryNode): void {
  sdk = loaded;
}

/** Only for tests: forget the SDK so a later assertion can prove the no-DSN path never attached one. */
export function detachSdk(): void {
  sdk = undefined;
}

export function isEnabled(): boolean {
  return sdk !== undefined;
}

function clean(attributes: Attrs | undefined): Attrs | undefined {
  if (!attributes) return undefined;
  const scrubbed = scrubAttributes(attributes as Record<string, unknown>);
  return scrubbed as Attrs | undefined;
}

export interface SpanOptions {
  name: string;
  op: string;
  attributes?: Attrs;
  /** A request span: it becomes its own entry in the trace list rather than a child of whatever was active. */
  transaction?: boolean;
}

/** Runs `fn` inside a span. With Sentry off this is exactly `fn(noopSpan)`: no wrapper, no allocation beyond the call. */
export function span<T>(options: SpanOptions, fn: (span: GhostSpan) => T): T {
  const active = sdk;
  if (!active) return fn(NOOP_SPAN);
  return active.startSpan(
    { name: scrubString(options.name), op: options.op, forceTransaction: options.transaction, attributes: clean(options.attributes) },
    (raw) => fn(wrap(raw)),
  );
}

/**
 * A span the caller ends itself. Needed wherever the work outlives the function that started it: a streamed model
 * answer ends when the last token arrives, not when `fetch` resolves.
 */
export function spanManual(options: SpanOptions): GhostSpan {
  const active = sdk;
  if (!active) return NOOP_SPAN;
  return wrap(active.startInactiveSpan({ name: scrubString(options.name), op: options.op, attributes: clean(options.attributes) }));
}

type RawSpan = ReturnType<SentryNode["startInactiveSpan"]>;

function wrap(raw: RawSpan): GhostSpan {
  return {
    setAttributes(attributes) {
      const scrubbed = clean(attributes);
      if (scrubbed) raw.setAttributes(scrubbed);
    },
    setStatus(ok, message) {
      raw.setStatus(ok ? { code: 1 } : { code: 2, message: message ? scrubString(message) : undefined });
    },
    end() {
      raw.end();
    },
  };
}

export type LogLevel = "info" | "warn" | "error";

/** One structured line per decision: the same value-free attributes as the span, plus what the user ended up seeing. */
export function log(level: LogLevel, message: string, attributes?: Attrs): void {
  const active = sdk;
  if (!active) return;
  active.logger[level](scrubString(message), clean(attributes) as Record<string, unknown> | undefined);
}

export function count(name: string, value = 1, attributes?: Attrs): void {
  sdk?.metrics.count(name, value, { attributes: clean(attributes) });
}

export function distribution(name: string, value: number, unit: string, attributes?: Attrs): void {
  if (!Number.isFinite(value)) return;
  sdk?.metrics.distribution(name, value, { unit, attributes: clean(attributes) });
}

/** Errors only: a thrown exception is worth an event, a refused request is not. */
export function captureError(err: unknown, attributes?: Attrs): void {
  const active = sdk;
  if (!active) return;
  const scrubbed = clean(attributes);
  active.withScope((scope) => {
    if (scrubbed) scope.setContext("ghost", scrubbed);
    active.captureException(err);
  });
}

/** Lets the process exit without losing the last envelope. Resolves immediately when Sentry is off. */
export async function flush(timeoutMs = 2000): Promise<void> {
  await sdk?.flush(timeoutMs);
}

/**
 * Like `spanManual`, but the span is ACTIVE for the duration of `fn`, so spans started inside become its children,
 * and it is still the caller who ends it. Needed for a streamed model answer: the call finishes when the last token
 * arrives, long after the function that started it returned.
 */
export function spanManualIn<T>(options: SpanOptions, fn: (span: GhostSpan) => T): T {
  const active = sdk;
  if (!active) return fn(NOOP_SPAN);
  return active.startSpanManual(
    { name: scrubString(options.name), op: options.op, forceTransaction: options.transaction, attributes: clean(options.attributes) },
    (raw) => fn(wrap(raw)),
  );
}
