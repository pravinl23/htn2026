export interface PoolOptions<T, R> {
  /** Most workers in flight at once. */
  limit: number;
  /** After a result this returns true for, no new item starts. Items already in flight finish, so every item is whole or untouched. */
  stopOn?: (result: R) => boolean;
  /** Once aborted, no new item starts either (cancel, client disconnect, job deadline). */
  signal?: AbortSignal;
  /** Result for an item that never started because the run stopped. */
  skipped: (item: T) => R;
}

/** Runs `worker` over `items` with bounded concurrency. Results keep the order of `items`. A worker must not throw. */
export async function runPool<T, R>(items: readonly T[], opts: PoolOptions<T, R>, worker: (item: T, position: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let stopped = false;

  async function lane(): Promise<void> {
    while (next < items.length) {
      const position = next++;
      const item = items[position] as T;
      if (stopped || opts.signal?.aborted) {
        results[position] = opts.skipped(item);
        continue;
      }
      const result = await worker(item, position);
      results[position] = result;
      if (opts.stopOn?.(result)) stopped = true;
    }
  }

  const lanes = Math.max(1, Math.min(Math.floor(opts.limit) || 1, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

export interface Semaphore {
  /** Resolves with the release function once a slot is free. */
  acquire(): Promise<() => void>;
}

/** Process-wide cap that outlives a single run: every run of one executor shares it, so N requests never mean N x limit sessions. */
export function createSemaphore(limit: number): Semaphore {
  let free = Math.max(1, Math.floor(limit) || 1);
  const waiting: Array<() => void> = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else free++;
  };
  return {
    acquire() {
      const once = (): (() => void) => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          release();
        };
      };
      if (free > 0) {
        free--;
        return Promise.resolve(once());
      }
      return new Promise((resolve) => waiting.push(() => resolve(once())));
    },
  };
}
