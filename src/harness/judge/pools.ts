import type { RunnerPool } from "../../core/rig-settings.ts";
import type { LaneRun, RemoteRunner } from "./remote-runner.ts";
import { RunnerAway } from "./runner-link.ts";

/**
 * The runners of a rig's other machines, in their pools (goal 206): each is the judge's, one
 * lane's (`lane-2`), or shared by the judge and every lane. A runner takes one run at a time,
 * first come, first served: the judge holds its runner for a whole job, a lane for one run of its
 * command, and whoever waited first for a runner it may use gets it when it is free. So a
 * measurement never shares its runner with another run.
 *
 * Runners come and go while the rig works: one added takes runs once it answers (up), one that
 * stops answering takes none until it answers again, and one taken away takes none again. A run
 * waits while no runner of its pool is up and free; a run that waits for a pool no runner serves
 * any more is told so.
 */

/** A runner's pool: the judge's, a lane's, or shared. */
export type Pool = RunnerPool;

interface Slot {
  runner: RemoteRunner;
  pool: Pool;
  /** Who holds it now, if anyone. */
  holder: string | undefined;
  /** It answered its last check: runs go to it. */
  up: boolean;
}

interface Waiter {
  who: string;
  /** When it asked, in ms. */
  since: number;
  may: (s: Slot) => boolean;
  take: (s: Slot | "gone") => void;
}

export class RunnerPools {
  private readonly slots: Slot[] = [];
  private readonly waiters: Waiter[] = [];
  /** Each trial's runners it ran on, by trial: their workspaces go when it ends. */
  private readonly used = new Map<string, { lane: string; runners: Set<RemoteRunner> }>();

  /** A runner joins its pool: it takes runs once it is up. */
  add(runner: RemoteRunner, pool: Pool, up = false): void {
    const s: Slot = { runner, pool, holder: undefined, up };
    this.slots.push(s);
    this.offer(s);
  }

