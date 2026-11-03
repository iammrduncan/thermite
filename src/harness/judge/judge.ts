import { errorText } from "../../common/errors.ts";
import { log, logError, logWarn } from "../../common/log.ts";
import { Audits } from "../audits.ts";
import { Conclusions } from "../conclusions.ts";
import type { JobRow, RunJob } from "../ledger/index.ts";
import { BASELINE_PRIORITY, baselineDue, baselineState } from "./baseline.ts";
import { type Finish, JudgeContext, type JudgeOptions } from "./context.ts";
import { leaseLost } from "./failure.ts";
import { baseline, calibrate, confirm, evaluate, validate } from "./jobs/index.ts";
import { queuePort } from "./ports.ts";
import { clipReason } from "./reasons.ts";

export type { JudgeOptions, PromotionPolicy } from "./context.ts";

/**
 * The judge: the only code that measures, decides verdicts and moves champions. It leases
 * jobs from the ledger with fences, so a judge that lost its lease can no longer write.
 *
 * evaluate:  build both arms, gate the candidate (correctness and dispatch on every cell),
 *            then screen in interleaved blocks with randomized arm order, deciding at the
 *            contract's looks.
 * confirm:   fresh blocks decided on their own data, plus held-out cells (pass or fail only,
 *            seen by promotion alone), then promotion by compare-and-swap if policy allows.
 * baseline:  a hill climb's first job (goal 115): the starting point alone, in blocks on every
 *            measured cell, its values recorded as the run's baseline. No other job of the run
 *            is leased until it exists. When the starting point can't be measured the run is in
 *            setup, and each setup change submitted is judged by a baseline job too: the first
 *            that measures becomes the starting point.
 * calibrate: A/A blocks (champion against itself) to measure the rig's noise.
 * validate:  a goal campaign's champion on every goal; when every required goal is met, a second
 *            validation, which also runs the held-out cells of the goals met, before the run
 *            closes (goal 086).
 *
 * The Judge leases a job, runs it and records its outcome (finish), and queues the jobs that fall
 * due. Each kind of job is a module in jobs/ (evaluate, confirm, baseline, calibrate, validate);
 * what they share is in context.ts, how they measure in blocks.ts, and a goal campaign's checks of
 * its goals in goals.ts.
 */

export class Judge {
  /** The judge's options, ledger, build store and held job, and the steps every job takes. */
  private readonly judge: JudgeContext;

  constructor(opts: JudgeOptions) {
    this.judge = new JudgeContext(opts);
  }

  /**
   * Takes back the jobs whose lease ran out: queued again, or blocked after their third lost lease.
   * It starts no work, so the harness does it while draining too (goal 079).
   */
  expireLeases(): number[] {
    return this.judge.ledger.jobs.expireLeases(this.judge.o.owner);
  }

  /** The job this judge works on now, for the health route (goal 173); undefined between jobs. */
  get job(): number | undefined {
    return this.judge.holding?.id;
  }

  /** One scheduling step. Returns true when a job was processed. */
  async tick(): Promise<boolean> {
    try {
      return await this.step();
    } finally {
      this.judge.holding = undefined;
    }
  }

