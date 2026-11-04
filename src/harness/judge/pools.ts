import type { LaneRun, RemoteRunner } from "./remote-runner.ts";

/**
 * The runners of a rig's other machines, in their pools (goal 206): each is the judge's, one
 * lane's (`lane-2`), or shared by the judge and every lane. A runner takes one run at a time,
 * first come, first served: the judge holds its runner for a whole job, a lane for one run of its
 * command, and whoever waited first for a runner it may use gets it when it is free. So a
 * measurement never shares its runner with another run.
 */

/** A runner's pool: the judge's, a lane's, or shared. */
export type Pool = "judge" | "shared" | `lane-${number}`;

interface Slot {
  runner: RemoteRunner;
  pool: Pool;
  /** Who holds it now, if anyone. */
  holder: string | undefined;
}

interface Waiter {
  who: string;
  may: (s: Slot) => boolean;
  take: (s: Slot) => void;
}

export class RunnerPools {
  private readonly slots: Slot[];
  private readonly waiters: Waiter[] = [];
  /** Each trial's runners it ran on, by trial: their workspaces go when it ends. */
  private readonly used = new Map<string, { lane: string; runners: Set<RemoteRunner> }>();

  constructor(runners: { runner: RemoteRunner; pool: Pool }[]) {
    this.slots = runners.map((r) => ({ ...r, holder: undefined }));
  }

  /** The runners the judge measures on: its own and the shared ones. */
  judges(): { runner: RemoteRunner; shared: boolean }[] {
    return this.slots
      .filter((s) => s.pool === "judge" || s.pool === "shared")
      .map((s) => ({ runner: s.runner, shared: s.pool === "shared" }));
  }

  /** Whether a lane's runs go to runners: it has one of its own, or a shared one serves it. */
  serves(lane: string): boolean {
    return this.slots.some((s) => s.pool === lane || s.pool === "shared");
  }

  /**
   * Holds a runner `who` may use, in the order asked: at once when one is free and nobody waits
   * for it (one `first` picks, when free), else when it comes free. Gives up, with undefined, when
   * `signal` aborts first.
   */
  private hold(
    who: string,
    may: (s: Slot) => boolean,
    signal?: AbortSignal,
    first?: (s: Slot) => boolean,
  ): Promise<Slot | undefined> {
    const open = (s: Slot) => !s.holder && may(s) && !this.waiters.some((w) => w.may(s));
    const free = this.slots.find((s) => open(s) && (first?.(s) ?? true)) ?? this.slots.find(open);
    if (free) {
      free.holder = who;
      return Promise.resolve(free);
    }
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const w: Waiter = {
        who,
        may,
        take: (s) => {
          signal?.removeEventListener("abort", gone);
          resolve(s);
        },
      };
      const gone = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(undefined);
      };
      signal?.addEventListener("abort", gone, { once: true });
      this.waiters.push(w);
    });
  }

  /** Lets a runner go: the first waiter that may use it takes it. */
  private release(s: Slot): void {
    s.holder = undefined;
    const i = this.waiters.findIndex((w) => w.may(s));
    if (i < 0) return;
    const [w] = this.waiters.splice(i, 1) as [Waiter];
    s.holder = w.who;
    w.take(s);
  }

  /** The judge's executor on `runner` holds it for a job; the function returned lets it go. */
  async holdForJudge(runner: RemoteRunner, who: string): Promise<() => void> {
    const s = await this.hold(who, (x) => x.runner === runner);
    if (!s) throw new Error("the runner was not held");
    return () => this.release(s);
  }

  /** Whether any lane waits for the runner, or holds it (the judge then waits its turn). */
  busy(runner: RemoteRunner): boolean {
    const s = this.slots.find((x) => x.runner === runner);
    return Boolean(s?.holder) || this.waiters.some((w) => s !== undefined && w.may(s));
  }

  /**
   * One run of a lane's command on a runner of its pools, its own first: it waits for one in
   * turn, and gives up when its trial ends first (`signal`). The answer is the run's output, which
   * never counts.
   */
  async laneRun(r: LaneRun, signal?: AbortSignal): Promise<object> {
    const mine = (s: Slot) => s.pool === r.lane;
    const may = (s: Slot) => mine(s) || s.pool === "shared";
    // Its own runner when it has one free: a shared one only when its own is busy or it has none.
    const s = await this.hold(r.lane, may, signal, mine);
    if (!s) return { ran: false, reason: "the trial ended before a runner was free" };
    const u = this.used.get(r.trial) ?? { lane: r.lane, runners: new Set() };
    u.runners.add(s.runner);
    this.used.set(r.trial, u);
    try {
      return { ...(await s.runner.laneRun(r)), runner: s.runner.name };
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
