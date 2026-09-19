import { describe, expect, it } from "vitest";
import { hedge } from "../src/providers/hedge";

/** Resolves after `ms`, or rejects as soon as the race aborts it. Records the abort. */
function request<T>(ms: number, value: T, signal: AbortSignal, aborted: number[] = [], index = -1): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      aborted.push(index);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

describe("hedge", () => {
  it("resolves with the first K results and aborts the straggler", async () => {
    const aborted: number[] = [];
    const delays = [10, 400, 20, 30]; // request 1 is the multi-second outlier of the real distribution, scaled down
    const started = performance.now();
    const outcome = await hedge({ total: 4, need: 3, deadlineMs: 1000, run: (i, signal) => request(delays[i] ?? 0, `r${i}`, signal, aborted, i) });
    expect(outcome.values).toEqual(["r0", "r2", "r3"]);
    expect(outcome).toMatchObject({ launched: 4, failed: 0, abandoned: 1, deadlineHit: false });
    expect(aborted).toEqual([1]);
    expect(performance.now() - started).toBeLessThan(300);
    expect(outcome.arrivalsMs).toHaveLength(3);
    expect(outcome.arrivalsMs[0]).toBeLessThanOrEqual(outcome.arrivalsMs[2] ?? 0);
  });

  it("fires every request at once, before any of them settles", async () => {
    const launchedAt: number[] = [];
    const started = performance.now();
    await hedge({
      total: 4,
      need: 4,
      deadlineMs: 1000,
      run: (i, signal) => {
        launchedAt.push(performance.now() - started);
        return request(30, i, signal);
      },
    });
    expect(launchedAt).toHaveLength(4);
    expect(Math.max(...launchedAt)).toBeLessThan(25);
  });

  it("a failed request is replaced by the hedge, and failures are counted", async () => {
    const outcome = await hedge({
      total: 4,
      need: 3,
      deadlineMs: 1000,
      run: (i, signal) => (i === 0 ? Promise.reject(new Error("HTTP 500")) : request(10 * i, i, signal)),
    });
    expect(outcome.values).toEqual([1, 2, 3]);
    expect(outcome).toMatchObject({ failed: 1, abandoned: 0, deadlineHit: false });
    expect(outcome.errors).toHaveLength(1);
  });

  it("settles early with fewer than K when every request is done", async () => {
    const started = performance.now();
    const outcome = await hedge({ total: 3, need: 3, deadlineMs: 5000, run: (i, signal) => (i < 2 ? Promise.reject(new Error("bad")) : request(5, "only", signal)) });
    expect(outcome.values).toEqual(["only"]);
    expect(outcome).toMatchObject({ failed: 2, abandoned: 0, deadlineHit: false });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("at the deadline it answers with what arrived and aborts the rest", async () => {
    const aborted: number[] = [];
    const delays = [10, 5000, 5000, 5000];
    const outcome = await hedge({ total: 4, need: 3, deadlineMs: 60, run: (i, signal) => request(delays[i] ?? 0, i, signal, aborted, i) });
    expect(outcome.values).toEqual([0]);
    expect(outcome).toMatchObject({ deadlineHit: true, abandoned: 3, failed: 0 });
    expect(aborted.sort()).toEqual([1, 2, 3]);
    expect(outcome.elapsedMs).toBeLessThan(1000);
  });

  it("reports zero values when nothing arrives in time, and never rejects", async () => {
    const outcome = await hedge({ total: 2, need: 2, deadlineMs: 30, run: (i, signal) => request(5000, i, signal) });
    expect(outcome.values).toEqual([]);
    expect(outcome.deadlineHit).toBe(true);
  });

  it("a fatal error ends the race at once and aborts everything else", async () => {
    const aborted: number[] = [];
    const fatal = Object.assign(new Error("HTTP 401"), { status: 401 });
    const started = performance.now();
    const outcome = await hedge({
      total: 4,
      need: 3,
      deadlineMs: 5000,
      run: (i, signal) => (i === 2 ? Promise.reject(fatal) : request(2000, i, signal, aborted, i)),
      isFatal: (err) => (err as { status?: number }).status === 401,
    });
    expect(outcome.fatal).toBe(fatal);
    expect(outcome.values).toEqual([]);
    expect(aborted.sort()).toEqual([0, 1, 3]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("treats a synchronous throw inside run() as an invalid result", async () => {
    const outcome = await hedge<number>({
      total: 2,
      need: 1,
      deadlineMs: 1000,
      run: (i, signal) => {
        if (i === 0) throw new Error("sync");
        return request(5, 7, signal);
      },
    });
    expect(outcome.values).toEqual([7]);
    expect(outcome.failed).toBe(1);
  });

  it("ignores results that arrive after the race is over", async () => {
    // This request ignores the abort signal, like a fetch whose body already arrived.
    const late = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 80));
    const outcome = await hedge({ total: 2, need: 1, deadlineMs: 1000, run: (i, signal) => (i === 0 ? request(5, "fast", signal) : late) });
    await late;
    expect(outcome.values).toEqual(["fast"]);
    expect(outcome.abandoned).toBe(1);
  });

  it("clamps nonsense: need never exceeds total, and at least one request is sent", async () => {
    const a = await hedge({ total: 2, need: 9, deadlineMs: 500, run: (i, signal) => request(5, i, signal) });
    expect(a.values).toHaveLength(2);
    const b = await hedge({ total: 0, need: 0, deadlineMs: 500, run: (i, signal) => request(5, i, signal) });
    expect(b).toMatchObject({ launched: 1 });
    expect(b.values).toEqual([0]);
    const c = await hedge({ total: Number.NaN, need: Number.NaN, deadlineMs: 500, run: (i, signal) => request(5, i, signal) });
    expect(c.launched).toBe(1);
  });
});
