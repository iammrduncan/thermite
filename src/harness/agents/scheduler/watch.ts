import { log, logError } from "../../../common/log.ts";
import { idle, type SchedulerContext } from "./context.ts";
import { stopRunsNotRunning } from "./stops.ts";

/**
 * Work in flight, watched while it runs: the runs that stop running (stops.ts), the owner's reset
 * of a run's workers, and the harness's own shutdown (goal 079).
 */

/**
 * Work in flight for a run no longer running (paused, closed) stops at once: its trials are
 * killed, and its planner call is cancelled, instead of running to their end.
 */
export function applyStops(sched: SchedulerContext): void {
  stopRunsNotRunning(sched.ledger, {
    aborts: sched.aborts,
    laneRun: sched.laneRun,
    owner: sched.o.owner,
  });
  const p = sched.planning;
  if (p && sched.ledger.runs.get(p.run)?.status !== "running") p.ctrl.abort();
}

/**
 * Checks every second while trials or a planner call are in flight (the tick may be waiting):
 * a run's status changes in many parts of the harness (the owner's pause, the judge, a budget).
 */
export function watch(sched: SchedulerContext): void {
  if (sched.watcher) return;
  sched.watcher = setInterval(() => {
    try {
      applyStops(sched);
    } catch (err) {
      logError("scheduler", "stop check failed", { error: String(err) });
    }
    if (!sched.aborts.size && !sched.planning && sched.watcher) {
      clearInterval(sched.watcher);
      sched.watcher = undefined;
    }
  }, 1000);
  sched.watcher.unref?.();
}

/** The running trials of a run are killed: the start of its reset. */
function abortRun(sched: SchedulerContext, run: string): void {
  for (const [lane, ctrl] of sched.aborts) if (sched.laneRun.get(lane) === run) ctrl.abort();
}

/**
 * reset_workers, as the service recorded it: the run's running trials are killed now, and the
 * rest of the reset waits for the scheduler's next step (applyResets), before it plans.
 */
export function resetAsked(sched: SchedulerContext, reset: { event: number; run: string }): void {
  if (sched.resets.some((r) => r.event === reset.event)) return;
  sched.resets.push(reset);
  abortRun(sched, reset.run);
}

/**
 * The resets waiting, oldest first: once the run's trials have ended, its lane bests are cleared
 * and its epoch ended, so the next tick plans afresh. The ledger records each reset applied with
 * what it changed, so one a restart cut off waits again at the next start.
 */
export async function applyResets(sched: SchedulerContext): Promise<void> {
  for (let r = sched.resets[0]; r; r = sched.resets[0]) {
    const { event, run } = r;
    abortRun(sched, run);
    await idle(sched);
    sched.ledger.tx(() => {
      for (const lane of sched.ledger.trials.lanes(run))
        sched.registry.clearLaneBest(run, lane, sched.o.owner, "workers reset");
      const epoch = sched.registry.currentEpoch(run);
      if (epoch && !epoch.ended_at) sched.registry.endEpoch(run, epoch.n, sched.o.owner);
      sched.ledger.trials.resetApplied(event);
    });
    sched.resets.shift();
    log("scheduler", "a run's workers reset: lane bests cleared and the round ended", {
      run,
      event,
    });
  }
}

/**
 * The harness is stopping (goal 079): no new plan or trial, the planner's call is cancelled, and
 * running trials stop and are recorded as interrupted, with the counters their workers last
 * reported, before this returns.
 */
export async function shutdown(sched: SchedulerContext, reason: string): Promise<void> {
  sched.stopping = true;
  for (const [lane, ctrl] of sched.aborts) {
    const run = sched.laneRun.get(lane);
    if (run && !ctrl.signal.aborted)
      sched.ledger.appendEvent(sched.o.owner, "trial_stopped", run, { lane, reason });
    ctrl.abort();
  }
  sched.planning?.ctrl.abort();
  await idle(sched);
}
