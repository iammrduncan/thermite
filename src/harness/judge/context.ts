import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../../common/errors.ts";
import { logError } from "../../common/log.ts";
import type { Contract, GoalContract, HillClimbContract } from "../../core/contract.ts";
import type { EventToRecord } from "../../core/events/bodies.ts";
import type { Kit } from "../../core/kit.ts";
import { toFraction } from "../../core/stats.ts";
import { builderRole, checkerRole, driverRole, type Runner, runRole } from "../broker/index.ts";
import type { JobRow, Ledger } from "../ledger/index.ts";
import type { HarnessService } from "../service/index.ts";
import type { TargetDriver } from "../targets/index.ts";
import { BASELINE_BLOCKS, type Baseline, baselineDir, baselineOf } from "./baseline.ts";
import { BuildStore } from "./builds.ts";
import type { Decision } from "./decide.ts";
import { recordInfraFailure } from "./failure.ts";
import { HELD_OUT_INFRA } from "./held-out.ts";
import { exportKit, loadKit } from "./kits.ts";
import { whileLeased } from "./lease.ts";
import type { Arm, ArmRun, MeasureContext } from "./measure.ts";
import type { PortFound } from "./ports.ts";
import { clipReason, REASONS_CHARS } from "./reasons.ts";

/**
 * What the judge's jobs share: the judge's options, its errors, a job's outcome (Finish) and
 * JudgeContext. judge.ts builds the context once; each job in jobs/ takes it. It holds the judge's
 * state (its options, its ledger, its build store and the job it holds) and the steps every job
 * takes: a line for Live, the job's run and spec, the kit, the builds and their arms, the
 * measuring context, a run's verdict, the contract of each mode, and the A/A noise floor.
 */

export type PromotionPolicy = "auto" | "owner_approval";

export interface JudgeOptions {
  service: HarnessService;
  runner: Runner;
  driver: TargetDriver;
  owner: string;
  /** The rig's promotion policy: confirmed wins promote on their own, or wait for the owner. */
  promotion: PromotionPolicy;
  leaseMs?: number | undefined;
  /** Readiness retries before a block is abandoned as an infrastructure failure. */
  readyRetries?: number | undefined;
  readyDelayMs?: number | undefined;
  calibrationBlocks?: number | undefined;
  calibrationEveryMs?: number | undefined;
  /** A hill climb's baseline: its blocks (BASELINE_BLOCKS), at least two. */
  baselineBlocks?: number | undefined;
  /** An agent's development run holds the device: the judge waits for it to end. */
  deviceGate?: { active: boolean } | undefined;
  /**
   * This executor's judge card on a rig with several: its place among the judge cards, its id,
   * and how many there are. Each card is calibrated on its own, a confirmation goes to another
   * card than its screen's, and runs are timed by the card's own user.
   */
  card?: { index: number; uuid: string; count: number } | undefined;
}

export class InfraError extends Error {}
/** An infrastructure failure in the judge's own fixed words, safe for the agents to read. */
export class FixedInfraError extends InfraError {}

/** A job's outcome, written by finish() in one fenced transaction. */
export interface Finish {
  result: unknown;
  verdict?: Parameters<Ledger["verdicts"]["record"]>[0] | undefined;
  promote?:
    | {
        run: string;
        expectedSeq: number;
        attempt: string;
        commitSha: string;
        /**
         * Declared flaws accepted by this step (goal 079: hands-off by default): who accepts
         * them, as the record says. Set only when nothing asks the owner.
         */
        clearFlaws?: string | undefined;
      }
    | undefined;
  events?: EventToRecord[] | undefined;
  /** A port to queue once the job is recorded (goal 135). */
  port?: PortFound | undefined;
  enqueue?: Parameters<Ledger["jobs"]["enqueue"]>[0] | undefined;
  lifecycle?: string | undefined;
  /** Close a run (a goal campaign whose success rule holds). */
  close?: { run: string; reason: string } | undefined;
  /**
   * A setup change the baseline job measured (goal 115): it becomes the run's starting point by
   * compare-and-swap on the champion the job read, and then, in the same transaction, its
   * verdict and its `baseline` event (with the new champion's number) are recorded.
   */
  start?:
    | {
        run: string;
        expectedSeq: number;
        attempt: string;
        commitSha: string;
        baseline: Omit<Baseline, "champion_seq">;
      }
    | undefined;
  /** Hold the attempt for an audit (written in the same transaction). */
  audit?:
    | {
        run: string;
        trigger: "absolute" | "ratio" | "known_flaws" | "adversarial_checklist";
        reason: string;
        expectedSeq: number;
      }
    | undefined;
}

