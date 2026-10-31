import { log, logError, logWarn } from "../../../../common/log.ts";
import { ANSWERED, NO_WRITER } from "../../../../core/research-check.ts";
import { type Research, type ResearchEnd, researchEnd } from "../../../research/index.ts";
import type { SchedulerContext } from "../context.ts";

/**
 * How a research run ends: closed by the owner, or ended by its review panel or the progress
 * rule, with its final report and, when its rig has a final writer, its research paper.
 */

/**
 * A research run the owner closed (close_run, goal 087) ends as one whose window is over: once
 * its last trial has ended, its final report is written from the ledger, and the next export
 * carries it and the run's folder. A run closed at the end of its window has its final report.
 */
export function finishClosedResearch(sched: SchedulerContext): void {
  if (!sched.o.research) return;
  const closed = sched.ledger.runs
    .ids("research", "closed")
    .filter((id) => !sched.ledger.events.count("research_final", { subject: id }));
  for (const id of closed) {
    // Its last trials end first; a report that failed is not tried again by this process.
    if ([...sched.laneRun.values()].includes(id) || sched.finalFailed.has(id)) continue;
    try {
      sched.o.research.report(id, "final");
    } catch (err) {
      sched.finalFailed.add(id);
      logError("scheduler", "final report of a closed research run failed", {
        run: id,
        error: String(err),
      });
    }
  }
}

/**
 * A running research run that ended (goals 112 and 117): its review's pass was accepted, or the
 * progress rule stopped it. No new trial starts in it (researchTick). It waits for its research
 * paper: the harness asks the supervisor's final writer for it once, and the run ends when code
 * accepted the paper and its running trials have ended (closeEnded). A rig whose supervisor says
 * it has no final writer ends the run without one, once its trials have ended; until the
 * supervisor says, the run waits. Checked on every step, with or without a model.
 */
export function finishEndedResearch(sched: SchedulerContext): void {
  if (!sched.o.research) return;
  const papers = sched.o.service.papers;
  for (const id of sched.ledger.runs.ids("research", "running")) {
    const end = researchEnd(sched.ledger, id);
    if (!end) continue;
    let noPaper: string | undefined;
    if (!papers.accepted(id)) {
      const advisors = sched.o.service.advisors;
      // The supervisor has not said yet whether it has a final writer: the run waits.
      if (!advisors) continue;
      if (advisors.writer) {
        try {
          if (papers.request(id, sched.o.owner))
            sched.o.service.live.append({
              source: "planner",
              kind: "status",
              text: "the final writer is asked for the run's research paper",
              run: id,
            });
        } catch (err) {
          log("scheduler", "the research paper was not asked for", {
            run: id,
            error: String(err),
          });
        }
        continue;
      }
      noPaper = NO_WRITER;
    }
    // Its running trials end first; a close that failed is not tried again by this process.
    if ([...sched.laneRun.values()].includes(id) || sched.finalFailed.has(id)) continue;
    try {
      closeEnded(sched, id, end, noPaper);
    } catch (err) {
      sched.finalFailed.add(id);
      logWarn("scheduler", "an ended research run could not close", {
        run: id,
        error: String(err),
      });
    }
  }
}

/**
 * The end of a research run that ended (goals 112 and 117): its final report, which starts
 * with its research paper, then holds the review panel's decisions, and the close, with the
 * end's reason: `every question is answered`, or the progress rule's. The one place a run ends
 * this way, once its paper is in (or its rig has no final writer, `noPaper`) and its running
 * trials have ended.
 */
function closeEnded(
  sched: SchedulerContext,
  run: string,
  end: ResearchEnd,
  noPaper?: string | undefined,
): void {
  (sched.o.research as Research).report(run, "final", { noPaper });
  if (noPaper)
    sched.o.service.live.append({
      source: "planner",
      kind: "status",
      text: `${end.reason === ANSWERED ? "every question is answered" : "research stopped adding"}; the run ends with no research paper: ${noPaper}`,
      run,
    });
  sched.ledger.runs.setStatus(run, "closed", end.reason, sched.o.owner);
}
