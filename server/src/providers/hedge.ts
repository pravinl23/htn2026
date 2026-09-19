/**
 * Tail-latency hedging: fire `total` identical requests at once, settle as soon as `need` valid results are in, and
 * abort the stragglers. Pure scheduling: it knows nothing about HTTP or models. Never rejects.
 */

export interface HedgeOptions<T> {
  /** Requests fired in parallel (K + H). */
  total: number;
  /** Valid results that end the race (K). */
  need: number;
  deadlineMs: number;
  /** A rejection is an invalid result. The signal aborts when the race is over. */
  run(index: number, signal: AbortSignal): Promise<T>;
  /** An error that makes waiting for the other requests pointless (a rejected key). Ends the race at once. */
  isFatal?(err: unknown): boolean;
}

export interface HedgeOutcome<T> {
  /** Valid results in arrival order, at most `need`. */
  values: T[];
  /** Milliseconds from the start to each valid arrival. */
  arrivalsMs: number[];
  launched: number;
  failed: number;
  /** Requests still running when the race ended (aborted). */
  abandoned: number;
  deadlineHit: boolean;
  errors: unknown[];
  fatal?: unknown;
  elapsedMs: number;
}

export class HedgeAbort extends Error {
  constructor() {
    super("hedged request no longer needed");
    this.name = "AbortError";
  }
}

function wholeNumber(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;
}

export function hedge<T>(options: HedgeOptions<T>): Promise<HedgeOutcome<T>> {
  const total = wholeNumber(options.total, 1, 64);
  const need = wholeNumber(options.need, 1, total);
  const controller = new AbortController();
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);

  return new Promise((resolve) => {
    const values: T[] = [];
    const arrivalsMs: number[] = [];
    const errors: unknown[] = [];
    let settled = 0;
    let done = false;

    const finish = (extra: { deadlineHit?: boolean; fatal?: unknown } = {}): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      controller.abort(new HedgeAbort());
      resolve({ values, arrivalsMs, launched: total, failed: errors.length, abandoned: total - settled, deadlineHit: extra.deadlineHit ?? false, errors, ...(extra.fatal === undefined ? {} : { fatal: extra.fatal }), elapsedMs: elapsed() });
    };
    const timer = setTimeout(() => finish({ deadlineHit: true }), Math.max(0, options.deadlineMs));

    const onValue = (value: T): void => {
      if (done) return;
      settled += 1;
      values.push(value);
      arrivalsMs.push(elapsed());
      if (values.length >= need || settled === total) finish();
    };
    const onError = (err: unknown): void => {
      if (done) return;
      settled += 1;
      errors.push(err);
      if (options.isFatal?.(err)) finish({ fatal: err });
      else if (settled === total) finish();
    };
    for (let i = 0; i < total; i += 1) {
      // The extra tick turns a synchronous throw inside run() into an ordinary invalid result.
      void Promise.resolve()
        .then(() => options.run(i, controller.signal))
        .then(onValue, onError);
    }
  });
}
