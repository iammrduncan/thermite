import type { RunnerPool } from "../../core/rig-settings.ts";
import type { LaneRun, RemoteRunner } from "./remote-runner.ts";
import { RunnerAway } from "./runner-link.ts";
import { RunnerClock, type RunnerTime, WaitTotals } from "./runner-time.ts";

/**
 * The runners of a rig's other machines, in their pools (goal 206): each is the judge's, one
 * lane's (`lane-2`), shared by the judge and every lane, or the lanes' (`lanes`, goal 229), shared
 * by every lane and never the judge. A runner takes one run at a time, first come, first served:
 * the judge holds its runner for a whole job, a lane for one run of its command, and whoever
 * waited first for a runner it may use gets it when it is free. So a measurement never shares its
 * runner with another run.
 *
 * Runners come and go while the rig works: one added takes runs once it answers (up), one that
 * stops answering takes none until it answers again, and one taken away takes none again. A run
 * waits while no runner of its pool is up and free; a run that waits for a pool no runner serves
 * any more is told so.
 */

/** A runner's pool: the judge's, a lane's, shared, or the lanes'. */
export type Pool = RunnerPool;

interface Slot {
  runner: RemoteRunner;
  pool: Pool;
  /** Who holds it now, if anyone. */
  holder: string | undefined;
  /** It answered its last check: runs go to it. */
  up: boolean;
  /** How it spent its time since it joined (goal 231). */
  clock: RunnerClock;
}

/** Who has a runner, for a lane that waits for it: `box-4-0: lane-2's run`. */
function heldWords(s: Slot): string {
  const who = !s.up
    ? "away"
    : !s.holder
      ? "promised to a run that waited longer"
      : s.holder.startsWith("executor-")
        ? "the judge's job"
        : `${s.holder}'s run`;
  return `${s.runner.name}: ${who}`;
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
  /** Who waited for a runner, and how long (goal 231), since the pools began. */
  private readonly waited = new WaitTotals();
  readonly since = Date.now();

  /** A runner joins its pool: it takes runs once it is up. */
  add(runner: RemoteRunner, pool: Pool, up = false): void {
    const s: Slot = { runner, pool, holder: undefined, up, clock: new RunnerClock() };
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
    s.clock.tally(s);
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

  /** Whether a lane's runs go to runners: it has one of its own, or a lanes' or shared one. */
  serves(lane: string): boolean {
    return this.slots.some((s) => s.pool === lane || s.pool === "lanes" || s.pool === "shared");
  }

  /**
   * Holds a runner `who` may use, in the order asked: at once when one is up and free and nobody
   * waits for it (the free one `rank` puts first, lowest first), else when one comes free, told
   * first by `onWait`. "ended": `signal` aborted first; "gone": no runner it may use is in the rig
   * any more.
   */
  private hold(
    who: string,
    may: (s: Slot) => boolean,
    signal?: AbortSignal,
    rank?: (s: Slot) => number,
    onWait?: () => void,
  ): Promise<Slot | "ended" | "gone"> {
    if (!this.slots.some(may)) return Promise.resolve("gone");
    const open = (s: Slot) => s.up && !s.holder && may(s) && !this.waiters.some((w) => w.may(s));
    const opens = this.slots.filter(open);
    const free = rank ? [...opens].sort((a, b) => rank(a) - rank(b))[0] : opens[0];
    if (free) {
      this.holdBy(free, who);
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
          this.waited.end(who, w.since);
          resolve(s);
        },
      };
      const ended = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        this.waited.end(who, w.since);
        resolve("ended");
      };
      signal?.addEventListener("abort", ended, { once: true });
      onWait?.();
      this.waiters.push(w);
    });
  }

  /** Gives a runner up and free to the first waiter that may use it. */
  private offer(s: Slot): void {
    if (!s.up || s.holder || !this.slots.includes(s)) return;
    const i = this.waiters.findIndex((w) => w.may(s));
    if (i < 0) return;
    const [w] = this.waiters.splice(i, 1) as [Waiter];
    this.holdBy(s, w.who);
    w.take(s);
  }

  /** Lets a runner go: the first waiter that may use it takes it. */
  private release(s: Slot): void {
    this.holdBy(s, undefined);
    this.offer(s);
  }

  /** A runner's holder changes, its time until then counted as its old holder's. */
  private holdBy(s: Slot, who: string | undefined): void {
    s.clock.tally(s);
    s.holder = who;
  }

  /**
   * How each runner spent its time since it joined, by its name, and who waited for one, the
   * judge's executors together as `judge` (goal 231).
   */
  use(now = Date.now()): {
    runners: Record<string, RunnerTime>;
    waited: Record<string, { count: number; ms: number }>;
  } {
    return {
      runners: Object.fromEntries(this.slots.map((s) => [s.runner.name, s.clock.totals(s, now)])),
      waited: this.waited.totals(this.waits(), now),
    };
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
  async laneRun(
    r: LaneRun,
    signal?: AbortSignal,
    onWait?: (held: string) => void,
  ): Promise<object> {
    const mine = (s: Slot) => s.pool === r.lane;
    // Its own runner, the lanes' (goal 229) or a shared one, the judge's too.
    const may = (s: Slot) => mine(s) || s.pool === "lanes" || s.pool === "shared";
    const asked = Date.now();
    let waited = false;
    // Its own runner when it has one free, then a lanes' runner, and a shared one last: the
    // judge needs that one too. One that must wait is told who holds its runners (goal 229).
    const s = await this.hold(
      r.lane,
      may,
      signal,
      (x) => (mine(x) ? 0 : x.pool === "lanes" ? 1 : 2),
      () => {
        waited = true;
        onWait?.(this.slots.filter(may).map(heldWords).join("; "));
      },
    );
    const waitedS = waited ? Math.round((Date.now() - asked) / 1000) : undefined;
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
      // The machine's memory for a run whose memory no one set, on the lane's own runner or a
      // lanes' one, which no judge's job shares (goals 219 and 229): a shared one keeps the default.
      const run =
        mine(s) || s.pool === "lanes" ? r : { ...r, limits: { ...r.limits, rssDefault: false } };
      const out = { ...(await s.runner.laneRun(run)), runner: s.runner.name };
      return waitedS === undefined ? out : { ...out, waited_s: waitedS };
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
