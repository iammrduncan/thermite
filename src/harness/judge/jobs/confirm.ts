import { logWarn } from "../../../common/log.ts";
import type { HillClimbContract } from "../../../core/contract.ts";
import { toLog } from "../../../core/stats.ts";
import { Audits, auditTrigger } from "../../audits.ts";
import type { JobRow } from "../../ledger/index.ts";
import { baselineOf, guardTotals } from "../baseline.ts";
import { runBlocks } from "../blocks.ts";
import { type Finish, FixedInfraError, InfraError, type JudgeContext, Stop } from "../context.ts";
import { decideConfirm, goalDelta, type StartValues } from "../decide.ts";
import { heldOutGoals, recordGoals, verifyGoals } from "../goals.ts";
import {
  type HeldOutCell,
  type HeldOutKind,
  type HeldOutResult,
  heldOutEvent,
  heldOutKindOf,
  heldOutKinds,
  heldOutMeasure,
  heldOutResult,
  heldOutWords,
} from "../held-out.ts";
import { type Arm, type MeasureContext, runArm } from "../measure.ts";

/**
 * The confirm job, and what happens to a win it confirms. A hill climb's screened win is measured
 * again in fresh blocks, decided on their own data, plus its held-out cells; a goal campaign's
 * screened attempt has its goals checked again (confirmGoal). A confirmed win then goes to an
 * audit, the owner or the champion (promotion).
 */

export async function confirm(judge: JudgeContext, job: JobRow): Promise<Finish> {
  const attemptId = job.attempt as string;
  const attempt = judge.ledger.attempts.get(attemptId);
  if (!attempt) throw new InfraError(`no attempt ${attemptId}`);
  const run = String(attempt.run);
  if (judge.o.service.contractFor(run).mode === "goal") return confirmGoal(judge, job);
  const contract = judge.hillClimb(run);
  const baselineSeq = Number(judge.spec(job).baseline_seq);
  const champion = judge.ledger.champions.current(run);
  if (champion.seq !== baselineSeq) {
    // The champion moved since screening: screen again against the new one.
    return {
      result: { rescreen: true, baseline_seq: baselineSeq, champion_seq: champion.seq },
      enqueue: { attempt: attemptId, kind: "evaluate", actor: judge.o.owner },
      lifecycle: "queued",
    };
  }

  try {
    const k = await judge.kitFor(contract);
    judge.ledger.jobs.heartbeat(job.id, job.fence, judge.o.leaseMs);
    const champ = await judge.armFor("champion", run, champion.commit_sha, k);
    const cand = await judge.armFor("candidate", run, String(attempt.commit_sha), k);
    const ctx = judge.context(k, job);
    const blocks = await runBlocks(judge, {
      job,
      ctx,
      arms: [cand, champ],
      cells: contract.cells,
      count: contract.acceptance.confirm_blocks,
      runsPerCell: contract.acceptance.runs_per_cell,
    });
    const ho = await judge.heldOutPass(job, () => heldOut(judge, job, ctx, cand, champ, contract));
    // The guards' total allowance holds against the starting point's values too (goal 115).
    const start: StartValues | undefined = baselineOf(judge.ledger, run)?.cells;
    const d = decideConfirm(
      contract,
      blocks,
      guardTotals(judge.ledger, run),
      judge.noiseFloor(run),
      start,
    );
    let verdict: string = d.verdict ?? "not_confirmed";
    let reasons = d.reasons;
    // A held-out failure is named by its kind alone (goal 082): the reasons say that a held-out
    // check failed and how, never which cell, its values or its texts. The owner's detail is in
    // the held_out record and its event. The figures are the measured cells' only.
    if (ho && !ho.pass) {
      const words = heldOutWords(heldOutKinds(ho.cells));
      reasons =
        verdict === "win_confirmed"
          ? `confirmation failed: ${words}; on the measured cells: ${d.reasons}`
          : `${d.reasons}; ${words}`;
      if (verdict === "win_confirmed") verdict = "not_confirmed";
    }
    const fin: Finish = {
      result: { verdict },
      verdict: {
        attempt: attemptId,
        verdict,
        ...judge.verdictFields(d),
        dependsOnJobs: [job.id, Number(judge.spec(job).screen_job ?? job.id)],
        reasons: `${reasons}; vs champion seq ${champion.seq}`,
        judgedBy: judge.o.owner,
      },
      ...(ho ? { events: [heldOutEvent(job.id, run, attemptId, ho)] } : {}),
      lifecycle: "judged",
    };
    if (verdict !== "win_confirmed") return fin;
    return promotion(judge, fin, attemptId, run, champion.seq, attempt);
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    return judge.stopped(job, err);
  }
}

