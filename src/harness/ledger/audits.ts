import { canonicalJson } from "../../core/canonical.ts";
import { LedgerPart, type Row } from "./part.ts";

/**
 * The `audit` table: the audits the judge asked for, one for each confirmation of an attempt that
 * held it, and the auditor's decision on each (written once).
 */
export class LedgerAudits extends LedgerPart {
  /**
   * An audit of an attempt's confirmation `job`, requested at `at`: its id, or the id of the one
   * requested for that confirmation before.
   */
  add(a: {
    attempt: string;
    job: number;
    run: string;
    trigger: string;
    reason: string;
    expectedSeq: number;
    at: string;
  }): number {
    const r = this.execute(
      `insert into audit (attempt, confirm_job, run, trigger, reason, expected_seq, requested_at)
           values (?, ?, ?, ?, ?, ?, ?) on conflict (attempt, confirm_job) do nothing`,
      a.attempt,
      a.job,
      a.run,
      a.trigger,
      a.reason,
      a.expectedSeq,
      a.at,
    );
    return r.changes
      ? r.id
      : Number(
          (
            this.row<Row>(
              "select id from audit where attempt = ? and confirm_job = ?",
              a.attempt,
              a.job,
            ) as Row
          ).id,
        );
  }

  get(id: number): Row | undefined {
    return this.row<Row>("select * from audit where id = ?", id);
  }

  /** The attempt's current audit: the one for its latest confirmation. */
  current(attempt: string): Row | undefined {
    return this.row<Row>("select * from audit where attempt = ? order by id desc limit 1", attempt);
  }

  /** The ids of the open audits: the current one of each attempt still held for one, oldest first. */
  pending(): number[] {
    return this.rows<{ id: number }>(
      `select au.id as id from audit au join attempt a on a.id = au.attempt
           where au.decision is null and a.lifecycle = 'awaiting_audit'
             and au.id = (select max(id) from audit x where x.attempt = au.attempt)
           order by au.id`,
    ).map((r) => r.id);
  }

  /** The auditor's decision on an audit, at `at`. */
  decide(
    id: number,
    d: { decision: string; reasons: string; citations: readonly string[]; auditor: string },
    at: string,
  ): void {
    this.execute(
      "update audit set decision = ?, reasons = ?, citations = ?, auditor = ?, decided_at = ? where id = ?",
      d.decision,
      d.reasons,
      canonicalJson(d.citations),
      d.auditor,
      at,
      id,
    );
  }
}
