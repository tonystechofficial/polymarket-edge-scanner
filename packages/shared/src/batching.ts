/**
 * Pure helpers that keep every invocation short and resumable.
 * A cron run is not a process: it gets 10 ms of CPU and a handful of subrequests,
 * so the universe is walked slice by slice with a cursor persisted in D1.
 */
export interface BatchSelection<T> {
  batch: T[];
  nextCursor: number;
  /** True when this slice reached the end of the list: the next run starts over. */
  wrapped: boolean;
}

export function selectBatch<T>(items: readonly T[], cursor: number, size: number, hardCap: number): BatchSelection<T> {
  const n = Math.max(0, Math.min(size, hardCap));
  if (items.length === 0 || n === 0) return { batch: [], nextCursor: 0, wrapped: items.length === 0 };
  const start = cursor >= items.length || cursor < 0 ? 0 : Math.floor(cursor);
  const end = Math.min(items.length, start + n);
  const nextCursor = end >= items.length ? 0 : end;
  return { batch: items.slice(start, end), nextCursor, wrapped: nextCursor === 0 };
}

/** Discovery (Gamma listing) is the heaviest step: run it on a cadence, or at once when nothing is tracked. */
export function shouldDiscover(runCounter: number, everyNRuns: number, trackedCount: number): boolean {
  if (trackedCount <= 0) return true;
  const n = Math.max(1, Math.floor(everyNRuns));
  return runCounter % n === 0;
}

/** Counters for one invocation. `take` throws so a run stops before the platform kills it. */
export class RunBudget {
  readonly used = { subrequests: 0, d1Statements: 0, aiCalls: 0 };
  constructor(readonly limits: { subrequests: number; d1Statements: number; aiCalls: number }) {}
  take(kind: keyof RunBudget['used'], count = 1): void {
    if (this.used[kind] + count > this.limits[kind]) {
      throw new Error(`Run budget exceeded for ${kind}: ${this.used[kind]} + ${count} > ${this.limits[kind]}`);
    }
    this.used[kind] += count;
  }
  can(kind: keyof RunBudget['used'], count = 1): boolean {
    return this.used[kind] + count <= this.limits[kind];
  }
}
