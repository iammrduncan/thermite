import type { SQLInputValue } from "node:sqlite";
import { canonicalJson, sha256Hex } from "../../core/canonical.ts";
import type { EventKind } from "../../core/names.ts";
import { LedgerError, LedgerPart, type Row } from "./part.ts";
import { type JobRow, toJob } from "./rows.ts";

/** After this many lease expiries a job is blocked instead of re-queued (poison-pill guard). */
export const MAX_LEASE_EXPIRIES = 3;

/** Why a job is blocked, in words for its lane and the owner: how its leases were lost. */
function blockedReason(kind: EventKind, expiries: number): string {
  const how =
    kind === "job_lease_expired"
      ? "the judge that held it did not renew its lease in time"
      : "the harness stopped, or its runner left the rig, while the job ran";
  return `the judge lost this job ${expiries} times (${how}): no verdict on the change. The job is blocked; the harness tries it once more when it starts again`;
}

/** A run's job, with its spec and result read. */
export interface RunJob {
  id: number;
  attempt: string | null;
  state: string;
  spec: Record<string, unknown>;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** The `job` and `receipt` tables: the judge's jobs, their leases and receipts. */
export class LedgerJobs extends LedgerPart {
  enqueue(input: {
    attempt?: string | undefined;
    kind: string;
    priority?: number | undefined;
    spec?: unknown;
    actor: string;
  }): number {
    return this.tx(() => {
      const at = this.now();
      const id = this.execute(
        "insert into job (attempt, kind, state, priority, spec, created_at, updated_at) values (?, ?, 'queued', ?, ?, ?, ?)",
        input.attempt ?? null,
        input.kind,
        input.priority ?? 100,
        canonicalJson(input.spec ?? {}),
        at,
        at,
      ).id;
      const run = (input.spec as { run?: unknown } | undefined)?.run;
      this.ledger.appendEvent(input.actor, "job_queued", String(id), {
        attempt: input.attempt ?? null,
        kind: input.kind,
        // The run it serves, when its spec names one: readers need not guess it.
        ...(typeof run === "string" ? { run } : {}),
      });
      return id;
    });
  }

  /**
   * Leases the next queued job (lowest priority number first). The fence increments on every
   * lease, so a holder whose lease expired can no longer write results. On a rig with several
   * judge cards each executor passes its card: it then skips a job pinned to another card (a
   * calibration). A confirmation goes to the first card free, its screen's own included, which
   * takes it at once (goal 233). The runs in `baseline` wait for the baseline of their starting
   * point (goal 115): of their jobs, only a `baseline` job is leased.
   */
  lease(
    owner: string,
    ttlMs: number,
    kinds?: readonly string[],
    card?: string | undefined,
    baseline: readonly string[] = [],
  ): JobRow | undefined {
    return this.tx(() => {
      const filter = kinds?.length ? `and j.kind in (${kinds.map(() => "?").join(",")})` : "";
      const cards = card === undefined ? "" : `and coalesce(json_extract(j.spec, '$.card'), ?) = ?`;
      const waits = baseline.length
        ? `and (i.id is null or j.kind = 'baseline' or i.id not in (${baseline.map(() => "?").join(",")}))`
        : "";
      // A paused or closed run's jobs wait in the queue: the judge's time goes to running runs.
      const r = this.row<Row>(
        `select j.id from job j
         left join attempt a on a.id = j.attempt
         left join run i on i.id = coalesce(a.run, json_extract(j.spec, '$.run'))
         where j.state = 'queued' ${filter} ${cards} ${waits}
           and (i.status is null or i.status = 'running')
         order by j.priority, j.id limit 1`,
        ...(kinds ?? []),
        ...(card === undefined ? [] : [card, card]),
        ...baseline,
      );
      if (!r) return undefined;
      const until = new Date(this.clock().getTime() + ttlMs).toISOString();
      this.execute(
        "update job set state = 'leased', lease_owner = ?, lease_until = ?, fence = fence + 1, updated_at = ?, leased_at = ? where id = ?",
        owner,
        until,
        this.now(),
        this.now(),
        Number(r.id),
      );
      const job = this.get(Number(r.id)) as JobRow;
      this.ledger.appendEvent(owner, "job_leased", String(job.id), { fence: job.fence, until });
      return job;
    });
  }

