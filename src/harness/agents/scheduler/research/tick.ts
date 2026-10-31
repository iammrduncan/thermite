import { errorText } from "../../../../common/errors.ts";
import { log } from "../../../../common/log.ts";
import type { ResearchContract } from "../../../../core/contract.ts";
import {
  PROGRESS_STOPPED,
  questionName,
  RESEARCH_PROGRESS,
  RESEARCH_STOPPED,
} from "../../../../core/research-check.ts";
import {
  itemsState,
  lastImprovement,
  progressStopped,
  questionSaturated,
  type Research,
  researchEnd,
  researchPackage,
  researchReviewDue,
  waitingReview,
} from "../../../research/index.ts";
import { Reviews } from "../../../reviews.ts";
import { halted, type SchedulerContext } from "../context.ts";
import { laneWaitMs } from "../gates.ts";
import { lanesInRound, roundOver } from "../rounds.ts";
import { planResearchEpoch } from "./plan.ts";
import { researchTaskFor } from "./tasks.ts";
import { startResearchTrial } from "./trial.ts";

/**
 * Research: the harness owns the clock. Lanes run trial after trial (no judge to wait for)
 * until the run ends (goals 112 and 117: the review panel's decisions give every item an end,
 * or the progress rule stops it) or max_duration; a digest every report_cadence.digest_minutes
 * and a final report come from the ledger.
 */
export async function researchTick(
  sched: SchedulerContext,
  run: string,
  contract: ResearchContract,
): Promise<boolean> {
  const research = sched.o.research as Research;
  const clock = research.clock(run);
  if (clock.done) {
    if (sched.running.size) return false; // let the last trials finish first
    research.report(run, "final");
    sched.ledger.runs.setStatus(run, "closed", "the research window is over", sched.o.owner);
    return false;
  }
  // The run ended: no new trial starts; it closes once those running end (finishEndedResearch).
  if (researchEnd(sched.ledger, run)) return false;
  const last = research.lastReportAt(run);
  if (!last || Date.now() - Date.parse(last) >= contract.report_cadence.digest_minutes * 60_000) {
    // At a digest, after the minimum: the review panel is asked about the items with no
    // standing decision, when code finds them ready (research/review.ts); then the progress
    // rule is checked. A failure of either is logged; the digest and the research go on, and
    // the next digest tries again.
    try {
      askResearchReview(sched, run, contract, clock);
    } catch (err) {
      log("scheduler", "the review panel was not asked", { run, error: String(err) });
    }
    try {
      if (checkProgress(sched, run, contract)) {
        research.report(run, "digest");
        return false;
      }
    } catch (err) {
      log("scheduler", "the progress rule was not checked", { run, error: String(err) });
    }
    research.report(run, "digest");
  }
  // The campaign's starting links, archived by the harness, beside the first trials.
  if (!sched.seeded.has(run)) {
    sched.seeded.add(run);
    void archiveSeeds(sched, run, contract);
  }
  let epoch = sched.registry.currentEpoch(run);
  if (!epoch || epoch.ended_at) {
    await planResearchEpoch(sched, run, contract, (epoch?.n ?? 0) + 1);
    epoch = sched.registry.currentEpoch(run);
    // Planning was cancelled (the run paused or closed meanwhile): no round started. A drain
    // or a stop that began while the planner worked: the round is recorded, and no trial starts.
    if (!epoch || epoch.ended_at || halted(sched)) return false;
  }
  let started = false;
  for (const a of epoch.assignments) {
    const trials = sched.registry.trials(run, a.lane, epoch.n);
    if (trials.length >= contract.lanes.trials_per_epoch || sched.running.has(a.lane)) continue;
    if (sched.running.size >= sched.o.maxConcurrent) continue;
    if (sched.o.workersOn && !sched.o.workersOn()) continue;
    if (laneWaitMs(sched, run, a.lane, true) > 0) continue;
    if (halted(sched)) return started;
    const got = researchTaskFor(sched, run, contract, epoch, a, trials.length + 1);
    if (!got) continue;
    startResearchTrial(sched, run, contract, epoch.n, a, clock, got);
    started = true;
  }
  const lanes = lanesInRound(sched.ledger, sched.registry, run, epoch, sched.running, true);
  if (roundOver(lanes, contract.lanes.trials_per_epoch))
    sched.registry.endEpoch(run, epoch.n, sched.o.owner);
  return started;
}

/**
 * The progress rule (goal 117), at a digest after the minimum: where it stands is the event
 * `research_progress`; when it holds (every open question saturated, no improvement for a
 * quarter of the running time), no review waits, and some item is still open, the run ends with
 * its open items stated (`research_stopped`): no new trial starts, the final writer writes its
 * paper, and it closes with PROGRESS_STOPPED. True when it ended the run. No time cap: the rule
 * holds only once research stopped adding.
 */
