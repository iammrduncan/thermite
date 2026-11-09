import { log } from "../../common/env.ts";
import type { Ledger } from "../ledger/index.ts";

/**
 * The judge's jobs and their leases around builds, runs and restarts. A build of a large project,
 * the wait for another executor's build of the same key, or a run of a slow kit, can take longer
 * than the lease (15 minutes): without renewal the lease ran out mid-build or mid-run, the job went
 * back to the queue, to hang again on another card when its change hangs (goal 240), and after
 * MAX_LEASE_EXPIRIES it was blocked, its attempt never judged.
 * A build and a run each have their own time limit (the kit's), so renewing the lease while they
 * go on can't hold a job forever.
 */

/**
 * Runs `work`, calling `renew` every `everyMs` until it ends; a renewal that throws stops them,
 * and says why in the log (goal 163): `what` names the job.
 */
export async function whileLeased<T>(
  renew: () => void,
  everyMs: number,
  work: () => Promise<T>,
  what: Record<string, unknown> = {},
): Promise<T> {
  const timer = setInterval(() => {
    try {
      renew();
    } catch (err) {
      // The lease is lost: whoever holds the job now owns its outcome; the work ends as it will.
      clearInterval(timer);
      log(
        "judge",
        "a lease renewal failed: the renewals stop",
        { ...what, error: String(err) },
        "error",
      );
    }
  }, everyMs);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/**
 * The harness's start: blocked jobs get one more try (`jobs.unblock`); then jobs still leased by
 * its executors, those of runners that left the rig meanwhile too, belonged to a process that
 * died, and go back to the queue (reclaimExecutorLeases), where the loss counts; then the queued jobs of closed runs are cancelled, those two may have put back
 * too. Unblocking first matters (goal 163): a job whose lease the reclaim takes for the third
 * time, one that killed the controller, stays blocked through this start instead of being
 * queued again at once, and so for ever.
 */
export function jobsAtStart(
  ledger: Ledger,
  log: (msg: string, fields: Record<string, unknown>) => void,
): void {
  const unblocked = ledger.jobs.unblock("controller-start");
  if (unblocked.length) log("blocked jobs queued again at start", { jobs: unblocked });
  const reclaimed = ledger.jobs.reclaimExecutorLeases("controller-start");
  if (reclaimed.length) log("reclaimed leases at start", { jobs: reclaimed });
  const cancelled = ledger.jobs.endClosedRuns("controller-start");
  if (cancelled.length) log("cancelled closed runs' jobs at start", { jobs: cancelled });
}
