import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Kit } from "../../core/kit.ts";
import { builderRole, checkerRole, driverRole, type Runner, runRole } from "../broker/index.ts";
import type { Ledger } from "../ledger/index.ts";
import {
  readThrottle,
  type TargetDriver,
  type ThrottleSample,
  throttledFraction,
} from "../targets/index.ts";
import { type BaselineFile, keepBaselineDir, sealBaselineDir } from "./baseline.ts";
import { type BuildInput, type BuildResult, BuildStore } from "./builds.ts";
import { type Arm, type ArmRun, type MeasureContext, runArm } from "./measure.ts";

/**
 * The judge's device (goal 205): what the judge does on the machine of one of its GPUs, apart from
 * the ledger. The judge decides and records on the rig's leader; its builds, its runs of an arm on
 * a case, the device's readiness and state, its throttling and a baseline's folder are the
 * device's. A GPU of the leader's own is a LocalDevice, which is how the judge has always worked;
 * a follower's GPU is reached through the bus behind the same interface.
 */

/**
 * What a job's runs need, wherever they run: the device makes its own folders, store and users
 * from it. The kit's folder is the leader's; a follower makes its own from the kit's repository
 * and commit.
 */
export interface MeasureSpec {
  /** The job the runs are for: its runs' folder is named from it. */
  job: number;
  kit: Kit;
  kitDir: string;
  kitRepo: string;
  kitCommit: string;
  /**
   * The baseline folder the kit's check gets (goal 115): the one a baseline job's checks write
   * (`written`, the device's own), or the run's kept one (`kept`, in the leader's state, with
   * the run and job it is named by).
   */
  baseline?: { written: string } | { kept: string; run: string; job: number } | undefined;
  uses?: ReadonlySet<string> | undefined;
  note?: MeasureContext["note"];
}

/** One run of an arm on a case, and how much of it the device's CPUs were throttled. */
export interface Measured {
  run: ArmRun;
  throttled: number | undefined;
}

/** A baseline job's sealed folder, or why it was refused (sealBaselineDir). */
type Sealed = { ok: true; files: BaselineFile[]; bytes: number } | { ok: false; reason: string };

export interface JudgeDevice {
  /** The device itself: its identity, readiness, state after a block and plausible values. */
  readonly driver: TargetDriver;
  /** Whether the judge's runs are separated from the agents' (each role its own user). */
  readonly separated: boolean;
  /** Builds a commit with the kit as the device's builder, or finds it built. */
  build(input: Omit<BuildInput, "role">): Promise<BuildResult>;
  /** One run of an arm on a case. */
  measure(spec: MeasureSpec, arm: Arm, cell: string): Promise<Measured>;
  /** The device's CPU throttling so far, read before and after a block. */
  throttle(): Promise<ThrottleSample | undefined>;
  /**
   * A baseline job's folder for the kit's check to write: `<scratch>/runs/job-<id>/baseline`, made
   * empty and handed to the device's checker.
   */
  baselineWork(job: number): Promise<string>;
  /**
   * Seals the folder a baseline job's checks wrote (sealBaselineDir) and keeps it in `to`, the
   * leader's folder for it (keepBaselineDir). Returns its files, or why it was refused.
   */
  keepBaseline(written: string, to: string): Promise<Sealed>;
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

  /** A job's measuring context here: its runs' folder, the models, the store and the card's users. */
  private context(spec: MeasureSpec): MeasureContext {
    const runs = join(this.o.paths.scratchDir, "runs");
    const runsDir = join(runs, `job-${spec.job}`);
    mkdirSync(runsDir, { recursive: true });
    // Reachable by exact (unguessable) path only: no role may list in-flight runs.
    chmodSync(runs, 0o711);
    chmodSync(runsDir, 0o711);
    const b = spec.baseline;
    const baselineDir = b && ("written" in b ? b.written : b.kept);
    return {
      runner: this.o.runner,
      store: this.store,
      kit: spec.kit,
      kitDir: spec.kitDir,
      runsDir,
      modelsDir: join(this.o.paths.stateDir, "models"),
      ...(baselineDir ? { baselineDir } : {}),
      ...(spec.uses ? { uses: spec.uses } : {}),
      runRole: runRole(this.o.index),
      checkerRole: checkerRole(this.o.index),
      driverRole: driverRole(this.o.index),
      note: spec.note,
    };
  }

  async measure(spec: MeasureSpec, arm: Arm, cell: string): Promise<Measured> {
    const ctx = this.context(spec);
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

  async keepBaseline(written: string, to: string): Promise<Sealed> {
    const sealed = sealBaselineDir(written);
    if (sealed.ok) keepBaselineDir(written, to);
    return sealed;
  }

  reclaim(dir: string): Promise<void> {
    return this.o.runner.reclaim(dir);
  }

  remove(dir: string): Promise<void> {
    return this.o.runner.remove(dir);
  }
}
