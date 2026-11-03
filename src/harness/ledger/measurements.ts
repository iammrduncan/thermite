import { LedgerError, LedgerPart, type Row } from "./part.ts";

/** The `measurement` table: what the judge measured. */
export class LedgerMeasurements extends LedgerPart {
  record(
    jobId: number,
    fence: number,
    m: {
      metric: string;
      cell: string;
      rep: number;
      value: number;
      /** The metric's unit (for example FLOP/s). */
      unit: string;
      arm?: string | undefined;
    },
  ): void {
    if (!Number.isFinite(m.value)) {
      throw new LedgerError("invalid", `non-finite value for ${m.metric}: never a score`);
    }
    this.tx(() => {
      this.ledger.jobs.assertFence(jobId, fence);
      this.execute(
        "insert into measurement (job, fence, arm, metric, cell, rep, value, unit, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        jobId,
        fence,
        m.arm ?? "candidate",
        m.metric,
        m.cell,
        m.rep,
        m.value,
        m.unit,
        this.now(),
      );
    });
  }

  /** Measurements from the job's latest lease only; rows from a dead earlier lease never mix in. */
  of(
    jobId: number,
  ): { arm: string; metric: string; cell: string; rep: number; value: number; unit: string }[] {
    return this.rows<Row>(
      `select arm, metric, cell, rep, value, unit from measurement
         where job = ? and fence = (select fence from job where id = ?) order by id`,
      jobId,
      jobId,
    ).map((r) => ({
      arm: String(r.arm),
      metric: String(r.metric),
      cell: String(r.cell),
      rep: Number(r.rep),
      value: Number(r.value),
      unit: String(r.unit),
    }));
  }
}
