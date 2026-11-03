/** When snapshots are taken, one at a time (Snapshotter), and a snapshot being taken. */

/** A snapshot being taken: whether it worked, and how to end it at once. */
export interface SnapshotJob {
  done: Promise<boolean>;
  abort: () => void;
}

export interface SnapshotterOptions {
  /** Starts taking a snapshot, for this reason. */
  take: (reason: string) => SnapshotJob;
  everyMs: number;
  /** After a snapshot that failed: 60 s by default. */
  retryMs?: number;
  /** A timed run is at work. */
  busy?: () => boolean;
  /** The longest a snapshot waits while busy: 5 minutes by default. */
  deferMs?: number;
  /** How often a waiting snapshot looks again: 2 s by default. */
  pollMs?: number;
}

/**
 * When snapshots are taken: every `everyMs`, and soon after each `request` (an export, an
 * enrollment), one at a time. A snapshot that falls due while `busy` (a timed run at work) waits
 * for it to end, up to `deferMs`, so its copying does not disturb the judge's timing. One that
 * fails is tried again after `retryMs`. `stop` takes the last one, within the time a stop allows.
 */
export class Snapshotter {
  private job: SnapshotJob | undefined;
  private wanted: string | undefined;
  private stopping = false;
  private waiting = false;
  private deferredSince: number | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private readonly o: SnapshotterOptions;

  constructor(o: SnapshotterOptions) {
    this.o = o;
  }

  start(): void {
    const every =
      this.o.everyMs >= 60_000
        ? `every ${Math.round((this.o.everyMs / 60_000) * 100) / 100} minutes`
        : `every ${this.o.everyMs / 1000} seconds`;
    this.interval = setInterval(() => this.request(every), this.o.everyMs);
    this.interval.unref?.();
  }

  /** A snapshot soon: now, or after the one being taken. */
  request(reason: string): void {
    if (this.stopping) return;
    this.wanted ??= reason;
    this.kick();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  private kick(): void {
    if (this.job || this.wanted === undefined || this.stopping) return;
    if (this.o.busy?.()) {
      const now = Date.now();
      this.deferredSince ??= now;
      if (now - this.deferredSince < (this.o.deferMs ?? 300_000)) {
        if (!this.waiting) {
          this.waiting = true;
          this.later(this.o.pollMs ?? 2000, () => {
            this.waiting = false;
            this.kick();
          });
        }
        return;
      }
    }
    this.deferredSince = undefined;
    const reason = this.wanted;
    this.wanted = undefined;
    const job = this.o.take(reason);
    this.job = job;
    void job.done
      .then(
        (ok) => ok,
        () => false,
      )
      .then((ok) => {
        if (this.job === job) this.job = undefined;
        if (this.stopping) return;
        if (!ok) this.later(this.o.retryMs ?? 60_000, () => this.request("again, after a failure"));
        this.kick();
      });
  }

  /**
   * At a stop: no more snapshots but this last one, taken once the one under way (if any) ends.
   * Gives up after `budgetMs`, ending the one under way; the last complete snapshot then stays.
   */
  async stop(budgetMs: number): Promise<"taken" | "failed" | "out of time"> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const deadline = Date.now() + budgetMs;
    const wait = (job: SnapshotJob) =>
      new Promise<boolean | "time">((resolve) => {
        const t = setTimeout(() => resolve("time"), Math.max(0, deadline - Date.now()));
        job.done.then(
          (ok) => {
            clearTimeout(t);
            resolve(ok);
          },
          () => {
            clearTimeout(t);
            resolve(false);
          },
        );
      });
    if (this.job) {
      const before = this.job;
      if ((await wait(before)) === "time") {
        before.abort();
        return "out of time";
      }
    }
    const job = this.o.take("at the stop");
    this.job = job;
    const r = await wait(job);
    this.job = undefined;
    if (r === "time") {
      job.abort();
      return "out of time";
    }
    return r ? "taken" : "failed";
  }

  /** Ends the snapshot under way now (a second stop signal). */
  abort(): void {
    this.job?.abort();
  }
}
