import { log } from "../../common/env.ts";
import { type JobRow, type Ledger, LedgerError } from "../ledger/index.ts";
import { clipReason } from "./reasons.ts";

/** Whether an error is the ledger saying the job's lease was lost: another holder has the job. */
export const leaseLost = (err: unknown) => err instanceof LedgerError && err.code === "stale";

/**
 * A job that failed for a reason that is no verdict on its change (a build tool missing, a
 * contract that can't be read): recorded as `crash_infra`, and the job tried once more before its
 * attempt is `errored`. A parent screen's failure is no verdict on its change and leaves it as it
 * is (goal 135). Nothing is recorded when the lease was lost: whoever holds it now owns the
 * outcome. Any other failure to record is logged, never taken for a lost lease (goal 163).
 */
export function recordInfraFailure(
  ledger: Ledger,
  job: JobRow,
  reason: string,
  o: { owner: string; spec: Record<string, unknown> },
): void {
  try {
    ledger.tx(() => {
      ledger.jobs.complete(job.id, job.fence, "failed", { error: clipReason(reason) });
      if (!job.attempt || job.kind === "parent_screen") return;
      const retries = Number(o.spec.retries ?? 0);
      ledger.verdicts.record({
        attempt: job.attempt,
        verdict: "crash_infra",
        dependsOnJobs: [job.id],
        reasons: clipReason(reason),
        judgedBy: o.owner,
      });
      if (retries < 1) {
        ledger.jobs.enqueue({
          attempt: job.attempt,
          kind: job.kind,
          // A setup change's baseline job keeps its place ahead of the run's other jobs.
          ...(job.kind === "baseline" ? { priority: job.priority } : {}),
          spec: { ...o.spec, retries: retries + 1 },
          actor: o.owner,
        });
        ledger.attempts.setLifecycle(job.attempt, "queued", o.owner);
      } else {
        ledger.attempts.setLifecycle(job.attempt, "errored", o.owner);
      }
    });
  } catch (err) {
    if (leaseLost(err))
      log(
        "judge",
        "a failed job's lease was lost: its new holder records it",
        { job: job.id },
        "warn",
      );
    else
      log(
        "judge",
        "could not record a failed job",
        { job: job.id, error: String(err), reason },
        "warn",
      );
  }
}
