import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { SHARED_DEV_RUN_S } from "../../core/contract.ts";
import { type Role, RoleSchema, type Runner } from "../broker/index.ts";
import type { Ledger } from "../ledger/index.ts";
import { laneCacheEnv } from "./workspace.ts";

/**
 * Agents' development runs on the measurement device. The judge goes first: a dev run
 * waits while the judge has work queued or running, and the judge does not start a job while a
 * dev run holds the device. On a rig with dedicated development cards, neither waits for the
 * other: dev runs use their own cards, and the broker keeps them off the judge's. The development
 * cards are a pool: a dev run takes any free card and waits only while all are busy, and a lane
 * has one dev run at a time. A dev run on a
 * card the judge shares is time-limited, so the judge gets the card back; on a dedicated card
 * only the contract's limit applies, if it sets one. Nothing a dev run starts on the device
 * outlives it. Its output is diagnostic only and never reaches the ledger as a measurement.
 */

export const DevRunRequest = z.object({
  lane: RoleSchema.refine((r) => /^lane-\d+$/.test(r), "a lane"),
  command: z.string().min(1).max(4000),
  cwd: z.string().min(1),
  timeout_s: z
    .number()
    .int()
    .min(1)
    .max(24 * 3600)
    .optional(),
});

export class DevRuns {
  /** True while a dev run holds the device; the judge checks it before leasing a job. */
  active = false;
  /** Which development cards are in use; one card in shared mode. */
  private readonly busy: boolean[];
  /** Dev runs waiting for a card, in arrival order. */
  private readonly waiters: { wake: () => void }[] = [];
  /** Each lane's newest dev run (queued or running), so its trial can wait for it to end. */
  private readonly perLane = new Map<string, Promise<unknown>>();
  /** Each lane's newest dev run until it has finished: the lane's next one starts after it. */
  private readonly laneTail = new Map<string, Promise<unknown>>();
  private readonly runner: Runner;
  private readonly ledger: Ledger;
  private readonly scratchDir: string;
  private readonly gpu: boolean;
  private readonly dedicated: boolean;
  private readonly unavailable: string | undefined;
  /** How long a dev run waits for a device before it gives up; none unless given (goal 079). */
  private readonly maxWaitMs: number | undefined;

  constructor(opts: {
    runner: Runner;
    ledger: Ledger;
    scratchDir: string;
    gpu: boolean;
    /** The rig has dedicated development cards. */
    dedicated?: boolean | undefined;
    /** How many development cards (dedicated mode); 1 otherwise. */
    cards?: number | undefined;
    /** Why dev runs cannot run on this rig at all. */
    unavailable?: string | undefined;
    maxWaitMs?: number;
  }) {
    this.runner = opts.runner;
    this.ledger = opts.ledger;
    this.scratchDir = opts.scratchDir;
    this.gpu = opts.gpu;
    this.dedicated = opts.dedicated === true;
    this.unavailable = opts.unavailable;
    this.maxWaitMs = opts.maxWaitMs;
    this.busy = Array.from(
      { length: this.dedicated ? Math.max(1, opts.cards ?? 1) : 1 },
      () => false,
    );
  }

  /** A free card, taken; undefined when every card is busy. */
  private take(): number | undefined {
    const k = this.busy.indexOf(false);
    if (k < 0) return undefined;
    this.busy[k] = true;
    return k;
  }

  private give(k: number): void {
    this.busy[k] = false;
    this.waiters.shift()?.wake();
  }

  private judgeBusy(): boolean {
    return this.ledger.jobs.open(["evaluate", "confirm", "calibrate", "validate"]) > 0;
  }

  /** Each lane's dev run still waiting for a device: how to give it up (its trial ended). */
  private readonly waiting = new Map<string, () => void>();

  /**
   * Waits until the lane's dev runs have ended (a trial's end waits for this). One still waiting
   * for a device gives up at once: its trial has ended (goal 079).
   */
  async settle(lane: string): Promise<void> {
    this.waiting.get(lane)?.();
    await this.perLane.get(lane)?.catch(() => undefined);
  }

  private trialOpen(trial: string): boolean {
    const t = this.ledger.trials.get(trial);
    return t !== undefined && t.ended_at === null;
  }

