import { toFraction } from "../../../core/stats.ts";
import type { JobRow } from "../../ledger/index.ts";
import { runBlocks } from "../blocks.ts";
import { type Finish, InfraError, type JudgeContext, Stop } from "../context.ts";
import { type Decision, decideScreen, goalDelta } from "../decide.ts";
import { recordGoals, verifyGoals } from "../goals.ts";
import { runArm } from "../measure.ts";
import { olderChampion, parentScreened } from "../ports.ts";

/**
 * The evaluate job. A hill climb's attempt is gated and screened against the champion in blocks,
 * decided at the contract's looks; a parent screen measures it against the older champion it was
 * written on (goal 135). A goal campaign's attempt is checked on every goal (evaluateGoal).
 */

export async function evaluate(judge: JudgeContext, job: JobRow): Promise<Finish> {
  const attemptId = job.attempt as string;
  const attempt = judge.ledger.attempts.get(attemptId);
  if (!attempt) throw new InfraError(`no attempt ${attemptId}`);
  const run = String(attempt.run);
  if (judge.o.service.contractFor(run).mode === "goal") return evaluateGoal(judge, job);
  const contract = judge.hillClimb(run);
  const champion = judge.ledger.champions.current(run);
  // A parent screen (goal 135): against the older champion it was written on, with no verdict.
  const parent = String(attempt.parent_commit);
  const onParent = job.kind === "parent_screen";
  const step = (l: string) => {
    judge.ledger.jobs.heartbeat(job.id, job.fence, judge.o.leaseMs);
    if (!onParent) judge.ledger.attempts.setLifecycle(attemptId, l, judge.o.owner);
  };

  try {
    const k = await judge.kitFor(contract);
    step("building");
    const champ = await judge.armFor("champion", run, onParent ? parent : champion.commit_sha, k);
    const cand = await judge.armFor("candidate", run, String(attempt.commit_sha), k);
    const ctx = judge.context(k, job);

    step("gating");
    for (const cell of contract.cells) {
      judge.judgeRun(cand, await runArm(ctx, cand, cell));
      judge.judgeRun(champ, await runArm(ctx, champ, cell));
    }

    step("screening");
    let decision: Decision<string> | undefined;
    const looks = contract.acceptance.looks;
    await runBlocks(judge, {
      job,
      ctx,
      arms: [cand, champ],
      cells: contract.cells,
      count: Math.max(...looks),
      runsPerCell: contract.acceptance.runs_per_cell,
      onBlock: (bs) => {
        if (!looks.includes(bs.length)) return false;
        decision = decideScreen(contract, bs, judge.noiseFloor(run));
        return decision.verdict !== undefined;
      },
    });
    const d = decision as Decision<string>;
    const verdict = d.verdict ?? "inconclusive";
    const win = verdict === "win_screened";
    const older = olderChampion(judge.ledger, run, attemptId, champion.seq);
    if (onParent)
      return parentScreened(run, attemptId, older, verdict, toFraction(d.primary.estimate));
    return {
      result: { verdict, delta: toFraction(d.primary.estimate), baseline_seq: champion.seq },
      verdict: {
        attempt: attemptId,
        verdict,
        ...judge.verdictFields(d),
        dependsOnJobs: [job.id],
        reasons: `${d.reasons}; vs champion seq ${champion.seq}`,
        judgedBy: judge.o.owner,
      },
      ...(win
        ? {
            enqueue: {
              attempt: attemptId,
              kind: "confirm",
              priority: 50,
              spec: { baseline_seq: champion.seq, screen_job: job.id, ...judge.avoidMe() },
              actor: judge.o.owner,
            },
          }
        : older !== undefined
          ? {
              enqueue: {
                attempt: attemptId,
                kind: "parent_screen",
                priority: 150,
                actor: judge.o.owner,
              },
            }
          : {}),
      lifecycle: win ? "confirming" : "judged",
    };
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    return judge.stopped(job, err);
  }
}

/**
 * A goal-mode attempt: progress means it meets at least one goal the champion does not, and
 * loses none the champion meets. The champion's statuses come from the latest validation.
 */
async function evaluateGoal(judge: JudgeContext, job: JobRow): Promise<Finish> {
  const attemptId = job.attempt as string;
  const attempt = judge.ledger.attempts.get(attemptId);
  if (!attempt) throw new InfraError(`no attempt ${attemptId}`);
  const run = String(attempt.run);
  const contract = judge.goalContract(run);
  const champion = judge.ledger.champions.current(run);
  try {
    const k = await judge.kitFor(contract);
    judge.ledger.attempts.setLifecycle(attemptId, "building", judge.o.owner);
    const cand = await judge.armFor("candidate", run, String(attempt.commit_sha), k);
    judge.ledger.attempts.setLifecycle(attemptId, "verifying", judge.o.owner);
    const results = await verifyGoals(judge, job, contract, judge.context(k, job), cand);
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
    // A goal the champion meets that the candidate fails is lost; one it could not check
    // (inconclusive, not runnable) is unknown, which is not a regression and not progress.
    const verdict = lost.length
      ? "regress"
      : unsure.length
        ? "inconclusive"
        : gained.length
          ? "goal_screened"
          : "no_progress";
    const reasons = `${gained.length ? `newly met: ${gained.join(", ")}` : "no new goal met"}${lost.length ? `; lost: ${lost.join(", ")}` : ""}${unsure.length ? `; could not check: ${unsure.join(", ")}` : ""}; vs champion seq ${champion.seq}`;
    const screened = verdict === "goal_screened";
    return {
      result: { verdict, gained, lost, unsure },
      verdict: {
        attempt: attemptId,
        verdict,
        dependsOnJobs: [job.id],
        reasons,
        judgedBy: judge.o.owner,
        guards: results.map((r) => ({ goal: r.goal, status: r.status })),
      },
      ...(screened
        ? {
            enqueue: {
              attempt: attemptId,
              kind: "confirm",
              priority: 50,
              spec: { baseline_seq: champion.seq, screen_job: job.id, gained, ...judge.avoidMe() },
              actor: judge.o.owner,
            },
          }
        : {}),
      lifecycle: screened ? "confirming" : "judged",
    };
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    return judge.stopped(job, err);
  }
}