/**
 * Held-out cells: correctness on every one, and no regression beyond twice the equivalence
 * band on the primary metric, judged on the median of three interleaved runs per arm. Each
 * cell's result is recorded with its kind of failure and, for the regression check, its ratio
 * against its threshold (goal 082): in the held_out table, and in the owner's event. Never a
 * cell's inputs, outputs or texts, and never as measurements.
 */
async function heldOut(
  judge: JudgeContext,
  job: JobRow,
  ctx: MeasureContext,
  cand: Arm,
  champ: Arm,
  contract: HillClimbContract,
): Promise<HeldOutResult | undefined> {
  if (!contract.held_out_cells.length) return undefined;
  const { metric, direction } = contract.objective.primary;
  const cells: HeldOutCell[] = [];
  const median = (xs: number[]) =>
    [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] as number;
  // A ratio to the champion above this passes: no worse than twice the equivalence band.
  const threshold = 1 / (1 + 2 * contract.acceptance.equivalence_band);
  for (const cell of contract.held_out_cells) {
    judge.ledger.jobs.heartbeat(job.id, job.fence, judge.o.leaseMs);
    const cv: number[] = [];
    const rv: number[] = [];
    let failed: HeldOutKind | undefined;
    for (let rep = 0; rep < 3 && !failed; rep++) {
      const c = await runArm(ctx, cand, cell);
      const r = await runArm(ctx, champ, cell);
      if (r.kind !== "ok") {
        // An opaque reason: details of held-out cells never leave promotion code.
        logWarn("judge", "champion failed on a held-out cell", { job: job.id, reason: r.reason });
        throw new FixedInfraError("champion failed on a held-out cell");
      }
      if (c.kind !== "ok") failed = heldOutKindOf(c);
      else {
        cv.push(c.metrics[metric] as number);
        rv.push(r.metrics[metric] as number);
      }
    }
    if (failed) {
      cells.push({ cell, ok: false, kind: failed });
      continue;
    }
    const ratio = direction === "max" ? median(cv) / median(rv) : median(rv) / median(cv);
    const measured = {
      value: ratio,
      threshold,
      op: ">" as const,
      measure: heldOutMeasure(metric, direction),
      unit: "ratio",
    };
    if (Math.log(ratio) > -toLog(2 * contract.acceptance.equivalence_band))
      cells.push({ cell, ok: true, ...measured });
    else cells.push({ cell, ok: false, kind: "threshold_missed", ...measured });
  }
  const result = heldOutResult(cells);
  judge.ledger.heldOut.record(job.id, job.fence, job.attempt as string, result.pass, result);
  return result;
}

/**
 * What happens to a promotable result (goal 079: hands-off by default). An audit first when one
 * is triggered (open known flaws, a gain above the contract's audit trigger, a goal campaign's
 * adversarial checklist) and the rig has an auditor, or may have one (its supervisor has not
 * said yet); without an auditor the audit is skipped, and recorded so. Then the owner only where
 * the run asks (every win, a gain above its line, declared flaws); else the champion.
 */
export function promotion(
  judge: JudgeContext,
  fin: Finish,
  attemptId: string,
  run: string,
  expectedSeq: number,
  attempt: Record<string, unknown>,
): Finish {
  // A run the owner closed while this job ran (goal 087): nothing changes its champion now. The
  // win stays recorded and waits, and no one decides it.
  if (String(judge.ledger.runs.get(run)?.status) === "closed")
    return {
      ...fin,
      result: { ...(fin.result as object), promoted: false, waiting: "run_closed" },
      lifecycle: "awaiting_approval",
    };
  const audits = new Audits(judge.ledger);
  const trigger = auditTrigger({
    contract: judge.o.service.contractFor(run),
    knownFlaws: JSON.parse(String(attempt.known_flaws)) as unknown[],
    delta: fin.verdict?.delta,
    priorDeltas: audits.priorDeltas(run, attemptId),
  });
  if (trigger && judge.o.service.advisors?.auditor !== false) {
    return {
      ...fin,
      result: { ...(fin.result as object), promoted: false, waiting: "audit" },
      events: [
        ...(fin.events ?? []),
        {
          kind: "promotion_blocked",
          subject: attemptId,
          body: { reason: `audit required: ${trigger.reason}` },
        },
      ],
      audit: { run, trigger: trigger.kind, reason: trigger.reason, expectedSeq },
      lifecycle: "awaiting_audit",
    };
  }
  const skipped = trigger
    ? [
        {
          kind: "audit_skipped" as const,
          subject: attemptId,
          body: { run, reason: trigger.reason, why: "this rig has no auditor" },
        },
      ]
    : [];
  const ask = judge.o.service.ownerAsks(run, attempt, fin.verdict?.delta ?? null);
  if (ask) {
    return {
      ...fin,
      result: { ...(fin.result as object), promoted: false, waiting: "owner" },
      events: [
        ...(fin.events ?? []),
        ...skipped,
        {
          kind: "promotion_pending",
          subject: attemptId,
          body: { run, expected_seq: expectedSeq, commit: attempt.commit_sha, reason: ask },
        },
      ],
      lifecycle: "awaiting_approval",
    };
  }
  return {
    ...fin,
    ...(skipped.length ? { events: [...(fin.events ?? []), ...skipped] } : {}),
    promote: {
      run,
      expectedSeq,
      attempt: attemptId,
      commitSha: String(attempt.commit_sha),
      clearFlaws: `${judge.o.owner} (no audit: ${trigger ? "this rig has no auditor" : "none was called for"})`,
    },
  };
}

