import type { Kit } from "../../core/kit.ts";
import type { TargetDriver, ThrottleSample } from "../targets/index.ts";
import type { BaselineFile } from "./baseline.ts";
import type { BuildInput, BuildResult } from "./builds.ts";
import type { Arm, ArmRun, MeasureContext } from "./measure.ts";

/**
 * The judge's runner (goal 206): one target resource of the rig and what the judge does on it.
 * The judge decides and records on the core; a runner builds a commit with its kit, runs an arm on
 * a cell with its check, keeps a baseline's folder, and answers for its device's readiness, state
 * and throttling. The core's own runner does these on the core's machine, as the judge always has
 * (core-runner.ts).
 */

/**
 * What a job's runs need, wherever they run: a runner makes its own folders, store and users from
 * it. The kit is named by its repository and commit too, so a runner elsewhere can export its own.
 */
export interface MeasureSpec {
  /** The job the runs are for: its runs' folder is named from it. */
  job: number;
  /** Its run: a runner of another machine fetches the run's model files once. */
  run?: string | undefined;
  kit: Kit;
  kitDir: string;
  kitRepo: string;
  kitCommit: string;
  /**
   * The baseline folder the kit's check gets (goal 115): the one a baseline job's checks write
   * (`written`, the runner's own), or the run's kept one (`kept`, in the core's state, with the
   * run and job it is named by).
   */
  baseline?: { written: string } | { kept: string; run: string; job: number } | undefined;
  uses?: ReadonlySet<string> | undefined;
  /** Which block of which job a run is for (goal 233): its run is told, and a once metric's need. */
  at?: RunAt | undefined;
  note?: MeasureContext["note"];
}

/** A run's place: the block of the job, from 1, and the job's kind (goal 233). */
interface RunAt {
  block: number;
  job: string;
}

/** What a build is made from, with the kit's repository, which names it anywhere. */
export type RunBuild = Omit<BuildInput, "role"> & {
  kitRepo: string;
  /** The run the build is for: a runner of another machine fetches its model files first. */
  run?: string | undefined;
};

/** One run of an arm on a cell, and how much of it the runner's CPUs were throttled. */
export interface Measured {
  run: ArmRun;
  throttled: number | undefined;
}

/** Where a run's baseline is kept on the core: its folder, by run and job. */
export interface KeptBaseline {
  dir: string;
  run: string;
  job: number;
}

/** A baseline job's sealed folder, or why it was refused. */
export type Sealed =
  | { ok: true; files: BaselineFile[]; bytes: number }
  | { ok: false; reason: string };

export interface RigRunner {
  /** Its name in the rig: `core` for the core's own. */
  readonly name: string;
  /** Its device: its kind, identity, readiness, state after a block and plausible values. */
  readonly driver: TargetDriver;
  /** Whether the judge's runs are separated from the agents' (each role its own user). */
  readonly separated: boolean;
  /** Builds a commit with the kit as the runner's builder, or finds it built. */
  build(input: RunBuild): Promise<BuildResult>;
  /** One run of an arm on a cell. */
  measure(spec: MeasureSpec, arm: Arm, cell: string): Promise<Measured>;
  /** The runner's CPU throttling so far, read before and after a block. */
  throttle(): Promise<ThrottleSample | undefined>;
  /**
   * A baseline job's folder for the kit's check to write: `<scratch>/runs/job-<id>/baseline`, made
   * empty and handed to the runner's checker.
   */
  baselineWork(job: number): Promise<string>;
  /**
   * Takes back the folder a baseline job's checks wrote, seals it and keeps it in `to.dir`, the
   * core's folder for the run's job. Returns its files, or why it was refused.
   */
  keepBaseline(written: string, to: KeptBaseline): Promise<Sealed>;
  /** Removes a folder of the runner's, whoever owns its files. */
  remove(dir: string): Promise<void>;
}