  /**
   * Device time a run's judging has used, in hours: from each finished job's last lease to
   * its completion (jobs for its attempts, and its validation and calibration jobs).
   */
  deviceHours(run: string): number {
    const r = this.row<Row>(
      `select sum((julianday(j.updated_at) - julianday(j.leased_at)) * 24) as h from job j
       left join attempt a on a.id = j.attempt
       where j.state in ('done', 'failed') and j.leased_at is not null
         and (a.run = ? or json_extract(j.spec, '$.run') = ?)`,
      run,
      run,
    );
    return Number(r?.h ?? 0);
  }

  get(id: number): JobRow | undefined {
    const r = this.row<Row>("select * from job where id = ?", id);
    return r ? toJob(r) : undefined;
  }

  assertFence(jobId: number, fence: number): JobRow {
    const job = this.get(jobId);
    if (!job) throw new LedgerError("not_found", `no job ${jobId}`);
    if (job.state !== "leased" || job.fence !== fence) {
      throw new LedgerError("stale", `job ${jobId} lease lost (fence ${fence}, now ${job.fence})`);
    }
    return job;
  }

  /** Throws unless the caller still holds the job's lease with this fence. */
  assertLease(jobId: number, fence: number): void {
    this.assertFence(jobId, fence);
  }

  heartbeat(jobId: number, fence: number, ttlMs: number): void {
    this.tx(() => {
      this.assertFence(jobId, fence);
      const until = new Date(this.clock().getTime() + ttlMs).toISOString();
      this.execute(
        "update job set lease_until = ?, updated_at = ? where id = ?",
        until,
        this.now(),
        jobId,
      );
    });
  }

  complete(jobId: number, fence: number, state: "done" | "failed", result: unknown): void {
    this.tx(() => {
      const job = this.assertFence(jobId, fence);
      this.execute(
        "update job set state = ?, result = ?, lease_owner = null, lease_until = null, updated_at = ? where id = ?",
        state,
        canonicalJson(result ?? {}),
        this.now(),
        jobId,
      );
      this.ledger.appendEvent(job.lease_owner ?? "executor", "job_finished", String(jobId), {
        state,
        result: result ?? {},
      });
    });
  }

  /** Re-queues jobs whose lease ran out, or blocks them after MAX_LEASE_EXPIRIES. */
  expireLeases(actor = "controller"): number[] {
    return this.requeue("lease_until < ?", [this.now()], actor, "job_lease_expired");
  }

  /**
   * Startup reconciliation: jobs still leased by `owner` belonged to a process that died, so
   * they are re-queued now (not after their lease runs out), each recorded once as crash_infra.
   */
  reclaimLeases(owner: string, actor = "controller"): number[] {
    return this.requeue("lease_owner = ?", [owner], actor, "crash_infra");
  }

  /**
   * The same for every executor's leases (`executor-…`): at the start, none of them runs yet, the
   * executors of runners that left the rig meanwhile included (goal 206).
   */
  reclaimExecutorLeases(actor = "controller"): number[] {
    return this.requeue("lease_owner like ?", ["executor-%"], actor, "crash_infra");
  }

  /**
   * One job back to the queue while `fence` still holds its lease, recorded as crash_infra: its
   * runner went away (goal 206). The loss counts, as after any lost lease.
   */
  reclaimJob(jobId: number, fence: number, actor: string): number[] {
    return this.requeue("id = ? and fence = ?", [jobId, fence], actor, "crash_infra");
  }

