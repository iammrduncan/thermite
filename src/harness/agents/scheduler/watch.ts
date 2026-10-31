import { logError } from "../../../common/log.ts";
import { idle, type SchedulerContext } from "./context.ts";
import { stopTrials } from "./stops.ts";

/**
 * Work in flight, watched while it runs: the stops that apply at once (stops.ts), the owner's
 * reset of a run's workers, and the harness's own shutdown (goal 079).
 */

/**
 * Work in flight that must stop stops at once (scheduler/stops.ts): the trials of a run that is
 * no longer running (paused, closed) and those the owner asked to stop are killed, and a planner
 * call for a run no longer running is cancelled, instead of running to their end.
 */
export function applyStops(sched: SchedulerContext): void {
  const o = { aborts: sched.aborts, laneRun: sched.laneRun, owner: sched.o.owner };
  sched.stopSeen = stopTrials(sched.ledger, { ...o, seen: sched.stopSeen });
  const p = sched.planning;
  if (p && sched.ledger.runs.get(p.run)?.status !== "running") p.ctrl.abort();
}

/** Checks every second while trials or a planner call are in flight (the tick may be waiting). */
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

/**
 * reset_workers: running trials of the run are killed, lane bests cleared and the
 * epoch ended, so the next tick plans afresh.
 */
export async function applyResets(sched: SchedulerContext): Promise<void> {
  for (const r of sched.ledger.events.list("workers_reset", { after: sched.resetSeen })) {
    sched.resetSeen = r.id;
    for (const a of sched.aborts.values()) a.abort();
    await idle(sched);
    if (r.subject === null) continue;
    for (const lane of sched.ledger.trials.lanes(r.subject))
      sched.registry.clearLaneBest(r.subject, lane, sched.o.owner, "workers reset");
    const epoch = sched.registry.currentEpoch(r.subject);
    if (epoch && !epoch.ended_at) sched.registry.endEpoch(r.subject, epoch.n, sched.o.owner);
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