  /**
   * A runner leaves: no run goes to it again. Its run under way fails through its link; a run
   * that waits for a pool no runner serves now is told so.
   */
  remove(runner: RemoteRunner): void {
    const i = this.slots.findIndex((s) => s.runner === runner);
    if (i < 0) return;
    this.slots.splice(i, 1);
    for (const w of [...this.waiters])
      if (!this.slots.some((s) => w.may(s))) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.take("gone");
      }
  }

  /** Whether the runner answers: up, it takes runs; down, none until it answers again. */
  setUp(runner: RemoteRunner, up: boolean): void {
    const s = this.slots.find((x) => x.runner === runner);
    if (!s || s.up === up) return;
    s.up = up;
    this.offer(s);
  }

  /**
   * The run's model files begun on each runner that is up and serves lanes (its own pool's or the
   * shared one), ahead of their first runs (goal 217). The judge's runner fetches its own before
   * its first build. A fetch that could not begin is tried again at the next call.
   */
  prefetch(run: string, failed: (runner: string, err: unknown) => void): void {
    for (const s of this.slots)
      if (s.up && s.pool !== "judge")
        void s.runner.prefetch(run).catch((err) => failed(s.runner.name, err));
  }

  /** Whether a lane's runs go to runners: it has one of its own, or a shared one serves it. */
  serves(lane: string): boolean {
    return this.slots.some((s) => s.pool === lane || s.pool === "shared");
  }

  /**
   * Holds a runner `who` may use, in the order asked: at once when one is up and free and nobody
   * waits for it (one `first` picks, when free), else when one comes free. "ended": `signal`
   * aborted first; "gone": no runner it may use is in the rig any more.
   */
  private hold(
    who: string,
    may: (s: Slot) => boolean,
    signal?: AbortSignal,
    first?: (s: Slot) => boolean,
  ): Promise<Slot | "ended" | "gone"> {
    if (!this.slots.some(may)) return Promise.resolve("gone");
    const open = (s: Slot) => s.up && !s.holder && may(s) && !this.waiters.some((w) => w.may(s));
    const free = this.slots.find((s) => open(s) && (first?.(s) ?? true)) ?? this.slots.find(open);
    if (free) {
      free.holder = who;
      return Promise.resolve(free);
    }
    if (signal?.aborted) return Promise.resolve("ended");
    return new Promise((resolve) => {
      const w: Waiter = {
        who,
        since: Date.now(),
        may,
        take: (s) => {
          signal?.removeEventListener("abort", ended);
          resolve(s);
        },
      };
      const ended = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve("ended");
      };
      signal?.addEventListener("abort", ended, { once: true });
      this.waiters.push(w);
    });
  }

  /** Gives a runner up and free to the first waiter that may use it. */
  private offer(s: Slot): void {
    if (!s.up || s.holder || !this.slots.includes(s)) return;
    const i = this.waiters.findIndex((w) => w.may(s));
    if (i < 0) return;
    const [w] = this.waiters.splice(i, 1) as [Waiter];
    s.holder = w.who;
    w.take(s);
  }

  /** Lets a runner go: the first waiter that may use it takes it. */
  private release(s: Slot): void {
    s.holder = undefined;
    this.offer(s);
  }

  /**
   * The judge's executor on `runner` holds it for a job; the function returned lets it go.
   * Undefined: the runner left the rig.
   */
  async holdForJudge(runner: RemoteRunner, who: string): Promise<(() => void) | undefined> {
    const s = await this.hold(who, (x) => x.runner === runner);
    if (typeof s === "string") return undefined;
    return () => this.release(s);
  }

  /** Who holds the runner now: the judge's executor (`executor-…`) or a lane; undefined: free. */
  holderOf(runner: RemoteRunner): string | undefined {
    return this.slots.find((x) => x.runner === runner)?.holder;
  }

  /** Who waits for a runner, in the order they asked: the judge's executors and the lanes. */
  waiting(): string[] {
    return this.waiters.map((w) => w.who);
  }

  /** The same, each with when it asked (goal 206: the rig's page says how long it waits). */
  waits(): { who: string; since: number }[] {
    return this.waiters.map((w) => ({ who: w.who, since: w.since }));
  }

  /** Whether any lane waits for the runner, or holds it (the judge then waits its turn). */
  busy(runner: RemoteRunner): boolean {
    const s = this.slots.find((x) => x.runner === runner);
    return Boolean(s?.holder) || this.waiters.some((w) => s !== undefined && w.may(s));
  }

  /**
   * One run of a lane's command on a runner of its pools, its own first: it waits for one in
   * turn, and gives up when its trial ends first (`signal`). The answer is the run's output, which
   * never counts, or why it did not run: its runner left or stopped answering.
   */
  async laneRun(r: LaneRun, signal?: AbortSignal): Promise<object> {
    const mine = (s: Slot) => s.pool === r.lane;
    const may = (s: Slot) => mine(s) || s.pool === "shared";
    // Its own runner when it has one free: a shared one only when its own is busy or it has none.
    const s = await this.hold(r.lane, may, signal, mine);
    if (s === "ended") return { ran: false, reason: "the trial ended before a runner was free" };
    if (s === "gone")
      return {
        ran: false,
        reason: `no runner serves ${r.lane} now: run it again, and it runs on the core's machine`,
      };
    const u = this.used.get(r.trial) ?? { lane: r.lane, runners: new Set() };
    u.runners.add(s.runner);
    this.used.set(r.trial, u);
    try {
      // The machine's memory for a run whose memory no one set, on the lane's own runner alone
      // (goal 219): a shared one keeps the default.
      const run = mine(s) ? r : { ...r, limits: { ...r.limits, rssDefault: false } };
      return { ...(await s.runner.laneRun(run)), runner: s.runner.name };
    } catch (err) {
      if (!(err instanceof RunnerAway)) throw err;
      return { ran: false, reason: `${err.message} while your command ran: run it again` };
    } finally {
      this.release(s);
    }
  }

  /** A trial ended: its workspaces on the runners it ran on go. */
  async trialEnded(trial: string): Promise<void> {
    const u = this.used.get(trial);
    this.used.delete(trial);
    for (const runner of u?.runners ?? [])
      await runner.laneEnd(u?.lane ?? "", trial).catch(() => undefined);
  }
}
