import { log } from "../../../common/log.ts";
import type { Ledger } from "../../ledger/index.ts";
import type { StopAsked } from "../../service/index.ts";

/**
 * Trials that stop before their end (goals 079 and 136): each trial of a run that is no longer
 * running (paused, closed), and a trial the owner or an operator asked to stop (`stop_trial`).
 * The service records an ask as `trial_stop_asked` and tells the scheduler at once (stopAsked);
 * an ask recorded while no scheduler ran is acted on when the next one starts (stopsAskedBefore).
 * Each stop gets a `trial_stopped` event and its abort. The trial then ends as interrupted, with
 * its counters, and its experiment goes back to the top of the run's queue, as after a restart.
 * A run that stops running is checked every second while trials run (watch.ts): many parts of the
 * harness change a run's status.
 */

export interface Stopping {
  /** Each running trial's abort, by lane. */
  aborts: ReadonlyMap<string, AbortController>;
  /** The run each running trial (by lane) works for. */
  laneRun: ReadonlyMap<string, string>;
  /** Who records a stop the harness decided itself. */
  owner: string;
}

/** The running trials of each run that is no longer running stop. */
export function stopRunsNotRunning(ledger: Ledger, o: Stopping): void {
  const running = (id: string) => ledger.runs.get(id)?.status === "running";
  for (const [lane, ctrl] of o.aborts) {
    const run = o.laneRun.get(lane);
    if (run && !running(run) && !ctrl.signal.aborted) {
      ledger.appendEvent(o.owner, "trial_stopped", run, { lane, reason: "run not running" });
      ctrl.abort();
    }
  }
}

/**
 * The owner's ask to stop a trial, as the service recorded it: the trial stops now. Only the trial
 * asked for, while it runs: a lane runs one trial at a time, so an open trial on the lane is the
 * one its abort stops. One that ended meanwhile is left as it ended. Whether it stopped.
 */
export function stopAsked(ledger: Ledger, o: Stopping, ask: StopAsked): boolean {
  const ctrl = o.aborts.get(ask.lane);
  const t = ledger.trials.get(ask.trial);
  const open = t?.lane === ask.lane && t.ended_at === null;
  if (!ctrl || ctrl.signal.aborted || o.laneRun.get(ask.lane) !== ask.run || !open) return false;
  ledger.appendEvent(ask.by, "trial_stopped", ask.run, {
    lane: ask.lane,
    trial: ask.trial,
    reason: ask.reason ?? `stopped by ${ask.by}`,
  });
  ctrl.abort();
  return true;
}

/**
 * Asks recorded while no scheduler ran (the harness stopped, or had not made its scheduler yet),
 * as a scheduler starts and before it ends the trials an earlier process left open: each open
 * trial asked to stop, and not stopped, gets its `trial_stopped` by whoever asked, with their
 * reason. The restart then ends it as interrupted (Registry.interruptUnfinished). How many.
 */
export function stopsAskedBefore(ledger: Ledger): number {
  let stopped = 0;
  for (const t of ledger.trials.open()) {
    const about = { subject: t.run, body: { trial: t.id } };
    const ask = ledger.events.newest("trial_stop_asked", about);
    if (!ask || ask.body.lane !== t.lane || ledger.events.count("trial_stopped", about)) continue;
    ledger.appendEvent(ask.actor, "trial_stopped", t.run, {
      lane: t.lane,
      trial: t.id,
      reason: ask.body.reason ?? `stopped by ${ask.actor}`,
    });
    stopped++;
    log("scheduler", "a trial asked to stop while no scheduler ran is recorded stopped", {
      run: t.run,
      trial: t.id,
      lane: t.lane,
      by: ask.actor,
      event: ask.id,
    });
  }
  return stopped;
}