function checkProgress(sched: SchedulerContext, run: string, contract: ResearchContract): boolean {
  const research = sched.o.research as Research;
  const clock = research.clock(run);
  if (clock.elapsed_ms < clock.min_ms) return false;
  const n = contract.questions.length;
  const p = progressStopped(sched.ledger, run, n, (at) => research.clock(run, at));
  const saturated = p.open.filter((q) => questionSaturated(sched.ledger, run, q));
  const last = lastImprovement(sched.ledger, run);
  const { open } = itemsState(sched.ledger, run, n);
  // A review that waits may still improve an item; a run with every item at an end waits for
  // the review panel's pass, or the owner's word on it, never for this rule.
  const waiting = waitingReview(sched.ledger, run);
  const ends = p.stopped && !waiting && (open.questions.length > 0 || open.hypotheses.length > 0);
  const figures = {
    open: p.open,
    saturated,
    last_improvement: last,
    since_ms: p.since_ms,
    needed_ms: p.needed_ms,
  };
  sched.ledger.appendEvent(sched.o.owner, RESEARCH_PROGRESS, run, { ...figures, stopped: ends });
  if (!ends) return false;
  const h = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
  const why = `every open question is saturated, and no item improved for ${h(p.since_ms)} (the rule needs ${h(p.needed_ms)}, a quarter of the running time)`;
  sched.ledger.appendEvent(sched.o.owner, RESEARCH_STOPPED, run, {
    reason: PROGRESS_STOPPED,
    ...figures,
    open: { questions: open.questions, hypotheses: open.hypotheses },
  });
  const items = [
    ...open.questions.map(questionName),
    ...(open.hypotheses.length
      ? [
          `${open.hypotheses.length} required ${open.hypotheses.length === 1 ? "hypothesis" : "hypotheses"} with no verdict`,
        ]
      : []),
  ];
  sched.o.service.journal.writeAll(
    run,
    [
      {
        kind: "decision",
        text: `Research stopped adding: ${why}. The run ends with these items open: ${items.join(", ")}. It writes its paper and final report, and closes once its running trials end.`.slice(
          0,
          2000,
        ),
      },
    ],
    { by: "harness", actor: sched.o.owner, source: "planner" },
  );
  sched.o.service.live.append({
    source: "planner",
    kind: "status",
    text: `research stopped adding (the progress rule): ${why}; open: ${items.join(", ")}`.slice(
      0,
      600,
    ),
    run,
  });
  return true;
}

/**
 * Asks the review panel about a research run's items (goals 112 and 117), when code finds it
 * due: after the minimum running time, every question with an answer card, the campaign's floor
 * of verified claims met, no review waiting, and some item with no standing decision.
 */
function askResearchReview(
  sched: SchedulerContext,
  run: string,
  contract: ResearchContract,
  clock: { elapsed_ms: number; min_ms: number },
): void {
  const due = researchReviewDue(sched.ledger, run, contract, clock);
  if (!due.due) return;
  const id = new Reviews(sched.ledger).requestResearch({
    run,
    marker: due.marker,
    pkg: researchPackage(sched.ledger, run, contract),
    by: sched.o.owner,
  });
  sched.o.service.live.append({
    source: "planner",
    kind: "status",
    text: `review ${id}: the review panel is asked to decide ${[
      due.questions.length ? questionsList(due.questions) : "",
      due.hypotheses.length
        ? `${due.hypotheses.length} required ${due.hypotheses.length === 1 ? "hypothesis" : "hypotheses"}`
        : "",
    ]
      .filter(Boolean)
      .join(" and ")}`,
    run,
  });
}

/**
 * A research run's starting links (goal 078), fetched and archived by the harness when the run
 * starts (and again after a restart, when an archived link is found at once), one after
 * another, beside the first trials. A link the fetcher refuses is an event with its reason
 * (fetch_refused) and a line in Live; the run goes on without it.
 */
async function archiveSeeds(
  sched: SchedulerContext,
  run: string,
  contract: ResearchContract,
): Promise<void> {
  if (!contract.seeds.length) return;
  const research = sched.o.research as Research;
  let archived = 0;
  const refused: string[] = [];
  for (const url of contract.seeds) {
    try {
      const r = (await research.fetch(run, null, url)) as { refused?: string };
      if (r.refused) refused.push(`${url} (${r.refused})`);
      else archived++;
    } catch (err) {
      refused.push(`${url} (${errorText(err)})`);
    }
  }
  sched.o.service.live.append({
    source: "planner",
    kind: "status",
    text: `starting links: ${archived} of ${contract.seeds.length} archived${refused.length ? `; not archived: ${refused.join("; ").slice(0, 1000)}` : ""}`,
    run,
  });
}

/** Question indexes in words for people: "question 2", "questions 2, 5". */
function questionsList(xs: number[]): string {
  return `${xs.length === 1 ? "question" : "questions"} ${xs.map((i) => i + 1).join(", ")}`;
}