/** A verdict reached before the screen finished (a crash, an invalid output, a bad build). */
export class Stop extends Error {
  readonly verdict: "invalid" | "crash_candidate";
  readonly reason: string;

  constructor(verdict: "invalid" | "crash_candidate", reason: string) {
    super(reason);
    this.verdict = verdict;
    this.reason = reason;
  }
}

/** The judge's state and the steps every job takes. */
export class JudgeContext {
  readonly o: Required<JudgeOptions>;
  readonly ledger: Ledger;
  readonly store: BuildStore;
  /** The job this judge holds: its lease is renewed while a build runs (lease.ts). */
  holding: JobRow | undefined;

  constructor(opts: JudgeOptions) {
    this.o = {
      leaseMs: 15 * 60_000,
      readyRetries: 15,
      readyDelayMs: 2000,
      calibrationBlocks: 6,
      calibrationEveryMs: 24 * 3_600_000,
      deviceGate: undefined,
      baselineBlocks: BASELINE_BLOCKS,
      card: undefined,
      ...opts,
    } as Required<JudgeOptions>;
    this.ledger = opts.service.ledger;
    const { stateDir, scratchDir } = opts.service.paths;
    this.store = new BuildStore(stateDir, scratchDir, opts.runner, this.ledger);
  }

  /** A line for control's live view of the judge. */
  note(text: string, run?: string | undefined): void {
    this.o.service.live.append({ source: "judge", kind: "log", text, run });
  }

  /** The run a job works for. */
  jobRun(job: JobRow): string | undefined {
    if (job.attempt) {
      const i = this.ledger.attempts.get(job.attempt)?.run;
      return i === undefined || i === null ? undefined : String(i);
    }
    const i = (JSON.parse(job.spec) as { run?: unknown }).run;
    return typeof i === "string" ? i : undefined;
  }

  spec(job: JobRow): Record<string, unknown> {
    return JSON.parse(job.spec) as Record<string, unknown>;
  }

  /** Infrastructure failures never count against the research: crash_infra, then one retry. */
  infraFailure(job: JobRow, reason: string): void {
    recordInfraFailure(this.ledger, job, reason, { owner: this.o.owner, spec: this.spec(job) });
  }

  async kitFor(contract: Contract): Promise<{ kit: Kit; dir: string; commit: string }> {
    const ref = contract.project.kit;
    if (!ref) throw new InfraError(`contract ${contract.campaign} names no kit`);
    const mirror = this.o.service.mirrorFor(`kit-${ref.repo}`);
    const dir = await exportKit(this.o.service.paths.stateDir, mirror, ref.commit);
    const kit = loadKit(dir);
    if (kit.target !== this.o.driver.type) {
      throw new InfraError(
        `kit ${kit.name} measures ${kit.target}, this rig has ${this.o.driver.type}`,
      );
    }
    return { kit, dir, commit: ref.commit };
  }

  private async build(run: string, commit: string, k: { kit: Kit; dir: string; commit: string }) {
    const inst = this.ledger.runs.get(run);
    if (!inst) throw new InfraError(`no run ${run}`);
    const started = Date.now();
    this.note(`build ${commit.slice(0, 12)}: started`, run);
    const ensure = () =>
      this.store.ensure({
        repo: inst.seed_repo,
        mirror: this.o.service.mirrorFor(inst.seed_repo),
        commit,
        kit: k.kit,
        kitDir: k.dir,
        kitCommit: k.commit,
        actor: this.o.owner,
        role: builderRole(this.o.card?.index ?? 0),
      });
    const h = this.holding;
    const renew = () => h && this.ledger.jobs.heartbeat(h.id, h.fence, this.o.leaseMs);
    const b = await whileLeased(renew, this.o.leaseMs / 3, ensure, { job: h?.id, commit });
    this.note(
      `build ${commit.slice(0, 12)}: ${b.ok ? "ok" : `failed (${clipReason(b.reason)})`} in ${Math.round((Date.now() - started) / 1000)} s`,
      run,
    );
    return b;
  }

