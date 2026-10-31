import type { Ledger } from "../../ledger/index.ts";

/**
 * Trials that stop before their end (goals 079 and 136): each trial of a run that is no longer
 * running (paused, closed), and a trial the owner or an operator asked to stop (`stop_trial`,
 * which the harness records as `trial_stop_asked`). Each gets a `trial_stopped` event and its
 * abort. The trial then ends as interrupted, with its counters, and its experiment goes back to
 * the top of the run's queue, as after a restart. The scheduler checks every second while trials
 * run.
 */

export interface Stopping {
  /** Each running trial's abort, by lane. */
  aborts: ReadonlyMap<string, AbortController>;
  /** The run each running trial (by lane) works for. */
  laneRun: ReadonlyMap<string, string>;
  /** Who records a stop the harness decided itself. */
  owner: string;
  /** The newest `trial_stop_asked` event read before. */
  seen: number;
}

/** The newest `trial_stop_asked` event: asks recorded before this process started are past. */
export function lastStopAsked(ledger: Ledger): number {
  return ledger.events.lastId("trial_stop_asked");
}

/** Stops what must stop now. Returns the newest `trial_stop_asked` event read. */
export function stopTrials(ledger: Ledger, o: Stopping): number {
  const running = (id: string) => ledger.runs.get(id)?.status === "running";
  for (const [lane, ctrl] of o.aborts) {
    const run = o.laneRun.get(lane);
    if (run && !running(run) && !ctrl.signal.aborted) {
      ledger.appendEvent(o.owner, "trial_stopped", run, { lane, reason: "run not running" });
      ctrl.abort();
    }
  }
  let seen = o.seen;
  for (const e of ledger.events.list("trial_stop_asked", { after: seen })) {
    seen = e.id;
    const b = e.body;
    const ctrl = o.aborts.get(b.lane);
    // Only the trial asked for, while it runs: a lane runs one trial at a time, so an open trial
    // on the lane is the one its abort stops. One that ended meanwhile is left as it ended.
    const t = ledger.trials.get(b.trial);
    const open = t?.lane === b.lane && t.ended_at === null;
    if (!ctrl || ctrl.signal.aborted || o.laneRun.get(b.lane) !== e.subject || !open) continue;
    ledger.appendEvent(e.actor, "trial_stopped", e.subject, {
      lane: b.lane,
      trial: b.trial,
      reason: b.reason ?? `stopped by ${e.actor}`,
    });
    ctrl.abort();
  }
  return seen;
}
