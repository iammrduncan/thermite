import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { builderRole, checkerRole, driverRole, type Runner, runRole } from "../broker/index.ts";
import type { Ledger } from "../ledger/index.ts";
import {
  readThrottle,
  type TargetDriver,
  type ThrottleSample,
  throttledFraction,
} from "../targets/index.ts";
import { type BuildInput, type BuildResult, BuildStore } from "./builds.ts";
import { type Arm, type ArmRun, type MeasureContext, runArm } from "./measure.ts";

/**
 * The judge's device (goal 205): what the judge does on the machine of one of its GPUs, apart from
 * the ledger. The judge decides and records on the rig's leader; its builds, its runs of an arm on
 * a case, the device's readiness and state, its throttling and a baseline's folder are the
 * device's. A GPU of the leader's own is a LocalDevice, which is how the judge has always worked;
 * a follower's GPU is reached through the bus behind the same interface.
 */

/** A run's measuring context without what the device adds: its folders, store, runner and users. */
type MeasureSpec = Omit<
  MeasureContext,
  "runner" | "store" | "runsDir" | "modelsDir" | "runRole" | "checkerRole" | "driverRole"
> & {
  /** The job the runs are for: its runs' folder is named from it. */
  job: number;
};

/** One run of an arm on a case, and how much of it the device's CPUs were throttled. */
export interface Measured {
  run: ArmRun;
  throttled: number | undefined;
}

export interface JudgeDevice {
  /** The device itself: its identity, readiness, state after a block and plausible values. */
  readonly driver: TargetDriver;
  /** Whether the judge's runs are separated from the agents' (each role its own user). */
  readonly separated: boolean;
  /** Builds a commit with the kit as the device's builder, or finds it built. */
  build(input: Omit<BuildInput, "role">): Promise<BuildResult>;
  /** A run's measuring context on this device. */
  context(spec: MeasureSpec): MeasureContext;
  /** One run of an arm on a case. */
  measure(ctx: MeasureContext, arm: Arm, cell: string): Promise<Measured>;
  /** The device's CPU throttling so far, read before and after a block. */
  throttle(): Promise<ThrottleSample | undefined>;
  /**
   * A baseline job's folder for the kit's check to write: `<scratch>/runs/job-<id>/baseline`, made
   * empty and handed to the device's checker.
   */
  baselineWork(job: number): Promise<string>;
  /** Takes a folder back from the user it was handed to. */
  reclaim(dir: string): Promise<void>;
  /** Removes a folder, whoever owns its files. */
  remove(dir: string): Promise<void>;
}

interface LocalDeviceOptions {
  runner: Runner;
  driver: TargetDriver;
  paths: { stateDir: string; scratchDir: string };
  ledger: Ledger;
  /** The card's place among the judge's cards: its users are run-i, builder-i and so on. */
  index: number;
}

/** A GPU (or the CPU) of the machine the judge runs on: the broker's roles of its card. */
export class LocalDevice implements JudgeDevice {
  readonly store: BuildStore;
  private readonly o: LocalDeviceOptions;

  constructor(o: LocalDeviceOptions) {
    this.o = o;
    this.store = new BuildStore(o.paths.stateDir, o.paths.scratchDir, o.runner, o.ledger);
  }

  get driver(): TargetDriver {
    return this.o.driver;
  }

  get separated(): boolean {
    return this.o.runner.separated;
  }

  build(input: Omit<BuildInput, "role">): Promise<BuildResult> {
    return this.store.ensure({ ...input, role: builderRole(this.o.index) });
  }

  context(spec: MeasureSpec): MeasureContext {
    const { job, ...rest } = spec;
    const runs = join(this.o.paths.scratchDir, "runs");
    const runsDir = join(runs, `job-${job}`);
    mkdirSync(runsDir, { recursive: true });
    // Reachable by exact (unguessable) path only: no role may list in-flight runs.
    chmodSync(runs, 0o711);
    chmodSync(runsDir, 0o711);
    return {
      ...rest,
      runner: this.o.runner,
      store: this.store,
      runsDir,
      modelsDir: join(this.o.paths.stateDir, "models"),
      runRole: runRole(this.o.index),
      checkerRole: checkerRole(this.o.index),
      driverRole: driverRole(this.o.index),
    };
  }

  async measure(ctx: MeasureContext, arm: Arm, cell: string): Promise<Measured> {
    const before = readThrottle();
    const run = await runArm(ctx, arm, cell);
    return { run, throttled: throttledFraction(before, readThrottle(), run.outcome.wallMs) };
  }

  async throttle(): Promise<ThrottleSample | undefined> {
    return readThrottle();
  }

  async baselineWork(job: number): Promise<string> {
    const runs = join(this.o.paths.scratchDir, "runs");
    const dir = join(runs, `job-${job}`, "baseline");
    // An earlier try of the same job left its folder: it starts empty again.
    if (existsSync(dir)) await this.o.runner.remove(dir);
    mkdirSync(dir, { recursive: true });
    for (const d of [runs, join(runs, `job-${job}`)]) chmodSync(d, 0o711);
    await this.o.runner.handOver(dir, checkerRole(this.o.index));
    return dir;
  }

  reclaim(dir: string): Promise<void> {
    return this.o.runner.reclaim(dir);
  }

  remove(dir: string): Promise<void> {
    return this.o.runner.remove(dir);
  }
}
