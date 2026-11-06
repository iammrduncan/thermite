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
import { keepBaselineDir, sealBaselineDir } from "./baseline.ts";
import { type BuildResult, BuildStore } from "./builds.ts";
import { type Arm, type MeasureContext, runArm } from "./measure.ts";
import type { KeptBaseline, Measured, MeasureSpec, RigRunner, RunBuild, Sealed } from "./runner.ts";

interface CoreRunnerOptions {
  runner: Runner;
  driver: TargetDriver;
  paths: { stateDir: string; scratchDir: string };
  ledger: Ledger;
  /** The card's place among the judge's cards: its users are run-i, builder-i and so on. */
  index: number;
}

/**
 * The core's own runner (goal 206): a GPU, or the CPU, of the machine the core runs on, with the
 * broker's roles of its card. It is how the judge has always built and measured.
 */
export class CoreRunner implements RigRunner {
  readonly name = "core";
  private readonly store: BuildStore;
  private readonly o: CoreRunnerOptions;

  constructor(o: CoreRunnerOptions) {
    this.o = o;
    this.store = new BuildStore(o.paths.stateDir, o.paths.scratchDir, o.runner, o.ledger);
  }

  get driver(): TargetDriver {
    return this.o.driver;
  }

  get separated(): boolean {
    return this.o.runner.separated;
  }

  build({ kitRepo: _, run: _run, ...input }: RunBuild): Promise<BuildResult> {
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

  async keepBaseline(written: string, to: KeptBaseline): Promise<Sealed> {
    await this.o.runner.reclaim(written);
    const sealed = sealBaselineDir(written);
    if (sealed.ok) keepBaselineDir(written, to.dir);
    return sealed;
  }

  remove(dir: string): Promise<void> {
    return this.o.runner.remove(dir);
  }
}
