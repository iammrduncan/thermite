import { clipReason } from "../../judge/index.ts";
import type { Ledger } from "../../ledger/index.ts";
import type { GoalReport } from "../planner/index.ts";
import { BRIEF_GOAL_CHARS, type SchedulerContext } from "./context.ts";

/**
 * A goal campaign's rounds and the judge's goal reports (goals 079 and 086): what the planner
 * and the workers read of a report, and the waits for one.
 */

/** The judge's latest goal report on this champion (its validation), if there is one. */
export function goalReport(ledger: Ledger, run: string, seq: number): GoalReport | undefined {
  const body = ledger.events.newest("goal_report", {
    subject: run,
    body: { champion_seq: seq },
  })?.body;
  if (!body) return undefined;
  return {
    champion_seq: seq,
    goals: body.goals.map((g) => ({
      goal: g.goal,
      status: g.status,
      reasons: clipReason(g.reasons, BRIEF_GOAL_CHARS),
    })),
    // Its held-out check failed (goal 086): the judge's fixed words of the kinds alone.
    ...(typeof body.not_confirmed === "string"
      ? { not_confirmed: clipReason(body.not_confirmed, BRIEF_GOAL_CHARS) }
      : {}),
  };
}

/**
 * A goal campaign's epoch is planned from the judge's goal report on the current champion, so
 * lanes are not sent after goals it already meets. The wait ends when the report arrives, when
 * the judge has stopped validating this champion (three failures), or after goalReportWaitMs.
 */
export function awaitingGoalReport(sched: SchedulerContext, run: string, n: number): boolean {
  const { seq } = sched.ledger.champions.current(run);
  if (goalReport(sched.ledger, run, seq)) return false;
  const since = sched.ledger.champions.promotedAt(run, seq) ?? "";
  const failed = sched.ledger.jobs
    .ofRun(run, "validate")
    .filter((j) => j.state === "failed" && j.updated_at >= since).length;
  const waited = since ? Date.now() - Date.parse(since) : Number.POSITIVE_INFINITY;
  const giveUp = failed >= 3 || waited >= sched.o.goalReportWaitMs;
  const key = `${run}:${seq}:${n}:${giveUp}`;
  if (sched.reportNoted !== key) {
    sched.reportNoted = key;
    sched.o.service.live.append({
      source: "planner",
      kind: "status",
      text: giveUp
        ? `planning round ${n} without a goal report on champion #${seq} (${failed >= 3 ? "its validation failed" : `none after ${Math.round(waited / 60_000)} min`})`
        : `round ${n} waits for the judge's goal report on champion #${seq}`,
      run,
    });
  }
  return !giveUp;
}

/**
 * Goal mode (goal 086): a validation of the champion found every required goal met, and only
 * the judge's second, confirming validation is left. No new round or trial starts while it is
 * queued or running: if it agrees, the run closes and a new trial's work would be lost. A trial
 * already at work goes on. If it does not agree (a goal is not met again, or the validation
 * fails), the lanes go on.
 */
export function waitingForConfirmation(sched: SchedulerContext, run: string): boolean {
  const { seq } = sched.ledger.champions.current(run);
  const waiting = sched.ledger.jobs
    .ofRun(run, "validate")
    .some(
      (j) =>
        (j.state === "queued" || j.state === "leased") &&
        j.spec.confirm === true &&
        j.spec.champion_seq === seq,
    );
  const noted = sched.confirmNoted.get(run);
  if (waiting && noted !== seq) {
    sched.confirmNoted.set(run, seq);
    sched.o.service.live.append({
      source: "planner",
      kind: "status",
      text: `no new trial starts: the judge is confirming that champion #${seq} meets every required goal; if it does, the run closes (a trial at work goes on until then)`,
      run,
    });
  } else if (!waiting && noted !== undefined) {
    sched.confirmNoted.delete(run);
    sched.o.service.live.append({
      source: "planner",
      kind: "status",
      text: `trials start again: the judge's confirmation of champion #${noted} did not close the run`,
      run,
    });
  }
  return waiting;
}