  async armFor(
    name: Arm["name"],
    run: string,
    commit: string,
    k: { kit: Kit; dir: string; commit: string },
  ): Promise<Arm> {
    const b = await this.build(run, commit, k);
    if (!b.ok) {
      // The starting point's baseline (goal 115) is judged as a candidate is: a build that fails
      // means it can't be measured yet.
      if (name !== "candidate" && name !== "baseline")
        throw new InfraError(`${name} build failed: ${b.reason}`);
      // A build killed for time or memory may be the host's load (never cached): its first kill is
      // no verdict and the job is tried once more; a second is the candidate's crash (the owner,
      // 2026-10-27, goal 163). A build that fails or produces refused outputs is invalid.
      const again = this.holding !== undefined && Number(this.spec(this.holding).retries ?? 0) >= 1;
      if (b.transient && !again) throw new InfraError(`build: ${b.reason}; tried once more`);
      throw new Stop(
        b.transient ? "crash_candidate" : "invalid",
        `build: ${b.reason}\n${b.log.slice(-1500)}`,
      );
    }
    return { name, dir: b.dir, manifest: b.manifest };
  }

  /**
   * The folder a baseline job's checks write the baseline's files to: `<scratch>/runs/job-<id>/
   * baseline`, made empty and handed to the job's card's checker. The job keeps what it holds
   * (keepBaselineDir), then removes it.
   */
  async baselineWork(job: JobRow): Promise<string> {
    const runs = join(this.o.service.paths.scratchDir, "runs");
    const dir = join(runs, `job-${job.id}`, "baseline");
    // An earlier try of the same job left its folder: it starts empty again.
    if (existsSync(dir)) await this.o.runner.remove(dir);
    mkdirSync(dir, { recursive: true });
    for (const d of [runs, join(runs, `job-${job.id}`)]) chmodSync(d, 0o711);
    await this.o.runner.handOver(dir, checkerRole(this.o.card?.index ?? 0));
    return dir;
  }

  /**
   * A job's measuring context. A hill climb's check gets the run's baseline folder (goal 115):
   * `baselineDir`, the folder a baseline job writes, or else the sealed folder of the run's
   * baseline, read-only. The job's card gives the users its runs, drivers and checks run as.
   */
  context(
    k: { kit: Kit; dir: string },
    job: JobRow,
    baselineDirNow?: string | undefined,
  ): MeasureContext {
    const runsDir = join(this.o.service.paths.scratchDir, "runs", `job-${job.id}`);
    mkdirSync(runsDir, { recursive: true });
    // Reachable by exact (unguessable) path only: no role may list in-flight runs.
    chmodSync(join(this.o.service.paths.scratchDir, "runs"), 0o711);
    chmodSync(runsDir, 0o711);
    const run = this.jobRun(job);
    // No contract, no held-out mask: the job stops as an infrastructure failure, never measuring
    // on cells it would have hidden (goal 163).
    const contract: Contract | undefined = run ? this.o.service.contractFor(run) : undefined;
    const held = new Set(contract && "held_out_cells" in contract ? contract.held_out_cells : []);
    let heldRuns = 0;
    const sealed = (() => {
      if (baselineDirNow || !run || contract?.mode !== "hill_climb") return undefined;
      const b = baselineOf(this.ledger, run);
      const dir = b ? baselineDir(this.o.service.paths.stateDir, run, b.job) : undefined;
      return dir && existsSync(dir) ? dir : undefined;
    })();
    const folder = baselineDirNow ?? sealed;
    return {
      runner: this.o.runner,
      store: this.store,
      kit: k.kit,
      kitDir: k.dir,
      runsDir,
      modelsDir: join(this.o.service.paths.stateDir, "models"),
      ...(folder ? { baselineDir: folder } : {}),
      runRole: runRole(this.o.card?.index ?? 0),
      checkerRole: checkerRole(this.o.card?.index ?? 0),
      driverRole: driverRole(this.o.card?.index ?? 0),
      note: (arm, cell, outcome) =>
        held.has(cell)
          ? this.note(`held-out run ${++heldRuns} done`, run)
          : this.note(`${arm} · ${cell}: ${outcome}`, run),
    };
  }