  /** A dev run for an open trial; one that waited past its trial's end never runs. */
  run(
    input: unknown,
    trial: string,
    limits: { rssMib: number; diskMib: number; timeoutS?: number; processes?: number } = {
      rssMib: 4096,
      diskMib: 2048,
    },
  ): Promise<unknown> {
    const req = DevRunRequest.parse(input);
    const laneRoot = join(this.scratchDir, "lanes", req.lane);
    const cwd = resolve(req.cwd);
    if (!cwd.startsWith(laneRoot + sep))
      throw new Error("a dev run must run in the lane's own workspace");
    if (this.unavailable) return Promise.resolve({ ran: false, reason: this.unavailable });
    const cap = limits.timeoutS ?? (this.dedicated ? undefined : SHARED_DEV_RUN_S);
    const timeoutS =
      req.timeout_s === undefined ? cap : Math.min(req.timeout_s, cap ?? Number.POSITIVE_INFINITY);
    // One dev run per card, in arrival order; a lane's next dev run waits for its last. It waits
    // until a card is free or its trial ends (goal 079: no time limit of its own); with maxWaitMs
    // given, one that waits longer is told so and never runs.
    let started = false;
    let gaveUp = false;
    let waiter: { wake: () => void } | undefined;
    const prev = this.laneTail.get(req.lane) ?? Promise.resolve();
    const next = prev.then(async () => {
      let card = gaveUp ? undefined : this.take();
      while (card === undefined && !gaveUp) {
        await new Promise<void>((wake) => {
          waiter = { wake };
          this.waiters.push(waiter);
        });
        card = gaveUp ? undefined : this.take();
      }
      if (gaveUp) {
        if (card !== undefined) this.give(card);
        return { ran: false, reason: "another lane's dev run held the device" };
      }
      return this.runOn(card as number, req, cwd, trial, limits, timeoutS, () => {
        started = true;
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let giveUp: (reason: string) => void = () => undefined;
    const waited = new Promise<unknown>((resolve) => {
      giveUp = (reason) => {
        if (started || gaveUp) return;
        gaveUp = true;
        // It leaves the line, and ends at once.
        if (waiter) {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          waiter.wake();
        }
        resolve({ ran: false, reason });
      };
      if (this.maxWaitMs === undefined) return;
      timer = setTimeout(
        () => giveUp("another lane's dev run held the device; try again later"),
        this.maxWaitMs,
      );
      timer.unref?.();
    });
    this.waiting.set(req.lane, () => giveUp("the trial ended before a device was free"));
    const outcome = Promise.race([next, waited]).finally(() => {
      clearTimeout(timer);
      if (this.perLane.get(req.lane) === outcome) this.waiting.delete(req.lane);
    });
    this.perLane.set(req.lane, outcome);
    this.laneTail.set(
      req.lane,
      next.catch(() => undefined),
    );
    return outcome;
  }

  /** One dev run on development card `card` (0 in shared mode); the card is given back after. */
  private async runOn(
    card: number,
    req: z.infer<typeof DevRunRequest>,
    cwd: string,
    trial: string,
    limits: { rssMib: number; diskMib: number; processes?: number },
    timeoutS: number | undefined,
    onStart: () => void,
  ): Promise<unknown> {
    try {
      onStart();
      // While the judge has work on the shared device: until it is done, or the trial ends (or,
      // with maxWaitMs given, until that wait is over).
      const deadline =
        this.maxWaitMs !== undefined ? Date.now() + this.maxWaitMs : Number.POSITIVE_INFINITY;
      while (!this.dedicated && this.judgeBusy()) {
        if (Date.now() > deadline)
          return { ran: false, reason: "the judge kept the device busy; try again later" };
        if (!this.trialOpen(trial)) return { ran: false, reason: "the trial has ended" };
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!this.trialOpen(trial)) return { ran: false, reason: "the trial has ended" };
      // The judge waits for a dev run only when they share the card.
      this.active = !this.dedicated;
      try {
        const r = await this.runner.run({
          role: req.lane as Role,
          argv: ["sh", "-c", req.command],
          cwd,
          env: laneCacheEnv(this.scratchDir, req.lane),
          ...(timeoutS !== undefined ? { timeoutMs: timeoutS * 1000 } : {}),
          rssLimitBytes: limits.rssMib * 1024 * 1024,
          disk: { path: cwd, limitBytes: limits.diskMib * 1024 * 1024 },
          ...(limits.processes !== undefined ? { nproc: limits.processes } : {}),
          captureBytes: 32 * 1024,
          // Without a device (a CPU target) a dev run is a lane command run in the judge's turn.
          ...(this.gpu
            ? { gpu: true, ...(card ? { devCard: card } : {}) }
            : { keepBackground: true }),
        });
        // What ran and its peak memory, so a killed dev run can be understood afterwards.
        this.ledger.appendEvent("devrun", "dev_run", req.lane, {
          wall_ms: Math.round(r.wallMs),
          exit: r.exitCode,
          killed: r.killedFor,
          peak_rss_mib: Math.round(r.peakRssBytes / 2 ** 20),
          command: req.command.slice(0, 300),
        });
        return {
          ran: true,
          exit: r.exitCode ?? r.signal,
          killed: r.killedFor,
          wall_ms: Math.round(r.wallMs),
          stdout: r.stdout.slice(-6_000),
          stderr: r.stderr.slice(-3_000),
          note: "diagnostic only: this number never counts",
          ...(this.busy.length > 1 ? { card: card + 1 } : {}),
        };
      } finally {
        // Only the dev run's processes: the lane's own background work runs on.
        if (this.gpu) await this.runner.killRole(req.lane as Role, { gpu: true }).catch(() => 0);
        this.active = false;
      }
    } finally {
      this.give(card);
    }
  }
}
