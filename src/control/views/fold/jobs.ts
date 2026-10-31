import type { Handler, Handlers } from "./index.ts";

/**
 * The judge's jobs: queued, leased, blocked after lost leases and queued again, and finished,
 * with what a finished job found for its attempt and what a validation means for its run.
 */

/** A job blocked after too many lost leases, or queued again. */
const blockedOrAgain: Handler = (f, e, b) => {
  // Blocked after too many lost leases (a crash, a lease that ran out): it won't run until a
  // harness start queues it again. A blocked validation leaves nothing to confirm (goal 086).
  const j = f.jobs.get(String(e.subject));
  const again = e.kind === "job_unblocked";
  if (!j || (b.state !== "blocked" && !again)) return;
  j.finished_at = again ? null : e.at;
  j.state = again ? "queued" : "blocked";
  const jr = j.run ? f.runs.get(j.run) : undefined;
  if (jr && j.kind === "validate") jr.goals_confirming = again;
};

export const JOBS: Handlers = {
  job_queued(f, e, b) {
    const attempt = (b.attempt as string | null) ?? null;
    const run =
      typeof b.run === "string" && b.run
        ? b.run
        : attempt
          ? (f.attempts.get(attempt)?.run ?? null)
          : f.running;
    f.jobs.set(String(e.subject), {
      id: String(e.subject),
      kind: String(b.kind ?? ""),
      attempt,
      run,
      queued_at: e.at,
      started_at: null,
      finished_at: null,
      state: "queued",
      result: {},
    });
    // The judge measures a hill climb's starting point (goal 115): its rounds wait.
    const jr = run ? f.runs.get(run) : undefined;
    if (jr && b.kind === "baseline" && !attempt && !jr.baseline && !jr.setup)
      jr.baseline_waiting = true;
  },
  job_leased(f, e) {
    const j = f.jobs.get(String(e.subject));
    if (j) Object.assign(j, { started_at: e.at, state: "running" });
  },
  crash_infra: blockedOrAgain,
  job_lease_expired: blockedOrAgain,
  job_unblocked: blockedOrAgain,
  // Cancelled for good (goal 174): its attempt's evidence was withdrawn.
  job_cancelled(f, e) {
    const j = f.jobs.get(String(e.subject));
    if (j) Object.assign(j, { finished_at: e.at, state: "cancelled" });
  },
  job_finished(f, e, b) {
    const j = f.jobs.get(String(e.subject));
    if (!j) return;
    j.finished_at = e.at;
    j.state = String(b.state ?? "done");
    j.result =
      b.result && typeof b.result === "object" ? (b.result as Record<string, unknown>) : {};
    // A validation that failed leaves no completion to confirm: the lanes go on (goal 086).
    const jr = j.run ? f.runs.get(j.run) : undefined;
    if (jr && j.kind === "validate" && j.state === "failed") jr.goals_confirming = false;
    const a = j.attempt ? f.attempts.get(j.attempt) : undefined;
    if (a && j.state === "done") {
      const r = j.result;
      if (Array.isArray(r.gained)) a.gained = r.gained.map(String);
      if (Array.isArray(r.lost)) a.lost = r.lost.map(String);
      if (Array.isArray(r.unsure)) a.unsure = r.unsure.map(String);
      a.waiting = typeof r.waiting === "string" ? r.waiting : null;
    }
  },
};