  /**
   * A candidate's failed run stops the job with its verdict; any other arm's is infra. The
   * baseline's (goal 115) stops it as a candidate's does: the starting point can't be measured.
   */
  judgeRun(arm: Arm, r: ArmRun, cell?: string): void {
    const judged = arm.name === "candidate" || arm.name === "baseline";
    // The baseline's reasons name the cell: they tell the workers in setup what to fix.
    const on = arm.name === "baseline" && cell ? `cell ${cell}: ` : "";
    if (r.kind === "ok") {
      const implausible = this.o.driver.plausibility(r.metrics);
      if (implausible.length === 0) return;
      if (judged) throw new Stop("invalid", `${on}implausible: ${implausible.join("; ")}`);
      throw new InfraError(`${arm.name} implausible: ${implausible.join("; ")}`);
    }
    if (!judged) throw new InfraError(`${arm.name} run failed: ${r.reason}`);
    throw new Stop(r.kind === "crash" ? "crash_candidate" : "invalid", `${on}${r.reason}`);
  }

  verdictFields(d: Decision<string>) {
    return {
      delta: toFraction(d.primary.estimate),
      ciLow: toFraction(d.primary.low),
      ciHigh: toFraction(d.primary.high),
      values: d.values,
      guards: d.guards.map((g) => {
        // At confirmation, the guard against the run's baseline too (goal 115): a log ratio.
        const s = d.vsStart?.find((x) => x.metric === g.metric);
        return {
          metric: g.metric,
          status: g.status,
          estimate: g.interval.estimate,
          low: g.interval.low,
          high: g.interval.high,
          ...(s ? { vs_start: { estimate: s.estimate, noise: s.noise, spent: s.spent } } : {}),
        };
      }),
    };
  }

  hillClimb(run: string): HillClimbContract {
    const c = this.o.service.contractFor(run);
    if (c.mode !== "hill_climb") {
      throw new InfraError(`the judge handles hill_climb attempts; ${run} is ${c.mode}`);
    }
    return c;
  }

  stopped(job: JobRow, err: Stop): Finish {
    return {
      result: { verdict: err.verdict },
      verdict: {
        attempt: job.attempt as string,
        verdict: err.verdict,
        dependsOnJobs: [job.id],
        reasons: clipReason(err.reason, REASONS_CHARS),
        judgedBy: this.o.owner,
      },
      lifecycle: "judged",
    };
  }

  /**
   * Runs a held-out pass. Whatever goes wrong in it reaches the verdict's reasons, Live and so the
   * agents in fixed words only (goal 082): an error's text can name a held-out cell or carry its
   * parameters or time. The error itself goes to the rig's log, for the owner.
   */
  async heldOutPass<T>(job: JobRow, pass: () => Promise<T>): Promise<T> {
    try {
      return await pass();
    } catch (err) {
      if (err instanceof FixedInfraError) throw err;
      logError("judge", "held-out pass failed", {
        job: job.id,
        attempt: job.attempt,
        error: errorText(err),
      });
      throw new InfraError(HELD_OUT_INFRA);
    }
  }

  goalContract(run: string): GoalContract {
    const c = this.o.service.contractFor(run);
    if (c.mode !== "goal") throw new InfraError(`${run} is not a goal campaign`);
    return c;
  }

  /**
   * The run's latest calibrated A/A block spread (log ratio): the least spread a verdict's
   * interval assumes, so a few blocks that happen to agree on a noisy rig do not decide.
   */
  noiseFloor(run: string): number {
    // With several judge cards, each card's own noise: a verdict uses the floor of the card it
    // was measured on.
    const mine = this.cards > 1 ? this.o.card?.uuid : undefined;
    const e = this.ledger.events.newest("calibration", {
      subject: run,
      body: mine ? { card: mine } : undefined,
    });
    const sigma = e ? Number(e.body.sigma) : 0;
    return Number.isFinite(sigma) && sigma > 0 ? sigma : 0;
  }

  /** How many judge cards the rig has. */
  get cards(): number {
    return this.o.card?.count ?? 1;
  }

  /** A confirmation's spec: on a rig with several judge cards, not on this (the screen's) card. */
  avoidMe(): { avoid_card?: string } {
    return this.cards > 1 && this.o.card ? { avoid_card: this.o.card.uuid } : {};
  }
}