  /**
   * A closed run is never resumed, so the judge never takes its queued jobs: they are cancelled,
   * each with a `job_cancelled` event, so control's view of the queue drops it (goal 201), and an
   * attempt that waited for one ends as not_judged. A leased job finishes as it is. With no run,
   * every closed run's: at start, for runs closed before a close did this.
   */
  endClosedRuns(actor: string, run?: string): number[] {
    return this.tx(() => {
      const rows = this.rows<Row>(
        `select j.id, j.attempt, j.kind, i.id as run, a.lifecycle from job j
         left join attempt a on a.id = j.attempt
         join run i on i.id = coalesce(a.run, json_extract(j.spec, '$.run'))
         where j.state = 'queued' and i.status = 'closed' ${run === undefined ? "" : "and i.id = ?"}`,
        ...(run === undefined ? [] : [run]),
      );
      for (const r of rows) {
        this.execute(
          "update job set state = 'cancelled', updated_at = ? where id = ?",
          this.now(),
          Number(r.id),
        );
        this.ledger.appendEvent(actor, "job_cancelled", String(r.id), {
          run: String(r.run),
          attempt: r.attempt === null ? null : String(r.attempt),
          kind: String(r.kind),
          was: "queued",
          reason: "its run closed",
        });
        if (r.attempt !== null && r.lifecycle === "queued")
          this.ledger.attempts.setLifecycle(String(r.attempt), "not_judged", actor);
      }
      return rows.map((r) => Number(r.id));
    });
  }

  /** The jobs of these attempts that are queued or leased, oldest first. */
  openOf(
    attempts: readonly string[],
  ): { id: number; kind: string; attempt: string; state: string }[] {
    if (!attempts.length) return [];
    return this.rows<Row>(
      `select id, kind, attempt, state from job where state in ('queued', 'leased')
         and attempt in (${attempts.map(() => "?").join(", ")}) order by id`,
      ...attempts,
    ).map((r) => ({
      id: Number(r.id),
      kind: String(r.kind),
      attempt: String(r.attempt),
      state: String(r.state),
    }));
  }

  /**
   * Cancels a queued or leased job for good, with a `job_cancelled` event (goal 174): it never runs,
   * and a judge that holds its lease can no longer write its outcome, as after a lost lease.
   */
  cancel(
    jobId: number,
    actor: string,
    why: { run: string | null; reason: string; invalidation?: number | undefined },
  ): void {
    this.tx(() => {
      const job = this.get(jobId);
      if (!job || (job.state !== "queued" && job.state !== "leased")) return;
      this.execute(
        "update job set state = 'cancelled', lease_owner = null, lease_until = null, updated_at = ? where id = ?",
        this.now(),
        jobId,
      );
      this.ledger.appendEvent(actor, "job_cancelled", String(jobId), {
        run: why.run,
        attempt: job.attempt ?? null,
        kind: job.kind,
        was: job.state,
        reason: why.reason,
        ...(why.invalidation !== undefined ? { invalidation: why.invalidation } : {}),
      });
    });
  }

  /** A queued job's new place in the queue: the lowest priority number is leased first (goal 238). */
  reprioritize(jobId: number, priority: number): void {
    this.execute(
      "update job set priority = ?, updated_at = ? where id = ? and state = 'queued' and priority <> ?",
      priority,
      this.now(),
      jobId,
      priority,
    );
  }

  /** The leased jobs `where` picks go back to the queue, or are blocked, each with a `kind` event. */
  private requeue(where: string, args: SQLInputValue[], actor: string, kind: EventKind): number[] {
    return this.tx(() => {
      const rows = this.rows<Row>(
        `select id, kind, expiries, fence, attempt from job where state = 'leased' and ${where}`,
        ...args,
      );
      for (const r of rows) {
        const expiries = Number(r.expiries) + 1;
        const state = expiries >= MAX_LEASE_EXPIRIES ? "blocked" : "queued";
        this.execute(
          "update job set state = ?, expiries = ?, lease_owner = null, lease_until = null, updated_at = ? where id = ?",
          state,
          expiries,
          this.now(),
          Number(r.id),
        );
        this.ledger.appendEvent(actor, kind, String(r.id), {
          fence: Number(r.fence),
          expiries,
          state,
        });
        // A blocked job's attempt ends, so its lane and round go on; a harness start queues it again.
        // It says why, as crash_infra (goal 240): no verdict on its change. A parent screen's is
        // no verdict on its change at all, which stays as it is (goal 135).
        if (state === "blocked" && r.attempt !== null && r.kind !== "parent_screen") {
          const attempt = String(r.attempt);
          if (this.ledger.attempts.get(attempt)?.invalidated_by === null)
            this.ledger.verdicts.record({
              attempt,
              verdict: "crash_infra",
              dependsOnJobs: [Number(r.id)],
              reasons: blockedReason(kind, expiries),
              judgedBy: actor,
            });
          this.ledger.attempts.setLifecycle(attempt, "errored", actor);
        }
      }
      return rows.map((r) => Number(r.id));
    });
  }

