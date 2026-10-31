import { canonicalJson } from "../../core/canonical.ts";
import { type HeldOutKind, heldOutCellsOf, heldOutKinds } from "../judge/index.ts";
import { LedgerPart, type Row } from "./part.ts";

/** The `held_out` table: the held-out checks' results. */
export class LedgerHeldOut extends LedgerPart {
  /**
   * A held-out record: whether every held-out cell passed, and each cell's name, kind of failure
   * and value against its threshold (goal 082). It never goes into a snapshot or an export; the
   * judge's `held_out_checked` event carries the same for the owner, and the agents get only the
   * kinds (`failure`).
   */
  record(jobId: number, fence: number, attempt: string, pass: boolean, detail: unknown): void {
    this.tx(() => {
      this.ledger.jobs.assertFence(jobId, fence);
      this.execute(
        "insert into held_out (job, fence, attempt, pass, detail, created_at) values (?, ?, ?, ?, ?, ?)",
        jobId,
        fence,
        attempt,
        pass ? 1 : 0,
        canonicalJson(detail ?? {}),
        this.now(),
      );
    });
  }

  /**
   * A goal run's champion's held-out record (goal 086): the confirming validation of a champion
   * that met every required goal runs its held-out cells too. It is kept as an attempt's is, by
   * run and champion and with no attempt, so `failure` never reads it as an attempt's own.
   */
  recordChampion(
    jobId: number,
    fence: number,
    run: string,
    championSeq: number,
    pass: boolean,
    detail: unknown,
  ): void {
    this.tx(() => {
      this.ledger.jobs.assertFence(jobId, fence);
      this.execute(
        "insert into held_out (job, fence, attempt, run, champion_seq, pass, detail, created_at) values (?, ?, null, ?, ?, ?, ?, ?)",
        jobId,
        fence,
        run,
        championSeq,
        pass ? 1 : 0,
        canonicalJson(detail ?? {}),
        this.now(),
      );
    });
  }

  /**
   * What the agents may know of an attempt's newest held-out record (goal 082): undefined when
   * it has none or it passed; else the kinds of failure it found, each once ([] for a record from
   * before goal 082, which kept no kinds). Never a cell's name, values or texts.
   */
  failure(attempt: string): HeldOutKind[] | undefined {
    const r = this.row<Row>(
      "select pass, detail from held_out where attempt = ? order by id desc limit 1",
      attempt,
    );
    if (!r || Number(r.pass) === 1) return undefined;
    try {
      return heldOutKinds(heldOutCellsOf(JSON.parse(String(r.detail))));
    } catch {
      return [];
    }
  }

  passed(jobId: number): boolean | undefined {
    const rows = this.rows<Row>(
      "select pass from held_out where job = ? and fence = (select fence from job where id = ?)",
      jobId,
      jobId,
    );
    return rows.length ? rows.every((r) => Number(r.pass) === 1) : undefined;
  }
}