  private async step(): Promise<boolean> {
    if (this.judge.o.deviceGate?.active) return false;
    this.expireLeases();
    const waiting = this.maybeScheduleBaseline();
    this.maybeScheduleCalibration(waiting);
    this.maybeScheduleValidation();
    const job = this.judge.ledger.jobs.lease(
      this.judge.o.owner,
      this.judge.o.leaseMs,
      ["baseline", "evaluate", "parent_screen", "confirm", "calibrate", "validate"],
      this.judge.cards > 1 ? this.judge.o.card?.uuid : undefined,
      waiting,
    );
    if (!job) return false;
    this.judge.holding = job;
    const subject = job.attempt ?? this.judge.jobRun(job) ?? "";
    this.judge.note(`${job.kind} ${subject}: started`, this.judge.jobRun(job));
    let fin: Finish;
    try {
      fin =
        job.kind === "baseline"
          ? await baseline(this.judge, job)
          : job.kind === "evaluate" || job.kind === "parent_screen"
            ? await evaluate(this.judge, job)
            : job.kind === "confirm"
              ? await confirm(this.judge, job)
              : job.kind === "validate"
                ? await validate(this.judge, job)
                : await calibrate(this.judge, job);
    } catch (err) {
      const reason = errorText(err);
      logError("judge", "job failed", { job: job.id, kind: job.kind, error: reason });
      this.judge.note(
        `${job.kind} ${subject}: failed (${clipReason(reason)})`,
        this.judge.jobRun(job),
      );
      this.judge.infraFailure(job, reason);
      return true;
    }
    this.judge.note(
      `${job.kind} ${subject}: ${fin.verdict ? `${fin.verdict.verdict}${typeof fin.verdict.delta === "number" ? ` ${(fin.verdict.delta * 100).toFixed(2)}%` : ""}` : (fin.lifecycle ?? "done")}`,
      this.judge.jobRun(job),
    );
    let promoted: string | undefined;
    try {
      promoted = this.finish(job, fin);
    } catch (err) {
      // Lost the lease (another holder owns the outcome now) or the ledger refused the write.
      const why = leaseLost(err) ? "its lease was lost: its new holder records it" : String(err);
      logWarn("judge", "could not record the outcome", { job: job.id, error: why });
      return true;
    }
    // The outcome is recorded: what follows from it is logged as its own step (goal 163).
    if (promoted)
      await this.judge.o.service.syncChampionRef(promoted).catch((err: unknown) => {
        log("judge", "the champion's ref was not synced", { run: promoted, error: String(err) });
      });
    if (fin.port)
      await queuePort(this.judge.o.service, fin.port).catch((err: unknown) => {
        log("judge", "the port was not queued", { job: job.id, error: String(err) });
      });
    return true;
  }

  /**
   * Writes a job's outcome in one transaction under its lease: the verdict, a promotion, events,
   * the follow-up job, the attempt's lifecycle and the job's completion. Either all of it is
   * recorded or none, so a crash cannot leave a verdict without its follow-up (or twice).
   * Returns the run whose champion moved, if one did.
   */
  private finish(job: JobRow, fin: Finish): string | undefined {
    let movedRun: string | undefined;
    this.judge.ledger.tx(() => {
      this.judge.ledger.jobs.assertLease(job.id, job.fence);
      const result = { ...(fin.result as object) } as Record<string, unknown>;
      let lifecycle = fin.lifecycle;
      let enqueue = fin.enqueue;
      if (fin.verdict) this.judge.ledger.verdicts.record(fin.verdict);
      for (const e of fin.events ?? [])
        this.judge.ledger.appendEvent(this.judge.o.owner, e.kind, e.subject, e.body);
      if (fin.promote) {
        const { clearFlaws, ...promote } = fin.promote;
        // Declared flaws nothing asks the owner about are accepted by this promotion (goal 079),
        // and only if it happens: in its own transaction.
        const r = this.judge.ledger.champions.promote({
          ...promote,
          by: this.judge.o.owner,
          acceptFlaws: clearFlaws,
        });
        if (r.ok) {
          lifecycle = "promoted";
          movedRun = fin.promote.run;
          result.promoted = { seq: r.seq };
        } else {
          // Lost the compare-and-swap: screen again against the new champion.
          lifecycle = "queued";
          enqueue = { attempt: fin.promote.attempt, kind: "evaluate", actor: this.judge.o.owner };
          result.lost_race_to_seq = r.currentSeq;
        }
      }
      if (fin.start) {
        const { baseline, ...start } = fin.start;
        const r = this.judge.ledger.champions.setStartingPoint({
          ...start,
          by: this.judge.o.owner,
        });
        if (r.ok) {
          this.judge.ledger.verdicts.record({
            attempt: start.attempt,
            verdict: "starting_point",
            dependsOnJobs: [job.id],
            reasons: `the judge measured this setup change on every cell: it is the run's starting point, champion #${r.seq}, and its values are the run's baseline; ${baseline.summary}`,
            judgedBy: this.judge.o.owner,
          });
          this.judge.ledger.appendEvent(this.judge.o.owner, "baseline", start.run, {
            ...baseline,
            champion_seq: r.seq,
          });
          lifecycle = "promoted";
          movedRun = start.run;
          result.start = { seq: r.seq };
        } else {
          // The champion moved while it was measured: judged as a change against it instead.
          lifecycle = "queued";
          enqueue = { attempt: start.attempt, kind: "evaluate", actor: this.judge.o.owner };
          result.lost_race_to_seq = r.currentSeq;
        }
      }
      if (enqueue) this.judge.ledger.jobs.enqueue(enqueue);
      if (fin.audit && job.attempt) {
        new Audits(this.judge.ledger).request({
          ...fin.audit,
          attempt: job.attempt,
          job: job.id,
          by: this.judge.o.owner,
        });
      }
      // A run the owner closed while this job ran keeps the owner's reason (goal 087).
      if (fin.close && this.judge.ledger.runs.get(fin.close.run)?.status !== "closed")
        this.judge.ledger.runs.setStatus(
          fin.close.run,
          "closed",
          fin.close.reason,
          this.judge.o.owner,
        );
      if (lifecycle && job.attempt)
        this.judge.ledger.attempts.setLifecycle(job.attempt, lifecycle, this.judge.o.owner);
      this.judge.ledger.jobs.complete(job.id, job.fence, "done", result);
    });
    return movedRun;
  }