  recordReceipt(jobId: number, fence: number, body: unknown): string {
    const json = canonicalJson(body);
    const id = sha256Hex(json);
    this.tx(() => {
      this.assertFence(jobId, fence);
      this.execute(
        "insert into receipt (id, job, fence, body, created_at) values (?, ?, ?, ?, ?)",
        id,
        jobId,
        fence,
        json,
        this.now(),
      );
    });
    return id;
  }

  /** How many jobs are in each state. */
  states(): Record<string, number> {
    const rows = this.rows<Row>("select state, count(*) as n from job group by state");
    return Object.fromEntries(rows.map((r) => [String(r.state), Number(r.n)]));
  }

  /** A run's jobs of one kind (its spec names the run), oldest first, with spec and result read. */
  ofRun(run: string, kind: string): RunJob[] {
    return this.rows<Row>(
      "select id, attempt, state, spec, result, created_at, updated_at from job where kind = ? and json_extract(spec, '$.run') = ? order by id",
      kind,
      run,
    ).map((r) => ({
      id: Number(r.id),
      attempt: r.attempt === null ? null : String(r.attempt),
      state: String(r.state),
      spec: JSON.parse(String(r.spec)) as Record<string, unknown>,
      result: r.result === null ? null : (JSON.parse(String(r.result)) as Record<string, unknown>),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    }));
  }

  /** How many jobs of these kinds are queued or leased. */
  open(kinds: readonly string[]): number {
    const r = this.row<Row>(
      `select count(*) as n from job where state in ('queued', 'leased') and kind in (${kinds.map(() => "?").join(", ")})`,
      ...kinds,
    );
    return Number(r?.n ?? 0);
  }

  /** How many jobs hold a lease that has not run out at `at`. */
  leasedAt(at: Date): number {
    const r = this.row<Row>(
      "select count(*) as n from job where state = 'leased' and lease_until > ?",
      at.toISOString(),
    );
    return Number(r?.n ?? 0);
  }

  /**
   * At the harness's start, each job blocked by lost leases is queued once more, one lost lease
   * from blocked again, with a `job_unblocked` event, and its attempt, which ended when the job
   * was blocked, waits for the judge again: a lease lost to a judge that could not renew it (an
   * older harness, during a long build) gets its try on the new one, and a job that keeps killing
   * its judge is blocked again after one more try. Returns their ids.
   */
  unblock(actor: string): number[] {
    return this.tx(() => {
      const rows = this.rows<Row>("select id, expiries, attempt from job where state = 'blocked'");
      for (const r of rows) {
        this.execute(
          "update job set state = 'queued', expiries = ?, lease_owner = null, lease_until = null, updated_at = ? where id = ?",
          MAX_LEASE_EXPIRIES - 1,
          this.now(),
          Number(r.id),
        );
        this.appendEvent(actor, "job_unblocked", String(r.id), {
          expiries: Number(r.expiries),
          reason: "queued again at the harness's start: one more lost lease blocks it again",
        });
        if (r.attempt !== null)
          this.ledger.attempts.setLifecycle(String(r.attempt), "queued", actor);
      }
      return rows.map((r) => Number(r.id));
    });
  }
}
