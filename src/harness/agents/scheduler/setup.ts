import { EXPERIMENT_DETAILS } from "../../../core/commands.ts";
import type { Contract } from "../../../core/contract.ts";
import { type BaselineState, clipReason, SETUP_FAMILY } from "../../judge/index.ts";
import { focusOf, type Handout, PLANNER } from "../coordinator.ts";
import { lanesOf } from "../planner/index.ts";
import type { Assignment, EpochRecord } from "../registry.ts";
import { laneCountOf, type SchedulerContext } from "./context.ts";

/**
 * A hill climb's baseline and its setup rounds (goal 115): no round of the plan starts until the
 * judge has measured the starting point, and while it can't, each lane works to make it build and
 * run its cells.
 */

/**
 * Tells Live where a hill climb's baseline stands (goal 115), once for each change: the round
 * that waits for it, the setup when the judge could not measure the starting point, and the
 * baseline's arrival after either.
 */
export function noteBaseline(
  sched: SchedulerContext,
  run: string,
  s: BaselineState,
  n: number,
): void {
  const before = sched.baselineNoted.get(run);
  const key =
    s.state === "waiting"
      ? `waiting:${s.start.seq}:${n}:${s.infra?.at ?? ""}`
      : s.state === "setup"
        ? `setup:${s.failure.id}`
        : `measured:${s.baseline.id}`;
  if (before === key) return;
  sched.baselineNoted.set(run, key);
  if (s.state === "measured" && (before === undefined || before.startsWith("measured:"))) return;
  sched.o.service.live.append({
    source: "planner",
    kind: "status",
    text:
      s.state === "waiting"
        ? `round ${n} waits for the judge's baseline of the starting point (champion #${s.start.seq})${s.infra ? `; the judge's last try failed (${clipReason(s.infra.error, 300)}), and it tries again` : ""}`
        : s.state === "setup"
          ? `the judge could not measure the starting point (champion #${s.start.seq}): the run is in setup, and each lane works to make it build and run its cells. ${clipReason(s.failure.summary, 600)}`
          : `the judge measured the starting point (champion #${s.baseline.champion_seq}): ${clipReason(s.baseline.summary, 600)}. The rounds of the plan start now`,
    run,
  });
}

/**
 * A setup round (goal 115): the judge could not measure the starting point, so each lane gets
 * one setup experiment, at the top of the queue: make the project build and run its cells,
 * within the editable paths, never the kit. No planner call: the judge's reasons are the plan.
 */
export function planSetupEpoch(
  sched: SchedulerContext,
  run: string,
  contract: Contract,
  n: number,
  setup: Extract<BaselineState, { state: "setup" }>,
): void {
  sched.registry.addFamily(
    run,
    SETUP_FAMILY,
    "Make the starting point build and run its cells, so the judge can measure it",
    PLANNER,
  );
  const queue = sched.o.service.queue;
  const handout: Handout[] = [];
  const assignments: Assignment[] = [];
  const why = `the judge could not measure the starting point (champion #${setup.start.seq}): no change can be judged until it can`;
  for (const lane of lanesOf(laneCountOf(sched, run, contract))) {
    const x = queue.add(
      run,
      {
        title: "Make the starting point build and run its cells",
        details: clipReason(
          `The judge could not measure the starting point (champion #${setup.start.seq}, commit ${setup.start.commit.slice(0, 12)}). Its reasons: ${setup.failure.reasons}`,
          EXPERIMENT_DETAILS,
        ),
        family: SETUP_FAMILY,
        why,
        by: PLANNER,
        position: "top",
      },
      PLANNER,
    );
    handout.push({ lane, experiment: x.id, why: "setup" });
    assignments.push({
      lane,
      family: SETUP_FAMILY,
      focus: focusOf(x),
      parent: "champion",
      experiment: x.id,
      why: "setup",
    });
  }
  sched.registry.startEpoch({
    run,
    n,
    source: "fallback",
    tries: 0,
    valid: false,
    rawViolations: [],
    assignments,
    notes:
      "setup: the judge could not measure the starting point; each lane works to make it build and run its cells",
    plan: "setup",
    by: sched.o.owner,
  });
  sched.coordinator.handout(
    run,
    n,
    handout,
    "setup round: each lane works to make the starting point build and run its cells",
  );
  sched.o.service.live.append({
    source: "planner",
    kind: "text",
    text: `round ${n}: a setup round (the judge could not measure the starting point)\n${assignments.map((a) => `${a.lane}: make the starting point build and run its cells`).join("\n")}`,
    run,
  });
}

/** Setup experiments left in the queue once the starting point is measured are dropped. */
export function dropSetupExperiments(sched: SchedulerContext, run: string): void {
  for (const x of sched.o.service.queue.queued(run)) {
    if (x.family !== SETUP_FAMILY) continue;
    sched.o.service.queue.drop(
      run,
      x.id,
      { by: PLANNER, why: "the judge measured the starting point: setup is over" },
      PLANNER,
    );
  }
}

/**
 * A setup round (goal 115): every lane's assignment is the setup direction, given out as setup
 * (planSetupEpoch), not a direction a planner chose.
 */
export function isSetupRound(e: EpochRecord): boolean {
  return (
    e.assignments.length > 0 &&
    e.assignments.every((a) => a.family === SETUP_FAMILY && a.why === "setup")
  );
}