  /**
   * Each running goal campaign's champion is validated: once per champion, again after a failure
   * (up to three times, ten minutes apart), and never while a validation is queued or running.
   */
  private maybeScheduleValidation(): void {
    for (const inst of this.judge.ledger.runs.list()) {
      if (inst.status !== "running" || inst.mode !== "goal") continue;
      const proposal = new Conclusions(this.judge.ledger).maybePropose(
        inst.id,
        this.judge.goalContract(inst.id),
        this.judge.o.owner,
      );
      // Hands-off by default (goal 079): the evidence ends the campaign unless the run asks.
      if (proposal !== undefined && this.judge.o.service.takeConclusion(inst.id, proposal))
        continue;
      const seq = this.judge.ledger.champions.current(inst.id).seq;
      const jobs = this.judge.ledger.jobs.ofRun(inst.id, "validate");
      if (jobs.some((j) => j.state === "queued" || j.state === "leased")) continue;
      // Settled: a validation of this champion that did not leave a completion to confirm.
      const settles = (j: RunJob) =>
        j.state === "done" && Number(j.result?.champion_seq) === seq && !j.result?.confirming;
      if (jobs.some(settles)) continue;
      const failed = jobs.filter(
        (j) =>
          j.state === "failed" &&
          (j.spec.champion_seq == null || Number(j.spec.champion_seq) === seq),
      );
      if (failed.length >= 3) continue;
      const lastFail = failed.at(-1);
      if (lastFail && Date.now() - Date.parse(lastFail.updated_at) < 10 * 60_000) continue;
      this.judge.ledger.jobs.enqueue({
        kind: "validate",
        priority: 40,
        spec: { run: inst.id, champion_seq: seq },
        actor: this.judge.o.owner,
      });
    }
  }

  /**
   * Queues the baseline of each running hill climb's starting point when it is due (baselineDue),
   * and returns the runs that have no baseline yet, waiting or in setup: the judge leases none
   * of their jobs but a baseline job until they have one.
   */
  private maybeScheduleBaseline(): string[] {
    const waiting: string[] = [];
    for (const inst of this.judge.ledger.runs.list()) {
      if (inst.status !== "running" || inst.mode !== "hill_climb") continue;
      const s = baselineState(this.judge.ledger, inst.id);
      if (!s || s.state === "measured") continue;
      waiting.push(inst.id);
      const due = baselineDue(this.judge.ledger, inst.id);
      if (!due) continue;
      this.judge.ledger.jobs.enqueue({
        kind: "baseline",
        priority: BASELINE_PRIORITY,
        spec: { run: inst.id, champion_seq: due.seq, commit: due.commit },
        actor: this.judge.o.owner,
      });
    }
    return waiting;
  }

  /**
   * A hill climb's calibration (the A/A) comes after its baseline (goal 115): a run that waits
   * for its baseline gets none queued yet.
   */
  private maybeScheduleCalibration(waiting: readonly string[] = []): void {
    if (this.judge.o.calibrationBlocks < 2) return;
    // Each judge card calibrates for itself; its executor schedules the job pinned to it.
    const mine = this.judge.cards > 1 ? this.judge.o.card?.uuid : undefined;
    for (const inst of this.judge.ledger.runs.list()) {
      if (inst.status !== "running" || inst.mode !== "hill_climb") continue;
      if (waiting.includes(inst.id)) continue;
      const last = this.judge.ledger.jobs
        .ofRun(inst.id, "calibrate")
        .filter((j) => !mine || j.spec.card === mine)
        .at(-1);
      if (last && Date.now() - Date.parse(last.created_at) < this.judge.o.calibrationEveryMs)
        continue;
      this.judge.ledger.jobs.enqueue({
        kind: "calibrate",
        priority: 200,
        spec: { run: inst.id, ...(mine ? { card: mine } : {}) },
        actor: this.judge.o.owner,
      });
    }
  }
}