/**
 * Confirms a screened goal attempt: the goals are checked again in fresh runs (and on the
 * held-out cells, whose result only promotion code sees). It is promoted only if the goals it
 * gained at screening still hold and it loses or blurs none the champion meets.
 */
async function confirmGoal(judge: JudgeContext, job: JobRow): Promise<Finish> {
  const attemptId = job.attempt as string;
  const attempt = judge.ledger.attempts.get(attemptId) as Record<string, unknown>;
  const run = String(attempt.run);
  const contract = judge.goalContract(run);
  const baselineSeq = Number(judge.spec(job).baseline_seq);
  const champion = judge.ledger.champions.current(run);
  if (champion.seq !== baselineSeq) {
    return {
      result: { rescreen: true, baseline_seq: baselineSeq, champion_seq: champion.seq },
      enqueue: { attempt: attemptId, kind: "evaluate", actor: judge.o.owner },
      lifecycle: "queued",
    };
  }
  try {
    const k = await judge.kitFor(contract);
    judge.ledger.attempts.setLifecycle(attemptId, "verifying", judge.o.owner);
    const cand = await judge.armFor("candidate", run, String(attempt.commit_sha), k);
    const ctx = judge.context(k, job);
    const results = await verifyGoals(judge, job, contract, ctx, cand);
    recordGoals(judge, job, run, attemptId, String(attempt.commit_sha), results, false);
    const champ = judge.ledger.goals.statuses(run);
    const reviewed = new Set(
      contract.goals.filter((g) => g.verify.type === "review").map((g) => g.id),
    );
    // Subjective goals are reviewed per champion, so they do not decide a candidate.
    const { gained, lost, unsure } = goalDelta(
      results.filter((r) => !reviewed.has(r.goal)),
      champ,
    );
    const screened = (judge.spec(job).gained as string[] | undefined) ?? [];
    const held = screened.filter((g) => !gained.includes(g));
    let ho: HeldOutResult | undefined;
    if (contract.held_out_cells.length && gained.length) {
      const { pass, cells } = await heldOutGoals(judge, job, contract, ctx, cand, gained);
      ho = { pass, cells };
      judge.ledger.heldOut.record(job.id, job.fence, attemptId, ho.pass, ho);
    }
    const ok =
      gained.length > 0 && !lost.length && !unsure.length && !held.length && ho?.pass !== false;
    const verdict = ok ? "goal_progress" : "not_confirmed";
    // A held-out failure is named by its kind alone (goal 082); the owner's detail is in the
    // held_out record and its event.
    const why = [
      ho && !ho.pass ? heldOutWords(heldOutKinds(ho.cells)) : "",
      held.length ? `no longer met: ${held.join(", ")}` : "",
      lost.length ? `lost: ${lost.join(", ")}` : "",
      unsure.length ? `could not check: ${unsure.join(", ")}` : "",
    ].filter(Boolean);
    const reasons = ok
      ? `confirmed: newly met ${gained.join(", ")}; vs champion seq ${champion.seq}`
      : `confirmation failed${why.length ? `: ${why.join("; ")}` : ""}; vs champion seq ${champion.seq}`;
    const fin: Finish = {
      result: { verdict, gained },
      verdict: {
        attempt: attemptId,
        verdict,
        dependsOnJobs: [job.id, Number(judge.spec(job).screen_job ?? job.id)],
        reasons,
        judgedBy: judge.o.owner,
        guards: results.map((r) => ({ goal: r.goal, status: r.status })),
      },
      ...(ho ? { events: [heldOutEvent(job.id, run, attemptId, ho)] } : {}),
      lifecycle: "judged",
    };
    if (!ok) return fin;
    const promoted = promotion(judge, fin, attemptId, run, champion.seq, attempt);
    // A new champion is validated afresh, so the goal tree reflects it.
    return promoted.promote
      ? {
          ...promoted,
          enqueue: { kind: "validate", priority: 60, spec: { run }, actor: judge.o.owner },
        }
      : promoted;
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    return judge.stopped(job, err);
  }
}
